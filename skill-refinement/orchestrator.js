const crypto = require('node:crypto');
const path = require('node:path');
const { loadSuite, listSuites } = require('./suite');
const { reflectSkillPatch } = require('./refiner');
const { resolveRefinementModels } = require('./models');
const { copySnapshot } = require('./workspace');
const { rankRollouts, summarizeRun } = require('./ranking');
const { createReliableModelCapability } = require('../runtime/reliable-model');
const { TrajectoryJournal } = require('./trajectory-journal');
const { applyPatchWithReport, parsePatch } = require('./skill-patch');
const { GitSkillStore } = require('./git-skill-store');

function validateCandidateSkill(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Skill Patch produced an empty candidate');
    }
    const candidate = value.trim();
    if (candidate.length > 64000) throw new Error('Refined Skill exceeds 64000 characters');
    return candidate;
}

function skillHash(skill) {
    return crypto.createHash('sha256').update(String(skill || '')).digest('hex');
}

function batchIdFor(epoch, step) {
    return `epoch-${String(epoch).padStart(3, '0')}-step-${String(step).padStart(3, '0')}`;
}

function rawRolloutRecord({ rollout, runId, suite, batch, skill, models }) {
    return {
        schemaVersion: 2,
        recordType: 'skill-refinement-rollout',
        id: rollout.id,
        runId,
        suiteId: suite.id,
        batchId: batch.id,
        phase: batch.phase,
        epoch: batch.epoch,
        step: batch.step,
        startedAt: rollout.startedAt || null,
        finishedAt: rollout.finishedAt || null,
        task: suite.task,
        skill,
        skillSha256: skillHash(skill),
        models,
        messages: rollout.messages,
        finalReply: rollout.reply,
        agentError: rollout.agentError,
        evaluation: rollout.evaluation,
        protectedPathViolations: rollout.protectedPathViolations,
        diff: rollout.diff,
        reward: rollout.score,
        infrastructureFailure: rollout.infrastructureFailure,
        attempts: rollout.attempts || [],
    };
}

function semanticRolloutRecord(record) {
    const { attempts, skill, task, models, ...semantic } = record;
    return semantic;
}

function summarizeBatch(batch) {
    if (!batch) return null;
    return {
        id: batch.id,
        phase: batch.phase,
        epoch: batch.epoch,
        step: batch.step,
        skillSha256: batch.skillSha256,
        valid: batch.valid,
        aggregateScore: batch.aggregateScore,
        passCount: batch.passCount,
        rolloutCount: batch.rollouts.length,
        infrastructureFailureCount: batch.infrastructureFailures.length,
        cleanedTrajectoryPath: batch.trajectory.path,
    };
}

function normalizeRefinementResult(value) {
    const patchValue = value && typeof value === 'object' && 'patch' in value
        ? value.patch
        : value;
    return {
        patch: parsePatch(patchValue),
        modelReasoning: value && typeof value.modelReasoning === 'string'
            ? value.modelReasoning
            : '',
    };
}

class SkillRefinementOrchestrator {
    constructor(config, dependencies = {}) {
        if (!dependencies.artifacts) throw new Error('Skill Refinement artifact repository is required');
        if (!dependencies.rollouts) throw new Error('Skill Refinement rollout coordinator is required');
        this.config = config;
        this.artifacts = dependencies.artifacts;
        this.rollouts = dependencies.rollouts;
        this.defaultModel = dependencies.defaultModel || null;
        this.modelResolver = dependencies.modelResolver || null;
        this.skillRefiner = dependencies.skillRefiner || reflectSkillPatch;
        this.skillStoreFactory = dependencies.skillStoreFactory
            || (artifactRoot => new GitSkillStore(artifactRoot));
    }

    listSuites() {
        return listSuites(this.config.suitesRoot, this.config.projectRoot);
    }

    async refine(args = {}) {
        const suite = loadSuite(this.config.suitesRoot, args.suiteId, this.config.projectRoot);
        const models = await resolveRefinementModels({
            suite,
            defaultModel: this.defaultModel,
            modelResolver: this.modelResolver,
        });
        const modelSummary = Object.freeze({
            template: models.template.info,
            reflection: models.reflection.info,
        });
        const runId = crypto.randomUUID();
        const { artifactRoot, baseline } = this.artifacts.createRun(runId);
        const trajectoryJournal = new TrajectoryJournal(artifactRoot);
        const templateModel = createReliableModelCapability(models.template.model, {
            recorder: trajectoryJournal,
            maxAttempts: this.config.modelTransportAttempts,
            retryDelayMs: this.config.modelRetryDelayMs,
            requestTimeoutMs: this.config.modelRequestTimeoutMs,
            reasoningRequired: true,
        });
        const reflectionModel = createReliableModelCapability(models.reflection.model, {
            recorder: trajectoryJournal,
            maxAttempts: this.config.modelTransportAttempts,
            retryDelayMs: this.config.modelRetryDelayMs,
            requestTimeoutMs: this.config.modelRequestTimeoutMs,
            reasoningRequired: true,
        });
        const skillStore = this.skillStoreFactory(artifactRoot);
        let sandboxSnapshot = null;
        let snapshot = null;
        let versionExport = null;
        let cleanedTrajectories = null;
        const steps = [];
        const run = {
            id: runId,
            suiteId: suite.id,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            rolloutCount: 0,
            batchSize: suite.rollouts,
            epochs: suite.epochs,
            stepsPerEpoch: suite.stepsPerEpoch,
            acceptedSteps: 0,
            bestRolloutId: null,
            bestScore: null,
            artifactRoot,
            candidateSkillPath: null,
            rawTrajectoryPath: trajectoryJournal.rawPath,
            cleanedTrajectoryPath: trajectoryJournal.cleanedPath,
            rolloutRecordsPath: null,
            models: modelSummary,
            error: null,
        };

        const pruneBatchWorkspaces = (batch, keepRolloutId, reason) => {
            if (!batch) return;
            for (const rollout of batch.rollouts || []) {
                const keepWorkspace = rollout.id === keepRolloutId
                    ? rollout.workspace
                    : null;
                const removed = new Set();
                for (const attempt of rollout.attempts || []) {
                    const workspace = attempt.workspace;
                    if (workspace && workspace !== keepWorkspace && !removed.has(workspace)) {
                        this.artifacts.removeWorkspace(artifactRoot, workspace, {
                            batchId: batch.id,
                            rolloutId: rollout.id,
                            attempt: attempt.attempt,
                            reason,
                        });
                        removed.add(workspace);
                        attempt.workspace = null;
                        attempt.workspaceRetained = false;
                    } else if (workspace) {
                        attempt.workspaceRetained = true;
                    }
                }
                if (rollout.workspace && rollout.workspace !== keepWorkspace) {
                    if (!removed.has(rollout.workspace)) {
                        this.artifacts.removeWorkspace(artifactRoot, rollout.workspace, {
                            batchId: batch.id,
                            rolloutId: rollout.id,
                            attempt: rollout.attempt,
                            reason,
                        });
                    }
                    rollout.workspace = null;
                    rollout.workspaceRetained = false;
                } else if (rollout.workspace) {
                    rollout.workspaceRetained = true;
                }
                this.artifacts.writeRollout(
                    artifactRoot,
                    rollout.id,
                    rollout,
                    batch.id
                );
            }
        };

        const runBatch = async ({ id, phase, epoch = null, step = null, skill }) => {
            const startSequence = trajectoryJournal.checkpoint();
            const effectiveSuite = { ...suite, skill };
            const batchMetadata = { id, phase, epoch, step };
            const rollouts = await Promise.all(
                Array.from({ length: suite.rollouts }, (_, rolloutIndex) => this.rollouts.run({
                    runId,
                    rolloutIndex,
                    suite: effectiveSuite,
                    artifactRoot,
                    baseline,
                    snapshot: sandboxSnapshot,
                    templateModel,
                    trajectoryJournal,
                    batchId: id,
                    phase,
                    epoch,
                    step,
                }))
            );
            run.rolloutCount += rollouts.length;
            const infrastructureFailures = rollouts.filter(
                rollout => rollout.infrastructureFailure
            );
            const invalidScores = rollouts.filter(rollout => (
                !rollout.infrastructureFailure && !Number.isFinite(rollout.score)
            ));
            const valid = infrastructureFailures.length === 0 && invalidScores.length === 0;
            const aggregateScore = valid
                ? rollouts.reduce((total, rollout) => total + rollout.score, 0)
                : null;
            const ranking = valid ? [...rollouts].sort(rankRollouts) : [];
            pruneBatchWorkspaces(
                { id, rollouts },
                valid ? ranking[0]?.id || null : null,
                'batch-non-best'
            );
            const records = rollouts.map(rollout => rawRolloutRecord({
                rollout,
                runId,
                suite,
                batch: batchMetadata,
                skill,
                models: modelSummary,
            }));
            run.rolloutRecordsPath = this.artifacts.appendRawTrajectories(
                artifactRoot,
                records
            );
            trajectoryJournal.recordSemanticEvent({
                eventId: crypto.randomUUID(),
                type: 'batch_summary',
                recordType: 'skill-refinement-batch-summary',
                purpose: 'evaluation',
                content: JSON.stringify({
                    schemaVersion: 2,
                    batch: batchMetadata,
                    testedSkill: skill,
                    testedSkillSha256: skillHash(skill),
                    valid,
                    aggregateScore,
                    invalidScoreRolloutIds: invalidScores.map(rollout => rollout.id),
                    rollouts: records.map(semanticRolloutRecord),
                }),
                payload: {
                    batch: batchMetadata,
                    valid,
                    aggregateScore,
                },
            });
            const endSequence = trajectoryJournal.checkpoint();
            const trajectory = trajectoryJournal.clean({
                afterSequence: startSequence,
                throughSequence: endSequence,
                path: `trajectory-batches/${id}.jsonl`,
            });
            return {
                ...batchMetadata,
                skill,
                skillSha256: skillHash(skill),
                valid,
                aggregateScore,
                passCount: valid
                    ? rollouts.filter(rollout => rollout.evaluation?.ok).length
                    : null,
                rollouts,
                ranking,
                infrastructureFailures,
                invalidScores,
                trajectory,
            };
        };

        try {
            snapshot = copySnapshot(suite.baseline, baseline);
            await skillStore.initialize(suite.skill);
            sandboxSnapshot = typeof this.rollouts.prepareSnapshot === 'function'
                ? await this.rollouts.prepareSnapshot(baseline, runId)
                : null;

            const baselineBatch = await runBatch({
                id: 'baseline',
                phase: 'baseline',
                skill: skillStore.read(),
            });
            if (!baselineBatch.valid) {
                throw new Error(
                    'Baseline batch is invalid because infrastructure failed after retry or a score is missing'
                );
            }

            let currentSkill = skillStore.read();
            let currentScore = baselineBatch.aggregateScore;
            let incumbentBatch = baselineBatch;
            let reflectionEvidence = baselineBatch;

            for (let epoch = 1; epoch <= suite.epochs; epoch += 1) {
                for (let step = 1; step <= suite.stepsPerEpoch; step += 1) {
                    const batchId = batchIdFor(epoch, step);
                    const headBefore = await skillStore.head();
                    const stepRecord = {
                        schemaVersion: 2,
                        recordType: 'skill-refinement-step',
                        epoch,
                        step,
                        batchId,
                        status: 'reflecting',
                        startedAt: new Date().toISOString(),
                        finishedAt: null,
                        incumbentScore: currentScore,
                        candidateScore: null,
                        accepted: false,
                        reason: null,
                        headBefore,
                        headAfter: headBefore,
                        evidenceBatch: summarizeBatch(reflectionEvidence),
                        patch: null,
                        patchReport: null,
                        gitDiff: '',
                        reflectionReasoning: '',
                        candidateBatch: null,
                        error: null,
                    };

                    let refinement;
                    try {
                        refinement = normalizeRefinementResult(await this.skillRefiner({
                            model: reflectionModel,
                            suite,
                            rollouts: reflectionEvidence.ranking,
                            trajectory: reflectionEvidence.trajectory,
                            currentSkill,
                            epoch,
                            step,
                        }));
                    } catch (error) {
                        stepRecord.status = 'reflection-failed';
                        stepRecord.reason = error?.infrastructureFailure
                            ? 'reflection-infrastructure-failure'
                            : 'invalid-reflection-output';
                        stepRecord.error = error instanceof Error ? error.message : String(error);
                        stepRecord.finishedAt = new Date().toISOString();
                        stepRecord.recordPath = this.artifacts.writeStep(
                            artifactRoot,
                            epoch,
                            step,
                            stepRecord
                        );
                        steps.push(stepRecord);
                        throw error;
                    }

                    stepRecord.patch = refinement.patch;
                    stepRecord.reflectionReasoning = refinement.modelReasoning;
                    const applied = applyPatchWithReport(currentSkill, refinement.patch);
                    stepRecord.patchReport = applied.reports;
                    if (!applied.changed) {
                        stepRecord.status = 'rejected';
                        stepRecord.reason = 'patch-made-no-change';
                        stepRecord.finishedAt = new Date().toISOString();
                        stepRecord.recordPath = this.artifacts.writeStep(
                            artifactRoot,
                            epoch,
                            step,
                            stepRecord
                        );
                        steps.push(stepRecord);
                        continue;
                    }

                    let candidateSkill;
                    try {
                        candidateSkill = validateCandidateSkill(applied.skill);
                    } catch (error) {
                        stepRecord.status = 'reflection-failed';
                        stepRecord.reason = 'invalid-patched-skill';
                        stepRecord.error = error instanceof Error ? error.message : String(error);
                        stepRecord.finishedAt = new Date().toISOString();
                        stepRecord.recordPath = this.artifacts.writeStep(
                            artifactRoot,
                            epoch,
                            step,
                            stepRecord
                        );
                        steps.push(stepRecord);
                        throw error;
                    }
                    if (candidateSkill === currentSkill) {
                        stepRecord.status = 'rejected';
                        stepRecord.reason = 'patch-normalized-to-no-change';
                        stepRecord.finishedAt = new Date().toISOString();
                        stepRecord.recordPath = this.artifacts.writeStep(
                            artifactRoot,
                            epoch,
                            step,
                            stepRecord
                        );
                        steps.push(stepRecord);
                        continue;
                    }
                    skillStore.write(candidateSkill);
                    stepRecord.gitDiff = await skillStore.diff();
                    const candidateBatch = await runBatch({
                        id: batchId,
                        phase: 'candidate',
                        epoch,
                        step,
                        skill: candidateSkill,
                    });
                    stepRecord.candidateBatch = summarizeBatch(candidateBatch);

                    if (!candidateBatch.valid) {
                        await skillStore.restore();
                        pruneBatchWorkspaces(
                            candidateBatch,
                            null,
                            candidateBatch.infrastructureFailures.length > 0
                                ? 'candidate-infrastructure-failure'
                                : 'candidate-missing-score'
                        );
                        stepRecord.status = 'invalid';
                        stepRecord.reason = candidateBatch.infrastructureFailures.length > 0
                            ? 'candidate-batch-infrastructure-failure'
                            : 'candidate-batch-missing-score';
                        stepRecord.headAfter = await skillStore.head();
                    } else if (candidateBatch.aggregateScore > currentScore) {
                        const headAfter = await skillStore.accept({
                            epoch,
                            step,
                            score: candidateBatch.aggregateScore,
                        });
                        pruneBatchWorkspaces(
                            incumbentBatch,
                            null,
                            'superseded-incumbent'
                        );
                        currentSkill = candidateSkill;
                        currentScore = candidateBatch.aggregateScore;
                        incumbentBatch = candidateBatch;
                        reflectionEvidence = candidateBatch;
                        run.acceptedSteps += 1;
                        stepRecord.status = 'accepted';
                        stepRecord.reason = 'aggregate-score-strictly-improved';
                        stepRecord.accepted = true;
                        stepRecord.candidateScore = candidateBatch.aggregateScore;
                        stepRecord.headAfter = headAfter;
                    } else {
                        await skillStore.restore();
                        pruneBatchWorkspaces(candidateBatch, null, 'candidate-rejected');
                        reflectionEvidence = candidateBatch;
                        stepRecord.status = 'rejected';
                        stepRecord.reason = candidateBatch.aggregateScore === currentScore
                            ? 'aggregate-score-tied'
                            : 'aggregate-score-regressed';
                        stepRecord.candidateScore = candidateBatch.aggregateScore;
                        stepRecord.headAfter = await skillStore.head();
                    }
                    stepRecord.finishedAt = new Date().toISOString();
                    stepRecord.recordPath = this.artifacts.writeStep(
                        artifactRoot,
                        epoch,
                        step,
                        stepRecord
                    );
                    steps.push(stepRecord);
                }
            }

            cleanedTrajectories = trajectoryJournal.clean();
            const candidateSkillPath = this.artifacts.writeCandidate(artifactRoot, currentSkill);
            versionExport = await skillStore.exportHistory();

            if (sandboxSnapshot && typeof this.rollouts.disposeSnapshot === 'function') {
                await this.rollouts.disposeSnapshot(sandboxSnapshot);
                sandboxSnapshot = null;
            }
            skillStore.dispose();

            const best = incumbentBatch.ranking[0] || null;
            run.status = 'completed';
            run.bestRolloutId = best?.id || null;
            run.bestScore = currentScore;
            run.candidateSkillPath = candidateSkillPath;
            run.cleanedTrajectoryPath = cleanedTrajectories.path;
            run.finishedAt = new Date().toISOString();

            const result = {
                schemaVersion: 2,
                run: summarizeRun(run),
                suite: {
                    id: suite.id,
                    task: suite.task,
                    sourceSkillPath: suite.skillPath,
                    templateModel: suite.templateModel,
                    reflectionModel: suite.reflectionModel,
                    batchSize: suite.rollouts,
                    epochs: suite.epochs,
                    stepsPerEpoch: suite.stepsPerEpoch,
                    evaluationCommand: suite.evaluation.command,
                    protectedPaths: [...suite.protectedPaths],
                },
                models: modelSummary,
                snapshot,
                baseline: summarizeBatch(baselineBatch),
                final: {
                    score: currentScore,
                    acceptedSteps: run.acceptedSteps,
                    skillSha256: skillHash(currentSkill),
                    verifiedBatch: summarizeBatch(incumbentBatch),
                },
                best: best ? {
                    rolloutId: best.id,
                    score: best.score,
                    workspace: best.workspace,
                    evaluation: best.evaluation,
                    diff: best.diff,
                    reply: best.reply,
                } : null,
                ranking: incumbentBatch.ranking.map(item => ({
                    rolloutId: item.id,
                    score: item.score,
                    evaluationPassed: item.evaluation.ok,
                    protectedPathViolations: item.protectedPathViolations,
                    changedFiles: item.diff.fileCount,
                    changedBytes: item.diff.changedBytes,
                })),
                steps: steps.map(item => ({
                    epoch: item.epoch,
                    step: item.step,
                    status: item.status,
                    accepted: item.accepted,
                    reason: item.reason,
                    incumbentScore: item.incumbentScore,
                    candidateScore: item.candidateScore,
                    recordPath: item.recordPath,
                })),
                candidateSkill: {
                    path: candidateSkillPath,
                    content: currentSkill,
                    verified: true,
                },
                skillVersions: {
                    historyPath: versionExport.historyPath,
                    diffPath: versionExport.diffPath,
                    head: versionExport.head,
                    worktreeSkillPath: skillStore.skillPath,
                    repositoryRemoved: true,
                },
                rawTrajectoryPath: trajectoryJournal.rawPath,
                cleanedTrajectoryPath: cleanedTrajectories.path,
                transportAttemptsPath: trajectoryJournal.transportPath,
                excludedAttemptsPath: trajectoryJournal.exclusionsPath,
                workspaceRetentionPath: path.join(artifactRoot, 'workspace-retention.jsonl'),
                rolloutRecordsPath: run.rolloutRecordsPath,
                evidencePath: cleanedTrajectories.path,
            };
            this.artifacts.writeResult(artifactRoot, result);
            return result;
        } catch (error) {
            try {
                cleanedTrajectories = trajectoryJournal.clean();
                run.cleanedTrajectoryPath = cleanedTrajectories.path;
            } catch {
                // Keep the original failure when a secondary artifact write also fails.
            }
            if (sandboxSnapshot && typeof this.rollouts.disposeSnapshot === 'function') {
                try {
                    await this.rollouts.disposeSnapshot(sandboxSnapshot);
                } catch {
                    // Preserve the primary failure while best-effort cleanup continues.
                }
                sandboxSnapshot = null;
            }
            if (skillStore.initialized && !versionExport) {
                try {
                    versionExport = await skillStore.exportHistory();
                } catch {
                    // A failed run can still retain all non-Git trajectory artifacts.
                }
            }
            try {
                skillStore.dispose();
            } catch {
                // Preserve the primary failure.
            }
            run.status = 'failed';
            run.error = error instanceof Error ? error.message : String(error);
            run.finishedAt = new Date().toISOString();
            this.artifacts.writeResult(artifactRoot, {
                schemaVersion: 2,
                run: summarizeRun(run),
                rawTrajectoryPath: trajectoryJournal.rawPath,
                cleanedTrajectoryPath: cleanedTrajectories?.path || null,
                transportAttemptsPath: trajectoryJournal.transportPath,
                excludedAttemptsPath: trajectoryJournal.exclusionsPath,
                rolloutRecordsPath: run.rolloutRecordsPath,
                workspaceRetentionPath: path.join(artifactRoot, 'workspace-retention.jsonl'),
                skillVersions: versionExport,
                steps: steps.map(item => ({
                    epoch: item.epoch,
                    step: item.step,
                    status: item.status,
                    reason: item.reason,
                    recordPath: item.recordPath,
                })),
            });
            throw error;
        }
    }
}

module.exports = {
    SkillRefinementOrchestrator,
    validateCandidateSkill,
    normalizeRefinementResult,
    summarizeBatch,
};

const crypto = require('node:crypto');
const path = require('node:path');
const { loadSuite, listSuites } = require('./suite');
const { reflectSkillPatch } = require('./refiner');
const { generateSlowUpdate, generateMetaUpdate } = require('./optimizer-memory');
const { resolveRefinementModels } = require('./models');
const { copySnapshot } = require('./workspace');
const { rankRollouts, meanScore, editBudgetAt, summarizeRun } = require('./ranking');
const { createReliableModelCapability } = require('../runtime/reliable-model');
const { TrajectoryJournal } = require('./trajectory-journal');
const {
    applyPatchWithReport,
    parsePatch,
    selectPatchEdits,
    replaceSlowUpdate,
} = require('./skill-patch');
const { GitSkillStore } = require('./git-skill-store');
const { RESULT_SCHEMA_VERSION } = require('./artifact-repository');

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

function batchIdFor(epoch, step, phase) {
    return `epoch-${String(epoch).padStart(3, '0')}-step-${String(step).padStart(3, '0')}-${phase}`;
}

function deterministicShuffle(items, seed, epoch, purpose = 'train') {
    return items.map((item, index) => ({
        item,
        key: crypto.createHash('sha256')
            .update(`${seed}:${epoch}:${purpose}:${item.id}:${index}`)
            .digest('hex'),
    })).sort((left, right) => left.key.localeCompare(right.key)).map(entry => entry.item);
}

function chunk(items, size) {
    const groups = [];
    for (let index = 0; index < items.length; index += size) {
        groups.push(items.slice(index, index + size));
    }
    return groups;
}

function epochEvidenceGroups(suite, epoch) {
    const optimizer = suite.optimizer;
    const shuffled = deterministicShuffle(
        suite.dataset.train,
        optimizer.shuffleSeed,
        epoch,
        'training'
    );
    const rolloutBatches = chunk(shuffled, optimizer.rolloutBatchSize);
    return chunk(rolloutBatches, optimizer.accumulationFactor);
}

function rawRolloutRecord({ rollout, runId, suite, batch, skill, models }) {
    const taskItem = rollout.taskItem || null;
    return {
        schemaVersion: 3,
        recordType: 'skill-refinement-rollout',
        id: rollout.id,
        runId,
        suiteId: suite.id,
        batchId: batch.id,
        phase: batch.phase,
        split: taskItem?.split || rollout.split || null,
        taskId: taskItem?.id || rollout.taskId || null,
        epoch: batch.epoch,
        step: batch.step,
        startedAt: rollout.startedAt || null,
        finishedAt: rollout.finishedAt || null,
        task: taskItem?.task || rollout.task || null,
        taskMetadata: taskItem?.metadata || {},
        skill,
        skillSha256: skillHash(skill),
        models,
        messages: rollout.messages || [],
        finalReply: rollout.reply || '',
        agentError: rollout.agentError || null,
        evaluation: rollout.evaluation,
        protectedPathViolations: rollout.protectedPathViolations || [],
        diff: rollout.diff,
        reward: rollout.score,
        success: rollout.success,
        infrastructureFailure: Boolean(rollout.infrastructureFailure),
        attempts: rollout.attempts || [],
    };
}

function semanticRolloutRecord(record) {
    const { attempts, skill, task, taskMetadata, models, messages, ...semantic } = record;
    return semantic;
}

function summarizeBatch(batch) {
    if (!batch) return null;
    return {
        id: batch.id,
        phase: batch.phase,
        split: batch.split || null,
        epoch: batch.epoch,
        step: batch.step,
        skillSha256: batch.skillSha256,
        valid: batch.valid,
        cached: Boolean(batch.cached),
        cachedFrom: batch.cachedFrom || null,
        meanScore: batch.meanScore,
        passCount: batch.passCount,
        rolloutCount: batch.rollouts.length,
        taskIds: (batch.items || []).map(item => item.id),
        infrastructureFailureCount: batch.infrastructureFailures.length,
        cleanedTrajectoryPath: batch.trajectory?.path || null,
    };
}

function normalizeRefinementResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('patch' in value)) {
        throw new Error('Skill refiner must return an object containing patch');
    }
    const patch = parsePatch(value.patch);
    return {
        patch,
            modelReasoning: typeof value.modelReasoning === 'string'
            ? value.modelReasoning
            : '',
        failurePatterns: Array.isArray(value?.failurePatterns)
            ? value.failurePatterns
            : [...patch.failureSummary],
        successPatterns: Array.isArray(value?.successPatterns)
            ? value.successPatterns
            : [...patch.successPatterns],
        analysis: value?.analysis && typeof value.analysis === 'object' ? value.analysis : null,
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
        this.slowUpdater = dependencies.slowUpdater || generateSlowUpdate;
        this.metaUpdater = dependencies.metaUpdater || generateMetaUpdate;
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
        let optimizerStatePath = null;
        const steps = [];
        const rejectedHistory = [];
        const epochGroups = Array.from(
            { length: suite.optimizer.epochs },
            (_, index) => epochEvidenceGroups(suite, index + 1)
        );
        const totalOptimizationSteps = epochGroups.reduce((total, groups) => total + groups.length, 0);
        const run = {
            id: runId,
            suiteId: suite.id,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            rolloutCount: 0,
            acceptedSteps: 0,
            bestTestRolloutId: null,
            selectionScore: null,
            testScore: null,
            artifactRoot,
            candidateSkillPath: null,
            rawTrajectoryPath: trajectoryJournal.rawPath,
            cleanedTrajectoryPath: trajectoryJournal.cleanedPath,
            rolloutRecordsPath: null,
            models: modelSummary,
            error: null,
        };

        const pruneBatchWorkspaces = (batch, keepRolloutId, reason) => {
            if (!batch || batch.cached) return;
            for (const rollout of batch.rollouts || []) {
                const keepWorkspace = rollout.id === keepRolloutId ? rollout.workspace : null;
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
                this.artifacts.writeRollout(artifactRoot, rollout.id, rollout, batch.id);
            }
        };

        const runBatch = async ({ id, phase, items, epoch = null, step = null, skill }) => {
            if (!Array.isArray(items) || items.length === 0) {
                throw new Error(`Skill Refinement batch ${id} has no task items`);
            }
            const startSequence = trajectoryJournal.checkpoint();
            const batchMetadata = {
                id,
                phase,
                split: items.every(item => item.split === items[0].split) ? items[0].split : 'mixed',
                epoch,
                step,
            };
            const rollouts = await Promise.all(items.map(async (item, rolloutIndex) => {
                const effectiveSuite = {
                    ...suite,
                    skill,
                    task: item.task,
                    taskItem: item,
                    evaluation: item.evaluation,
                };
                const rollout = await this.rollouts.run({
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
                });
                const success = typeof rollout.success === 'boolean'
                    ? rollout.success
                    : (Number.isFinite(rollout.score)
                        ? rollout.score >= item.evaluation.reward.successThreshold
                        : null);
                return { ...rollout, taskItem: item, taskId: item.id, split: item.split, success };
            }));
            run.rolloutCount += rollouts.length;
            const infrastructureFailures = rollouts.filter(rollout => rollout.infrastructureFailure);
            const invalidScores = rollouts.filter(rollout => (
                !rollout.infrastructureFailure && !Number.isFinite(rollout.score)
            ));
            const valid = infrastructureFailures.length === 0 && invalidScores.length === 0;
            const batchMeanScore = valid ? meanScore(rollouts) : null;
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
            run.rolloutRecordsPath = this.artifacts.appendRawTrajectories(artifactRoot, records);
            trajectoryJournal.recordSemanticEvent({
                eventId: crypto.randomUUID(),
                type: 'batch_summary',
                recordType: 'skill-refinement-batch-summary',
                purpose: 'evaluation',
                content: JSON.stringify({
                    schemaVersion: 3,
                    batch: batchMetadata,
                    testedSkill: skill,
                    testedSkillSha256: skillHash(skill),
                    valid,
                    meanScore: batchMeanScore,
                    invalidScoreRolloutIds: invalidScores.map(rollout => rollout.id),
                    rollouts: records.map(semanticRolloutRecord),
                }),
                payload: { batch: batchMetadata, valid, meanScore: batchMeanScore },
            });
            const endSequence = trajectoryJournal.checkpoint();
            const trajectory = trajectoryJournal.clean({
                afterSequence: startSequence,
                throughSequence: endSequence,
                path: `trajectory-batches/${id}.jsonl`,
            });
            return {
                ...batchMetadata,
                items,
                skill,
                skillSha256: skillHash(skill),
                valid,
                meanScore: batchMeanScore,
                passCount: valid ? rollouts.filter(rollout => rollout.success).length : null,
                rollouts,
                ranking,
                infrastructureFailures,
                invalidScores,
                trajectory,
                cached: false,
            };
        };

        const assertValidBatch = (batch, label) => {
            if (batch.valid) return batch;
            const reason = batch.infrastructureFailures.length > 0
                ? 'infrastructure failed after retry'
                : 'a reward is missing or outside [0, 1]';
            throw new Error(`${label} batch is invalid because ${reason}`);
        };

        const selectionCache = new Map();
        const evaluateSelection = async ({ id, phase, skill, epoch = null, step = null }) => {
            const hash = skillHash(skill);
            if (selectionCache.has(hash)) {
                const cached = selectionCache.get(hash);
                return {
                    id,
                    phase,
                    split: 'selection',
                    epoch,
                    step,
                    items: suite.dataset.selection,
                    skill,
                    skillSha256: hash,
                    valid: true,
                    meanScore: cached.meanScore,
                    passCount: cached.passCount,
                    rollouts: [],
                    ranking: [],
                    infrastructureFailures: [],
                    invalidScores: [],
                    trajectory: null,
                    cached: true,
                    cachedFrom: cached.batchId,
                    itemScores: cached.itemScores,
                };
            }
            const batch = await runBatch({
                id,
                phase,
                items: suite.dataset.selection,
                epoch,
                step,
                skill,
            });
            if (batch.valid) {
                selectionCache.set(hash, {
                    meanScore: batch.meanScore,
                    passCount: batch.passCount,
                    batchId: batch.id,
                    itemScores: batch.rollouts.map(rollout => ({
                        taskId: rollout.taskId,
                        reward: rollout.score,
                    })),
                });
            }
            return batch;
        };

        const writeStepRecord = stepRecord => {
            stepRecord.finishedAt = new Date().toISOString();
            stepRecord.recordPath = this.artifacts.writeStep(
                artifactRoot,
                stepRecord.epoch,
                stepRecord.step,
                stepRecord
            );
            steps.push(stepRecord);
            return stepRecord;
        };

        try {
            snapshot = copySnapshot(suite.baseline, baseline, { excludePaths: [suite.suiteDir] });
            await skillStore.initialize(suite.skill);
            sandboxSnapshot = typeof this.rollouts.prepareSnapshot === 'function'
                ? await this.rollouts.prepareSnapshot(baseline, runId)
                : null;

            let currentSkill = skillStore.read();
            const baselineSelection = assertValidBatch(await evaluateSelection({
                id: 'selection-baseline',
                phase: 'selection-baseline',
                skill: currentSkill,
            }), 'Baseline selection');
            let currentSelectionScore = baselineSelection.meanScore;
            let incumbentSelectionBatch = baselineSelection;
            let metaSkill = '';
            let previousEpochEndSkill = null;
            let globalStep = 0;

            for (let epoch = 1; epoch <= suite.optimizer.epochs; epoch += 1) {
                const rejectedBuffer = [];
                const epochHistory = [];
                const evidenceGroups = epochGroups[epoch - 1];
                for (let step = 1; step <= evidenceGroups.length; step += 1) {
                    const editBudget = editBudgetAt(
                        suite.optimizer.editBudget,
                        globalStep,
                        totalOptimizationSteps
                    );
                    globalStep += 1;
                    const trainingBatches = [];
                    for (const [batchIndex, items] of evidenceGroups[step - 1].entries()) {
                        trainingBatches.push(assertValidBatch(await runBatch({
                            id: `${batchIdFor(epoch, step, 'train')}-${String(batchIndex + 1).padStart(2, '0')}`,
                            phase: 'train',
                            items,
                            epoch,
                            step,
                            skill: currentSkill,
                        }), 'Training evidence'));
                    }
                    const headBefore = await skillStore.head();
                    const stepRecord = {
                        schemaVersion: 3,
                        recordType: 'skill-refinement-step',
                        epoch,
                        step,
                        batchId: batchIdFor(epoch, step, 'candidate'),
                        status: 'reflecting',
                        startedAt: new Date().toISOString(),
                        finishedAt: null,
                        incumbentSelectionScore: currentSelectionScore,
                        candidateSelectionScore: null,
                        editBudget,
                        accepted: false,
                        reason: null,
                        headBefore,
                        headAfter: headBefore,
                        evidenceBatches: trainingBatches.map(summarizeBatch),
                        patch: null,
                        patchReport: null,
                        gitDiff: '',
                        reflectionReasoning: '',
                        reflectionAnalysis: null,
                        candidateBatch: null,
                        error: null,
                    };

                    let refinement;
                    try {
                        refinement = normalizeRefinementResult(await this.skillRefiner({
                            model: reflectionModel,
                            suite,
                            evidenceBatches: trainingBatches,
                            currentSkill,
                            epoch,
                            step,
                            rejectedBuffer,
                            metaSkill,
                            editBudget,
                        }));
                    } catch (error) {
                        for (const batch of trainingBatches) {
                            pruneBatchWorkspaces(batch, null, 'reflection-failed');
                        }
                        stepRecord.status = 'reflection-failed';
                        stepRecord.reason = error?.infrastructureFailure
                            ? 'reflection-infrastructure-failure'
                            : 'invalid-reflection-output';
                        stepRecord.error = error instanceof Error ? error.message : String(error);
                        writeStepRecord(stepRecord);
                        throw error;
                    }
                    for (const batch of trainingBatches) {
                        pruneBatchWorkspaces(batch, null, 'training-evidence-consumed');
                    }
                    refinement.patch = selectPatchEdits(refinement.patch, editBudget);
                    stepRecord.patch = refinement.patch;
                    stepRecord.reflectionReasoning = refinement.modelReasoning;
                    stepRecord.reflectionAnalysis = refinement.analysis;
                    const applied = applyPatchWithReport(currentSkill, refinement.patch);
                    stepRecord.patchReport = applied.reports;

                    const rememberRejection = (reason, candidateSelectionScore = null) => {
                        if (!suite.optimizer.rejectedBuffer.enabled) return;
                        const entry = {
                            epoch,
                            step,
                            reason,
                            failurePatterns: refinement.failurePatterns,
                            edits: refinement.patch.edits,
                            incumbentSelectionScore: currentSelectionScore,
                            candidateSelectionScore,
                            scoreDelta: Number.isFinite(candidateSelectionScore)
                                ? candidateSelectionScore - currentSelectionScore
                                : null,
                        };
                        rejectedBuffer.push(entry);
                        if (rejectedBuffer.length > suite.optimizer.rejectedBuffer.maxEntries) {
                            rejectedBuffer.splice(
                                0,
                                rejectedBuffer.length - suite.optimizer.rejectedBuffer.maxEntries
                            );
                        }
                        rejectedHistory.push(entry);
                    };

                    if (!applied.changed) {
                        stepRecord.status = 'rejected';
                        stepRecord.reason = 'patch-made-no-change';
                        rememberRejection(stepRecord.reason);
                        writeStepRecord(stepRecord);
                        epochHistory.push(stepRecord);
                        continue;
                    }

                    let candidateSkill;
                    try {
                        candidateSkill = validateCandidateSkill(applied.skill);
                    } catch (error) {
                        stepRecord.status = 'reflection-failed';
                        stepRecord.reason = 'invalid-patched-skill';
                        stepRecord.error = error instanceof Error ? error.message : String(error);
                        writeStepRecord(stepRecord);
                        throw error;
                    }
                    if (candidateSkill === currentSkill) {
                        stepRecord.status = 'rejected';
                        stepRecord.reason = 'patch-normalized-to-no-change';
                        rememberRejection(stepRecord.reason);
                        writeStepRecord(stepRecord);
                        epochHistory.push(stepRecord);
                        continue;
                    }

                    skillStore.write(candidateSkill);
                    stepRecord.gitDiff = await skillStore.diff();
                    const candidateBatch = await evaluateSelection({
                        id: batchIdFor(epoch, step, 'selection'),
                        phase: 'selection-candidate',
                        epoch,
                        step,
                        skill: candidateSkill,
                    });
                    stepRecord.candidateBatch = summarizeBatch(candidateBatch);

                    if (!candidateBatch.valid) {
                        await skillStore.restore();
                        pruneBatchWorkspaces(candidateBatch, null, 'candidate-invalid');
                        stepRecord.status = 'invalid';
                        stepRecord.reason = candidateBatch.infrastructureFailures.length > 0
                            ? 'candidate-selection-infrastructure-failure'
                            : 'candidate-selection-missing-reward';
                        stepRecord.headAfter = await skillStore.head();
                    } else if (candidateBatch.meanScore > currentSelectionScore) {
                        const headAfter = await skillStore.accept({
                            epoch,
                            step,
                            score: candidateBatch.meanScore,
                        });
                        pruneBatchWorkspaces(
                            incumbentSelectionBatch,
                            null,
                            'superseded-selection-incumbent'
                        );
                        currentSkill = candidateSkill;
                        currentSelectionScore = candidateBatch.meanScore;
                        incumbentSelectionBatch = candidateBatch;
                        run.acceptedSteps += 1;
                        stepRecord.status = 'accepted';
                        stepRecord.reason = 'selection-score-strictly-improved';
                        stepRecord.accepted = true;
                        stepRecord.candidateSelectionScore = candidateBatch.meanScore;
                        stepRecord.headAfter = headAfter;
                    } else {
                        await skillStore.restore();
                        pruneBatchWorkspaces(candidateBatch, null, 'candidate-rejected');
                        stepRecord.status = 'rejected';
                        stepRecord.reason = candidateBatch.meanScore === currentSelectionScore
                            ? 'selection-score-tied'
                            : 'selection-score-regressed';
                        stepRecord.candidateSelectionScore = candidateBatch.meanScore;
                        stepRecord.headAfter = await skillStore.head();
                        rememberRejection(stepRecord.reason, candidateBatch.meanScore);
                    }
                    writeStepRecord(stepRecord);
                    epochHistory.push(stepRecord);
                }

                if (epoch >= 2 && suite.optimizer.slowUpdate.enabled) {
                    const sample = deterministicShuffle(
                        suite.dataset.train,
                        suite.optimizer.shuffleSeed,
                        epoch,
                        'slow-update'
                    ).slice(0, Math.min(suite.optimizer.slowUpdate.sampleSize, suite.dataset.train.length));
                    const previousBatch = assertValidBatch(await runBatch({
                        id: `epoch-${String(epoch).padStart(3, '0')}-slow-previous`,
                        phase: 'slow-previous',
                        items: sample,
                        epoch,
                        step: 'slow',
                        skill: previousEpochEndSkill,
                    }), 'Slow-update previous-skill');
                    const currentBatch = assertValidBatch(await runBatch({
                        id: `epoch-${String(epoch).padStart(3, '0')}-slow-current`,
                        phase: 'slow-current',
                        items: sample,
                        epoch,
                        step: 'slow',
                        skill: currentSkill,
                    }), 'Slow-update current-skill');
                    const slow = await this.slowUpdater({
                        model: reflectionModel,
                        suite,
                        epoch,
                        previousSkill: previousEpochEndSkill,
                        currentSkill,
                        previousBatch,
                        currentBatch,
                        metaSkill,
                    });
                    pruneBatchWorkspaces(previousBatch, null, 'slow-update-evidence-consumed');
                    pruneBatchWorkspaces(currentBatch, null, 'slow-update-evidence-consumed');
                    const headBefore = await skillStore.head();
                    const slowRecord = {
                        schemaVersion: 3,
                        recordType: 'skill-refinement-slow-update',
                        epoch,
                        step: 'slow',
                        status: 'generated',
                        startedAt: new Date().toISOString(),
                        incumbentSelectionScore: currentSelectionScore,
                        candidateSelectionScore: null,
                        accepted: false,
                        reason: null,
                        headBefore,
                        headAfter: headBefore,
                        comparison: slow.comparison,
                        guidance: slow.content,
                        reflectionReasoning: slow.modelReasoning || slow.reasoning || '',
                        candidateBatch: null,
                    };
                    const slowCandidate = validateCandidateSkill(replaceSlowUpdate(currentSkill, slow.content));
                    if (slowCandidate === currentSkill) {
                        slowRecord.status = 'rejected';
                        slowRecord.reason = 'slow-update-made-no-change';
                    } else {
                        skillStore.write(slowCandidate);
                        const validation = await evaluateSelection({
                            id: `epoch-${String(epoch).padStart(3, '0')}-slow-selection`,
                            phase: 'selection-slow-update',
                            epoch,
                            step: 'slow',
                            skill: slowCandidate,
                        });
                        slowRecord.candidateBatch = summarizeBatch(validation);
                        slowRecord.candidateSelectionScore = validation.meanScore;
                        if (!validation.valid) {
                            await skillStore.restore();
                            pruneBatchWorkspaces(validation, null, 'slow-update-invalid');
                            slowRecord.status = 'invalid';
                            slowRecord.reason = 'slow-update-selection-invalid';
                        } else if (validation.meanScore > currentSelectionScore) {
                            const headAfter = await skillStore.accept({
                                epoch,
                                step: 'slow',
                                score: validation.meanScore,
                            });
                            pruneBatchWorkspaces(
                                incumbentSelectionBatch,
                                null,
                                'superseded-selection-incumbent'
                            );
                            currentSkill = slowCandidate;
                            currentSelectionScore = validation.meanScore;
                            incumbentSelectionBatch = validation;
                            run.acceptedSteps += 1;
                            slowRecord.status = 'accepted';
                            slowRecord.reason = 'slow-update-selection-score-strictly-improved';
                            slowRecord.accepted = true;
                            slowRecord.headAfter = headAfter;
                        } else {
                            await skillStore.restore();
                            pruneBatchWorkspaces(validation, null, 'slow-update-rejected');
                            slowRecord.status = 'rejected';
                            slowRecord.reason = validation.meanScore === currentSelectionScore
                                ? 'slow-update-selection-score-tied'
                                : 'slow-update-selection-score-regressed';
                            const entry = {
                                epoch,
                                step: 'slow',
                                reason: slowRecord.reason,
                                failurePatterns: [],
                                edits: [{ updateTarget: 'SLOW_UPDATE', content: slow.content }],
                                incumbentSelectionScore: currentSelectionScore,
                                candidateSelectionScore: validation.meanScore,
                                scoreDelta: validation.meanScore - currentSelectionScore,
                            };
                            rejectedBuffer.push(entry);
                            rejectedHistory.push(entry);
                        }
                    }
                    writeStepRecord(slowRecord);
                    epochHistory.push(slowRecord);
                }

                if (epoch >= 2 && suite.optimizer.metaUpdate.enabled) {
                    const meta = await this.metaUpdater({
                        model: reflectionModel,
                        suite,
                        epoch,
                        metaSkill,
                        history: epochHistory.map(item => ({
                            step: item.step,
                            status: item.status,
                            reason: item.reason,
                            incumbentSelectionScore: item.incumbentSelectionScore,
                            candidateSelectionScore: item.candidateSelectionScore,
                            patch: item.patch || null,
                        })),
                        rejectedBuffer,
                    });
                    metaSkill = meta.content;
                }
                previousEpochEndSkill = currentSkill;
                optimizerStatePath = this.artifacts.writeOptimizerState(artifactRoot, {
                    schemaVersion: 1,
                    epoch,
                    currentSkillSha256: skillHash(currentSkill),
                    currentSelectionScore,
                    selectionScoreCache: Object.fromEntries(
                        [...selectionCache].map(([hash, entry]) => [hash, entry.meanScore])
                    ),
                    rejectedBuffer,
                    metaSkill,
                });
            }

            const testBatch = assertValidBatch(await runBatch({
                id: 'test-final',
                phase: 'test-final',
                items: suite.dataset.test,
                skill: currentSkill,
            }), 'Held-out test');
            cleanedTrajectories = trajectoryJournal.clean();
            const candidateSkillPath = this.artifacts.writeCandidate(artifactRoot, currentSkill);
            versionExport = await skillStore.exportHistory();

            pruneBatchWorkspaces(incumbentSelectionBatch, null, 'selection-finished');
            if (sandboxSnapshot && typeof this.rollouts.disposeSnapshot === 'function') {
                await this.rollouts.disposeSnapshot(sandboxSnapshot);
                sandboxSnapshot = null;
            }
            skillStore.dispose();

            const bestRollout = testBatch.ranking[0] || null;
            run.status = 'completed';
            run.bestTestRolloutId = bestRollout?.id || null;
            run.selectionScore = currentSelectionScore;
            run.testScore = testBatch.meanScore;
            run.candidateSkillPath = candidateSkillPath;
            run.cleanedTrajectoryPath = cleanedTrajectories.path;
            run.finishedAt = new Date().toISOString();

            const result = {
                schemaVersion: RESULT_SCHEMA_VERSION,
                run: summarizeRun(run),
                suite: {
                    id: suite.id,
                    sourceSkillPath: suite.skillPath,
                    templateModel: suite.templateModel,
                    reflectionModel: suite.reflectionModel,
                    dataset: {
                        train: suite.dataset.train.length,
                        selection: suite.dataset.selection.length,
                        test: suite.dataset.test.length,
                    },
                    optimizer: suite.optimizer,
                    evaluationCommand: suite.evaluation.command,
                    protectedPaths: [...suite.protectedPaths],
                },
                models: modelSummary,
                snapshot,
                baselineSelection: summarizeBatch(baselineSelection),
                final: {
                    selectionScore: currentSelectionScore,
                    testScore: testBatch.meanScore,
                    acceptedSteps: run.acceptedSteps,
                    skillSha256: skillHash(currentSkill),
                    verifiedSelectionBatch: summarizeBatch(incumbentSelectionBatch),
                    heldOutTestBatch: summarizeBatch(testBatch),
                },
                bestTestRollout: bestRollout ? {
                    rolloutId: bestRollout.id,
                    taskId: bestRollout.taskId,
                    score: bestRollout.score,
                    workspace: bestRollout.workspace,
                    evaluation: bestRollout.evaluation,
                    diff: bestRollout.diff,
                    reply: bestRollout.reply,
                } : null,
                testRanking: testBatch.ranking.map(item => ({
                    rolloutId: item.id,
                    taskId: item.taskId,
                    score: item.score,
                    success: item.success,
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
                    editBudget: item.editBudget ?? null,
                    incumbentSelectionScore: item.incumbentSelectionScore,
                    candidateSelectionScore: item.candidateSelectionScore,
                    recordPath: item.recordPath,
                })),
                candidateSkill: {
                    path: candidateSkillPath,
                    content: currentSkill,
                    verified: true,
                },
                optimizerState: {
                    path: optimizerStatePath,
                    metaSkill,
                    selectionCacheSize: selectionCache.size,
                    rejectedSteps: rejectedHistory.length,
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
                    // A failed run can still retain non-Git trajectory artifacts.
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
                schemaVersion: RESULT_SCHEMA_VERSION,
                run: summarizeRun(run),
                rawTrajectoryPath: trajectoryJournal.rawPath,
                cleanedTrajectoryPath: cleanedTrajectories?.path || null,
                transportAttemptsPath: trajectoryJournal.transportPath,
                excludedAttemptsPath: trajectoryJournal.exclusionsPath,
                rolloutRecordsPath: run.rolloutRecordsPath,
                workspaceRetentionPath: path.join(artifactRoot, 'workspace-retention.jsonl'),
                optimizerStatePath,
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
};

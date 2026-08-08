const crypto = require('node:crypto');
const { loadSuite, listSuites } = require('./suite');
const { refineSkill } = require('./refiner');
const { resolveRefinementModels } = require('./models');
const { copySnapshot } = require('./workspace');
const { rankRollouts, summarizeRun } = require('./ranking');

function validateCandidateSkill(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Skill refiner returned an empty candidate');
    }
    const candidate = value.trim();
    if (candidate.length > 64000) throw new Error('Refined Skill exceeds 64000 characters');
    return candidate;
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
        this.skillRefiner = dependencies.skillRefiner || refineSkill;
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
        const snapshot = copySnapshot(suite.baseline, baseline);
        const run = {
            id: runId,
            suiteId: suite.id,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            rolloutCount: suite.rollouts,
            bestRolloutId: null,
            bestScore: null,
            artifactRoot,
            candidateSkillPath: null,
            rawTrajectoryPath: null,
            models: modelSummary,
            error: null,
        };

        try {
            const rollouts = await Promise.all(
                Array.from({ length: suite.rollouts }, (_, index) => this.rollouts.run({
                    runId,
                    rolloutIndex: index,
                    suite,
                    artifactRoot,
                    baseline,
                    templateModel: models.template.model,
                }))
            );
            const ranking = [...rollouts].sort(rankRollouts);
            const best = ranking[0] || null;
            const rawTrajectoryRecords = rollouts.map(rollout => ({
                schemaVersion: 1,
                recordType: 'skill-refinement-rollout',
                id: rollout.id,
                runId,
                suiteId: suite.id,
                startedAt: rollout.startedAt || null,
                finishedAt: rollout.finishedAt || null,
                task: suite.task,
                skill: suite.skill,
                models: modelSummary,
                messages: rollout.messages,
                finalReply: rollout.reply,
                agentError: rollout.agentError,
                evaluation: rollout.evaluation,
                protectedPathViolations: rollout.protectedPathViolations,
                diff: rollout.diff,
                reward: rollout.score,
            }));
            const rawTrajectoryPath = this.artifacts.writeRawTrajectories(
                artifactRoot,
                rawTrajectoryRecords
            );
            run.rawTrajectoryPath = rawTrajectoryPath;
            const candidateSkill = validateCandidateSkill(await this.skillRefiner({
                model: models.reflection.model,
                suite,
                rollouts: ranking,
            }));
            const candidateSkillPath = this.artifacts.writeCandidate(artifactRoot, candidateSkill);

            run.status = 'completed';
            run.bestRolloutId = best ? best.id : null;
            run.bestScore = best ? best.score : null;
            run.candidateSkillPath = candidateSkillPath;
            run.finishedAt = new Date().toISOString();

            const result = {
                schemaVersion: 1,
                run: summarizeRun(run),
                suite: {
                    id: suite.id,
                    task: suite.task,
                    sourceSkillPath: suite.skillPath,
                    templateModel: suite.templateModel,
                    reflectionModel: suite.reflectionModel,
                    evaluationCommand: suite.evaluation.command,
                    protectedPaths: [...suite.protectedPaths],
                },
                models: modelSummary,
                snapshot,
                best: best ? {
                    rolloutId: best.id,
                    score: best.score,
                    workspace: best.workspace,
                    evaluation: best.evaluation,
                    diff: best.diff,
                    reply: best.reply,
                } : null,
                ranking: ranking.map(item => ({
                    rolloutId: item.id,
                    score: item.score,
                    evaluationPassed: item.evaluation.ok,
                    protectedPathViolations: item.protectedPathViolations,
                    changedFiles: item.diff.fileCount,
                    changedBytes: item.diff.changedBytes,
                })),
                candidateSkill: { path: candidateSkillPath, content: candidateSkill },
                rawTrajectoryPath,
                evidencePath: rawTrajectoryPath,
            };
            this.artifacts.writeResult(artifactRoot, result);
            return result;
        } catch (error) {
            run.status = 'failed';
            run.error = error.message;
            run.finishedAt = new Date().toISOString();
            this.artifacts.writeResult(artifactRoot, {
                schemaVersion: 1,
                run: summarizeRun(run),
            });
            throw error;
        }
    }

}

module.exports = { SkillRefinementOrchestrator, validateCandidateSkill };

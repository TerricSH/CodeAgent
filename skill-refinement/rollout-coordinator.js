const path = require('node:path');
const { runSkillRollout } = require('./rollout-runner');
const { copySnapshot, diffTrees, protectedViolations } = require('./workspace');
const { refinementScore } = require('./ranking');

class RolloutCoordinator {
    constructor(dependencies = {}) {
        if (!dependencies.evaluator) throw new Error('Rollout evaluator is required');
        if (!dependencies.artifacts) throw new Error('Rollout artifact repository is required');
        this.evaluator = dependencies.evaluator;
        this.artifacts = dependencies.artifacts;
        this.rolloutExecutor = dependencies.rolloutExecutor || runSkillRollout;
    }

    async run({ runId, rolloutIndex, suite, artifactRoot, baseline, templateModel }) {
        const id = `rollout-${String(rolloutIndex + 1).padStart(3, '0')}`;
        const startedAt = new Date().toISOString();
        const workspace = path.join(artifactRoot, 'rollouts', id, 'workspace');
        copySnapshot(baseline, workspace);

        let reply = '';
        let messages = [];
        let agentError = null;
        try {
            const outcome = await this.rolloutExecutor({
                model: templateModel,
                suite,
                runId,
                rolloutId: id,
                workspace,
                executeCommand: commandArgs => this.evaluator.execute(
                    commandArgs,
                    workspace,
                    { runId, rolloutId: id, purpose: 'skill-refinement-work' }
                ),
            });
            reply = outcome && outcome.reply ? String(outcome.reply) : '';
            messages = outcome && Array.isArray(outcome.messages) ? outcome.messages : [];
        } catch (error) {
            agentError = error.message;
        }

        const violations = protectedViolations(baseline, workspace, suite.protectedPaths);
        const evaluation = violations.length > 0
            ? {
                ok: false,
                exitCode: null,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                truncated: false,
                error: `Protected paths changed: ${violations.join(', ')}`,
                errorCode: 'PROTECTED_PATH_CHANGED',
                durationMs: 0,
                purpose: 'skill-refinement-evaluation',
                runId,
                rolloutId: id,
            }
            : await this.evaluator.execute(
                { command: suite.evaluation.command, timeoutMs: suite.evaluation.timeoutMs },
                workspace,
                { runId, rolloutId: id, purpose: 'skill-refinement-evaluation' }
            );
        const diff = diffTrees(baseline, workspace);
        const record = {
            id,
            runId,
            startedAt,
            finishedAt: new Date().toISOString(),
            workspace,
            reply,
            messages,
            agentError,
            evaluation,
            protectedPathViolations: violations,
            diff,
            score: refinementScore(evaluation, violations),
        };
        this.artifacts.writeRollout(artifactRoot, id, record);
        return record;
    }
}

module.exports = { RolloutCoordinator };

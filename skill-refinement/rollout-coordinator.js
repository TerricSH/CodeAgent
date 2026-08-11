const path = require('node:path');
const { runSkillRollout } = require('./rollout-runner');
const { copySnapshot, diffTrees, protectedViolations } = require('./workspace');
const { refinementOutcome } = require('./ranking');

const INFRASTRUCTURE_FAILURES = new Set(['oom', 'timeout', 'infrastructure']);

function infrastructureEvaluation(failures, runId, rolloutId) {
    const first = failures[0] || {};
    return {
        ok: false,
        exitCode: first.exitCode ?? null,
        signal: first.signal || null,
        timedOut: Boolean(first.timedOut),
        stdout: first.stdout || '',
        stderr: first.stderr || '',
        truncated: Boolean(first.truncated),
        error: first.error || `Sandbox infrastructure failure: ${first.failureType || 'unknown'}`,
        errorCode: first.errorCode
            || `SANDBOX_${String(first.failureType || 'infrastructure').toUpperCase()}`,
        failureType: first.failureType || 'infrastructure',
        durationMs: first.durationMs || 0,
        purpose: 'skill-refinement-infrastructure',
        runId,
        rolloutId,
    };
}

function localRolloutId(index) {
    return `rollout-${String(index + 1).padStart(3, '0')}`;
}

function isInfrastructureResult(result) {
    if (!result) return true;
    if (INFRASTRUCTURE_FAILURES.has(result.failureType)) return true;
    return Boolean(result.timedOut || (result.error && result.exitCode === null));
}

function isInfrastructureError(error) {
    if (error?.infrastructureFailure) return true;
    const code = String(error?.code || '');
    return code.startsWith('SANDBOX_')
        || /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENET|UND_ERR_)/.test(code);
}

function normalizedEvaluation(result = {}) {
    const failureType = result.failureType
        || (result.timedOut ? 'timeout' : (result.error && result.exitCode === null
            ? 'infrastructure'
            : (result.exitCode === 0 ? 'success' : 'task')));
    return {
        ok: result.ok === true || (result.exitCode === 0 && !result.error),
        ...result,
        failureType,
    };
}

function attemptWorkspace(artifactRoot, batchId, rolloutId, attempt) {
    return path.join(
        artifactRoot,
        'batches',
        batchId,
        'rollouts',
        rolloutId,
        'attempts',
        `attempt-${String(attempt).padStart(3, '0')}`,
        'workspace'
    );
}

class RolloutCoordinator {
    constructor(dependencies = {}) {
        if (!dependencies.evaluator) throw new Error('Rollout evaluator is required');
        if (!dependencies.artifacts) throw new Error('Rollout artifact repository is required');
        this.evaluator = dependencies.evaluator;
        this.artifacts = dependencies.artifacts;
        this.rolloutExecutor = dependencies.rolloutExecutor || runSkillRollout;
        this.nativeSandbox = !dependencies.rolloutExecutor;
    }

    prepareSnapshot(source, snapshotId) {
        if (!this.nativeSandbox) return null;
        return this.evaluator.prepareSnapshot(source, snapshotId);
    }

    disposeSnapshot(snapshot) {
        if (!snapshot || !this.nativeSandbox) return null;
        return this.evaluator.disposeSnapshot(snapshot);
    }

    async run(options) {
        if (typeof options.batchId !== 'string' || !options.batchId) {
            throw new Error('Skill Refinement rollout requires batchId');
        }
        if (typeof options.phase !== 'string' || !options.phase) {
            throw new Error('Skill Refinement rollout requires phase');
        }
        const id = localRolloutId(options.rolloutIndex);
        const attempts = [];
        let last = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                last = this.nativeSandbox
                    ? await this._runLeaseAttempt({ ...options, id, attempt })
                    : await this._runInjectedAttempt({ ...options, id, attempt });
            } catch (error) {
                if (!isInfrastructureError(error)) throw error;
                last = this._unexpectedInfrastructureFailure({
                    ...options,
                    id,
                    attempt,
                    error,
                });
            }
            attempts.push({ ...last });
            if (!last.infrastructureFailure) break;
            options.trajectoryJournal?.excludeAttempt(last.attemptKey, {
                runId: options.runId,
                batchId: options.batchId,
                rolloutId: id,
                attempt,
                error: last.evaluation?.error || null,
                errorCode: last.evaluation?.errorCode || null,
            });
        }
        last.attempts = attempts;
        this.artifacts.writeRollout(
            options.artifactRoot,
            id,
            last,
            options.batchId
        );
        return last;
    }

    _attemptContext(options, id, attempt) {
        const batchId = options.batchId;
        return {
            runId: options.runId,
            suiteId: options.suite.id,
            batchId,
            phase: options.phase,
            epoch: options.epoch ?? null,
            step: options.step ?? null,
            split: options.suite.taskItem?.split || null,
            taskId: options.suite.taskItem?.id || null,
            rolloutId: id,
            rolloutAttempt: attempt,
            attemptKey: `${options.runId}:${batchId}:${id}:${attempt}`,
        };
    }

    _unexpectedInfrastructureFailure(options) {
        const context = this._attemptContext(options, options.id, options.attempt);
        const failure = {
            failureType: 'infrastructure',
            error: options.error instanceof Error
                ? options.error.message
                : String(options.error),
            errorCode: options.error?.code || 'SANDBOX_ATTEMPT_FAILED',
        };
        return {
            id: options.id,
            runId: options.runId,
            batchId: options.batchId,
            phase: options.phase,
            epoch: options.epoch ?? null,
            step: options.step ?? null,
            split: context.split,
            taskId: context.taskId,
            attempt: options.attempt,
            attemptKey: context.attemptKey,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            workspace: null,
            reply: '',
            messages: [],
            agentError: failure.error,
            evaluation: infrastructureEvaluation([failure], options.runId, options.id),
            protectedPathViolations: [],
            diff: { files: [], fileCount: 0, changedBytes: 0 },
            infrastructureFailure: true,
            score: null,
            success: null,
        };
    }

    async _runLeaseAttempt(options) {
        const {
            runId,
            suite,
            artifactRoot,
            baseline,
            snapshot,
            templateModel,
            trajectoryJournal,
            id,
            attempt,
        } = options;
        if (!snapshot) throw new Error('Native Skill Refinement rollout requires a sandbox snapshot');
        const context = this._attemptContext(options, id, attempt);
        const startedAt = new Date().toISOString();
        const workspace = attemptWorkspace(artifactRoot, context.batchId, id, attempt);
        const lease = await this.evaluator.acquire(snapshot, context);
        const infrastructureFailures = [];
        let reply = '';
        let messages = [];
        let agentError = null;
        let evaluation = null;

        const execute = async (commandArgs, purpose) => {
            const result = normalizedEvaluation(await this.evaluator.execute(commandArgs, lease, {
                ...context,
                purpose,
            }));
            if (isInfrastructureResult(result)) infrastructureFailures.push(result);
            return result;
        };

        try {
            try {
                const outcome = await this.rolloutExecutor({
                    model: templateModel,
                    suite,
                    runId,
                    rolloutId: id,
                    executeCommand: commandArgs => execute(
                        commandArgs,
                        'skill-refinement-work'
                    ),
                    trajectoryJournal,
                    trajectoryContext: context,
                });
                reply = outcome?.reply ? String(outcome.reply) : '';
                messages = Array.isArray(outcome?.messages) ? outcome.messages : [];
            } catch (error) {
                agentError = error instanceof Error ? error.message : String(error);
                if (error?.infrastructureFailure) {
                    infrastructureFailures.push({
                        failureType: 'infrastructure',
                        error: agentError,
                        errorCode: error.code || null,
                    });
                }
            }

            await lease.exportWorkspace(workspace);
            const violations = infrastructureFailures.length > 0
                ? []
                : protectedViolations(baseline, workspace, suite.protectedPaths);
            if (infrastructureFailures.length > 0) {
                evaluation = infrastructureEvaluation(infrastructureFailures, runId, id);
            } else if (violations.length > 0) {
                evaluation = this._protectedEvaluation(violations, context);
            } else {
                evaluation = await execute(
                    { command: suite.evaluation.command, timeoutMs: suite.evaluation.timeoutMs },
                    'skill-refinement-evaluation'
                );
                if (infrastructureFailures.length > 0) {
                    evaluation = infrastructureEvaluation(infrastructureFailures, runId, id);
                }
            }
            const infrastructureFailure = infrastructureFailures.length > 0;
            let outcome = null;
            if (!infrastructureFailure) {
                try {
                    outcome = refinementOutcome(
                        evaluation,
                        violations,
                        suite.evaluation.reward
                    );
                } catch (error) {
                    evaluation = {
                        ...evaluation,
                        rewardError: error instanceof Error ? error.message : String(error),
                    };
                }
            }
            const diff = diffTrees(baseline, workspace);
            return {
                id,
                runId,
                batchId: context.batchId,
                phase: context.phase,
                epoch: context.epoch,
                step: context.step,
                split: context.split,
                taskId: context.taskId,
                attempt,
                attemptKey: context.attemptKey,
                startedAt,
                finishedAt: new Date().toISOString(),
                workspace,
                reply,
                messages,
                agentError,
                evaluation,
                protectedPathViolations: violations,
                diff,
                infrastructureFailure,
                score: outcome?.reward ?? null,
                success: outcome?.success ?? null,
            };
        } finally {
            await lease.dispose();
        }
    }

    async _runInjectedAttempt(options) {
        const {
            runId,
            suite,
            artifactRoot,
            baseline,
            templateModel,
            trajectoryJournal,
            id,
            attempt,
        } = options;
        const context = this._attemptContext(options, id, attempt);
        const startedAt = new Date().toISOString();
        const workspace = attemptWorkspace(artifactRoot, context.batchId, id, attempt);
        copySnapshot(baseline, workspace);
        const infrastructureFailures = [];
        let reply = '';
        let messages = [];
        let agentError = null;

        const execute = async commandArgs => {
            const result = normalizedEvaluation(await this.evaluator.execute(
                commandArgs,
                { exec: args => this.evaluator.client.run(args) },
                { ...context, purpose: 'skill-refinement-work' }
            ));
            if (isInfrastructureResult(result)) infrastructureFailures.push(result);
            return result;
        };

        try {
            const outcome = await this.rolloutExecutor({
                model: templateModel,
                suite,
                runId,
                rolloutId: id,
                workspace,
                executeCommand: execute,
                trajectoryJournal,
                trajectoryContext: context,
            });
            reply = outcome?.reply ? String(outcome.reply) : '';
            messages = Array.isArray(outcome?.messages) ? outcome.messages : [];
        } catch (error) {
            agentError = error instanceof Error ? error.message : String(error);
            if (error?.infrastructureFailure) {
                infrastructureFailures.push({
                    failureType: 'infrastructure',
                    error: agentError,
                    errorCode: error.code || null,
                });
            }
        }

        const violations = infrastructureFailures.length > 0
            ? []
            : protectedViolations(baseline, workspace, suite.protectedPaths);
        let evaluation;
        if (infrastructureFailures.length > 0) {
            evaluation = infrastructureEvaluation(infrastructureFailures, runId, id);
        } else if (violations.length > 0) {
            evaluation = this._protectedEvaluation(violations, context);
        } else {
            evaluation = normalizedEvaluation(await this.evaluator.client.run([
                '/bin/sh', '-lc', suite.evaluation.command,
            ], { timeoutMs: suite.evaluation.timeoutMs }));
            if (isInfrastructureResult(evaluation)) infrastructureFailures.push(evaluation);
            if (infrastructureFailures.length > 0) {
                evaluation = infrastructureEvaluation(infrastructureFailures, runId, id);
            }
        }
        const infrastructureFailure = infrastructureFailures.length > 0;
        let outcome = null;
        if (!infrastructureFailure) {
            try {
                outcome = refinementOutcome(
                    evaluation,
                    violations,
                    suite.evaluation.reward
                );
            } catch (error) {
                evaluation = {
                    ...evaluation,
                    rewardError: error instanceof Error ? error.message : String(error),
                };
            }
        }
        const diff = diffTrees(baseline, workspace);
        return {
            id,
            runId,
            batchId: context.batchId,
            phase: context.phase,
            epoch: context.epoch,
            step: context.step,
            split: context.split,
            taskId: context.taskId,
            attempt,
            attemptKey: context.attemptKey,
            startedAt,
            finishedAt: new Date().toISOString(),
            workspace,
            reply,
            messages,
            agentError,
            evaluation,
            protectedPathViolations: violations,
            diff,
            infrastructureFailure,
            score: outcome?.reward ?? null,
            success: outcome?.success ?? null,
        };
    }

    _protectedEvaluation(violations, context) {
        return {
            ok: false,
            exitCode: null,
            signal: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            truncated: false,
            error: `Protected paths changed: ${violations.join(', ')}`,
            errorCode: 'PROTECTED_PATH_CHANGED',
            failureType: 'task',
            durationMs: 0,
            purpose: 'skill-refinement-evaluation',
            ...context,
        };
    }
}

module.exports = {
    RolloutCoordinator,
};

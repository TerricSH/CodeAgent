function fieldValue(value, field) {
    if (!field) return value;
    return String(field).split('.').reduce((current, segment) => (
        current && typeof current === 'object' ? current[segment] : undefined
    ), value);
}

function parseRewardPayload(stdout) {
    const text = String(stdout || '').trim();
    if (!text) throw new Error('Evaluation stdout did not contain a JSON reward');
    const candidates = [text, ...text.split(/\r?\n/).reverse().filter(line => line.trim())];
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // A verifier may log before printing one final JSON reward line.
        }
    }
    throw new Error('Evaluation stdout did not contain valid JSON reward output');
}

function assertReward(value) {
    const reward = Number(value);
    if (!Number.isFinite(reward) || reward < 0 || reward > 1) {
        throw new Error(`Evaluation reward must be a finite number within [0, 1], received: ${value}`);
    }
    return reward;
}

function refinementOutcome(evaluation, violations = [], rewardConfig = {}) {
    const config = {
        mode: rewardConfig.mode || 'exit_code',
        field: rewardConfig.field || 'reward',
        successField: rewardConfig.successField || 'success',
        successThreshold: rewardConfig.successThreshold === undefined
            ? 1
            : Number(rewardConfig.successThreshold),
    };
    if (violations.length > 0) {
        return Object.freeze({ reward: 0, success: false, payload: null });
    }
    let payload = null;
    let rawReward;
    if (evaluation && evaluation.reward !== undefined) {
        rawReward = evaluation.reward;
        payload = evaluation;
    } else if (config.mode === 'stdout_json') {
        payload = parseRewardPayload(evaluation?.stdout);
        rawReward = fieldValue(payload, config.field);
    } else {
        rawReward = evaluation && evaluation.ok ? 1 : 0;
    }
    const reward = assertReward(rawReward);
    const explicitSuccess = evaluation && typeof evaluation.success === 'boolean'
        ? evaluation.success
        : fieldValue(payload, config.successField);
    const success = typeof explicitSuccess === 'boolean'
        ? explicitSuccess
        : reward >= config.successThreshold;
    return Object.freeze({ reward, success, payload });
}

function meanScore(rollouts) {
    if (!Array.isArray(rollouts) || rollouts.length === 0) return null;
    if (rollouts.some(rollout => !Number.isFinite(rollout.score))) return null;
    return rollouts.reduce((total, rollout) => total + rollout.score, 0) / rollouts.length;
}

function rankRollouts(left, right) {
    if (left.score !== right.score) return right.score - left.score;
    if (left.diff.changedBytes !== right.diff.changedBytes) {
        return left.diff.changedBytes - right.diff.changedBytes;
    }
    const leftDuration = left.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    const rightDuration = right.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    return `${left.taskId || ''}:${left.id}`.localeCompare(`${right.taskId || ''}:${right.id}`);
}

function editBudgetAt(config, position, totalPositions) {
    const initial = Number(config?.initial) || 1;
    const floor = Math.min(initial, Number(config?.floor) || 1);
    const total = Math.max(1, Number(totalPositions) || 1);
    const index = Math.min(Math.max(0, Number(position) || 0), total - 1);
    const progress = total <= 1 ? 0 : index / (total - 1);
    if (config?.schedule === 'constant' || config?.schedule === 'autonomous') return initial;
    const ratio = config?.schedule === 'linear'
        ? 1 - progress
        : (1 + Math.cos(Math.PI * progress)) / 2;
    return Math.max(floor, Math.min(initial, Math.round(floor + ((initial - floor) * ratio))));
}

function summarizeRun(run) {
    return {
        id: run.id,
        suiteId: run.suiteId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        rolloutCount: run.rolloutCount,
        acceptedSteps: run.acceptedSteps || 0,
        bestTestRolloutId: run.bestTestRolloutId || null,
        selectionScore: Number.isFinite(run.selectionScore) ? run.selectionScore : null,
        testScore: Number.isFinite(run.testScore) ? run.testScore : null,
        artifactRoot: run.artifactRoot,
        candidateSkillPath: run.candidateSkillPath || null,
        rawTrajectoryPath: run.rawTrajectoryPath || null,
        cleanedTrajectoryPath: run.cleanedTrajectoryPath || null,
        rolloutRecordsPath: run.rolloutRecordsPath || null,
        models: run.models || null,
        error: run.error || null,
    };
}

module.exports = {
    refinementOutcome,
    meanScore,
    rankRollouts,
    editBudgetAt,
    summarizeRun,
};

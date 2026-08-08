function refinementScore(evaluation, violations) {
    if (violations.length > 0) return -1;
    return evaluation && evaluation.ok ? 1 : 0;
}

function rankRollouts(left, right) {
    if (left.score !== right.score) return right.score - left.score;
    if (left.diff.changedBytes !== right.diff.changedBytes) {
        return left.diff.changedBytes - right.diff.changedBytes;
    }
    const leftDuration = left.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    const rightDuration = right.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    return left.id.localeCompare(right.id);
}

function summarizeRun(run) {
    return {
        id: run.id,
        suiteId: run.suiteId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        rolloutCount: run.rolloutCount,
        bestRolloutId: run.bestRolloutId || null,
        bestScore: Number.isFinite(run.bestScore) ? run.bestScore : null,
        artifactRoot: run.artifactRoot,
        candidateSkillPath: run.candidateSkillPath || null,
        rawTrajectoryPath: run.rawTrajectoryPath || null,
        models: run.models || null,
        error: run.error || null,
    };
}

module.exports = { refinementScore, rankRollouts, summarizeRun };

function rolloutSucceeded(trajectory) {
    return trajectory.outcome.status === 'succeeded';
}

function compareTrajectories(trajectories) {
    if (!Array.isArray(trajectories) || trajectories.length === 0) {
        throw new Error('At least one extracted trajectory is required');
    }

    const toolStats = new Map();
    const failures = new Map();
    let succeeded = 0;
    let failed = 0;
    let unknown = 0;

    for (const trajectory of trajectories) {
        if (trajectory.outcome.status === 'succeeded') succeeded += 1;
        else if (trajectory.outcome.status === 'failed') failed += 1;
        else unknown += 1;

        const seenTools = new Set();
        for (const span of trajectory.spans.filter(item => item.spanKind === 'tool')) {
            if (!toolStats.has(span.name)) {
                toolStats.set(span.name, {
                    toolName: span.name,
                    executions: 0,
                    ok: 0,
                    error: 0,
                    unknown: 0,
                    successfulRolloutIds: new Set(),
                    failedRolloutIds: new Set(),
                    evidenceSpanIds: [],
                });
            }
            const stats = toolStats.get(span.name);
            stats.executions += 1;
            stats[span.status.code] = (stats[span.status.code] || 0) + 1;
            if (stats.evidenceSpanIds.length < 20) stats.evidenceSpanIds.push(span.spanId);
            seenTools.add(span.name);
        }
        for (const name of seenTools) {
            const stats = toolStats.get(name);
            if (rolloutSucceeded(trajectory)) stats.successfulRolloutIds.add(trajectory.rolloutId);
            else if (trajectory.outcome.status === 'failed') stats.failedRolloutIds.add(trajectory.rolloutId);
        }

        for (const reason of trajectory.signals.failureReasons) {
            const key = `${reason.code}\n${reason.message}`;
            if (!failures.has(key)) {
                failures.set(key, {
                    code: reason.code,
                    message: reason.message,
                    count: 0,
                    rolloutIds: [],
                    evidenceSpanIds: [],
                });
            }
            const item = failures.get(key);
            item.count += 1;
            item.rolloutIds.push(trajectory.rolloutId);
            item.evidenceSpanIds.push(...(reason.evidenceSpanIds || []));
        }
    }

    const ranking = trajectories
        .map(item => ({
            rolloutId: item.rolloutId,
            reward: item.outcome.reward,
            status: item.outcome.status,
            toolCalls: item.summary.toolCalls,
            failedToolCalls: item.summary.failedToolCalls,
        }))
        .sort((left, right) => {
            const leftReward = Number.isFinite(left.reward) ? left.reward : Number.NEGATIVE_INFINITY;
            const rightReward = Number.isFinite(right.reward) ? right.reward : Number.NEGATIVE_INFINITY;
            return rightReward - leftReward || left.failedToolCalls - right.failedToolCalls;
        });

    return {
        rolloutCount: trajectories.length,
        outcomes: { succeeded, failed, unknown },
        ranking,
        toolAssociations: [...toolStats.values()]
            .map(item => ({
                ...item,
                successfulRolloutIds: [...item.successfulRolloutIds],
                failedRolloutIds: [...item.failedRolloutIds],
                note: 'Association only; this does not establish that the tool caused the outcome.',
            }))
            .sort((left, right) => right.executions - left.executions || left.toolName.localeCompare(right.toolName)),
        recurrentFailures: [...failures.values()]
            .map(item => ({
                ...item,
                rolloutIds: [...new Set(item.rolloutIds)],
                evidenceSpanIds: [...new Set(item.evidenceSpanIds)].slice(0, 50),
            }))
            .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    };
}

module.exports = { compareTrajectories };

function truncate(value, maxChars) {
    const text = value == null ? '' : String(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[truncated]`;
}

function createReflectionEvidence(rollouts) {
    if (!Array.isArray(rollouts)) throw new Error('Rollout evidence must be an array');
    return rollouts.map(rollout => ({
        id: rollout.id,
        score: rollout.score,
        agentError: rollout.agentError,
        evaluation: {
            ok: Boolean(rollout.evaluation?.ok),
            exitCode: rollout.evaluation?.exitCode ?? null,
            error: rollout.evaluation?.error || null,
            stdout: truncate(rollout.evaluation?.stdout, 2000),
            stderr: truncate(rollout.evaluation?.stderr, 2000),
        },
        protectedPathViolations: Array.isArray(rollout.protectedPathViolations)
            ? [...rollout.protectedPathViolations]
            : [],
        changedFiles: Array.isArray(rollout.diff?.files)
            ? rollout.diff.files.map(file => ({ path: file.path, status: file.status }))
            : [],
        finalReply: truncate(rollout.reply, 4000),
    }));
}

module.exports = { createReflectionEvidence, truncate };

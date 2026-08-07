function truncate(value, maxChars) {
    const text = value == null ? '' : String(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[truncated]`;
}

function stripMarkdownFence(value) {
    const text = String(value || '').trim();
    const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return (match ? match[1] : text).trim();
}

function refinementEvidence(rollouts) {
    return rollouts.map(rollout => ({
        id: rollout.id,
        score: rollout.score,
        agentError: rollout.agentError,
        evaluation: {
            ok: rollout.evaluation.ok,
            exitCode: rollout.evaluation.exitCode,
            error: rollout.evaluation.error,
            stdout: truncate(rollout.evaluation.stdout, 2000),
            stderr: truncate(rollout.evaluation.stderr, 2000),
        },
        protectedPathViolations: rollout.protectedPathViolations,
        changedFiles: rollout.diff.files.map(file => ({ path: file.path, status: file.status })),
        finalReply: truncate(rollout.reply, 4000),
    }));
}

async function refineSkill({ model, suite, rollouts }) {
    if (!model || typeof model.complete !== 'function') {
        throw new Error('Skill Refinement synthesis requires a model capability with complete()');
    }
    const evidence = refinementEvidence(rollouts);
    const result = await model.complete([
        {
            role: 'system',
            content: [
                'You refine reusable agent Skills from controlled rollout evidence.',
                'Return only the complete refined Skill in Markdown.',
                'Preserve useful constraints, correct instructions that caused failures, and avoid task-specific overfitting.',
                'Do not wrap the result in a code fence and do not add commentary outside the Skill.',
            ].join(' '),
        },
        {
            role: 'user',
            content: [
                '# Skill to refine',
                suite.skill,
                '',
                '# Evaluation task',
                suite.task,
                '',
                '# Scored rollout evidence',
                JSON.stringify(evidence, null, 2),
            ].join('\n'),
        },
    ]);
    const refined = stripMarkdownFence(result);
    if (!refined) throw new Error('Skill refiner returned an empty candidate');
    if (refined.length > 64000) throw new Error('Refined Skill exceeds 64000 characters');
    return refined;
}

module.exports = { refineSkill, refinementEvidence, stripMarkdownFence };

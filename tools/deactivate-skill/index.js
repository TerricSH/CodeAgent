const definition = {
    type: 'function',
    function: {
        name: 'deactivate_skill',
        description: 'Unload an unsuitable active Skill from the hot Context cache.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                reason: { type: 'string' },
            },
            required: ['name', 'reason'],
        },
    },
};

function handler({ name, reason }, context) {
    const entry = context.cache.entries.find(candidate =>
        candidate.kind === 'skill' && candidate.metadata?.skillName === name && candidate.resident
    );
    if (!entry) return { unloaded: false, name, reason: 'not-active' };
    context.evict(entry.id, `skill-unsuitable:${reason}`);
    if (context.auditWriter) {
        context.auditWriter.record({
            eventType: 'skill.unloaded',
            actor: 'skill',
            content: name,
            payload: { reason, cacheNodeId: entry.id },
        });
    }
    return { unloaded: true, name, reason };
}

module.exports = { definition, handler };

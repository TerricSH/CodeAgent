function messagesFromAudit(events = []) {
    const messages = [];
    const toolCallsSeen = new Set();
    for (const event of events) {
        if (event.eventType === 'dialogue.user') {
            messages.push({ role: 'user', content: event.content, created_at: event.createdAt });
            continue;
        }
        if (event.eventType === 'dialogue.assistant') {
            messages.push({ role: 'assistant', content: event.content, created_at: event.createdAt });
            continue;
        }
        if (event.eventType === 'model.tool_calls') {
            const calls = event.payload?.calls || event.payload?.toolCalls || [];
            const unseen = calls.filter(call => call && call.id && !toolCallsSeen.has(call.id));
            if (unseen.length === 0) continue;
            unseen.forEach(call => toolCallsSeen.add(call.id));
            messages.push({
                role: 'assistant',
                content: null,
                created_at: event.createdAt,
                tool_calls: unseen.map(call => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name || call.function?.name,
                        arguments: typeof call.arguments === 'string'
                            ? call.arguments
                            : JSON.stringify(call.arguments || {}),
                    },
                })),
            });
            continue;
        }
        if ((event.eventType === 'tool.result' || event.eventType === 'tool.failed') && event.spanId) {
            messages.push({
                role: 'tool',
                tool_call_id: event.spanId,
                content: event.content || '',
                created_at: event.createdAt,
                finished_at: event.createdAt,
            });
        }
    }
    return messages;
}

function parseSnapshot(event, options = {}) {
    const allowed = options.includeCompressed === false
        ? ['context.loaded', 'context.updated']
        : ['context.loaded', 'context.updated', 'context.compressed'];
    if (!event || !allowed.includes(event.eventType)) {
        return null;
    }
    try {
        const messages = JSON.parse(event.content || '[]');
        return Array.isArray(messages) ? messages : null;
    } catch {
        return null;
    }
}

function cacheEntriesFromAudit(events = [], checkpoint = null) {
    if (!checkpoint?.state?.nodes || !Array.isArray(checkpoint.state.nodes)) return null;
    const snapshots = new Map();
    for (const event of events) {
        const nodeId = event.payload?.cacheNodeId;
        const messages = parseSnapshot(event);
        if (nodeId && messages) snapshots.set(nodeId, messages);
    }
    return checkpoint.state.nodes.map(node => ({
        ...node,
        messages: node.resident ? (snapshots.get(node.id) || []) : [],
    }));
}

function cacheNodeMessages(events = [], nodeId, options = {}) {
    let latest = null;
    for (const event of events) {
        if (event.payload?.cacheNodeId !== nodeId) continue;
        const snapshot = parseSnapshot(event, {
            includeCompressed: options.preferFull !== true,
        });
        if (snapshot) latest = snapshot;
    }
    return latest;
}

module.exports = { messagesFromAudit, cacheEntriesFromAudit, cacheNodeMessages };

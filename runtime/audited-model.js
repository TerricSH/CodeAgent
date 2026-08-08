function safeError(error) {
    return { error: error instanceof Error ? error.message : String(error), code: error?.code || null };
}

function createAuditedModelCapability(model, getAuditWriter, options = {}) {
    if (!model || typeof model.chat !== 'function') return null;
    const info = () => typeof model.info === 'function'
        ? model.info() || {}
        : { model: model.model || null, maxContextTokens: model.maxContextTokens || null };

    async function* chat(messages, chatOptions = {}) {
        const writer = typeof getAuditWriter === 'function' ? getAuditWriter() : null;
        const spanId = globalThis.crypto.randomUUID();
        const profile = info();
        if (writer) {
            writer.record({
                eventType: 'model.system_prompt',
                actor: options.actor || 'auxiliary-model',
                spanId,
                parentSpanId: writer.activeTraceId,
                content: messages[0]?.role === 'system' ? messages[0].content : '',
                forceBlob: true,
                indexable: false,
            });
            writer.record({
                eventType: 'model.tool_schema',
                actor: options.actor || 'auxiliary-model',
                spanId,
                parentSpanId: writer.activeTraceId,
                content: JSON.stringify(chatOptions.tools || []),
                forceBlob: true,
                indexable: false,
            });
            writer.record({
                eventType: 'model.request',
                actor: options.actor || 'auxiliary-model',
                spanId,
                parentSpanId: writer.activeTraceId,
                content: JSON.stringify({ messages, tools: chatOptions.tools || [] }),
                payload: {
                    auxiliary: true,
                    purpose: chatOptions.purpose || options.purpose || null,
                    profile: {
                        ref: profile.ref || null,
                        model: profile.model || null,
                        maxContextTokens: profile.maxContextTokens || null,
                        maxOutputTokens: profile.maxOutputTokens || null,
                    },
                },
                forceBlob: true,
                indexable: false,
            });
        }
        try {
            for await (const event of model.chat(messages, chatOptions)) {
                if (writer && event) {
                    writer.record({
                        eventType: `model.${event.type === 'thinking' ? 'reasoning' : event.type || 'event'}`,
                        actor: options.actor || 'auxiliary-model',
                        spanId,
                        parentSpanId: writer.activeTraceId,
                        content: typeof event.content === 'string' ? event.content : null,
                        payload: event.type === 'tool_calls' ? { calls: event.calls || [] } : {},
                    });
                }
                yield event;
            }
            if (writer) writer.record({
                eventType: 'model.completed',
                actor: options.actor || 'auxiliary-model',
                spanId,
                parentSpanId: writer.activeTraceId,
                payload: { auxiliary: true },
            });
        } catch (error) {
            if (writer) writer.record({
                eventType: 'model.failed',
                actor: options.actor || 'auxiliary-model',
                spanId,
                parentSpanId: writer.activeTraceId,
                payload: { auxiliary: true, ...safeError(error) },
            });
            throw error;
        } finally {
            if (writer) await writer.flush();
        }
    }

    async function complete(messages, chatOptions = {}) {
        let text = '';
        for await (const event of chat(messages, chatOptions)) {
            if (event?.type === 'content' && typeof event.content === 'string') text += event.content;
        }
        return text;
    }

    return Object.freeze({ chat, complete, info });
}

module.exports = { createAuditedModelCapability };

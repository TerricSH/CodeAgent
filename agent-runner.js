const EventDispatcher = require('./event-dispatcher');
const tools = require('./tools');
const turnContinuation = require('./runtime/turn-continuation');

function getToolName(definition) {
    return definition?.function?.name || null;
}

function hasToolHandler(toolRegistry, name) {
    if (typeof toolRegistry.has === 'function') return toolRegistry.has(name);
    return Array.isArray(toolRegistry.definitions)
        && toolRegistry.definitions.some(definition => getToolName(definition) === name);
}

function validateToolRegistry(toolDefs, toolRegistry) {
    if (!toolRegistry || typeof toolRegistry.execute !== 'function') {
        throw new Error('toolRegistry must provide execute(name, args, context)');
    }
    const missing = toolDefs.map(getToolName).filter(Boolean)
        .filter(name => !hasToolHandler(toolRegistry, name));
    if (missing.length > 0) {
        throw new Error(`Tool definitions are missing handlers: ${missing.join(', ')}`);
    }
}

function safeError(error) {
    return {
        error: error instanceof Error ? error.message : String(error),
        code: error && error.code ? error.code : 'TOOL_EXECUTION_FAILED',
    };
}

function cacheKindForToolCalls(calls = []) {
    const names = calls.map(call => call.name);
    if (names.length === 1 && names[0] === 'delegate_agent') return 'subagent_result';
    if (names.every(name => name === 'rag')) return 'workspace_data';
    if (names.every(name => /skill/i.test(name))) return 'skill';
    if (names.every(name => /web|search/i.test(name))) return 'web_result';
    return 'tool_exchange';
}

function currentUserContent(context) {
    const latest = [...context.messages].reverse().find(message => message.role === 'user');
    return latest && typeof latest.content === 'string' ? latest.content : null;
}

function renderBufferedReply(output, reply) {
    if (!reply) return;
    output.content.renderStart();
    output.content.render(reply);
    output.content.renderEnd();
}

async function runAgentLoop(context, output, options = {}) {
    const client = options.client;
    if (!client || typeof client.chat !== 'function') {
        throw new Error('runAgentLoop requires options.client with chat(messages, options)');
    }
    const toolRegistry = options.toolRegistry || tools;
    const toolDefs = options.tools || toolRegistry.definitions || [];
    validateToolRegistry(toolDefs, toolRegistry);
    const plugins = options.plugins || null;
    const persist = typeof options.persist === 'function' ? options.persist : null;
    const audit = options.audit || context.auditWriter || null;
    if (audit && !audit.activeTraceId) {
        const userContent = currentUserContent(context);
        const tracePolicy = plugins && typeof plugins.deriveTracePolicy === 'function'
            ? plugins.deriveTracePolicy({ userContent })
            : {};
        const traceId = audit.startTrace({ content: userContent, tracePolicy });
        context.startTask(traceId, tracePolicy);
    }

    let activeModelSpanId = null;
    const dispatcher = new EventDispatcher(output, (event) => {
        if (!audit || !event) return;
        const type = event.type === 'thinking' ? 'reasoning' : event.type;
        audit.record({
            eventType: `model.${type || 'event'}`,
            actor: 'model',
            spanId: activeModelSpanId,
            parentSpanId: audit.activeTraceId,
            content: typeof event.content === 'string' ? event.content : null,
            payload: event.type === 'tool_calls' ? { calls: event.calls || [] } : {},
        });
    });

    try {
        while (true) {
            if (plugins) await plugins.onBeforeTurn(context);
            const deferContent = plugins
                && typeof plugins.requiresCompletionAuthorization === 'function'
                && plugins.requiresCompletionAuthorization(context);
            const state = dispatcher.createState({ deferContent });

            const modelProfile = typeof client.info === 'function' ? client.info() || {} : {};
            const prepared = context.prepareRequest({ tools: toolDefs, modelProfile });
            activeModelSpanId = globalThis.crypto.randomUUID();
            if (audit) {
                const serializableProfile = {
                    ref: modelProfile.ref || null,
                    model: modelProfile.model || client.model || null,
                    maxContextTokens: modelProfile.maxContextTokens || null,
                    maxOutputTokens: modelProfile.maxOutputTokens || null,
                };
                audit.record({
                    eventType: 'model.system_prompt',
                    actor: 'runtime',
                    spanId: activeModelSpanId,
                    parentSpanId: audit.activeTraceId,
                    content: prepared.messages[0]?.role === 'system' ? prepared.messages[0].content : '',
                    forceBlob: true,
                    indexable: false,
                });
                audit.record({
                    eventType: 'model.tool_schema',
                    actor: 'runtime',
                    spanId: activeModelSpanId,
                    parentSpanId: audit.activeTraceId,
                    content: JSON.stringify(toolDefs),
                    forceBlob: true,
                    indexable: false,
                });
                audit.record({
                    eventType: 'model.request',
                    actor: 'model',
                    spanId: activeModelSpanId,
                    parentSpanId: audit.activeTraceId,
                    content: JSON.stringify({ messages: prepared.messages, tools: toolDefs }),
                    payload: { profile: serializableProfile, usage: prepared.usage },
                    tokenCount: prepared.usage.requestTokens,
                    forceBlob: true,
                    indexable: false,
                });
            }

            try {
                for await (const event of client.chat(prepared.messages, {
                    ...(options.modelOptions || {}),
                    tools: toolDefs,
                })) {
                    dispatcher.dispatch(event, state);
                }
                if (audit) {
                    audit.record({
                        eventType: 'model.completed',
                        actor: 'model',
                        spanId: activeModelSpanId,
                        parentSpanId: audit.activeTraceId,
                        payload: {
                            hasToolCalls: Boolean(state.pendingToolCalls),
                            outputCharacters: state.reply.length,
                        },
                    });
                }
            } catch (error) {
                if (audit) {
                    audit.record({
                        eventType: 'model.failed',
                        actor: 'model',
                        spanId: activeModelSpanId,
                        parentSpanId: audit.activeTraceId,
                        payload: safeError(error),
                    });
                }
                throw error;
            }

            if (state.inThinking) {
                state.inThinking = false;
                output.thinking.renderEnd();
            }
            if (state.reply && !state.deferContent) output.content.renderEnd();
            if (!state.pendingToolCalls) {
                if (state.reply && !state.deferContent) context.addAssistant(state.reply);
                if (audit) await audit.flush();
                if (plugins && !state.deferContent) await plugins.onAfterTurn(context, state);

                const guards = plugins ? plugins.getContinuationGuards(context) : [];
                const continuation = await turnContinuation.evaluate(context, guards);
                if (continuation.shouldContinue) {
                    if (persist) await persist();
                    context.addUser(continuation.reminder);
                    if (persist) await persist();
                    continue;
                }

                const authorization = plugins && typeof plugins.authorizeTraceCompletion === 'function'
                    ? await plugins.authorizeTraceCompletion(context, { reply: state.reply })
                    : { authorized: true, reminder: null };
                if (!authorization.authorized) {
                    const reminder = authorization.reminder
                        || authorization.reason
                        || 'Runtime completion authorization was denied. Resolve the blocking condition and try again.';
                    if (persist) await persist();
                    context.addUser(reminder);
                    if (persist) await persist();
                    continue;
                }

                if (state.reply && state.deferContent) {
                    renderBufferedReply(output, state.reply);
                    context.addAssistant(state.reply);
                }
                if (state.deferContent) {
                    if (audit) await audit.flush();
                    if (plugins) await plugins.onAfterTurn(context, state);
                }

                if (audit) {
                    context.completeTask(audit.activeTraceId, 'task-completed');
                    audit.finishTrace('completed', { outputCharacters: state.reply.length });
                }
                if (persist) await persist();
                else if (audit) await audit.flush(context.checkpoint());
                return state.reply;
            }

            if (state.reply && state.deferContent) renderBufferedReply(output, state.reply);
            const exchangeKind = cacheKindForToolCalls(state.pendingToolCalls);
            context.addAssistantToolCalls(state.pendingToolCalls, {
                kind: exchangeKind,
                content: state.reply || null,
                auditRecorded: true,
            });
            if (audit) await audit.flush();
            let batchFailure = null;
            if (typeof toolRegistry.preflight === 'function') {
                try {
                    await toolRegistry.preflight(state.pendingToolCalls, context);
                } catch (error) {
                    batchFailure = safeError(error);
                }
            }
            const results = await Promise.all(state.pendingToolCalls.map(async (toolCall) => {
                const startedAt = new Date().toISOString();
                output.tool.renderCall(toolCall.name, toolCall.arguments);
                if (audit) {
                    audit.record({
                        eventType: batchFailure ? 'tool.blocked' : 'tool.started',
                        actor: toolCall.name,
                        spanId: toolCall.id,
                        parentSpanId: activeModelSpanId,
                        payload: batchFailure
                            ? { arguments: toolCall.arguments, ...batchFailure }
                            : { arguments: toolCall.arguments },
                        createdAt: startedAt,
                    });
                    await audit.flush();
                }
                let result;
                let failure = batchFailure ? { ...batchFailure } : null;
                if (failure) {
                    result = JSON.stringify(failure);
                } else {
                    try {
                        result = await toolRegistry.execute(
                            toolCall.name,
                            toolCall.arguments,
                            context,
                            { toolCallId: toolCall.id, modelSpanId: activeModelSpanId }
                        );
                    } catch (error) {
                        failure = safeError(error);
                        result = JSON.stringify(failure);
                    }
                }
                const finishedAt = new Date().toISOString();
                output.tool.renderResult(toolCall.name, result);
                if (audit) {
                    audit.record({
                        eventType: failure ? 'tool.failed' : 'tool.result',
                        actor: toolCall.name,
                        spanId: toolCall.id,
                        parentSpanId: activeModelSpanId,
                        content: typeof result === 'string' ? result : JSON.stringify(result),
                        payload: failure
                            ? { ...failure, startedAt, finishedAt }
                            : { startedAt, finishedAt },
                        createdAt: finishedAt,
                    });
                }
                context.addToolResult(toolCall.id, result, {
                    finishedAt,
                    failed: Boolean(failure),
                    toolName: toolCall.name,
                    kind: exchangeKind,
                    auditRecorded: true,
                });
                if (audit) await audit.flush();
                return {
                    id: toolCall.id,
                    toolCall,
                    result,
                    finishedAt,
                    failed: Boolean(failure),
                };
            }));
            for (const { toolCall, result } of results) {
                if (plugins) await plugins.onToolResult(context, toolCall, result);
            }
            if (audit) await audit.flush();
            if (persist) await persist();
        }
    } catch (error) {
        if (audit && audit.activeTraceId) {
            context.completeTask(audit.activeTraceId, 'task-failed');
            audit.finishTrace('failed', safeError(error));
            await audit.flush(context.checkpoint());
        }
        throw error;
    }
}

module.exports = runAgentLoop;
module.exports.cacheKindForToolCalls = cacheKindForToolCalls;

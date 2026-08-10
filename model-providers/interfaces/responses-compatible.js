const BaseInterface = require('./base-interface');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function safeParseArgs(value) {
    if (typeof value !== 'string' || value.trim() === '') return {};
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function toResponsesTools(definitions = []) {
    return definitions
        .filter(definition => definition && definition.type === 'function' && definition.function)
        .map(({ function: fn }) => ({
            type: 'function',
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters || { type: 'object', properties: {} },
        }));
}

function toResponsesInput(messages = []) {
    const instructions = [];
    const input = [];

    for (const message of messages) {
        if (!message || !message.role) continue;

        if (message.role === 'system') {
            if (typeof message.content === 'string') instructions.push(message.content);
            continue;
        }

        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                const fn = toolCall && toolCall.function;
                if (!toolCall.id || !fn || !fn.name) continue;
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: fn.name,
                    arguments: typeof fn.arguments === 'string'
                        ? fn.arguments
                        : JSON.stringify(fn.arguments || {}),
                });
            }
            continue;
        }

        if (message.role === 'tool') {
            if (!message.tool_call_id) continue;
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id,
                output: typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content),
            });
            continue;
        }

        if (message.role === 'user' || message.role === 'assistant') {
            input.push({
                role: message.role,
                content: typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content ?? ''),
            });
        }
    }

    return {
        instructions: instructions.join('\n\n') || undefined,
        input,
    };
}

async function* parseEventStream(response) {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';

        for (const block of blocks) {
            const data = block
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart())
                .join('\n');
            if (!data || data === '[DONE]') continue;
            yield JSON.parse(data);
        }
    }

    buffer += decoder.decode();
    const data = buffer
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
}

class ResponsesCompatible extends BaseInterface {
    constructor(conn = {}) {
        super(conn);
        this.baseURL = (this.baseURL || DEFAULT_BASE_URL).replace(/\/$/, '');
    }

    buildParams(messages, options = {}) {
        const converted = toResponsesInput(messages);
        const params = {
            ...this.requestOptions,
            ...(options.providerOptions || {}),
            model: this.model,
            input: converted.input,
            stream: true,
        };
        if (converted.instructions) params.instructions = converted.instructions;

        const tools = toResponsesTools(options.tools);
        if (tools.length > 0) params.tools = tools;
        if (options.reasoning?.enabled && params.reasoning === undefined) {
            params.reasoning = {
                effort: options.reasoning.effort || 'medium',
                summary: options.reasoning.summary || 'detailed',
            };
        }
        return params;
    }

    async *chat(messages, options = {}) {
        if (!this.apiKey) {
            throw new Error('OpenAI Responses API is not configured: set OPENAI_API_KEY.');
        }
        if (!this.model) {
            throw new Error('OpenAI Responses API is not configured: select a model.');
        }

        const response = await fetch(`${this.baseURL}/responses`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            signal: options.signal,
            body: JSON.stringify(this.buildParams(messages, options)),
        });

        if (!response.ok) {
            const body = await response.text();
            const error = new Error(`OpenAI Responses API failed (${response.status}): ${body}`);
            error.status = response.status;
            throw error;
        }
        if (!response.body) {
            const error = new Error('OpenAI Responses API returned no event stream');
            error.code = 'MODEL_STREAM_UNAVAILABLE';
            throw error;
        }

        const toolCalls = new Map();
        let emittedToolCalls = false;

        for await (const event of parseEventStream(response)) {
            if (event.type === 'response.output_text.delta' && event.delta) {
                yield { type: 'content', content: event.delta, raw: event };
                continue;
            }

            if ((event.type === 'response.reasoning_summary_text.delta'
                || event.type === 'response.reasoning_text.delta') && event.delta) {
                yield { type: 'thinking', content: event.delta, raw: event };
                continue;
            }

            if (event.type === 'response.output_item.added'
                && event.item && event.item.type === 'function_call') {
                toolCalls.set(event.output_index, { ...event.item });
                continue;
            }

            if (event.type === 'response.function_call_arguments.delta') {
                const call = toolCalls.get(event.output_index);
                if (call) call.arguments = `${call.arguments || ''}${event.delta || ''}`;
                continue;
            }

            if (event.type === 'response.output_item.done'
                && event.item && event.item.type === 'function_call') {
                toolCalls.set(event.output_index, { ...event.item });
                continue;
            }

            if (event.type === 'error' || event.type === 'response.failed') {
                const error = event.error || event.response?.error || {};
                const failure = new Error(error.message || 'OpenAI Responses API stream failed.');
                failure.status = event.response?.status || error.status || null;
                failure.code = error.code || null;
                throw failure;
            }

            if (event.type === 'response.completed' && toolCalls.size > 0) {
                emittedToolCalls = true;
                yield {
                    type: 'tool_calls',
                    calls: [...toolCalls.values()].map(call => ({
                        id: call.call_id,
                        name: call.name,
                        arguments: safeParseArgs(call.arguments),
                    })),
                    raw: event,
                };
            }
        }

        if (!emittedToolCalls && toolCalls.size > 0) {
            yield {
                type: 'tool_calls',
                calls: [...toolCalls.values()].map(call => ({
                    id: call.call_id,
                    name: call.name,
                    arguments: safeParseArgs(call.arguments),
                })),
                raw: null,
            };
        }
    }
}

module.exports = ResponsesCompatible;

const BaseInterface = require('./base-interface');

// Anthropic 兼容接口（默认实现，fetch + SSE，无需额外依赖）。
// 与 OpenAI 形状的差异全部封装在本接口内部：
//   - 鉴权：x-api-key + anthropic-version（不是 Authorization: Bearer）
//   - system：顶层参数（从消息里的 role:system 抽出来），不在 messages 里
//   - max_tokens：必填
//   - 工具：function.parameters -> input_schema；tool_calls -> tool_use；tool 结果 -> tool_result
//   - 流式：content_block_delta 等事件，翻译成统一的 content/thinking/tool_calls 事件
class AnthropicCompatible extends BaseInterface {
    constructor(conn = {}) {
        super(conn);
        this.baseURL = (this.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
        this.anthropicVersion = conn.anthropicVersion || '2023-06-01';
    }

    // 可覆写：构建请求体（厂商可加自家特殊参数）。
    buildBody(messages, options) {
        const { system, messages: anthropicMessages } = translateMessages(messages);
        const body = {
            ...this.requestOptions,
            ...(options.providerOptions || {}),
            model: this.model,
            max_tokens: options.maxTokens || this.maxOutputTokens,
            messages: anthropicMessages,
            stream: true,
        };
        if (system) body.system = system;
        if (options.temperature != null) body.temperature = options.temperature;
        if (options.topP != null) body.top_p = options.topP;
        if (options.tools && options.tools.length > 0) {
            body.tools = translateTools(options.tools);
        }
        if (options.reasoning?.enabled && body.thinking === undefined) {
            if (body.max_tokens <= 1024) {
                throw new Error('Anthropic reasoning requires max_tokens greater than 1024');
            }
            body.thinking = {
                type: 'enabled',
                budget_tokens: Math.min(
                    body.max_tokens - 1,
                    Math.max(1024, Number(options.reasoning.budgetTokens) || 2048)
                ),
            };
        }
        return body;
    }

    async *chat(messages, options = {}) {
        if (!this.model) {
            throw new Error('未配置模型：请为该 agent 指定 anthropic 模型。');
        }
        if (!this.apiKey) {
            throw new Error('Anthropic 未配置 API key（请设置对应的 apiKeyEnv，如 ANTHROPIC_API_KEY）。');
        }

        const response = await fetch(`${this.baseURL}/v1/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': this.anthropicVersion,
                'content-type': 'application/json',
            },
            signal: options.signal,
            body: JSON.stringify(this.buildBody(messages, options)),
        });

        if (!response.ok || !response.body) {
            const text = await response.text().catch(() => '');
            const error = new Error(`Anthropic 请求失败 (${response.status}): ${text}`);
            error.status = response.status;
            if (response.ok && !response.body) error.code = 'MODEL_STREAM_UNAVAILABLE';
            throw error;
        }

        // tool_use 累积：content block index -> { id, name, json(partial) }
        const toolUses = {};
        let sawToolUse = false;

        for await (const { event, data } of parseSSE(response.body)) {
            if (!data) continue;
            let json;
            try {
                json = JSON.parse(data);
            } catch {
                continue;
            }
            const type = json.type || event;

            if (type === 'error') {
                const error = new Error(json.error?.message || 'Anthropic stream failed');
                error.status = json.error?.status || null;
                error.code = json.error?.type || null;
                throw error;
            }

            if (type === 'content_block_start') {
                const cb = json.content_block;
                if (cb && cb.type === 'tool_use') {
                    sawToolUse = true;
                    toolUses[json.index] = { id: cb.id, name: cb.name, json: '' };
                }
            } else if (type === 'content_block_delta') {
                const d = json.delta;
                if (!d) continue;
                if (d.type === 'text_delta' && d.text) {
                    yield { type: 'content', content: d.text, raw: json };
                } else if (d.type === 'thinking_delta' && d.thinking) {
                    yield { type: 'thinking', content: d.thinking, raw: json };
                } else if (d.type === 'input_json_delta' && toolUses[json.index]) {
                    toolUses[json.index].json += d.partial_json || '';
                }
            } else if (type === 'message_stop') {
                if (sawToolUse) {
                    const calls = Object.values(toolUses).map(t => ({
                        id: t.id,
                        name: t.name,
                        arguments: safeJSON(t.json) || {},
                    }));
                    yield { type: 'tool_calls', calls, raw: json };
                }
            }
        }
    }
}

// ---- 翻译层：统一消息(OpenAI 形状) <-> Anthropic ----

function translateMessages(messages) {
    const systemParts = [];
    const out = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
            continue;
        }

        if (msg.role === 'user') {
            out.push({ role: 'user', content: toText(msg.content) });
            continue;
        }

        if (msg.role === 'assistant') {
            const blocks = [];
            if (typeof msg.content === 'string' && msg.content) {
                blocks.push({ type: 'text', text: msg.content });
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function && tc.function.name,
                        input: safeJSON(tc.function && tc.function.arguments) || {},
                    });
                }
            }
            out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
            continue;
        }

        if (msg.role === 'tool') {
            const block = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            };
            // 连续的 tool 结果合并进同一个 user 消息（Anthropic 要求工具结果在 user 回合）。
            const last = out[out.length - 1];
            if (last && last._toolResult) {
                last.content.push(block);
            } else {
                out.push({ role: 'user', content: [block], _toolResult: true });
            }
            continue;
        }
    }

    for (const m of out) delete m._toolResult;
    return { system: systemParts.join('\n\n'), messages: out };
}

function translateTools(tools) {
    return tools.map(t => ({
        name: t.function && t.function.name,
        description: t.function && t.function.description,
        input_schema: (t.function && t.function.parameters) || { type: 'object', properties: {} },
    }));
}

function toText(content) {
    if (typeof content === 'string') return content;
    return content == null ? '' : JSON.stringify(content);
}

function safeJSON(str) {
    if (str == null) return null;
    if (typeof str !== 'string') return str;
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

// 解析 fetch 响应体的 SSE 流，逐个 yield { event, data }。
async function* parseSSE(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = null;
            let data = '';
            for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            yield { event, data };
        }
    }
}

module.exports = AnthropicCompatible;

const OpenAI = require('openai');
const BaseInterface = require('./base-interface');

// OpenAI 兼容接口（默认实现）：走官方 OpenAI SDK 流式接口。
// 纯标准兼容的厂商直接用本类；有私货的厂商在 vendors/ 下继承本类覆写
// （如覆写 buildParams 加特殊参数，或覆写 chat 改鉴权/headers）。
class OpenAICompatible extends BaseInterface {
    constructor(conn = {}) {
        super(conn);
        this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
    }

    // 可覆写：构建请求参数（厂商可加自家特殊参数）。
    buildParams(messages, options) {
        const params = {
            model: this.model,
            messages,
            temperature: options.temperature ?? 1.0,
            top_p: options.topP ?? 0.95,
            stream: true,
        };
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
        }
        return params;
    }

    async *chat(messages, options = {}) {
        if (!this.model) {
            throw new Error('未配置模型：请设置 MODEL_NAME 环境变量，或为该 agent 指定 model。');
        }

        const stream = await this.client.chat.completions.create(this.buildParams(messages, options));
        const toolCalls = {};

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
                yield { type: 'thinking', content: delta.reasoning_content };
            }
            if (delta.content) {
                yield { type: 'content', content: delta.content };
            }
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const id = tc.index;
                    if (!toolCalls[id]) {
                        toolCalls[id] = { id: tc.id, name: '', arguments: '' };
                    }
                    if (tc.function?.name) {
                        toolCalls[id].name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                        toolCalls[id].arguments += tc.function.arguments;
                    }
                }
            }

            const finishReason = chunk.choices[0]?.finish_reason;
            if (finishReason === 'tool_calls') {
                const calls = Object.values(toolCalls).map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: safeParseArgs(tc.arguments),
                }));
                yield { type: 'tool_calls', calls };
            }
        }
    }
}

// 容错解析工具参数：模型可能吐出空串或非法 JSON，解析失败时降级为空对象，
// 避免在流式生成器内抛错中断整轮（与 anthropic 接口的 safeJSON 行为对齐）。
function safeParseArgs(str) {
    if (typeof str !== 'string' || str.trim() === '') return {};
    try {
        return JSON.parse(str);
    } catch {
        return {};
    }
}

module.exports = OpenAICompatible;

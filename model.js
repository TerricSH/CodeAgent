const OpenAI = require('openai');

class ModelClient {
    constructor({ apiKey, baseURL, model }) {
        this.client = new OpenAI({ apiKey, baseURL });
        this.model = model;
    }

    async *chat(messages, options = {}) {
        const params = {
            model: this.model,
            messages,
            max_completion_tokens: options.maxTokens || 1024,
            temperature: options.temperature ?? 1.0,
            top_p: options.topP ?? 0.95,
            stream: true,
        };
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
        }

        const stream = await this.client.chat.completions.create(params);

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
                    arguments: JSON.parse(tc.arguments),
                }));
                yield { type: 'tool_calls', calls };
            }
        }
    }
}

module.exports = ModelClient;

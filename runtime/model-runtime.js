const providers = require('../model-providers');

async function completeWithClient(client, messages, options = {}) {
    let text = '';
    for await (const event of client.chat(messages, options)) {
        if (event && event.type === 'content' && typeof event.content === 'string') {
            text += event.content;
        }
    }
    return text;
}

function createModelCapability(client, ref = null) {
    return Object.freeze({
        chat: (messages, options) => client.chat(messages, options),
        complete: (messages, options) => completeWithClient(client, messages, options),
        info: () => ({
            ref,
            model: client.model,
            maxContextTokens: client.maxContextTokens,
            maxOutputTokens: client.maxOutputTokens,
            reasoningRequired: Boolean(client.reasoningRequired),
            countTokens: (messages, tools) => client.countTokens(messages, tools),
        }),
    });
}

// 公共模型运行时：拥有「当前模型连接」，与 session / agent 解耦。
// 模型是无状态的——只接收消息、流式吐回统一事件，不关心 agent 这边怎么操作、怎么管上下文。
// mainloop 通过本接口调用；切换模型也由它负责（公共能力，与会话切换无关）。
class ModelRuntime {
    constructor(ref) {
        this._ref = ref || null;
        this._client = ref ? providers.resolve(ref) : providers.resolveDefault();
    }

    get model() {
        return this._client.model;
    }

    // 当前模型的上下文窗口（出厂属性）；供宿主同步给 Context 作 token 预算。
    get maxContextTokens() {
        return this._client.maxContextTokens;
    }

    get maxOutputTokens() {
        return this._client.maxOutputTokens;
    }

    info() {
        return {
            ref: this._ref,
            model: this._client.model,
            maxContextTokens: this._client.maxContextTokens,
            maxOutputTokens: this._client.maxOutputTokens,
            reasoningRequired: Boolean(this._client.reasoningRequired),
            countTokens: (messages, tools) => this._client.countTokens(messages, tools),
        };
    }

    // 无状态调用：消息 → 统一事件流（thinking / content / tool_calls）。
    async *chat(messages, options = {}) {
        yield* this._client.chat(messages, options);
    }

    // 非流式便捷调用：消耗事件流、拼接 content 文本返回。供插件（如摘要）做一次性补全。
    // 不需要工具，故不传 tools；纯文本进、纯文本出。
    async complete(messages, options = {}) {
        return completeWithClient(this._client, messages, options);
    }

    // 创建绑定到指定模型引用的独立能力，不切换或修改当前主会话模型。
    resolve(ref) {
        if (typeof ref !== 'string' || !ref.trim()) {
            throw new Error('Model reference is required');
        }
        const normalized = ref.trim();
        return createModelCapability(providers.resolve(normalized), normalized);
    }

    // 切换当前模型（公共能力，与 session 无关）；返回新信息供宿主同步预算/显示。
    switch(ref) {
        this._client = providers.resolve(ref);
        this._ref = ref;
        return this.info();
    }
}

module.exports = ModelRuntime;
module.exports.createModelCapability = createModelCapability;
module.exports.completeWithClient = completeWithClient;

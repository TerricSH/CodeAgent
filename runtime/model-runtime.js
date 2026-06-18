const providers = require('../model-providers');

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

    info() {
        return {
            ref: this._ref,
            model: this._client.model,
            maxContextTokens: this._client.maxContextTokens,
        };
    }

    // 无状态调用：消息 → 统一事件流（thinking / content / tool_calls）。
    async *chat(messages, options = {}) {
        yield* this._client.chat(messages, options);
    }

    // 切换当前模型（公共能力，与 session 无关）；返回新信息供宿主同步预算/显示。
    switch(ref) {
        this._client = providers.resolve(ref);
        this._ref = ref;
        return this.info();
    }
}

module.exports = ModelRuntime;

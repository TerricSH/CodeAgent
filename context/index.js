const SystemPrompt = require('./system-prompt');
const { createContextState } = require('./state');
const ops = require('./ops');

// Context 是对外兼容外壳：对外暴露稳定 API，内部委托给私有内核 state + ops。
// - 消息：context 是消息格式唯一权威（时间字段在入口规范化一次）。
// - messages getter 返回只读副本，外部无法直接修改内部状态。
// - 插件状态不再由 context 持有；context 仅通过注入的 resolveExtension 暴露 getExtension。
class Context {
    constructor(systemPromptText, options = {}) {
        this.systemPrompt = new SystemPrompt(systemPromptText);
        this.state = createContextState(options);
        this._resolveExtension = typeof options.resolveExtension === 'function'
            ? options.resolveExtension
            : null;
    }

    get sessionId() {
        return this.state.sessionId;
    }

    get metadata() {
        return this.state.metadata;
    }

    set metadata(value) {
        this.state.metadata = value && typeof value === 'object' ? value : {};
    }

    // 由宿主同步当前模型的上下文窗口（token 预算）。Context 不感知模型，只收一个数字。
    setMaxContextTokens(value) {
        this.state.maxContextTokens = Number.isInteger(value) && value > 0 ? value : null;
    }

    // 只读副本：冻结每条消息与数组，外部不能改动内部状态（边界 1 = B）。
    get messages() {
        return Object.freeze(this.state.messages.map((msg) => Object.freeze(ops.normalizeMessage(msg))));
    }

    // 扩展访问入口：转调注入的解析器，context 不持有任何插件状态本体（边界 4 + A1）。
    getExtension(name) {
        return this._resolveExtension ? this._resolveExtension(name) : null;
    }

    addUser(content) {
        return ops.addUser(this.state, content);
    }

    addAssistant(content) {
        return ops.addAssistant(this.state, content);
    }

    addAssistantToolCalls(toolCalls) {
        return ops.addAssistantToolCalls(this.state, toolCalls);
    }

    addToolResult(toolCallId, result, options = {}) {
        return ops.addToolResult(this.state, toolCallId, result, options);
    }

    // 传输态：把 system prompt 拼到最前给模型；存储态不含 system（边界 3）。
    getMessages() {
        return ops.getMessages(this.state, this.systemPrompt.toMessage());
    }

    // 只读用量快照：估算已用 token（历史 + system）、限额、剩余、明细。供 UI 实时显示，不改状态。
    usage() {
        return ops.usage(this.state, this.systemPrompt.toMessage());
    }

    // 安全保存点用：返回规范化后的消息快照（边界 5）。
    snapshotMessages() {
        return ops.snapshotMessages(this.state);
    }

    clear() {
        ops.clear(this.state);
    }
}

module.exports = Context;

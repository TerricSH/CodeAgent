// context/ops.js 是 context 私有内核的薄聚合层（兼容外壳）。
// 职责已拆分到三个单一职责模块，本文件仅做聚合 re-export，保持 Context 调用点不变：
//   - messages.js：消息格式唯一权威（normalize / add* / snapshot / clear）
//   - tokens.js：词元估算与只读用量快照（estimateTokens / totalTokensOf / usage）
//   - transport.js：传输态组装（内置裁撤 + 可替换裁撤接口 / getMessages）
const messages = require('./messages');
const tokens = require('./tokens');
const transport = require('./transport');

module.exports = {
    // —— messages（消息权威） ——
    normalizeMessage: messages.normalizeMessage,
    addMessage: messages.addMessage,
    addUser: messages.addUser,
    addAssistant: messages.addAssistant,
    addAssistantToolCalls: messages.addAssistantToolCalls,
    addToolResult: messages.addToolResult,
    snapshotMessages: messages.snapshotMessages,
    clear: messages.clear,

    // —— tokens（估算 / 用量） ——
    estimateTokens: tokens.estimateTokens,
    usage: tokens.usage,

    // —— transport（传输态组装） ——
    getMessages: transport.getMessages,
    manageContext: transport.manageContext,
};

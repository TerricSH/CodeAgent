// 兼容接口契约：定义某种线协议如何
//   构建请求 + 解析流 + 分类成统一事件（thinking / content / tool_calls）。
// 厂商通过 config 声明它【实现哪些接口】（可多个，如同时支持 openai + anthropic）。
//   - 纯标准兼容的厂商：直接用接口的默认实现，只写 config。
//   - 有私货的厂商：在 vendors/ 下继承对应接口、覆写差异点。
function defaultOutputReserve(maxContextTokens) {
    const window = Number.isInteger(maxContextTokens) && maxContextTokens > 0
        ? maxContextTokens
        : 32768;
    return Math.min(32768, Math.max(4096, Math.floor(window * 0.05)));
}

class BaseInterface {
    constructor({ apiKey, baseURL, model, maxContextTokens, maxOutputTokens } = {}) {
        this.apiKey = apiKey || null;
        this.baseURL = baseURL || null;
        this.model = model || null;
        // 上下文窗口（出厂属性）：供 Context 读取作 token 预算；非法/未知记为 null。
        this.maxContextTokens = Number.isInteger(maxContextTokens) && maxContextTokens > 0
            ? maxContextTokens
            : null;
        this.maxOutputTokens = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
            ? maxOutputTokens
            : defaultOutputReserve(this.maxContextTokens);
    }

    // 子类必须实现：async *chat(messages, options) -> AsyncGenerator<event>
    async *chat() {
        throw new Error('接口必须实现 chat(messages, options)');
    }

    countTokens(messages = [], tools = []) {
        const { estimateRequestTokens } = require('../../context/tokens');
        return estimateRequestTokens(messages, tools);
    }
}

module.exports = BaseInterface;
module.exports.defaultOutputReserve = defaultOutputReserve;

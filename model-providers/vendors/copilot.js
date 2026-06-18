const OpenAICompatible = require('../interfaces/openai-compatible');

// Copilot 厂商 —— 私货覆写示例（占位）。
// Copilot 的线格式是 OpenAI 形状，但鉴权/headers/baseURL/模型获取都不同，
// 因此【继承 openai 兼容接口】并覆写，而不是新造一套协议。后续实现需覆盖：
//   1) GitHub device-flow 拿 OAuth token（固定 client_id，poll login/oauth/access_token）；
//   2) 用它换短期 Copilot token：GET api.github.com/copilot_internal/v2/token
//      （返回 { token, expires_at, refresh_in }），并按 refresh_in 定时刷新；
//   3) chat 端点 {base}/chat/completions，但需特殊 headers：
//      copilot-integration-id、editor-version、editor-plugin-version、user-agent、
//      x-github-api-version、每次新的 x-request-id、按消息动态计算的 X-Initiator: agent|user；
//   4) baseURL 随账户类型变化（individual / business / enterprise）；
//   5) 模型列表与上下文上限从 GET /models 动态获取。
class CopilotOpenAI extends OpenAICompatible {
    async *chat() {
        throw new Error('Copilot 尚未实现：需 device-flow 鉴权 + token 刷新 + 动态 headers/模型。');
    }
}

// 厂商可实现多个接口：键 = 接口名，值 = 覆写该接口的类。
module.exports = { openai: CopilotOpenAI };

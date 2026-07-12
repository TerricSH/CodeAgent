const path = require('path');
const fs = require('fs');
require('dotenv').config();

const OpenAICompatible = require('./interfaces/openai-compatible');
const AnthropicCompatible = require('./interfaces/anthropic-compatible');
const ResponsesCompatible = require('./interfaces/responses-compatible');

// 兼容接口注册表（默认实现）：厂商在 config 里按名【声明实现哪些】。
// 新增接口 = 加一个 interfaces/*.js + 在此登记。
const INTERFACES = {
    openai: OpenAICompatible,
    anthropic: AnthropicCompatible,
    responses: ResponsesCompatible,
};

// 厂商私货覆写注册表：厂商有自家加强时，在 vendors/<name>.js 导出 { 接口名: 覆写类 }。
const VENDOR_IMPLS = {
    copilot: require('./vendors/copilot'),
};

const CONFIG_PATH = path.join(__dirname, 'config.json');

// 默认配置模板：config.json 缺失时自动生成（如全新克隆，因为该文件已被 gitignore）。
// 出厂属性（baseURL / 模型窗口）直接写值；密钥走 env。openai 厂商默认从 env 取连接，
// 配好 .env 即可开箱即用；之后可按需改成 catalog 形式或增删厂商。
const DEFAULT_CONFIG = {
    default: 'openai',
    vendors: {
        openai: {
            interfaces: {
                openai: {
                    apiKeyEnv: 'API_KEY',
                    baseURLEnv: 'API_BASE_URL',
                    modelEnv: 'MODEL_NAME',
                    maxContextTokensEnv: 'MODEL_MAX_CONTEXT_TOKENS',
                    models: {},
                },
                responses: {
                    apiKeyEnv: 'OPENAI_API_KEY',
                    baseURL: 'https://api.openai.com/v1',
                    modelEnv: 'OPENAI_RESPONSES_MODEL',
                    models: {
                        
                    },
                },
            },
        },
        anthropic: {
            interfaces: {
                anthropic: {
                    apiKeyEnv: 'ANTHROPIC_API_KEY',
                    baseURL: 'https://api.anthropic.com',
                    anthropicVersion: '2023-06-01',
                    maxOutputTokens: 4096,
                    models: {
                        'claude-sonnet-4-5': { maxContextTokens: 200000 },
                    },
                },
            },
        },
        copilot: {
            impl: 'copilot',
            interfaces: {
                openai: { accountType: 'individual', githubTokenEnv: 'GH_TOKEN', models: {} },
            },
        },
    },
};

// 加载配置；缺失则用默认模板生成一份再读取。
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4) + '\n');
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

const config = loadConfig();

function parseTokenBudget(value) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// 模型引用："厂商" / "厂商/模型" / "厂商@接口/模型"。
//   - @接口 省略时用该厂商的第一个接口为默认。
//   - 模型省略时用该接口配置的 modelEnv。
//   - model 可含 '/'，按首个 '/' 切分。
function parseRef(ref) {
    const str = String(ref || '');
    const slash = str.indexOf('/');
    const head = slash === -1 ? str : str.slice(0, slash);
    const model = slash === -1 ? null : str.slice(slash + 1);
    const at = head.indexOf('@');
    const vendor = at === -1 ? head : head.slice(0, at);
    const iface = at === -1 ? null : head.slice(at + 1);
    return { vendor, iface, model };
}

function buildProvider(vendorName, ifaceName, modelName) {
    const vc = config.vendors[vendorName];
    if (!vc || !vc.interfaces) throw new Error(`未知模型厂商: ${vendorName}`);

    // 接口名：引用指定优先，否则该厂商声明的第一个接口。
    const ifaceKey = ifaceName || Object.keys(vc.interfaces)[0];
    const ic = vc.interfaces[ifaceKey];
    if (!ic) throw new Error(`厂商 ${vendorName} 不支持接口: ${ifaceKey}`);

    // 接口实现：厂商有私货覆写则用覆写类，否则用接口默认实现。
    const vendorImpl = vc.impl && VENDOR_IMPLS[vc.impl] && VENDOR_IMPLS[vc.impl][ifaceKey];
    const Impl = vendorImpl || INTERFACES[ifaceKey];
    if (!Impl) throw new Error(`未知接口: ${ifaceKey}`);

    // 凭证（用户提供）：优先 env，其次 config 内联值。
    const apiKey = ic.apiKeyEnv ? process.env[ic.apiKeyEnv] : ic.apiKey;
    // 访问链接（出厂属性）：优先 env，其次 config 固定值。
    const baseURL = ic.baseURLEnv ? process.env[ic.baseURLEnv] : ic.baseURL;
    // 模型名：引用里指定优先，否则 env 默认。
    const model = modelName || (ic.modelEnv ? process.env[ic.modelEnv] : undefined);
    // 上下文窗口（出厂属性）：catalog 模型条目优先，否则 env，否则 null（Context 用内置默认）。
    const catalogEntry = (ic.models && model && ic.models[model]) || null;
    const maxContextTokens = catalogEntry && Number.isInteger(catalogEntry.maxContextTokens)
        ? catalogEntry.maxContextTokens
        : (ic.maxContextTokensEnv ? parseTokenBudget(process.env[ic.maxContextTokensEnv]) : null);

    // 接口实现直接就是 client：携带连接 + model + maxContextTokens，并自带 chat()。
    // 不再套一层 Provider 转发，调用链更短。
    return new Impl({
        apiKey,
        baseURL,
        model,
        maxContextTokens,
        anthropicVersion: ic.anthropicVersion,
        maxOutputTokens: ic.maxOutputTokens,
        accountType: ic.accountType,
    });
}

// 解析 "厂商[@接口]/模型" 引用为绑定到具体模型的 Provider 实例。
function resolve(ref) {
    const { vendor, iface, model } = parseRef(ref);
    return buildProvider(vendor, iface, model);
}

// 解析 config.default 指向的默认模型（主 agent 用）。
function resolveDefault() {
    return resolve(config.default);
}

module.exports = { resolve, resolveDefault, config };

const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');

// 配置缺失/损坏不应阻断 agent 启动（config.json 被 .gitignore，fresh clone 无此文件）。
// 缺失时回退到默认模板：无 provider 凭据，对应工具在调用时返回“未配置”，而非启动即崩。
const DEFAULT_CONFIG = { provider: 'tavily', providers: {} };
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
        return DEFAULT_CONFIG;
    }
}

const config = loadConfig();

const BUILTIN = {
    tavily: './tavily',
    serper: './serper',
    github: './github',
};

function loadProvider(name) {
    const providerConfig = (config.providers && config.providers[name]) || {};

    const modulePath = BUILTIN[name];
    if (modulePath) {
        const Provider = require(modulePath);
        return new Provider(providerConfig);
    }

    try {
        const Provider = require(`codeagent-search-${name}`);
        return new Provider(providerConfig);
    } catch {
        throw new Error(`未找到搜索引擎: ${name}`);
    }
}

const provider = loadProvider(config.provider || 'tavily');

module.exports = provider;
// 同时暴露已加载配置与加载器，供其它工具复用，避免各自再脆弱地直读 config.json。
module.exports.config = config;
module.exports.loadProvider = loadProvider;

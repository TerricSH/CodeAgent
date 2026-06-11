const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const BUILTIN = {
    tavily: './tavily',
    serper: './serper',
};

function loadProvider(name) {
    const providerConfig = config.providers[name] || {};

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

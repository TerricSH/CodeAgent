const fs = require('fs');
const path = require('path');
const GitHubProvider = require('../../search-providers/github');
const { config: spConfig } = require('../../search-providers');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

// 复用 search-providers 已加载（且缺失时已回退默认）的配置，避免在模块加载时再脆弱地直读 config.json。
const github = new GitHubProvider((spConfig.providers && spConfig.providers.github) || {});

const definition = {
    type: 'function',
    function: {
        name: 'github_search',
        description: '搜索 GitHub 上的仓库、代码、Issue 或用户',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'GitHub 搜索关键词',
                },
                type: {
                    type: 'string',
                    description: '搜索类型，默认 repositories',
                    enum: ['repositories', 'code', 'issues', 'users'],
                },
                max_results: {
                    type: 'number',
                    description: '返回结果数量，默认 5',
                },
            },
            required: ['query'],
        },
    },
};

async function handler({ query, type, max_results }) {
    try {
        const data = await github.search(query, max_results || 5, { type: type || 'repositories' });

        if (data.error) return `GitHub 搜索失败: ${data.error}`;

        let output = `总数: ${data.totalCount}\n\n`;
        for (const item of data.results) {
            output += `- ${item.title}\n  ${item.url}\n  ${item.content}\n\n`;
        }

        return output.trim() || '未找到结果';
    } catch (err) {
        return `GitHub 搜索失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };

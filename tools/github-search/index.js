const fs = require('fs');
const path = require('path');
const githubSearch = require('../../github/search-client');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'github_search',
        description: '搜索 GitHub 上的仓库、代码、Issue/PR 或用户',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'GitHub 搜索关键词，支持 repo:, user:, org:, language:, filename: 等限定符',
                },
                type: {
                    type: 'string',
                    description: '搜索类型，默认 repositories',
                    enum: ['repositories', 'code', 'issues', 'users'],
                },
                max_results: {
                    type: 'number',
                    description: '返回结果数量，默认使用 github/config.json 中的 perPage',
                },
            },
            required: ['query'],
        },
    },
};

async function handler({ query, type, max_results }) {
    try {
        const data = await githubSearch.search({
            query,
            type: type || 'repositories',
            maxResults: max_results,
        });

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

const fs = require('fs');
const path = require('path');
const searchProvider = require('../../search-providers');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'web_search',
        description: '搜索互联网内容，返回摘要和相关链接',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                max_results: { type: 'number', description: '返回结果数量，默认 5' },
            },
            required: ['query'],
        },
    },
};

async function handler({ query, max_results }) {
    try {
        const data = await searchProvider.search(query, max_results || 5);

        if (data.error) return `搜索失败: ${data.error}`;

        let output = '';
        if (data.answer) {
            output += `摘要: ${data.answer}\n\n`;
        }
        if (data.results) {
            for (const r of data.results) {
                output += `- ${r.title}\n  ${r.url}\n  ${r.content}\n\n`;
            }
        }
        return output || '未找到结果';
    } catch (err) {
        return `搜索失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt, effects: 'external' };

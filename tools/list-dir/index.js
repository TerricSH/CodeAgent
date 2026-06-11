const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'list_dir',
        description: '列出目录下的文件和文件夹',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '目录路径，默认为当前目录' },
            },
            required: [],
        },
    },
};

function handler({ path: dirPath }) {
    try {
        const resolved = path.resolve(dirPath || '.');
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n');
    } catch (err) {
        return `列出失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };

const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'read_file',
        description: '读取本地文件内容',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件路径' },
            },
            required: ['path'],
        },
    },
};

function handler({ path: filePath }) {
    try {
        return fs.readFileSync(path.resolve(filePath), 'utf-8');
    } catch (err) {
        return `读取失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };

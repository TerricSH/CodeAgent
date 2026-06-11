const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'write_file',
        description: '写入内容到本地文件',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件路径' },
                content: { type: 'string', description: '文件内容' },
            },
            required: ['path', 'content'],
        },
    },
};

function handler({ path: filePath, content }) {
    try {
        const resolved = path.resolve(filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return `已写入 ${resolved}`;
    } catch (err) {
        return `写入失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };

const fs = require('fs');
const path = require('path');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');

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

const capabilities = { required: ['fileSystem'] };

function handler({ path: filePath, content }, context, injectedCapabilities) {
    let fileSystem = null;
    try {
        fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
        const resolved = fileSystem.resolveForWrite(filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return `已写入: ${fileSystem.relative(resolved)}`;
    } catch (err) {
        return formatCapabilityError(fileSystem, err, '写入失败');
    }
}

module.exports = { definition, handler, prompt, capabilities };

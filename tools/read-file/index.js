const fs = require('fs');
const path = require('path');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');

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

const capabilities = { required: ['fileSystem'] };

function handler({ path: filePath }, context, injectedCapabilities) {
    let fileSystem = null;
    try {
        fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
        const resolved = fileSystem.resolveExisting(filePath, { type: 'file' });
        return fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
        return formatCapabilityError(fileSystem, err, '读取失败');
    }
}

module.exports = { definition, handler, prompt, capabilities, effects: 'read' };

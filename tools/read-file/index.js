const fs = require('fs');
const path = require('path');
const {
    requireRuntimeService,
    formatServiceError,
} = require('../runtime-service');

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

function handler({ path: filePath }, context) {
    let fileSystem = null;
    try {
        fileSystem = requireRuntimeService(context, 'fileSystem');
        const resolved = fileSystem.resolveExisting(filePath, { type: 'file' });
        return fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
        return formatServiceError(fileSystem, err, '读取失败');
    }
}

module.exports = { definition, handler, prompt };

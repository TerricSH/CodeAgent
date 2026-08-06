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

function handler({ path: dirPath }, context) {
    let fileSystem = null;
    try {
        fileSystem = requireRuntimeService(context, 'fileSystem');
        const resolved = fileSystem.resolveExisting(dirPath || '.', { type: 'directory' });
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n');
    } catch (err) {
        return formatServiceError(fileSystem, err, '列出失败');
    }
}

module.exports = { definition, handler, prompt };

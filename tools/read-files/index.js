const fs = require('node:fs');
const path = require('node:path');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'read_files',
        description: '批量读取多个本地 UTF-8 文本文件，并逐个返回结果',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    description: '要读取的文件路径列表',
                    items: { type: 'string' },
                    minItems: 1,
                },
            },
            required: ['paths'],
        },
    },
};

const capabilities = { required: ['fileSystem'] };

function errorDetail(fileSystem, error) {
    const formatted = formatCapabilityError(fileSystem, error, '读取失败');
    try {
        return JSON.parse(formatted);
    } catch {
        return formatted;
    }
}

function handler(args = {}, context, injectedCapabilities) {
    let fileSystem = null;
    try {
        fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
        if (!Array.isArray(args.paths) || args.paths.length === 0) {
            throw new TypeError('paths 必须是非空数组');
        }

        const results = args.paths.map((filePath) => {
            try {
                if (typeof filePath !== 'string' || filePath.trim() === '') {
                    throw new TypeError('文件路径必须是非空字符串');
                }
                const resolved = fileSystem.resolveExisting(filePath, { type: 'file' });
                return {
                    path: filePath,
                    ok: true,
                    content: fs.readFileSync(resolved, 'utf8'),
                };
            } catch (error) {
                return {
                    path: filePath,
                    ok: false,
                    error: errorDetail(fileSystem, error),
                };
            }
        });
        const succeeded = results.filter(result => result.ok).length;

        return JSON.stringify({
            summary: {
                total: results.length,
                succeeded,
                failed: results.length - succeeded,
            },
            results,
        }, null, 2);
    } catch (error) {
        return formatCapabilityError(fileSystem, error, '批量读取失败');
    }
}

module.exports = { definition, handler, prompt, capabilities, effects: 'read' };

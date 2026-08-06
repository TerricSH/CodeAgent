const fs = require('node:fs');
const path = require('node:path');
const {
    requireRuntimeService,
    formatServiceError,
} = require('../runtime-service');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'write_files',
        description: '批量写入多个本地 UTF-8 文本文件，并逐个返回结果',
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    description: '要写入的文件列表',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: '文件路径' },
                            content: { type: 'string', description: '文件内容' },
                        },
                        required: ['path', 'content'],
                        additionalProperties: false,
                    },
                    minItems: 1,
                },
            },
            required: ['files'],
        },
    },
};

function errorDetail(fileSystem, error) {
    const formatted = formatServiceError(fileSystem, error, '写入失败');
    try {
        return JSON.parse(formatted);
    } catch {
        return formatted;
    }
}

function handler(args = {}, context) {
    let fileSystem = null;
    try {
        fileSystem = requireRuntimeService(context, 'fileSystem');
        if (!Array.isArray(args.files) || args.files.length === 0) {
            throw new TypeError('files 必须是非空数组');
        }

        const results = args.files.map((file) => {
            const filePath = file && file.path;
            try {
                if (!file || typeof file !== 'object' || Array.isArray(file)) {
                    throw new TypeError('每个文件必须包含 path 和 content');
                }
                if (typeof filePath !== 'string' || filePath.trim() === '') {
                    throw new TypeError('文件路径必须是非空字符串');
                }
                if (typeof file.content !== 'string') {
                    throw new TypeError('文件内容必须是字符串');
                }
                const resolved = fileSystem.resolveForWrite(filePath);
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                fs.writeFileSync(resolved, file.content, 'utf8');
                return {
                    path: filePath,
                    ok: true,
                    writtenPath: fileSystem.relative(resolved),
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
        return formatServiceError(fileSystem, error, '批量写入失败');
    }
}

module.exports = { definition, handler, prompt };

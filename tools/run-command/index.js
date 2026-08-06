const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requireRuntimeService } = require('../runtime-service');

const DEFAULT_TIMEOUT = 30000;
const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'run_command',
        description: '在本地执行一条 shell 命令并返回输出',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令' },
                timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
            },
            required: ['command'],
        },
    },
};

function handler({ command, timeout }, context) {
    try {
        const commandScope = requireRuntimeService(context, 'commandScope');
        return execSync(command, {
            cwd: commandScope.cwd,
            encoding: 'utf-8',
            timeout: timeout || DEFAULT_TIMEOUT,
            env: { ...process.env, ...(commandScope.environment || {}) },
        });
    } catch (err) {
        return `命令执行失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };

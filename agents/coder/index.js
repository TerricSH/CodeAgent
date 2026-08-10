const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'coder',
    description: '编程助手 - 编写代码、创建文件、执行命令',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
    tools: ['run_command', 'read_file', 'read_files', 'write_file', 'write_files', 'apply_patch', 'list_dir', 'workspace_status', 'rag', 'task_ledger', 'verification_gate'],
};

const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'tester',
    description: 'Independent test verifier - runs behavioral and regression tests and evaluates assertion quality without editing the project',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
    tools: ['run_command', 'read_file', 'read_files', 'list_dir', 'workspace_status', 'rag', 'task_ledger', 'verification_gate'],
};

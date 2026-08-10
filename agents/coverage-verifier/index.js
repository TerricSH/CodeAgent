const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'coverage-verifier',
    description: 'Independent coverage verifier - measures test coverage and identifies uncovered changed, branch, and error paths without editing the project',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
    tools: ['run_command', 'read_file', 'read_files', 'list_dir', 'workspace_status', 'rag', 'task_ledger'],
};

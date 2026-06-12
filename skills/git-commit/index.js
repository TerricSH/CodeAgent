const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'git-commit',
    description: 'Git提交 - 生成规范的Git提交信息',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
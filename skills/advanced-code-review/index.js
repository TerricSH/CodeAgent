const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'advanced-code-review',
    description: '高级代码审查 - 涵盖多语言框架的深度代码审查',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
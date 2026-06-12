const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'systematic-debugging',
    description: '系统化调试 - 四阶段调试方法论，强调先找根因再修复',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
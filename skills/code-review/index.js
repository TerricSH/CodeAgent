const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'code-review',
    description: '代码审查 - 分析代码质量、安全性和性能，给出改进建议',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};

const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'prompt-master',
    description: '提示词大师 - 为任何AI工具编写精准的提示词',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
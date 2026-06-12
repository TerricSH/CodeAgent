const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'grill-me',
    description: '代码质询 - 对代码进行深度质询和挑战性审查',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
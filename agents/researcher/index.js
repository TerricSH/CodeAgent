const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'researcher',
    description: '研究助手 - 搜索互联网并整理信息回答问题',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
    tools: ['web_search'],
};

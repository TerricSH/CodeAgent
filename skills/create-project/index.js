const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'create-project',
    description: '项目创建 - 根据需求从零搭建完整项目结构和代码',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};

const fs = require('fs');
const path = require('path');
const skills = require('../../skills');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'activate_skill',
        description: '激活一个技能，切换到特定工作模式。可用技能：\n' + skills.listDescription(),
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: '要激活的技能名称',
                    enum: skills.list().map(s => s.name),
                },
            },
            required: ['name'],
        },
    },
};

function handler({ name }, context) {
    const skill = skills.get(name);
    if (!skill) return `未知技能: ${name}`;
    context.systemPrompt.set(
        [context.systemPrompt.get().split('\n<active_skill>')[0], `\n<active_skill>\n${skill.prompt}\n</active_skill>`].join('')
    );
    return `已激活技能: ${skill.description}`;
}

module.exports = { definition, handler, prompt };

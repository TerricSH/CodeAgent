const fs = require('node:fs');
const path = require('node:path');
const skills = require('../../skills');
const { loadPromptTemplate } = require('../../prompts/loader');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
const ACTIVE_SKILL_SECTION = 'active-skill';
const renderActiveSkillSystem = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'active-skill-system.md')
);

const definition = {
    type: 'function',
    function: {
        name: 'activate_skill',
        description: `激活一个技能，切换到特定工作模式。可用技能：\n${skills.listDescription()}`,
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: '要激活的技能名称',
                    enum: skills.list().map(skill => skill.name),
                },
            },
            required: ['name'],
        },
    },
};

function handler({ name }, context) {
    const skill = skills.get(name);
    if (!skill) return `未知技能: ${name}`;
    const activeSkill = renderActiveSkillSystem({ skillPrompt: skill.prompt });
    context.systemPrompt.upsertSection(ACTIVE_SKILL_SECTION, activeSkill);
    return `已激活技能: ${skill.description}`;
}

module.exports = { definition, handler, prompt };

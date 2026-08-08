const fs = require('node:fs');
const path = require('node:path');
const skills = require('../../skills');
const { loadPromptTemplate } = require('../../prompts/loader');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
const renderActiveSkillSystem = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'active-skill-system.md')
);

const definition = {
    type: 'function',
    function: {
        name: 'activate_skill',
        description: 'Activate an installed Skill candidate returned by skill_search.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Candidate ID or Skill name from skill_search.' },
            },
            required: ['name'],
        },
    },
};

async function handler({ name }, context) {
    const skill = skills.get(name);
    if (!skill) return { activated: false, name, reason: 'unknown-skill' };
    const existing = context.cache.entries.find(entry =>
        entry.kind === 'skill' && entry.metadata?.skillName === name
    );
    if (existing) {
        context.touch(existing.id, 'skill-used');
        if (!existing.resident) await context.restore(existing.id, 'skill-reactivated');
        return { activated: true, name, cacheNodeId: existing.id, alreadyLoaded: true };
    }
    const activeSkill = renderActiveSkillSystem({ skillPrompt: skill.prompt });
    const entry = context.load({
        role: 'system',
        content: activeSkill,
        kind: 'skill',
        sourceRef: `skill:${name}`,
        metadata: { skillName: name, description: skill.description },
    });
    if (context.auditWriter) {
        context.auditWriter.record({
            eventType: 'skill.loaded',
            actor: 'skill',
            content: activeSkill,
            payload: { name, cacheNodeId: entry.id, sourceRef: entry.sourceRef },
            forceBlob: true,
        });
    }
    return { activated: true, name, description: skill.description, cacheNodeId: entry.id };
}

module.exports = { definition, handler, prompt };

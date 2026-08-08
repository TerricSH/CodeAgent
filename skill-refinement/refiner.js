const { createReflectionEvidence } = require('./evidence');
const path = require('node:path');
const { loadPrompt, loadPromptTemplate } = require('../prompts/loader');

const REFINER_SYSTEM_PROMPT = loadPrompt(path.join(__dirname, 'prompts', 'refiner-system.md'));
const renderRefinerUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'refiner-user.md'));

function stripMarkdownFence(value) {
    const text = String(value || '').trim();
    const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return (match ? match[1] : text).trim();
}

async function refineSkill({ model, suite, rollouts }) {
    if (!model || typeof model.complete !== 'function') {
        throw new Error('Skill Refinement synthesis requires a model capability with complete()');
    }
    const evidence = createReflectionEvidence(rollouts);
    const result = await model.complete([
        {
            role: 'system',
            content: REFINER_SYSTEM_PROMPT,
        },
        {
            role: 'user',
            content: renderRefinerUser({
                skill: suite.skill,
                task: suite.task,
                evidence: JSON.stringify(evidence, null, 2),
            }),
        },
    ]);
    const refined = stripMarkdownFence(result);
    if (!refined) throw new Error('Skill refiner returned an empty candidate');
    if (refined.length > 64000) throw new Error('Refined Skill exceeds 64000 characters');
    return refined;
}

module.exports = {
    refineSkill,
    refinementEvidence: createReflectionEvidence,
    stripMarkdownFence,
};

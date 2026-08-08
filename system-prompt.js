const path = require('path');
const { loadPrompt } = require('./prompts/loader');

const POLICY_PATH = path.join(__dirname, 'prompts', 'system-policy.md');

function buildSystemPrompt({ basePrompt, toolPrompts }) {
    return [basePrompt, loadPrompt(POLICY_PATH), toolPrompts].filter(Boolean).join('\n\n');
}

module.exports = { buildSystemPrompt };

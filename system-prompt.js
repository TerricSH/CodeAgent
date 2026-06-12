const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, 'prompts', 'system-policy.md');

function buildSystemPrompt({ basePrompt, toolPrompts }) {
    const policy = fs.readFileSync(POLICY_PATH, 'utf-8');
    return [basePrompt, policy, toolPrompts].filter(Boolean).join('\n\n');
}

module.exports = { buildSystemPrompt };

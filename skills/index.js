const codeReview = require('./code-review');
const createProject = require('./create-project');
const advancedCodeReview = require('./advanced-code-review');
const systematicDebugging = require('./systematic-debugging');
const promptMaster = require('./prompt-master');
const grillMe = require('./grill-me');
const gitCommit = require('./git-commit');

const skills = [
    codeReview,
    createProject,
    advancedCodeReview,
    systematicDebugging,
    promptMaster,
    grillMe,
    gitCommit
];

const registry = {};
for (const s of skills) {
    registry[s.name] = s;
}

function list() {
    return skills.map(s => ({ name: s.name, description: s.description }));
}

function get(name) {
    return registry[name] || null;
}

function listDescription() {
    return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}

module.exports = { list, get, listDescription };
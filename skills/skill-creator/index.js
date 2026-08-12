const fs = require('node:fs');
const path = require('node:path');

module.exports = Object.freeze({
    name: 'skill-creator',
    description: 'Create or update project Skills when no installed Skill fits or an existing Skill needs improvement. Use for SkillOpt refinement and Skill-R1 conformance audits.',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8'),
});

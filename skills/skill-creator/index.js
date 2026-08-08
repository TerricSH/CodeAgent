const fs = require('node:fs');
const path = require('node:path');

module.exports = Object.freeze({
    name: 'skill-creator',
    description: 'Skill creation - bootstrap an unknown Skill through verified recurrent refinement',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8'),
});

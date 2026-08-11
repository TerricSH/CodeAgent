const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const skills = require('../skills');
const activateSkill = require('../tools/activate-skill');
const tools = require('../tools');

test('skill-creator is registered as a project Skill', () => {
    const skill = skills.get('skill-creator');

    assert.ok(skill);
    assert.equal(skill.name, 'skill-creator');
    assert.match(skill.description, /unknown Skill/i);
    assert.equal(activateSkill.definition.function.parameters.properties.name.enum, undefined);
    assert.equal(tools.has('skill_search'), true);
});

test('skill-creator keeps creation, rollout, verification, and reflection roles explicit', () => {
    const prompt = skills.get('skill-creator').prompt;

    assert.match(prompt, /Creator:/);
    assert.match(prompt, /Template model:/);
    assert.match(prompt, /Verifier:/);
    assert.match(prompt, /Reflection model:/);
    assert.match(prompt, /templateModel/);
    assert.match(prompt, /reflectionModel/);
    assert.match(prompt, /skill_refinement/);
    assert.match(prompt, /call `refine` once/i);
    assert.match(prompt, /mean score on the fixed selection split is strictly greater/i);
    assert.match(prompt, /dataset\.train/);
    assert.match(prompt, /test split is used only for final reporting/i);
    assert.match(prompt, /temporary Git versions/i);
    assert.match(prompt, /do\s+not describe it as reinforcement-learning model training/i);
    assert.match(prompt, /Place the returned best verified Skill[\s\S]+`skills\/<name>\/`/i);
    assert.match(prompt, /Never overwrite an existing Skill without explicit user approval/i);
});

test('refinement intermediates and downloaded model weights stay outside Git', () => {
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');

    assert.match(ignore, /^\.code\/$/m);
    assert.match(ignore, /^skill-refinement\/suites\/\*\/$/m);
    assert.match(ignore, /^model\/models\/Qwen3-8B\/$/m);
    assert.match(ignore, /^model\/models\/DeepSeek-R1-Distill-Qwen-7B\/$/m);
    assert.match(ignore, /^model\/models\/Qwen3-8B-GGUF\/$/m);
    assert.match(ignore, /^model\/models\/DeepSeek-R1-Distill-Qwen-7B-GGUF\/$/m);
});

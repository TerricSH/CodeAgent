const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const skills = require('../skills');
const activateSkill = require('../tools/activate-skill');
const tools = require('../tools');

test('skill-creator is registered for project Skill creation and updates', () => {
    const skill = skills.get('skill-creator');

    assert.ok(skill);
    assert.equal(skill.name, 'skill-creator');
    assert.match(skill.description, /create or update/i);
    assert.match(skill.description, /no installed Skill/i);
    assert.match(skill.description, /existing Skill needs improvement/i);
    assert.equal(activateSkill.definition.function.parameters.properties.name.enum, undefined);
    assert.equal(tools.has('skill_search'), true);
});

test('skill-creator keeps SkillOpt responsibilities explicit without claiming Skill-R1', () => {
    const prompt = skills.get('skill-creator').prompt;

    assert.match(prompt, /Creator:/);
    assert.match(prompt, /Task model:/);
    assert.match(prompt, /Verifier:/);
    assert.match(prompt, /Reflection model:/);
    assert.match(prompt, /templateModel/);
    assert.match(prompt, /reflectionModel/);
    assert.match(prompt, /skill_refinement/);
    assert.match(prompt, /SkillOpt/);
    assert.match(prompt, /is not Skill-R1/i);
    assert.doesNotMatch(prompt, /inspired by Skill-R1/i);
    assert.match(prompt, /call `refine` once/i);
    assert.match(prompt, /mean score on\s+the fixed selection split is strictly greater/i);
    assert.match(prompt, /dataset\.train/);
    assert.match(prompt, /test split is used only for final reporting/i);
    assert.match(prompt, /temporary Git versions/i);
    assert.match(prompt, /Place the returned best verified Skill[\s\S]+`skills\/<name>\/`/i);
    assert.match(prompt, /Never overwrite an existing Skill without explicit\s+user approval/i);
});

test('skill-creator gates explicit Skill-R1 claims on the paper requirements', () => {
    const prompt = skills.get('skill-creator').prompt;
    const reference = fs.readFileSync(
        path.join(__dirname, '..', 'skills', 'skill-creator', 'references', 'skill-r1.md'),
        'utf8'
    );

    assert.match(prompt, /read\s+`skills\/skill-creator\/references\/skill-r1\.md`/i);
    assert.match(prompt, /report the missing requirements/i);
    assert.match(reference, /arXiv:2605\.09359/);
    assert.match(reference, /trainable lightweight skill generator/i);
    assert.match(reference, /frozen task LLM/i);
    assert.match(reference, /same task instance/i);
    assert.match(reference, /group of K rollouts/i);
    assert.match(reference, /intra-generation advantage/i);
    assert.match(reference, /inter-generation advantage/i);
    assert.match(reference, /clipped GRPO/i);
    assert.match(reference, /KL penalty/i);
    assert.match(reference, /selection-gated textual patches/i);
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

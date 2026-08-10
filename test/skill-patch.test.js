const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPatchWithReport, parsePatch } = require('../skill-refinement/skill-patch');
const { GitSkillStore } = require('../skill-refinement/git-skill-store');

test('SkillOpt Patch applies structured edits sequentially and protects managed regions', () => {
    const skill = [
        '# Skill',
        '',
        '## Verification',
        'old rule',
        '',
        '<!-- APPENDIX_START -->',
        'protected text',
        '<!-- APPENDIX_END -->',
        '',
    ].join('\n');
    const result = applyPatchWithReport(skill, {
        reasoning: 'verified failures require a stronger rule',
        edits: [
            { op: 'replace', target: 'old rule', content: 'new rule' },
            { op: 'insert_after', target: '## Verification', content: 'run tests' },
            { op: 'delete', target: 'protected text' },
            { op: 'append', content: 'final instruction' },
        ],
    });

    assert.equal(result.changed, true);
    assert.match(result.skill, /## Verification\n\nrun tests\nnew rule/);
    assert.match(result.skill, /protected text/);
    assert.ok(result.skill.indexOf('final instruction') < result.skill.indexOf('<!-- APPENDIX_START -->'));
    assert.deepEqual(result.reports.map(report => report.status), [
        'applied_replace',
        'applied_insert_after',
        'skipped_protected_region',
        'applied_append_before_protected_region',
    ]);
});

test('SkillOpt Patch rejects malformed operations before mutating a Skill', () => {
    assert.throws(
        () => parsePatch('{"edits":[{"op":"add","content":"bad"}]}'),
        /unsupported op/
    );
    assert.throws(
        () => parsePatch({ edits: [{ op: 'replace', content: 'missing target' }] }),
        /requires target/
    );
    assert.throws(
        () => parsePatch({ edits: [{ op: 'append', content: '   ' }] }),
        /non-empty content/
    );
});

test('SkillOpt Patch blocks targets that overlap a protected region boundary', () => {
    const skill = '# Skill\nBefore\n<!-- APPENDIX_START -->\nprotected\n<!-- APPENDIX_END -->\n';
    const result = applyPatchWithReport(skill, {
        edits: [{
            op: 'delete',
            target: 'Before\n<!-- APPENDIX_START -->\nprotected',
        }],
    });
    assert.equal(result.changed, false);
    assert.equal(result.reports[0].status, 'skipped_protected_region');
    assert.match(result.skill, /protected/);
});

test('one temporary Git repository records accepted Skill versions and restores rejected work', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-skill-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new GitSkillStore(root);
    const baseline = await store.initialize('# Skill\nBaseline');
    assert.equal(fs.statSync(path.join(store.root, '.git')).isDirectory(), true);
    store.write('# Skill\nAccepted');
    assert.match(await store.diff(), /-Baseline[\s\S]*\+Accepted/);
    const accepted = await store.accept({ epoch: 1, step: 1, score: 2 });
    assert.notEqual(accepted, baseline);

    store.write('# Skill\nRejected');
    await store.restore();
    assert.equal(store.read(), '# Skill\nAccepted');
    const exported = await store.exportHistory();
    assert.match(fs.readFileSync(exported.historyPath, 'utf8'), /skillopt: baseline/);
    assert.match(fs.readFileSync(exported.historyPath, 'utf8'), /skillopt: accept epoch=1 step=1 score=2/);
    assert.doesNotMatch(
        fs.readFileSync(exported.historyPath, 'utf8'),
        /co[d]ex|co[-]authored/i
    );

    store.dispose();
    assert.equal(fs.existsSync(path.join(store.root, '.git')), false);
    assert.equal(fs.readFileSync(store.skillPath, 'utf8').trim(), '# Skill\nAccepted');
});

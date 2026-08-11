const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    refinementOutcome,
    meanScore,
    editBudgetAt,
} = require('../skill-refinement/ranking');
const {
    selectPatchEdits,
    replaceSlowUpdate,
    applyPatchWithReport,
} = require('../skill-refinement/skill-patch');
const { loadSuite } = require('../skill-refinement/suite');
const {
    compareSlowBatches,
    generateSlowUpdate,
    generateMetaUpdate,
} = require('../skill-refinement/optimizer-memory');
const { copySnapshot } = require('../skill-refinement/workspace');

test('automated reward contract normalizes exit, JSON, and protected-path outcomes to [0,1]', () => {
    assert.deepEqual(
        refinementOutcome({ ok: true }, [], { mode: 'exit_code', successThreshold: 1 }),
        { reward: 1, success: true, payload: null }
    );
    assert.deepEqual(
        refinementOutcome({ ok: false }, [], { mode: 'exit_code', successThreshold: 1 }),
        { reward: 0, success: false, payload: null }
    );
    const partial = refinementOutcome({
        ok: true,
        stdout: 'evaluation complete\n{"metrics":{"quality":0.75},"success":false}\n',
    }, [], {
        mode: 'stdout_json',
        field: 'metrics.quality',
        successField: 'success',
        successThreshold: 1,
    });
    assert.equal(partial.reward, 0.75);
    assert.equal(partial.success, false);
    assert.equal(refinementOutcome({ ok: true }, ['test'], {}).reward, 0);
    assert.throws(
        () => refinementOutcome({ reward: 1.5 }, [], {}),
        /within \[0, 1\]/
    );
});

test('selection aggregation is a mean and textual learning rate is bounded', () => {
    assert.equal(meanScore([{ score: 1 }, { score: 0.5 }, { score: 0 }]), 0.5);
    assert.equal(editBudgetAt({ initial: 4, floor: 2, schedule: 'cosine' }, 0, 5), 4);
    assert.equal(editBudgetAt({ initial: 4, floor: 2, schedule: 'cosine' }, 4, 5), 2);
    assert.equal(editBudgetAt({ initial: 4, floor: 2, schedule: 'constant' }, 4, 5), 4);

    const selected = selectPatchEdits({
        edits: [
            { op: 'append', content: 'success rule', support_count: 5, source_type: 'success' },
            { op: 'append', content: 'failure rule', support_count: 5, source_type: 'failure' },
            { op: 'append', content: 'weak rule', support_count: 1, source_type: 'failure' },
        ],
    }, 1);
    assert.equal(selected.edits.length, 1);
    assert.equal(selected.edits[0].content, 'failure rule');
});

test('schema-v2 suites load disjoint inline/JSON/JSONL splits and paper defaults', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-skillopt-suite-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    const suitesRoot = path.join(project, 'skill-refinement', 'suites');
    const suiteDir = path.join(suitesRoot, 'suite');
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'source.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(suiteDir, 'seed.md'), '# Skill\n');
    fs.writeFileSync(
        path.join(suiteDir, 'selection.jsonl'),
        '{"id":"selection-1","task":"selection task"}\n'
    );
    fs.writeFileSync(
        path.join(suiteDir, 'test.json'),
        JSON.stringify({ items: [{ id: 'test-1', task: 'test task' }] })
    );
    fs.writeFileSync(path.join(suiteDir, 'suite.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'suite',
        baseline: '.',
        skillPath: 'seed.md',
        dataset: {
            train: [{ id: 'train-1', task: 'training task' }],
            selection: { file: 'selection.jsonl' },
            test: { file: 'test.json' },
        },
        evaluation: { command: 'npm test' },
    }));

    const suite = loadSuite(suitesRoot, 'suite', project);
    assert.deepEqual(suite.dataset.train.map(item => item.id), ['train-1']);
    assert.deepEqual(suite.dataset.selection.map(item => item.id), ['selection-1']);
    assert.deepEqual(suite.dataset.test.map(item => item.id), ['test-1']);
    assert.equal(suite.optimizer.epochs, 4);
    assert.equal(suite.optimizer.rolloutBatchSize, 40);
    assert.equal(suite.optimizer.reflectionMinibatchSize, 8);
    assert.deepEqual(suite.optimizer.editBudget, {
        initial: 4,
        floor: 2,
        schedule: 'cosine',
    });

    const manifestPath = path.join(suiteDir, 'suite.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.stepsPerEpoch = 2;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
        () => loadSuite(suitesRoot, 'suite', project),
        /unsupported fields: stepsPerEpoch/
    );
    delete manifest.stepsPerEpoch;
    manifest.optimizer = { maxStepsPerEpoch: 2 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
        () => loadSuite(suitesRoot, 'suite', project),
        /unsupported fields: maxStepsPerEpoch/
    );
    delete manifest.optimizer;
    manifest.dataset.test = [{ id: 'train-1', task: 'leaked test task' }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
        () => loadSuite(suitesRoot, 'suite', project),
        /unique across splits/
    );
});

test('rollout snapshots exclude a custom private suite directory containing held-out data', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-skillopt-private-suite-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'project');
    const suiteDir = path.join(source, 'custom-suite-inputs', 'suite');
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(path.join(source, 'source.js'), 'public\n');
    fs.writeFileSync(path.join(suiteDir, 'selection.json'), '{"secret":"held-out"}\n');

    copySnapshot(source, destination, { excludePaths: [suiteDir] });
    assert.equal(fs.existsSync(path.join(destination, 'source.js')), true);
    assert.equal(fs.existsSync(path.join(destination, 'custom-suite-inputs', 'suite')), false);
});

test('slow update compares identical task IDs and fast patches cannot overwrite its region', () => {
    const previousBatch = {
        rollouts: [
            { taskId: 'a', score: 0, success: false, evaluation: {} },
            { taskId: 'b', score: 1, success: true, evaluation: {} },
            { taskId: 'c', score: 0, success: false, evaluation: {} },
        ],
    };
    const currentBatch = {
        rollouts: [
            { taskId: 'a', score: 1, success: true, evaluation: {} },
            { taskId: 'b', score: 0, success: false, evaluation: {} },
            { taskId: 'c', score: 0, success: false, evaluation: {} },
        ],
    };
    const comparison = compareSlowBatches(previousBatch, currentBatch);
    assert.deepEqual(Object.fromEntries(
        Object.entries(comparison).map(([key, value]) => [key, value.length])
    ), {
        improved: 1,
        regressed: 1,
        persistentFailures: 1,
        stableSuccesses: 0,
    });

    const skill = replaceSlowUpdate('# Skill\nFast rule', 'Durable guidance');
    assert.match(skill, /SLOW_UPDATE_START[\s\S]*Durable guidance[\s\S]*SLOW_UPDATE_END/);
    const attempted = applyPatchWithReport(skill, {
        edits: [{ op: 'replace', target: 'Durable guidance', content: 'fast overwrite' }],
    });
    assert.equal(attempted.changed, false);
    assert.match(attempted.skill, /Durable guidance/);
});

test('built-in slow/meta optimizer prompts parse structured autonomous updates', async () => {
    const model = {
        async completeDetailed(messages, options) {
            if (options.purpose === 'slow-update') {
                assert.match(messages[0].content, /Same-task longitudinal comparison/);
                return {
                    reasoning: 'slow model reasoning',
                    content: JSON.stringify({
                        reasoning: 'persistent failure',
                        slow_update_content: 'Always verify durable outcomes.',
                    }),
                };
            }
            assert.equal(options.purpose, 'meta-update');
            assert.match(messages[0].content, /Epoch optimization history/);
            return {
                reasoning: 'meta model reasoning',
                content: JSON.stringify({
                    reasoning: 'avoid a rejected direction',
                    meta_skill_content: 'Prefer edits with repeated failure support.',
                }),
            };
        },
    };
    const previousBatch = {
        rollouts: [{
            taskId: 'train-1', score: 0, success: false, reply: 'bad', evaluation: {},
        }],
    };
    const currentBatch = {
        rollouts: [{
            taskId: 'train-1', score: 1, success: true, reply: 'good', evaluation: {},
        }],
    };
    const slow = await generateSlowUpdate({
        model,
        suite: { id: 'suite' },
        epoch: 2,
        previousSkill: '# Previous',
        currentSkill: '# Current',
        previousBatch,
        currentBatch,
        metaSkill: '',
    });
    assert.equal(slow.content, 'Always verify durable outcomes.');
    assert.equal(slow.comparison.improved.length, 1);

    const meta = await generateMetaUpdate({
        model,
        suite: { id: 'suite' },
        epoch: 2,
        metaSkill: '',
        history: [{ status: 'rejected' }],
        rejectedBuffer: [{ reason: 'selection-score-regressed' }],
    });
    assert.equal(meta.content, 'Prefer edits with repeated failure support.');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../tools');
const skillRefinementTool = require('../tools/skill-refinement');
const { SkillRefinementService } = require('../skill-refinement');

function createSuite(root) {
    const project = path.join(root, 'project');
    const suitesRoot = path.join(project, 'skill-refinement', 'suites');
    const suiteDir = path.join(suitesRoot, 'sample-suite');
    fs.mkdirSync(path.join(project, 'test'), { recursive: true });
    fs.mkdirSync(path.join(project, 'model-providers'), { recursive: true });
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'source.js'), 'module.exports = 1;\n', 'utf8');
    fs.writeFileSync(path.join(project, '.env'), 'API_KEY=must-not-enter-rollouts\n', 'utf8');
    fs.writeFileSync(
        path.join(project, 'model-providers', 'config.json'),
        '{"secret":true}\n',
        'utf8'
    );
    fs.writeFileSync(path.join(project, 'test', 'locked.test.js'), 'trusted\n', 'utf8');
    fs.writeFileSync(path.join(suiteDir, 'seed-skill.md'), '# Seed Skill\nPrefer small patches.\n', 'utf8');
    fs.writeFileSync(path.join(suiteDir, 'suite.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'sample-suite',
        task: 'Improve source.js without changing protected tests.',
        baseline: '.',
        skillPath: 'seed-skill.md',
        rollouts: 3,
        protectedPaths: ['test'],
        evaluation: { command: 'node verify.js', timeoutMs: 5000 },
    }, null, 2), 'utf8');
    return { project, suitesRoot, sourceSkill: path.join(suiteDir, 'seed-skill.md') };
}

test('Skill Refinement runs isolated evaluations and produces a refined Skill candidate', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-refinement-'));
    const { project, suitesRoot, sourceSkill } = createSuite(root);
    const sandboxRoot = path.join(root, 'sandboxes');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const dockerCalls = [];
    const client = {
        async run(args) {
            dockerCalls.push(args);
            return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: 'trusted evaluation passed\n',
                stderr: '',
                truncated: false,
                error: null,
                durationMs: 20,
            };
        },
        async removeContainer() {},
    };
    const rolloutExecutor = async ({ rolloutId, workspace }) => {
        assert.equal(fs.existsSync(path.join(workspace, '.env')), false);
        assert.equal(fs.existsSync(path.join(workspace, 'model-providers', 'config.json')), false);
        if (rolloutId === 'rollout-001') {
            fs.writeFileSync(path.join(workspace, 'solution.js'), 'ok\n', 'utf8');
        } else if (rolloutId === 'rollout-002') {
            fs.writeFileSync(
                path.join(workspace, 'solution.js'),
                'a substantially larger but passing candidate\n',
                'utf8'
            );
        } else {
            fs.writeFileSync(path.join(workspace, 'solution.js'), 'tiny\n', 'utf8');
            fs.writeFileSync(path.join(workspace, 'test', 'locked.test.js'), 'tampered\n', 'utf8');
        }
        return {
            reply: `completed ${rolloutId}`,
            messages: [{ role: 'assistant', content: `completed ${rolloutId}` }],
        };
    };
    const skillRefiner = async ({ suite, rollouts }) => {
        assert.match(suite.skill, /Prefer small patches/);
        assert.equal(rollouts[0].id, 'rollout-001');
        return '# Refined Skill\nPrefer the smallest verified patch.';
    };
    const service = new SkillRefinementService('refinement-session', {
        sandboxRoot,
        projectRoot: project,
        suitesRoot,
    }, { client, rolloutExecutor, skillRefiner });

    assert.equal(service.listSuites().suites[0].id, 'sample-suite');
    const result = await service.refine({ suiteId: 'sample-suite' });

    assert.equal(result.run.status, 'completed');
    assert.equal(result.best.rolloutId, 'rollout-001');
    assert.equal(result.ranking.at(-1).rolloutId, 'rollout-003');
    assert.deepEqual(result.ranking.at(-1).protectedPathViolations, ['test']);
    assert.equal(dockerCalls.length, 2, 'protected rollout must not reach the evaluator');
    assert.match(result.candidateSkill.content, /Refined Skill/);
    assert.equal(fs.readFileSync(result.candidateSkill.path, 'utf8').trim(), result.candidateSkill.content);
    assert.match(fs.readFileSync(result.evidencePath, 'utf8'), /"reward":-1/);
    assert.match(fs.readFileSync(sourceSkill, 'utf8'), /Seed Skill/);
    assert.equal(service.history()[0].id, result.run.id);
    assert.equal(service.result(result.run.id).candidateSkill.content, result.candidateSkill.content);
});

test('Skill Refinement is one core Tool and routes actions to its service', async () => {
    const calls = [];
    const service = {
        async status() { calls.push('status'); return { available: true }; },
        listSuites() { calls.push('list_suites'); return { suites: [] }; },
        async refine(args) { calls.push(['refine', args]); return { candidateSkill: {} }; },
        history(limit) { calls.push(['history', limit]); return []; },
        result(runId) { calls.push(['result', runId]); return { run: { id: runId } }; },
        async dispose() { calls.push('dispose'); },
    };
    const handler = skillRefinementTool.createHandler({ createService: () => service });
    const capabilities = {
        sandboxScope: { projectRoot: 'E:/project', sandboxRoot: 'E:/project/.code/sandboxes' },
    };
    const context = { sessionId: 'session', metadata: {} };

    assert.equal(tools.has('skill_refinement'), true);
    assert.equal(tools.names().some(name => name.includes('training')), false);
    assert.equal(JSON.parse(await handler({ action: 'list_suites' }, context, capabilities)).suites.length, 0);
    assert.equal(JSON.parse(await handler({ action: 'refine', suiteId: 'suite' }, context, capabilities)).candidateSkill != null, true);
    context.metadata.type = 'subagent';
    const blocked = JSON.parse(await handler({ action: 'refine', suiteId: 'suite' }, context, capabilities));
    assert.match(blocked.error, /Subagents may not start/);
    assert.deepEqual(calls.slice(0, 4), ['list_suites', 'dispose', ['refine', { suiteId: 'suite' }], 'dispose']);
});

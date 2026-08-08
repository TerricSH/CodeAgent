const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../tools');
const skillRefinementTool = require('../tools/skill-refinement');
const {
    SkillRefinementService,
    SkillRefinementOrchestrator,
    SandboxEvaluator,
    RefinementArtifactRepository,
} = require('../skill-refinement');
const { resolveRefinementModels } = require('../skill-refinement/models');

function createSuite(root, overrides = {}) {
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
        templateModel: 'vendor@interface/template-model',
        reflectionModel: 'vendor@interface/reflection-model',
        task: 'Improve source.js without changing protected tests.',
        baseline: '.',
        skillPath: 'seed-skill.md',
        rollouts: 3,
        protectedPaths: ['test'],
        evaluation: { command: 'node verify.js', timeoutMs: 5000 },
        ...overrides,
    }, null, 2), 'utf8');
    return { project, suitesRoot, sourceSkill: path.join(suiteDir, 'seed-skill.md') };
}

test('Skill Refinement runs isolated evaluations and produces a refined Skill candidate', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-refinement-'));
    const { project, suitesRoot, sourceSkill } = createSuite(root);
    const sandboxRoot = path.join(root, 'sandboxes');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const dockerCalls = [];
    const resolvedRefs = [];
    const templateModel = {
        chat() {},
        info: () => ({ ref: 'vendor@interface/template-model', model: 'template-model' }),
    };
    const reflectionModel = {
        complete() {},
        info: () => ({ ref: 'vendor@interface/reflection-model', model: 'reflection-model' }),
    };
    const modelResolver = {
        resolve(ref) {
            resolvedRefs.push(ref);
            if (ref.endsWith('/template-model')) return templateModel;
            if (ref.endsWith('/reflection-model')) return reflectionModel;
            throw new Error(`Unexpected model: ${ref}`);
        },
    };
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
    const rolloutExecutor = async ({ model, rolloutId, workspace }) => {
        assert.equal(model, templateModel);
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
    const skillRefiner = async ({ model, suite, rollouts }) => {
        assert.equal(model, reflectionModel);
        assert.match(suite.skill, /Prefer small patches/);
        assert.equal(rollouts[0].id, 'rollout-001');
        return '# Refined Skill\nPrefer the smallest verified patch.';
    };
    const service = new SkillRefinementService('refinement-session', {
        sandboxRoot,
        projectRoot: project,
        suitesRoot,
    }, { client, modelResolver, rolloutExecutor, skillRefiner });

    assert.equal(service.listSuites().suites[0].id, 'sample-suite');
    assert.equal(
        service.listSuites().suites[0].reflectionModel,
        'vendor@interface/reflection-model'
    );
    const result = await service.refine({ suiteId: 'sample-suite' });

    assert.equal(result.run.status, 'completed');
    assert.equal(result.best.rolloutId, 'rollout-001');
    assert.equal(result.ranking.at(-1).rolloutId, 'rollout-003');
    assert.deepEqual(result.ranking.at(-1).protectedPathViolations, ['test']);
    assert.equal(dockerCalls.length, 2, 'protected rollout must not reach the evaluator');
    assert.match(result.candidateSkill.content, /Refined Skill/);
    assert.equal(result.models.template.model, 'template-model');
    assert.equal(result.models.reflection.model, 'reflection-model');
    assert.deepEqual(resolvedRefs.sort(), [
        'vendor@interface/reflection-model',
        'vendor@interface/template-model',
    ]);
    assert.equal(fs.readFileSync(result.candidateSkill.path, 'utf8').trim(), result.candidateSkill.content);
    assert.match(fs.readFileSync(result.evidencePath, 'utf8'), /"reward":-1/);
    assert.equal(result.rawTrajectoryPath, result.evidencePath);
    assert.match(path.basename(result.rawTrajectoryPath), /raw-rollout-trajectories\.jsonl/);
    assert.match(fs.readFileSync(result.rawTrajectoryPath, 'utf8'), /"agentError":null/);
    assert.match(fs.readFileSync(sourceSkill, 'utf8'), /Seed Skill/);
    assert.equal(service.history()[0].id, result.run.id);
    assert.equal(service.result(result.run.id).candidateSkill.content, result.candidateSkill.content);
});

test('Skill Refinement model roles fall back explicitly and reject unresolved suite references', async () => {
    const currentModel = {
        chat() {},
        complete() {},
        info: () => ({ ref: null, model: 'current-model', maxContextTokens: 1000 }),
    };
    const fallback = await resolveRefinementModels({
        suite: { templateModel: null, reflectionModel: null },
        defaultModel: currentModel,
        modelResolver: null,
    });
    assert.equal(fallback.template.model, currentModel);
    assert.equal(fallback.reflection.model, currentModel);
    assert.equal(fallback.template.info.source, 'current');

    await assert.rejects(
        resolveRefinementModels({
            suite: { templateModel: 'vendor/template', reflectionModel: null },
            defaultModel: currentModel,
            modelResolver: null,
        }),
        /modelResolver capability is unavailable/
    );
});

test('Skill Refinement preserves raw trajectories when reflection synthesis fails', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-refinement-failure-'));
    const { project, suitesRoot } = createSuite(root, {
        templateModel: null,
        reflectionModel: null,
        rollouts: 2,
        protectedPaths: [],
    });
    const sandboxRoot = path.join(root, 'sandboxes');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const artifacts = new RefinementArtifactRepository('failed-reflection', {
        sandboxRoot,
        maxRuns: 20,
    });
    const model = {
        chat() {},
        complete() {},
        info: () => ({ model: 'current-model' }),
    };
    const rollouts = {
        async run({ runId, rolloutIndex }) {
            return {
                id: `rollout-00${rolloutIndex + 1}`,
                runId,
                workspace: null,
                reply: 'done',
                messages: [{ role: 'assistant', content: 'done' }],
                agentError: null,
                evaluation: { ok: true, exitCode: 0, durationMs: 1, stdout: 'passed', stderr: '' },
                protectedPathViolations: [],
                diff: { fileCount: 0, changedBytes: 0, files: [] },
                score: 1,
            };
        },
    };
    let rawPathSeenByReflection = null;
    const orchestrator = new SkillRefinementOrchestrator({
        projectRoot: project,
        suitesRoot,
    }, {
        artifacts,
        rollouts,
        defaultModel: model,
        async skillRefiner() {
            const runDirectories = fs.readdirSync(artifacts.runRoot);
            assert.equal(runDirectories.length, 1);
            rawPathSeenByReflection = path.join(
                artifacts.runRoot,
                runDirectories[0],
                'raw-rollout-trajectories.jsonl'
            );
            assert.equal(fs.existsSync(rawPathSeenByReflection), true);
            throw new Error('reflection synthesis failed');
        },
    });

    await assert.rejects(orchestrator.refine({ suiteId: 'sample-suite' }), /reflection synthesis failed/);
    const failedRun = artifacts.history(1)[0];
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.rawTrajectoryPath, rawPathSeenByReflection);
    assert.equal(fs.existsSync(failedRun.rawTrajectoryPath), true);
    assert.equal(fs.readFileSync(failedRun.rawTrajectoryPath, 'utf8').trim().split(/\r?\n/).length, 2);
});

test('Skill Refinement components expose narrow, non-overlapping responsibilities', () => {
    assert.equal(typeof SkillRefinementOrchestrator.prototype.refine, 'function');
    assert.equal(typeof SkillRefinementOrchestrator.prototype.status, 'undefined');
    assert.equal(typeof SandboxEvaluator.prototype.execute, 'function');
    assert.equal(typeof SandboxEvaluator.prototype.refine, 'undefined');
    assert.equal(typeof RefinementArtifactRepository.prototype.history, 'function');
    assert.equal(typeof RefinementArtifactRepository.prototype.execute, 'undefined');
    assert.equal(typeof SkillRefinementService.prototype.refine, 'function');
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
    assert.deepEqual(skillRefinementTool.capabilities.optional, ['model', 'modelResolver']);
    assert.equal(tools.names().some(name => name.includes('training')), false);
    assert.equal(JSON.parse(await handler({ action: 'list_suites' }, context, capabilities)).suites.length, 0);
    assert.equal(JSON.parse(await handler({ action: 'refine', suiteId: 'suite' }, context, capabilities)).candidateSkill != null, true);
    context.metadata.type = 'subagent';
    const blocked = JSON.parse(await handler({ action: 'refine', suiteId: 'suite' }, context, capabilities));
    assert.match(blocked.error, /Subagents may not start/);
    assert.deepEqual(calls.slice(0, 4), ['list_suites', 'dispose', ['refine', { suiteId: 'suite' }], 'dispose']);
});

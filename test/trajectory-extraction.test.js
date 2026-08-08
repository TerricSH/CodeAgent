const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../tools');
const trajectoryTool = require('../tools/trajectory-extract');
const { TrajectoryExtractor } = require('../trajectory-extraction');
const { WorkspaceService } = require('../workspace/service');
const { WorkspaceAccess } = require('../workspace/access');

function rawRecord(id = 'rollout-001', reward = 0) {
    return {
        id,
        runId: 'run-001',
        suiteId: 'suite-001',
        recordType: 'skill-refinement-rollout',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:02.000Z',
        task: 'Fix the failing test.',
        skill: '# Test Skill\nRun the verifier.',
        messages: [
            { role: 'user', content: 'Fix the failing test.', created_at: '2026-01-01T00:00:00.000Z' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call-1',
                    type: 'function',
                    function: {
                        name: 'sandbox_exec',
                        arguments: JSON.stringify({ command: 'npm test', accessToken: 'must-not-leak' }),
                    },
                }],
            },
            {
                role: 'tool',
                tool_call_id: 'call-1',
                content: JSON.stringify({ exitCode: 0, stdout: 'ok', authorization: 'Bearer secret' }),
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call-2',
                    type: 'function',
                    function: {
                        name: 'sandbox_exec',
                        arguments: JSON.stringify({ command: 'npm test', accessToken: 'must-not-leak' }),
                    },
                }],
            },
            {
                role: 'tool',
                tool_call_id: 'call-2',
                content: JSON.stringify({ ok: false, error: 'test failed' }),
            },
            { role: 'assistant', content: 'Finished.' },
        ],
        finalReply: 'Finished.',
        evaluation: {
            ok: false,
            exitCode: 1,
            errorCode: 'TEST_FAILED',
            stderr: 'one assertion failed',
        },
        protectedPathViolations: [],
        diff: {
            fileCount: 1,
            changedBytes: 12,
            files: [{ path: 'source.js', status: 'modified' }],
        },
        reward,
    };
}

test('TrajectoryExtractor pairs messages into traceable spans and redacts secrets', () => {
    const trajectory = new TrajectoryExtractor().extract(rawRecord());
    const toolSpans = trajectory.spans.filter(span => span.spanKind === 'tool');

    assert.equal(trajectory.outcome.status, 'failed');
    assert.equal(trajectory.context.task, 'Fix the failing test.');
    assert.match(trajectory.context.skill, /Test Skill/);
    assert.equal(trajectory.startedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(toolSpans.length, 2);
    assert.deepEqual(toolSpans[0].source.messageIndexes, [1, 2]);
    assert.equal(toolSpans[0].phase, 'verification');
    assert.equal(toolSpans[0].status.code, 'ok');
    assert.equal(toolSpans[0].input.accessToken, '[REDACTED]');
    assert.equal(toolSpans[0].output.authorization, '[REDACTED]');
    assert.equal(toolSpans[1].status.code, 'error');
    assert.deepEqual(trajectory.signals.failedSpanIds, [toolSpans[1].spanId]);
    assert.equal(trajectory.signals.repeatedToolCalls[0].count, 2);
    assert.ok(trajectory.signals.failureReasons.some(reason => reason.code === 'TEST_FAILED'));
    assert.match(trajectory.signals.verifierLinks[0].note, /not proof of causality/);
});

test('trajectory_extract cleans a saved JSONL file without overwriting the raw process', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-'));
    try {
        const source = path.join(root, 'raw-rollout-trajectories.jsonl');
        const sourceContent = `${JSON.stringify(rawRecord('rollout-001', 0))}\n${JSON.stringify({
            ...rawRecord('rollout-002', 1),
            evaluation: { ok: true, exitCode: 0, stdout: 'passed' },
        })}\n`;
        fs.writeFileSync(source, sourceContent, 'utf8');
        const fileSystem = new WorkspaceAccess(new WorkspaceService({ root }));
        const handler = trajectoryTool.createHandler();

        const response = JSON.parse(handler(
            { sourcePath: 'raw-rollout-trajectories.jsonl' },
            {},
            { fileSystem }
        ));

        assert.equal(response.ok, true);
        assert.equal(response.summary.trajectoryCount, 2);
        assert.equal(response.outputPath, 'raw-rollout-trajectories.cleaned.json');
        assert.equal(fs.readFileSync(source, 'utf8'), sourceContent);
        const cleaned = JSON.parse(fs.readFileSync(path.join(root, response.outputPath), 'utf8'));
        assert.equal(cleaned.trajectories.length, 2);
        assert.equal(cleaned.comparison.outcomes.succeeded, 1);

        const overwrite = JSON.parse(handler(
            {
                sourcePath: 'raw-rollout-trajectories.jsonl',
                outputPath: 'raw-rollout-trajectories.jsonl',
            },
            {},
            { fileSystem }
        ));
        assert.equal(overwrite.ok, false);
        assert.match(overwrite.error, /must not overwrite/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Skill Refinement and trajectory extraction are joined only by the saved file format', () => {
    const refinementSources = [
        'service.js',
        'orchestrator.js',
        'rollout-coordinator.js',
        'refiner.js',
    ].map(file => fs.readFileSync(path.join(__dirname, '..', 'skill-refinement', file), 'utf8'));

    assert.equal(tools.has('trajectory_extract'), true);
    assert.deepEqual(trajectoryTool.capabilities.required, ['fileSystem']);
    for (const source of refinementSources) {
        assert.doesNotMatch(source, /trajectory-extraction|trajectory_extract|TrajectoryExtractor/);
    }
});

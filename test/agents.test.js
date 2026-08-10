const test = require('node:test');
const assert = require('node:assert/strict');
const agents = require('../agents');
const delegateAgent = require('../tools/delegate-agent');

test('tester and coverage verifier are registered as separate subagents', () => {
    const names = agents.list().map(agent => agent.name);

    assert.ok(names.includes('tester'));
    assert.ok(names.includes('coverage-verifier'));
    assert.match(delegateAgent.definition.function.parameters.properties.agent.enum.join(','), /tester/);
    assert.match(delegateAgent.definition.function.parameters.properties.agent.enum.join(','), /coverage-verifier/);
});

test('verification subagents can inspect and execute but have no file-writing tools', () => {
    for (const name of ['tester', 'coverage-verifier']) {
        const agent = agents.get(name);

        assert.ok(agent.tools.includes('run_command'));
        assert.ok(agent.tools.includes('read_file'));
        assert.ok(agent.tools.includes('read_files'));
        assert.equal(agent.tools.includes('write_file'), false);
        assert.equal(agent.tools.includes('write_files'), false);
        assert.match(agent.prompt, /PASS/);
        assert.match(agent.prompt, /FAIL/);
        assert.match(agent.prompt, /INCONCLUSIVE/);
    }
});

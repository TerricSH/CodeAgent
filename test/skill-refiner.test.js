const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitOversizedSpan,
    partitionTrajectory,
    reflectSkillPatch,
} = require('../skill-refinement/refiner');

test('oversized trajectory spans are partitioned as lossless serialized fragments', () => {
    const span = {
        spanId: 'large-span',
        kind: 'model_request',
        content: '',
        payload: { messages: [{ role: 'user', content: 'x'.repeat(12000) }] },
    };
    const fragments = splitOversizedSpan(span, 4000);
    assert.ok(fragments.length > 1);
    assert.ok(fragments.every(fragment => fragment.kind === 'serialized_span_fragment'));
    assert.equal(fragments.map(fragment => fragment.content).join(''), JSON.stringify(span));

    const chunks = partitionTrajectory([span], {
        maxContextTokens: 6000,
        maxOutputTokens: 4000,
    });
    assert.ok(chunks.length > 1);
    const partitioned = chunks.flat();
    assert.equal(partitioned.map(fragment => fragment.content).join(''), JSON.stringify(span));
});

test('reflection processes every trajectory chunk and aggregates structured patches', async () => {
    let chunkCalls = 0;
    let aggregateCalls = 0;
    const model = {
        info: () => ({ maxContextTokens: 20000, maxOutputTokens: 4000 }),
        async completeDetailed(messages) {
            const prompt = messages.at(-1).content;
            if (prompt.includes('Patches derived from all lossless trajectory chunks')) {
                aggregateCalls += 1;
                return {
                    reasoning: 'aggregate all chunk findings',
                    content: JSON.stringify({
                        reasoning: 'combined',
                        edits: [{ op: 'append', content: 'combined rule' }],
                    }),
                };
            }
            chunkCalls += 1;
            return {
                reasoning: `reason over chunk ${chunkCalls}`,
                content: JSON.stringify({
                    reasoning: `chunk ${chunkCalls}`,
                    edits: [{ op: 'append', content: `rule ${chunkCalls}` }],
                }),
            };
        },
        complete() {},
    };
    const result = await reflectSkillPatch({
        model,
        suite: { id: 'suite', task: 'fixed task' },
        trajectory: {
            spans: [{
                spanId: 'large-span',
                kind: 'batch_summary',
                content: 'evidence'.repeat(2000),
            }],
        },
        currentSkill: '# Skill\nCurrent rule.',
        epoch: 1,
        step: 1,
    });

    assert.ok(chunkCalls > 1);
    assert.equal(aggregateCalls, 1);
    assert.equal(result.patch.edits[0].op, 'append');
    assert.equal(result.patch.edits[0].content, 'combined rule');
    assert.equal(result.modelReasoning, 'aggregate all chunk findings');
});

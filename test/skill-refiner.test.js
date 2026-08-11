const test = require('node:test');
const assert = require('node:assert/strict');
const { reflectSkillPatch } = require('../skill-refinement/refiner');

test('reflection rejects the removed single-trajectory input contract', async () => {
    await assert.rejects(
        reflectSkillPatch({
            model: { completeDetailed() {} },
            suite: {
                optimizer: {
                    reflectionMinibatchSize: 1,
                    mergeBatchSize: 1,
                    analystWorkers: 1,
                    reflectionRounds: 1,
                },
            },
            currentSkill: '# Skill',
            epoch: 1,
            step: 1,
            editBudget: 1,
            rollouts: [],
            trajectory: { spans: [] },
        }),
        /non-empty evidenceBatches/
    );
});

function rollout(id, taskItem, success) {
    return {
        id,
        taskId: taskItem.id,
        taskItem,
        score: success ? 1 : 0,
        success,
        reply: success ? 'completed correctly' : 'incorrect result',
        messages: [],
        agentError: null,
        evaluation: { ok: success, failureType: success ? 'success' : 'task' },
        protectedPathViolations: [],
        diff: { fileCount: 0, changedBytes: 0, files: [] },
    };
}

test('reflection separates failures and successes, merges hierarchically, and enforces Top-L', async () => {
    const calls = { failure: 0, success: 0, merge: 0, rank: 0 };
    const model = {
        info: () => ({ maxContextTokens: 30000, maxOutputTokens: 4000 }),
        async completeDetailed(messages) {
            const prompt = messages.at(-1).content;
            if (prompt.includes('# Failed scored trajectories')) {
                calls.failure += 1;
                return {
                    reasoning: 'failure analysis',
                    content: JSON.stringify({
                        failure_summary: [{ failure_type: 'verification', count: 1 }],
                        edits: [{
                            op: 'append',
                            content: 'Verify the final result before responding.',
                            support_count: 2,
                            source_type: 'failure',
                        }],
                    }),
                };
            }
            if (prompt.includes('# Successful scored trajectories')) {
                calls.success += 1;
                return {
                    reasoning: 'success analysis',
                    content: JSON.stringify({
                        success_patterns: ['small changes work'],
                        edits: [{
                            op: 'append',
                            content: 'Prefer focused changes.',
                            support_count: 1,
                            source_type: 'success',
                        }],
                    }),
                };
            }
            if (prompt.includes('# Merge stage')) {
                calls.merge += 1;
                const final = prompt.includes('final failure-prioritized merge');
                return {
                    reasoning: 'hierarchical merge',
                    content: JSON.stringify({
                        edits: final ? [
                            {
                                op: 'append',
                                content: 'Verify the final result before responding.',
                                support_count: 4,
                                source_type: 'failure',
                                merge_level: 2,
                            },
                            {
                                op: 'append',
                                content: 'Prefer focused changes.',
                                support_count: 2,
                                source_type: 'success',
                                merge_level: 2,
                            },
                        ] : [{
                            op: 'append',
                            content: prompt.includes('failure consolidation')
                                ? 'Verify the final result before responding.'
                                : 'Prefer focused changes.',
                            support_count: 2,
                            source_type: prompt.includes('failure consolidation') ? 'failure' : 'success',
                            merge_level: 1,
                        }],
                    }),
                };
            }
            if (prompt.includes('# Maximum edits')) {
                calls.rank += 1;
                return {
                    reasoning: 'rank recurring failures first',
                    content: JSON.stringify({
                        edits: [{
                            op: 'append',
                            content: 'Verify the final result before responding.',
                            support_count: 4,
                            source_type: 'failure',
                            merge_level: 2,
                        }],
                    }),
                };
            }
            throw new Error(`Unexpected optimizer prompt: ${prompt.slice(0, 80)}`);
        },
    };
    const items = Array.from({ length: 4 }, (_, index) => ({
        id: `train-${index + 1}`,
        split: 'train',
        task: `task ${index + 1}`,
    }));
    const evidenceBatch = {
        id: 'train-batch',
        items,
        rollouts: [
            rollout('rollout-001', items[0], false),
            rollout('rollout-002', items[1], false),
            rollout('rollout-003', items[2], true),
            rollout('rollout-004', items[3], true),
        ],
        trajectory: { spans: [] },
    };
    const result = await reflectSkillPatch({
        model,
        suite: {
            id: 'suite',
            optimizer: {
                reflectionMinibatchSize: 1,
                mergeBatchSize: 8,
                analystWorkers: 4,
                reflectionRounds: 1,
                editBudget: { initial: 1 },
            },
        },
        evidenceBatches: [evidenceBatch],
        currentSkill: '# Skill\nCurrent rule.',
        epoch: 1,
        step: 1,
        editBudget: 1,
    });

    assert.deepEqual(calls, { failure: 2, success: 2, merge: 3, rank: 1 });
    assert.equal(result.analysis.failureMinibatches, 2);
    assert.equal(result.analysis.successMinibatches, 2);
    assert.equal(result.patch.edits.length, 1);
    assert.equal(result.patch.edits[0].sourceType, 'failure');
    assert.equal(result.patch.edits[0].content, 'Verify the final result before responding.');
    assert.equal(result.failurePatterns.length, 2);
});

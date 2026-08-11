const path = require('node:path');
const { loadPromptTemplate } = require('../prompts/loader');
const { stripFence } = require('./skill-patch');

const renderSlowUpdate = loadPromptTemplate(path.join(__dirname, 'prompts', 'slow-update-user.md'));
const renderMetaUpdate = loadPromptTemplate(path.join(__dirname, 'prompts', 'meta-update-user.md'));

async function completeJson(model, messages, purpose, trajectoryContext) {
    if (!model || typeof model.completeDetailed !== 'function') {
        throw new Error(`Optimizer ${purpose} requires completeDetailed()`);
    }
    const response = await model.completeDetailed(messages, { purpose, trajectoryContext });
    let value;
    try {
        value = JSON.parse(stripFence(response.content));
    } catch (error) {
        throw new Error(`Optimizer ${purpose} response is not valid JSON: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Optimizer ${purpose} response must be an object`);
    }
    return { value, modelReasoning: response.reasoning || '' };
}

function compactRollout(rollout) {
    return {
        taskId: rollout.taskId,
        reward: rollout.score,
        success: rollout.success,
        finalReply: rollout.reply,
        evaluation: {
            ok: rollout.evaluation?.ok ?? false,
            failureType: rollout.evaluation?.failureType || null,
            error: rollout.evaluation?.error || null,
        },
    };
}

function compareSlowBatches(previousBatch, currentBatch) {
    const previous = new Map((previousBatch.rollouts || []).map(item => [item.taskId, item]));
    const groups = {
        improved: [],
        regressed: [],
        persistentFailures: [],
        stableSuccesses: [],
    };
    for (const current of currentBatch.rollouts || []) {
        const before = previous.get(current.taskId);
        if (!before) continue;
        const pair = { previous: compactRollout(before), current: compactRollout(current) };
        if (current.score > before.score) groups.improved.push(pair);
        else if (current.score < before.score) groups.regressed.push(pair);
        else if (current.success && before.success) groups.stableSuccesses.push(pair);
        else groups.persistentFailures.push(pair);
    }
    return groups;
}

async function generateSlowUpdate(options) {
    const comparison = compareSlowBatches(options.previousBatch, options.currentBatch);
    const result = await completeJson(options.model, [{
        role: 'user',
        content: renderSlowUpdate({
            previousSkill: options.previousSkill,
            currentSkill: options.currentSkill,
            comparison: JSON.stringify(comparison, null, 2),
            metaSkill: options.metaSkill || '(none)',
        }),
    }], 'slow-update', {
        suiteId: options.suite.id,
        epoch: options.epoch,
    });
    const content = typeof result.value.slow_update_content === 'string'
        ? result.value.slow_update_content.trim()
        : '';
    if (!content) throw new Error('Optimizer slow-update response omitted slow_update_content');
    if (content.length > 16000) throw new Error('Optimizer slow-update content exceeds 16000 characters');
    return {
        content,
        reasoning: typeof result.value.reasoning === 'string' ? result.value.reasoning : '',
        modelReasoning: result.modelReasoning,
        comparison,
    };
}

async function generateMetaUpdate(options) {
    const result = await completeJson(options.model, [{
        role: 'user',
        content: renderMetaUpdate({
            metaSkill: options.metaSkill || '(none)',
            history: JSON.stringify(options.history || [], null, 2),
            rejectedBuffer: JSON.stringify(options.rejectedBuffer || [], null, 2),
        }),
    }], 'meta-update', {
        suiteId: options.suite.id,
        epoch: options.epoch,
    });
    const content = typeof result.value.meta_skill_content === 'string'
        ? result.value.meta_skill_content.trim()
        : '';
    if (content.length > 16000) throw new Error('Optimizer meta skill exceeds 16000 characters');
    return {
        content,
        reasoning: typeof result.value.reasoning === 'string' ? result.value.reasoning : '',
        modelReasoning: result.modelReasoning,
    };
}

module.exports = {
    compareSlowBatches,
    generateSlowUpdate,
    generateMetaUpdate,
};

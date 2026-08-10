const test = require('node:test');
const assert = require('node:assert/strict');
const OpenAICompatible = require('../model-providers/interfaces/openai-compatible');
const ResponsesCompatible = require('../model-providers/interfaces/responses-compatible');
const AnthropicCompatible = require('../model-providers/interfaces/anthropic-compatible');

const messages = [{ role: 'user', content: 'reason about this task' }];

test('model interfaces translate the common reasoning request to each API protocol', () => {
    const openai = new OpenAICompatible({ apiKey: 'test', model: 'reasoning-model' });
    const openaiParams = openai.buildParams(messages, {
        reasoning: { enabled: true, required: true, effort: 'high' },
    });
    assert.equal(openaiParams.reasoning_effort, 'high');

    const responses = new ResponsesCompatible({ apiKey: 'test', model: 'reasoning-model' });
    const responsesParams = responses.buildParams(messages, {
        reasoning: { enabled: true, required: true, effort: 'high', summary: 'detailed' },
    });
    assert.deepEqual(responsesParams.reasoning, { effort: 'high', summary: 'detailed' });

    const anthropic = new AnthropicCompatible({
        apiKey: 'test',
        model: 'reasoning-model',
        maxOutputTokens: 4096,
    });
    const anthropicBody = anthropic.buildBody(messages, {
        reasoning: { enabled: true, required: true, budgetTokens: 1536 },
    });
    assert.deepEqual(anthropicBody.thinking, { type: 'enabled', budget_tokens: 1536 });
});

test('provider request options can explicitly override automatic reasoning defaults', () => {
    const openai = new OpenAICompatible({
        apiKey: 'test',
        model: 'reasoning-model',
        requestOptions: { reasoning_effort: 'low' },
    });
    assert.equal(openai.buildParams(messages, {
        reasoning: { enabled: true, effort: 'high' },
    }).reasoning_effort, 'low');

    const responses = new ResponsesCompatible({
        apiKey: 'test',
        model: 'reasoning-model',
        requestOptions: { reasoning: { effort: 'low', summary: 'auto' } },
    });
    assert.deepEqual(responses.buildParams(messages, {
        reasoning: { enabled: true, effort: 'high' },
    }).reasoning, { effort: 'low', summary: 'auto' });
});

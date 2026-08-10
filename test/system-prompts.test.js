const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPrompt, renderPrompt, loadPromptTemplate } = require('../prompts/loader');
const { buildSummaryRequest } = require('../plugins/auto-compaction/compactor');
const { formatSection } = require('../plugins/ask-user/format');
const { buildRefinementRolloutPrompt } = require('../skill-refinement/rollout-runner');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRECTORIES = new Set(['.git', '.code', 'node_modules', 'test']);

function productionJavaScript(root = PROJECT_ROOT) {
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...productionJavaScript(target));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
    return files;
}

const SYSTEM_PROMPT_FILES = [
    'prompts/system-policy.md',
    'agents/coder/prompt.md',
    'agents/researcher/prompt.md',
    'agents/tester/prompt.md',
    'agents/coverage-verifier/prompt.md',
    'plugins/verification-gate/prompt.md',
    'plugins/verification-gate/prompts/active-system.md',
    'plugins/auto-compaction/prompts/summary-system.md',
    'plugins/memory/prompts/resume-system.md',
    'plugins/memory/prompts/recall-system.md',
    'plugins/ask-user/prompts/history-system.md',
    'skill-refinement/prompts/refiner-system.md',
    'skill-refinement/prompts/rollout-system.md',
    'tools/activate-skill/prompts/active-skill-system.md',
    'tools/activate-skill/prompt.md',
    'tools/skill-search/prompt.md',
    'tools/trajectory-extract/prompt.md',
    'plugins/memory/prompt.md',
    'context/prompts/cache-summary.md',
    'context/prompts/source-reference.md',
    'tools/image-inspect/prompts/system.md',
];

test('all runtime system prompts are stored in non-empty Markdown files', () => {
    for (const relative of SYSTEM_PROMPT_FILES) {
        const file = path.join(PROJECT_ROOT, relative);
        assert.equal(fs.existsSync(file), true, `${relative} is missing`);
        assert.ok(loadPrompt(file).length > 0, `${relative} is empty`);
    }
});

test('production JavaScript does not hardcode system prompt content', () => {
    const forbidden = [
        {
            label: 'direct role:system content literal',
            pattern: /role\s*:\s*['"]system['"]\s*,\s*content\s*:\s*(?:['"`]|\[)/s,
        },
        {
            label: 'SYSTEM_PROMPT literal',
            pattern: /(?:const|let|var)\s+[A-Za-z0-9_]*SYSTEM_PROMPT[A-Za-z0-9_]*\s*=\s*(?:['"`]|\[)/i,
        },
        {
            label: 'literal Context system prompt',
            pattern: /new\s+Context\s*\(\s*(?:['"`]|\[)/s,
        },
        {
            label: 'literal systemPrompt.set content',
            pattern: /systemPrompt\.set\s*\(\s*(?:['"`]|\[)/s,
        },
        {
            label: 'literal systemPrompt section content',
            pattern: /systemPrompt\.upsertSection\s*\([^,]+,\s*(?:['"`]|\[)/s,
        },
    ];

    const violations = [];
    for (const file of productionJavaScript()) {
        const source = fs.readFileSync(file, 'utf8');
        for (const rule of forbidden) {
            if (rule.pattern.test(source)) {
                violations.push(`${path.relative(PROJECT_ROOT, file)}: ${rule.label}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('prompt loader renders required values and optional blocks without mutating source files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-prompts-'));
    try {
        const file = path.join(root, 'sample.md');
        const source = 'Hello {{name}}.\n{{#details}}Details: {{details}}{{/details}}';
        fs.writeFileSync(file, source, 'utf8');
        const render = loadPromptTemplate(file);

        assert.equal(render({ name: 'Agent', details: '' }), 'Hello Agent.');
        assert.equal(render({ name: 'Agent', details: 'verified' }), 'Hello Agent.\nDetails: verified');
        assert.throws(() => renderPrompt('{{missing}}', {}), /value is missing/);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('dynamic system prompt builders render external templates with runtime data', () => {
    const summary = buildSummaryRequest([{ role: 'user', content: 'keep this' }], 321);
    assert.equal(summary[0].role, 'system');
    assert.match(summary[0].content, /321/);
    assert.match(summary[1].content, /keep this/);

    const rollout = buildRefinementRolloutPrompt({
        rolloutId: 'rollout-007',
        suite: {
            protectedPaths: ['test'],
            skill: '# Candidate\nVerify first.',
        },
    });
    assert.match(rollout, /rollout-007/);
    assert.match(rollout, /- test/);
    assert.match(rollout, /Verify first/);

    const history = formatSection([{ pairs: [{ question: 'Target?', answer: 'Game' }] }]);
    assert.match(history, /已收集的基础信息/);
    assert.match(history, /Target/);
    assert.match(history, /Game/);
});

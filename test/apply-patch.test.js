const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const applyPatch = require('../tools/apply-patch');
const tools = require('../tools');
const agents = require('../agents');
const { WorkspaceManager } = require('../workspace');

function fixture(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-apply-patch-'));
    const root = path.join(parent, 'root');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const manager = new WorkspaceManager({ root });
    const capabilities = manager.createRuntimeCapabilities();
    return { parent, root, outside, capabilities };
}

function patch(lines) {
    return lines.join('\n');
}

test('apply_patch transactionally adds, updates, and deletes multiple files', (t) => {
    const { root, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'existing.txt'), 'alpha\r\nbeta\r\n', 'utf8');
    fs.writeFileSync(path.join(root, 'obsolete.txt'), 'remove me\n', 'utf8');

    const result = JSON.parse(applyPatch.handler({
        patch: patch([
            '*** Begin Patch',
            '*** Update File: existing.txt',
            '@@ -1,2 +1,2 @@',
            ' alpha',
            '-beta',
            '+gamma',
            '*** Add File: nested/new.txt',
            '+created',
            '*** Delete File: obsolete.txt',
            '*** End Patch',
        ]),
    }, null, { fileSystem: capabilities.fileSystem }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.summary, { total: 3, added: 1, updated: 1, deleted: 1 });
    assert.equal(result.transaction.committed, true);
    assert.deepEqual(result.transaction.cleanupWarnings, []);
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'alpha\r\ngamma\r\n');
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'new.txt'), 'utf8'), 'created\n');
    assert.equal(fs.existsSync(path.join(root, 'obsolete.txt')), false);
});

test('apply_patch leaves every file unchanged when any hunk fails preflight', (t) => {
    const { root, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'one.txt'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(root, 'two.txt'), 'two\n', 'utf8');

    const result = JSON.parse(applyPatch.handler({
        patch: patch([
            '*** Begin Patch',
            '*** Update File: one.txt',
            '@@',
            '-one',
            '+changed one',
            '*** Update File: two.txt',
            '@@',
            '-missing context',
            '+changed two',
            '*** End Patch',
        ]),
    }, null, { fileSystem: capabilities.fileSystem }));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'PATCH_CONTEXT_MISMATCH');
    assert.deepEqual(result.transaction, {
        committed: false,
        rolledBack: false,
        unchanged: true,
        phase: 'preflight',
        cleanupWarnings: [],
    });
    assert.equal(fs.readFileSync(path.join(root, 'one.txt'), 'utf8'), 'one\n');
    assert.equal(fs.readFileSync(path.join(root, 'two.txt'), 'utf8'), 'two\n');
});

test('apply_patch preflights all workspace paths before writing', (t) => {
    const { root, outside, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'inside.txt'), 'before\n', 'utf8');
    const blockedPath = path.join(outside, 'blocked.txt');

    const result = JSON.parse(applyPatch.handler({
        patch: patch([
            '*** Begin Patch',
            '*** Update File: inside.txt',
            '@@',
            '-before',
            '+after',
            `*** Add File: ${blockedPath}`,
            '+blocked',
            '*** End Patch',
        ]),
    }, null, { fileSystem: capabilities.fileSystem }));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'WORKSPACE_APPROVAL_REQUIRED');
    assert.equal(result.nextTool, 'workspace__workspace_request_access');
    assert.equal(result.transaction.unchanged, true);
    assert.equal(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8'), 'before\n');
    assert.equal(fs.existsSync(blockedPath), false);
});

test('apply_patch rolls back files already committed when a later rename fails', (t) => {
    const { root, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'one.txt'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(root, 'two.txt'), 'two\n', 'utf8');

    let renameCount = 0;
    const failingFileOps = new Proxy(fs, {
        get(target, property, receiver) {
            if (property !== 'renameSync') return Reflect.get(target, property, receiver);
            return (source, destination) => {
                renameCount += 1;
                if (renameCount === 4) {
                    const error = new Error('injected commit failure');
                    error.code = 'EIO';
                    throw error;
                }
                return fs.renameSync(source, destination);
            };
        },
    });
    const handler = applyPatch.createHandler({
        fileOps: failingFileOps,
        transactionId: () => 'rollback-test',
    });

    const result = JSON.parse(handler({
        patch: patch([
            '*** Begin Patch',
            '*** Update File: one.txt',
            '@@',
            '-one',
            '+changed one',
            '*** Update File: two.txt',
            '@@',
            '-two',
            '+changed two',
            '*** End Patch',
        ]),
    }, null, { fileSystem: capabilities.fileSystem }));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'PATCH_COMMIT_FAILED');
    assert.equal(result.transaction.committed, false);
    assert.equal(result.transaction.rolledBack, true);
    assert.equal(result.transaction.unchanged, true);
    assert.equal(fs.readFileSync(path.join(root, 'one.txt'), 'utf8'), 'one\n');
    assert.equal(fs.readFileSync(path.join(root, 'two.txt'), 'utf8'), 'two\n');
    assert.deepEqual(fs.readdirSync(root).sort(), ['one.txt', 'two.txt']);
});

test('apply_patch cleans staged files and new directories when preparation fails', (t) => {
    const { root, capabilities } = fixture(t);
    let writeCount = 0;
    const failingFileOps = new Proxy(fs, {
        get(target, property, receiver) {
            if (property !== 'writeFileSync') return Reflect.get(target, property, receiver);
            return (...args) => {
                writeCount += 1;
                if (writeCount === 2) {
                    const error = new Error('injected staging failure');
                    error.code = 'ENOSPC';
                    throw error;
                }
                return fs.writeFileSync(...args);
            };
        },
    });
    const handler = applyPatch.createHandler({
        fileOps: failingFileOps,
        transactionId: () => 'staging-test',
    });

    const result = JSON.parse(handler({
        patch: patch([
            '*** Begin Patch',
            '*** Add File: nested/one.txt',
            '+one',
            '*** Add File: nested/two.txt',
            '+two',
            '*** End Patch',
        ]),
    }, null, { fileSystem: capabilities.fileSystem }));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'PATCH_STAGE_FAILED');
    assert.equal(result.transaction.unchanged, true);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('apply_patch is a core write tool available to the coder agent', () => {
    assert.equal(tools.has('apply_patch'), true);
    assert.equal(tools.describe('apply_patch').effects, 'write');
    assert.equal(agents.get('coder').tools.includes('apply_patch'), true);
});

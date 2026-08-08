const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    WorkspaceService,
    WorkspaceAccess,
    WorkspaceApprovalRequiredError,
    WorkspaceManager,
} = require('../workspace');
const readFile = require('../tools/read-file');
const readFiles = require('../tools/read-files');
const writeFile = require('../tools/write-file');
const writeFiles = require('../tools/write-files');
const listDir = require('../tools/list-dir');
const runCommand = require('../tools/run-command');
const delegateAgent = require('../tools/delegate-agent');
const Context = require('../context');
const SessionRuntime = require('../runtime/session-runtime');
const commands = require('../runtime/commands');
const PluginRegistry = require('../plugins/registry');
const { definePlugin } = require('../plugins/define-plugin');
const workspacePlugin = require('../plugins/workspace');
const dockerSandboxPlugin = require('../plugins/docker-sandbox');
const MemoryService = require('../plugins/memory/service');

function fixture(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-workspace-'));
    const root = path.join(parent, 'root');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const manager = new WorkspaceManager({ root });
    const capabilities = manager.createRuntimeCapabilities();
    const context = new Context('test');
    return {
        parent,
        root,
        outside,
        manager,
        capabilities,
        workspace: manager.current,
        context,
    };
}

test('workspace resolves relative paths and requires approval for lexical escapes', (t) => {
    const { root, outside, workspace } = fixture(t);
    fs.writeFileSync(path.join(root, 'inside.txt'), 'inside', 'utf8');
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside', 'utf8');

    assert.equal(workspace.resolveExisting('inside.txt'), path.join(root, 'inside.txt'));
    assert.equal(workspace.resolveForWrite('nested/new.txt'), path.join(root, 'nested', 'new.txt'));
    assert.throws(
        () => workspace.resolveExisting('../outside/outside.txt'),
        (error) => error instanceof WorkspaceApprovalRequiredError
            && error.code === 'WORKSPACE_APPROVAL_REQUIRED'
            && error.reason === 'path_escape'
    );
    assert.throws(
        () => workspace.resolveForWrite('../outside/new.txt'),
        (error) => error instanceof WorkspaceApprovalRequiredError
            && error.access === 'write'
    );
    assert.equal('ragCollection' in workspace, false);
});

test('workspace requires approval for symbolic-link and junction escapes', (t) => {
    const { root, outside, workspace } = fixture(t);
    const link = path.join(root, 'linked');
    try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`symbolic links are unavailable: ${error.message}`);
        return;
    }

    assert.throws(
        () => workspace.resolveExisting('linked'),
        (error) => error instanceof WorkspaceApprovalRequiredError
            && error.reason === 'link_escape'
    );
    assert.throws(
        () => workspace.resolveForWrite('linked/new.txt'),
        (error) => error instanceof WorkspaceApprovalRequiredError
            && error.reason === 'link_escape'
    );
});

test('core tools consume narrow runtime capabilities instead of the workspace plugin', (t) => {
    const { root, outside, context, capabilities } = fixture(t);
    const fileCapabilities = { fileSystem: capabilities.fileSystem };
    const writeResult = writeFile.handler(
        { path: 'notes/item.txt', content: 'workspace-data' },
        context,
        fileCapabilities
    );
    assert.match(writeResult, /notes\/item\.txt/);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'item.txt'), 'utf8'), 'workspace-data');
    assert.equal(readFile.handler({ path: 'notes/item.txt' }, context, fileCapabilities), 'workspace-data');
    assert.match(listDir.handler({ path: 'notes' }, context, fileCapabilities), /item\.txt/);

    const outsidePath = path.join(outside, 'blocked.txt');
    const blocked = JSON.parse(writeFile.handler(
        { path: outsidePath, content: 'blocked' },
        context,
        fileCapabilities
    ));
    assert.equal(blocked.code, 'WORKSPACE_APPROVAL_REQUIRED');
    assert.equal(blocked.nextTool, 'workspace__workspace_request_access');
    assert.equal(fs.existsSync(outsidePath), false);
});

test('batch file tools process every item and report partial failures', (t) => {
    const { root, outside, context, capabilities } = fixture(t);
    const fileCapabilities = { fileSystem: capabilities.fileSystem };
    const blockedPath = path.join(outside, 'blocked.txt');
    const writeResult = JSON.parse(writeFiles.handler({
        files: [
            { path: 'one.txt', content: 'first' },
            { path: 'nested/two.txt', content: 'second' },
            { path: blockedPath, content: 'blocked' },
        ],
    }, context, fileCapabilities));

    assert.deepEqual(writeResult.summary, { total: 3, succeeded: 2, failed: 1 });
    assert.equal(writeResult.results[0].writtenPath, 'one.txt');
    assert.equal(writeResult.results[2].error.code, 'WORKSPACE_APPROVAL_REQUIRED');
    assert.equal(writeResult.results[2].error.nextTool, 'workspace__workspace_request_access');
    assert.equal(fs.readFileSync(path.join(root, 'one.txt'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'two.txt'), 'utf8'), 'second');
    assert.equal(fs.existsSync(blockedPath), false);

    const readResult = JSON.parse(readFiles.handler({
        paths: ['one.txt', 'nested/two.txt', 'missing.txt'],
    }, context, fileCapabilities));
    assert.deepEqual(readResult.summary, { total: 3, succeeded: 2, failed: 1 });
    assert.equal(readResult.results[0].content, 'first');
    assert.equal(readResult.results[1].content, 'second');
    assert.match(readResult.results[2].error, /读取失败.*does not exist/);
});

test('batch file tools are registered as core tools and validate empty batches', (t) => {
    const { context, capabilities } = fixture(t);
    const fileCapabilities = { fileSystem: capabilities.fileSystem };
    const tools = require('../tools');

    assert.equal(tools.has('read_files'), true);
    assert.equal(tools.has('write_files'), true);
    assert.match(readFiles.handler({ paths: [] }, context, fileCapabilities), /批量读取失败.*非空数组/);
    assert.match(writeFiles.handler({ files: [] }, context, fileCapabilities), /批量写入失败.*非空数组/);
});

test('outside access requires real user approval and is consumed once', async (t) => {
    const { outside, workspace } = fixture(t);
    const target = path.join(outside, 'approved.txt');
    fs.writeFileSync(target, 'approved-data', 'utf8');
    const questions = [];
    const access = new WorkspaceAccess(workspace, {
        async askUser(question) {
            questions.push(question);
            return '允许本次访问';
        },
    });

    assert.throws(() => access.resolveExisting(target, { type: 'file' }), /requires user approval/);
    const approval = await access.requestAccess({
        path: target,
        access: 'read',
        reason: 'Read the explicitly selected external fixture.',
    });
    assert.equal(approval.approved, true);
    assert.equal(approval.scope, 'once');
    assert.equal(questions.length, 1);
    assert.equal(access.resolveExisting(target, { type: 'file' }), target);
    assert.throws(() => access.resolveExisting(target, { type: 'file' }), /requires user approval/);
});

test('workspace approval tool uses the runtime-owned control capability', async (t) => {
    const { root, outside } = fixture(t);
    const target = path.join(outside, 'tool-approved.txt');
    fs.writeFileSync(target, 'tool-approved-data', 'utf8');
    const prompts = [];
    const manager = new WorkspaceManager({ root });
    const capabilities = manager.createRuntimeCapabilities({
        async askUser(question) {
            prompts.push(question);
            return '允许本次访问';
        },
    });
    const registry = new PluginRegistry({ capabilities });
    registry.register(workspacePlugin);
    const context = new Context('system', {
        sessionId: 'workspace-approval-tool',
        resolveExtension: (name) => registry.resolveApi(name),
    });

    await registry.init(context);
    try {
        const requestTool = registry.getTools(context).find(
            (tool) => tool.definition.function.name === 'workspace__workspace_request_access'
        );
        const result = JSON.parse(await requestTool.handler({
            path: target,
            access: 'read',
            reason: 'Verify the selected external file.',
        }, context));
        assert.equal(result.approved, true);
        assert.equal(prompts.length, 1);
        const fileCapabilities = { fileSystem: capabilities.fileSystem };
        assert.equal(readFile.handler({ path: target }, context, fileCapabilities), 'tool-approved-data');
        const secondRead = JSON.parse(readFile.handler({ path: target }, context, fileCapabilities));
        assert.equal(secondRead.code, 'WORKSPACE_APPROVAL_REQUIRED');
    } finally {
        await registry.dispose(context, { reason: 'close' });
    }
});

test('run_command receives only the runtime command scope', (t) => {
    const { root, context, capabilities } = fixture(t);
    const output = runCommand.handler({
        command: 'node -e "process.stdout.write(process.cwd())"',
        timeout: 5000,
    }, context, { commandScope: capabilities.commandScope });
    assert.equal(path.resolve(output), root);
});

test('Workspace exposes file, memory, and sandbox capabilities without RAG state', async (t) => {
    const { root, manager } = fixture(t);
    const capabilities = manager.createRuntimeCapabilities();
    const registry = new PluginRegistry({ capabilities });
    registry.register(dockerSandboxPlugin);
    registry.register(workspacePlugin);
    const context = new Context('system', {
        sessionId: 'workspace-integration',
        resolveExtension: (name) => registry.resolveApi(name),
    });

    try {
        await registry.init(context);
        const workspace = context.getExtension('workspace');
        const sandbox = context.getExtension('docker-sandbox');
        const memory = new MemoryService(context, {}, {
            projectKey: capabilities.memoryScope.projectKey,
        });

        assert.equal('ragScope' in capabilities, false);
        assert.equal('projectFiles' in capabilities, false);
        assert.equal('ragCollection' in workspace.status(), false);
        assert.equal(memory.projectKey, capabilities.memoryScope.projectKey);
        assert.equal('projectRoot' in sandbox.config, false);
        assert.equal(sandbox.config.sandboxRoot, capabilities.sandboxScope.sandboxRoot);
        assert.equal(workspace.status().root, root);
        assert.ok(registry.getTools(context).some(
            (tool) => tool.definition.function.name === 'workspace__workspace_status'
        ));
    } finally {
        await registry.dispose(context, { reason: 'close' });
    }
});

test('delegate agent forwards only its declared runtime capabilities', (t) => {
    const { capabilities } = fixture(t);
    const output = {};
    const model = {};
    const inherited = delegateAgent.createSubagentCapabilities(
        { ...capabilities, undeclared: 'hidden' },
        { output, model }
    );

    assert.equal(inherited.output, output);
    assert.equal(inherited.model, model);
    for (const name of delegateAgent.FORWARDED_CAPABILITIES) {
        assert.equal(inherited[name], capabilities[name], `${name} should be forwarded`);
    }
    assert.equal('undeclared' in inherited, false);
    assert.equal(typeof new Context('subagent').getService, 'undefined');

    const subPlugins = require('../plugins').createDefaultRegistry({ capabilities: inherited });
    const subTools = require('../tools').createRegistry(
        subPlugins.getTools(),
        { capabilities: inherited }
    );
    assert.equal(subTools.has('read_file'), true);
    assert.equal(subTools.has('rag'), true);
});

function workspaceOnlyRegistry({ capabilities }) {
    const registry = new PluginRegistry({ capabilities });
    registry.register(workspacePlugin);
    return registry;
}

test('/workspace accepts a folder path with spaces', async () => {
    let requested = null;
    const result = await commands.dispatch('/workspace "C:\\projects\\folder with spaces"', {
        runtime: {
            requestWorkspace(root) {
                requested = root;
            },
        },
        labels: {},
    });
    assert.equal(result.handled, true);
    assert.equal(requested, 'C:\\projects\\folder with spaces');
});

function inMemoryAuditStore() {
    return {
        appendEvents: async (_sessionId, events) => events,
        readEvents: async () => [],
        readAllEvents: async () => [],
        readCheckpoint: async () => null,
        verifySession: async sessionId => ({ ok: true, sessionId, eventCount: 0, failures: [] }),
        listAuditSessions: async () => [],
        indexQueueStats: async () => ({}),
    };
}

test('runtime atomically rebuilds workspace-scoped capabilities and preserves the conversation', async (t) => {
    const { parent, root, manager } = fixture(t);
    const nextRoot = path.join(parent, 'next root');
    fs.mkdirSync(nextRoot);
    const runtime = await new SessionRuntime({
        workspaceManager: manager,
        registryFactory: workspaceOnlyRegistry,
        auditStore: inMemoryAuditStore(),
    }).start();
    runtime.persist = () => runtime.session.id;

    try {
        const previousContext = runtime.context;
        const previousToolRegistry = runtime.toolRegistry;
        runtime.context.addUser('keep this conversation');
        runtime.requestWorkspace(nextRoot);
        const event = await runtime.applyPending();

        assert.equal(event.type, 'workspace-switch');
        assert.equal(event.changed, true);
        assert.equal(event.root, fs.realpathSync(nextRoot));
        assert.notEqual(runtime.context, previousContext);
        assert.equal(runtime.context.messages.at(-1).content, 'keep this conversation');
        assert.equal(runtime.context.metadata.workspaceRoot, fs.realpathSync(nextRoot));
        const currentCwd = await runtime.toolRegistry.execute('run_command', {
            command: 'node -e "process.stdout.write(process.cwd())"',
        }, runtime.context);
        const previousCwd = await previousToolRegistry.execute('run_command', {
            command: 'node -e "process.stdout.write(process.cwd())"',
        }, previousContext);
        assert.equal(path.resolve(currentCwd), fs.realpathSync(nextRoot));
        assert.equal(path.resolve(previousCwd), fs.realpathSync(root));

        await runtime.toolRegistry.execute(
            'write_file',
            { path: 'new.txt', content: 'new workspace' },
            runtime.context
        );
        assert.equal(fs.readFileSync(path.join(nextRoot, 'new.txt'), 'utf8'), 'new workspace');
        assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
    } finally {
        await runtime.dispose('close');
    }
});

test('runtime rolls back the workspace snapshot when scoped service rebuild fails', async (t) => {
    const { parent, root, manager } = fixture(t);
    const rejectedRoot = path.join(parent, 'rejected');
    fs.mkdirSync(rejectedRoot);
    const guardPlugin = definePlugin({
        name: 'workspace-switch-guard',
        scope: 'session',
        capabilities: { required: ['commandScope'] },
        init(context, { capabilities }) {
            if (capabilities.commandScope.cwd === fs.realpathSync(rejectedRoot)) {
                throw new Error('rejected workspace fixture');
            }
            return { getApi: () => ({ ready: true }) };
        },
        onError(error) {
            throw error;
        },
    });
    const registryFactory = ({ capabilities }) => {
        const registry = workspaceOnlyRegistry({ capabilities });
        registry.register(guardPlugin);
        return registry;
    };
    const runtime = await new SessionRuntime({
        workspaceManager: manager,
        registryFactory,
        auditStore: inMemoryAuditStore(),
    }).start();
    runtime.persist = () => runtime.session.id;

    try {
        runtime.context.addUser('survive rollback');
        runtime.requestWorkspace(rejectedRoot);
        const event = await runtime.applyPending();

        assert.equal(event.type, 'workspace-error');
        assert.match(event.detail, /rejected workspace fixture/);
        assert.equal(runtime.workspaceStatus().root, fs.realpathSync(root));
        const cwd = await runtime.toolRegistry.execute('run_command', {
            command: 'node -e "process.stdout.write(process.cwd())"',
        }, runtime.context);
        assert.equal(path.resolve(cwd), fs.realpathSync(root));
        assert.equal(runtime.context.messages.at(-1).content, 'survive rollback');
    } finally {
        await runtime.dispose('close');
    }
});

test('workspace service remains directly constructible for host integrations', (t) => {
    const { root } = fixture(t);
    assert.equal(new WorkspaceService({ root }).root, fs.realpathSync(root));
});

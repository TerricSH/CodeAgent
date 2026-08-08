const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../context');
const PluginRegistry = require('../plugins/registry');
const { definePlugin } = require('../plugins/define-plugin');
const tools = require('../tools');
const SessionRuntime = require('../runtime/session-runtime');

test('plugin registration rejects missing required capabilities', () => {
    const plugin = definePlugin({
        name: 'needs-database',
        capabilities: { required: ['database'] },
        init() { return null; },
        onError(error) { throw error; },
    });
    const registry = new PluginRegistry({ capabilities: {} });

    assert.throws(
        () => registry.register(plugin),
        /Plugin "needs-database" requires unavailable runtime capabilities: database/
    );
});

test('plugins receive only their declared capability subset', async () => {
    const database = {};
    const logger = {};
    let injected = null;
    const plugin = definePlugin({
        name: 'scoped-plugin',
        capabilities: {
            required: ['database'],
            optional: ['logger'],
        },
        init(context, options) {
            injected = options.capabilities;
            return null;
        },
        onError(error) { throw error; },
    });
    const registry = new PluginRegistry({
        capabilities: { database, logger, secret: 'must-not-leak' },
    });
    registry.register(plugin);

    await registry.init(new Context('test'));
    assert.deepEqual(Object.keys(injected), ['database', 'logger']);
    assert.equal(injected.database, database);
    assert.equal(injected.logger, logger);
    assert.equal('secret' in injected, false);
    assert.equal(Object.isFrozen(injected), true);
});

test('tool registration validates dependencies and injects only declared capabilities', async () => {
    let injected = null;
    const tool = {
        definition: {
            type: 'function',
            function: {
                name: 'scoped_tool',
                description: 'fixture',
                parameters: { type: 'object', properties: {} },
            },
        },
        capabilities: { required: ['database'] },
        handler(args, context, capabilities) {
            injected = capabilities;
            return 'ok';
        },
    };

    assert.throws(
        () => tools.createRegistry([tool], { includeCore: false, capabilities: {} }),
        /Tool "scoped_tool" requires unavailable runtime capabilities: database/
    );

    const database = {};
    const registry = tools.createRegistry([tool], {
        includeCore: false,
        capabilities: { database, secret: 'must-not-leak' },
    });
    assert.equal(await registry.execute('scoped_tool', {}, new Context('test')), 'ok');
    assert.deepEqual(Object.keys(injected), ['database']);
    assert.equal(injected.database, database);
    assert.equal('secret' in injected, false);
});

test('Context no longer exposes a runtime service locator', () => {
    const context = new Context('test');
    assert.equal(typeof context.getService, 'undefined');
    assert.equal('_resolveService' in context, false);
});

test('runtime exposes an explicit model resolver without switching the current model', () => {
    const resolvedModel = { chat() {}, complete() {}, info: () => ({ model: 'resolved' }) };
    const requested = [];
    const currentModel = {
        chat() {},
        complete() {},
        info: () => ({ ref: null, model: 'current' }),
        resolve(ref) {
            requested.push(ref);
            return resolvedModel;
        },
    };
    const runtime = new SessionRuntime({ model: currentModel, workspaceRoot: process.cwd() });
    const capabilities = runtime._buildCapabilities();

    assert.equal(capabilities.model.info().model, 'current');
    const resolved = capabilities.modelResolver.resolve('vendor/model');
    assert.notEqual(resolved, resolvedModel);
    assert.equal(resolved.info().model, 'resolved');
    assert.deepEqual(requested, ['vendor/model']);
    assert.equal(capabilities.model.info().model, 'current');
    assert.equal(Object.isFrozen(capabilities.modelResolver), true);
});

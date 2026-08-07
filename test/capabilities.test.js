const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../context');
const PluginRegistry = require('../plugins/registry');
const { definePlugin } = require('../plugins/define-plugin');
const tools = require('../tools');

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

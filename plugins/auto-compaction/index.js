const { Compactor } = require('./compactor');
const { definePlugin } = require('../define-plugin');

const NAME = 'auto-compaction';

// auto-compaction 扩展：纯 onBeforeTurn 钩子，无工具/守卫。
// 用量超阈值时生成摘要缓存节点，并将已摘要的原子节点转冷。
// 存储态始终全量；摘要为派生的传输覆盖，不持久化，重载后下一轮按需重算。
const autoCompactionPlugin = definePlugin({
    name: NAME,
    scope: 'session',
    capabilities: { optional: ['model'] },

    onError(error) {
        throw error;
    },

    // 钩子在 plugin 对象上被调用；通过 context.getExtension 取扩展状态（compactor）。
    onBeforeTurn(context) {
        const ext = context && typeof context.getExtension === 'function'
            ? context.getExtension(NAME)
            : null;
        if (ext && typeof ext.apply === 'function') {
            ext.apply(context);
        }
    },

    onAfterTurn(context) {
        const ext = context && typeof context.getExtension === 'function'
            ? context.getExtension(NAME)
            : null;
        if (ext && typeof ext.schedule === 'function') ext.schedule(context);
    },

    // 模型能力是显式声明的可选依赖；缺省则 Compactor 自动降级为不压缩。
    init(context, { store, config = {}, capabilities = {} } = {}) {
        const compactor = new Compactor(capabilities.model || null, config);
        return {
            getApi: () => compactor,
            isDirty: () => compactor.dirty,
            hydrate: async (sessionId) => {
                if (!store || !sessionId) return;
                compactor.hydrate(await store.read(sessionId));
            },
            persist: async (sessionId, options = {}) => {
                if (!store || !sessionId) return;
                await store.write(sessionId, compactor.serialize(), options);
                compactor.dirty = false;
            },
            dispose: () => compactor.dispose(),
        };
    },
});

module.exports = autoCompactionPlugin;

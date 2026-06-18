const { Compactor } = require('./compactor');

const NAME = 'auto-compaction';

// auto-compaction 扩展：纯 onBeforeTurn 钩子，无工具/守卫。
// 用量超阈值时调 services.model 生成摘要，经 context.setTransportOverlay 仅作用于传输态。
// 存储态始终全量；摘要为派生的传输覆盖，不持久化，重载后下一轮按需重算。
const autoCompactionPlugin = {
    name: NAME,
    scope: 'session',

    // 钩子在 plugin 对象上被调用；通过 context.getExtension 取扩展状态（compactor）。
    async onBeforeTurn(context) {
        const ext = context && typeof context.getExtension === 'function'
            ? context.getExtension(NAME)
            : null;
        if (ext && typeof ext.maybeCompact === 'function') {
            await ext.maybeCompact(context);
        }
    },

    // 模型能力来自宿主通用注入的 services.model；缺省则 Compactor 自动降级为不压缩。
    init(context, { config = {}, services = {} } = {}) {
        const compactor = new Compactor(services && services.model, config);
        return {
            getApi: () => compactor,
        };
    },
};

module.exports = autoCompactionPlugin;

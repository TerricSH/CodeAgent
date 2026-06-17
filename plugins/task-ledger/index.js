const TaskLedger = require('./ledger');
const continuationGuard = require('./guard');
const tool = require('./tool');

const NAME = 'task-ledger';
const VERSION = 1;

// task-ledger 扩展：状态归自己，按 sessionId 通过注入 store 落库（版本信封）。
// 不再使用 context.pluginState；tools/guards 在执行期收到 getApi() 返回的 ledger。
const taskLedgerPlugin = {
    name: NAME,
    scope: 'session',
    tools: [tool],
    continuationGuards: [continuationGuard],

    init(context, { store, config = {} } = {}) {
        const ledger = (config && config.ledger) || new TaskLedger();
        let dirty = false;
        ledger.onChange(() => { dirty = true; });

        return {
            getApi: () => ledger,
            isDirty: () => dirty,

            // 恢复：缺失 → 空状态；版本不符/损坏 → 降级保持空，不抛错。
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                let raw;
                try {
                    raw = store.read(sessionId);
                } catch {
                    raw = null;
                }
                if (!raw) return;

                let envelope;
                try {
                    envelope = JSON.parse(raw);
                } catch {
                    return;
                }
                if (!envelope || envelope.version !== VERSION || !Array.isArray(envelope.data)) {
                    return;
                }

                ledger.restore(envelope.data);
                dirty = false;
            },

            // 持久化：同步写入版本信封；由宿主在事务内调用，保证原子。
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                const envelope = JSON.stringify({ name: NAME, version: VERSION, data: ledger.list() });
                store.write(sessionId, envelope);
                dirty = false;
            },
        };
    },
};

module.exports = taskLedgerPlugin;
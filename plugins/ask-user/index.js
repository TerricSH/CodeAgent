const tool = require('./tool');
const { formatSection } = require('./format');
const { definePlugin } = require('../define-plugin');

const NAME = 'ask-user';
const VERSION = 1;

// ask-user 扩展：状态为历史问答记录，按 sessionId 通过注入 store 落库（版本信封）。
// 交互能力（askUser = output.prompt.collect）由宿主经 config 注入，扩展不感知 CLI/TUI。
// onBeforeTurn 把已收集信息写入系统提示动态分段，作为模型持续可见的基础信息（Option B）。
const askUserPlugin = definePlugin({
    name: NAME,
    scope: 'session',
    tools: [tool],
    capabilities: { optional: ['output'] },

    onError(error) {
        throw error;
    },

    // 钩子在 plugin 对象上被调用；通过 context.getExtension 取扩展状态。
    onBeforeTurn(context) {
        const ext = context && typeof context.getExtension === 'function'
            ? context.getExtension(NAME)
            : null;
        const records = ext && typeof ext.list === 'function' ? ext.list() : [];
        const text = formatSection(records);
        if (text) {
            context.systemPrompt.upsertSection(NAME, text);
        } else {
            context.systemPrompt.removeSection(NAME);
        }
    },

    init(context, { store, capabilities = {} } = {}) {
        // 交互能力来自宿主通用注入的 output（不感知具体宿主/模式）；缺省则降级为不可用。
        const output = capabilities.output;
        const prompt = output && output.prompt && typeof output.prompt.collect === 'function'
            ? output.prompt
            : null;
        const askUser = prompt ? (question) => prompt.collect(question) : null;

        const records = [];
        let dirty = false;

        return {
            getApi: () => ({
                askUser,
                record: (entry) => {
                    if (!entry) return;
                    records.push(entry);
                    dirty = true;
                },
                list: () => records.slice(),
            }),

            isDirty: () => dirty,

            // 恢复：缺失 → 空状态；版本不符/损坏 → 降级保持空，不抛错。
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                const raw = store.read(sessionId);
                if (!raw) return;

                const envelope = JSON.parse(raw);
                if (!envelope || envelope.version !== VERSION || !Array.isArray(envelope.data)) {
                    throw new Error(`Invalid ${NAME} state envelope`);
                }

                records.length = 0;
                records.push(...envelope.data);
                dirty = false;
            },

            // 持久化：同步写入版本信封；由宿主在事务内调用，保证原子。
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                const envelope = JSON.stringify({ name: NAME, version: VERSION, data: records });
                store.write(sessionId, envelope);
                dirty = false;
            },
        };
    },
});

module.exports = askUserPlugin;

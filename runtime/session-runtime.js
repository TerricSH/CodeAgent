const Context = require('../context');
const Session = require('../session');
const tools = require('../tools');
const { createDefaultRegistry } = require('../plugins');
const { buildSystemPrompt } = require('../system-prompt');

// 会话运行时：拥有 (session, context, plugins, toolRegistry)，对外暴露当前态。
// 切换 = 两轮之间的原子重建替换（persist 当前 → 物化目标 → 重建三件套 → 切引用）。
// Context 对切换无感知：切换只在本层换引用，不进 Context 内部。
class SessionRuntime {
    constructor({ output }) {
        this.output = output;
        this.session = null;
        this.context = null;
        this.plugins = null;
        this.toolRegistry = null;
        this._savedFingerprint = null;
        this._pending = null; // { type:'new' } | { type:'switch', id }
    }

    async start() {
        await this._build(new Session(), null);
        return this;
    }

    // 构建/替换当前会话三件套；loaded 为 null=全新会话，否则为 Session.load 结果。
    async _build(sessionInstance, loaded) {
        const plugins = createDefaultRegistry({ services: this._buildServices() });
        const toolRegistry = tools.createRegistry(plugins.getTools());
        const systemPrompt = buildSystemPrompt({
            basePrompt: process.env.SYSTEM_PROMPT,
            toolPrompts: toolRegistry.prompts,
        });
        const context = new Context(systemPrompt, {
            sessionId: sessionInstance.id,
            metadata: loaded ? loaded.metadata : undefined,
            messages: loaded ? loaded.messages : undefined,
            resolveExtension: (name) => plugins.resolveApi(name),
        });
        // 插件按新 sessionId hydrate；systemPrompt 动态分段随新会话重建。
        await plugins.init(context);

        this.session = sessionInstance;
        this.context = context;
        this.plugins = plugins;
        this.toolRegistry = toolRegistry;
        this._savedFingerprint = this._fingerprint();
    }

    _fingerprint() {
        const msgs = this.context.snapshotMessages();
        const last = msgs[msgs.length - 1];
        return `${msgs.length}:${last ? (last.finished_at || last.created_at || '') : ''}`;
    }

    persist({ force = false, closing = false } = {}) {
        const fp = this._fingerprint();
        const dirty = force || closing || fp !== this._savedFingerprint || this.plugins.isDirty();
        if (!dirty) return this.session.id;
        const id = this.session.save({
            messages: this.context.snapshotMessages(),
            metadata: this.context.metadata,
            endTime: closing ? new Date().toISOString() : null,
            persist: () => this.plugins.persistAll(this.session.id),
        });
        this._savedFingerprint = fp;
        return id;
    }

    // —— 意图登记（写）：不当场切，避免自我销毁/重入 ——
    requestNew() { this._pending = { type: 'new' }; }
    requestSwitch(id) { this._pending = { type: 'switch', id }; }
    hasPending() { return Boolean(this._pending); }

    // —— 安全点执行切换：persist 当前 → 重建替换。只返回结构化事件，显示文本归显示层。 ——
    async applyPending() {
        const pending = this._pending;
        this._pending = null;
        if (!pending) return null;

        try {
            this.persist({ force: true });

            if (pending.type === 'new') {
                await this._build(new Session(), null);
                return { type: 'new', id: this.session.id };
            }
            const loaded = Session.load(pending.id);
            if (!loaded) return { type: 'error', id: pending.id, reason: 'not_found' };
            const sess = new Session({ id: loaded.id, startTime: loaded.startTime, metadata: loaded.metadata });
            await this._build(sess, loaded);
            return { type: 'switch', id: this.session.id, messageCount: loaded.messages.length };
        } catch (err) {
            // 切换失败不应中断主循环：返回结构化错误事件，文案由显示层呈现。
            return { type: 'error', id: pending.id, reason: 'failed', detail: err.message };
        }
    }

    // —— 只读查询：当前会话默认读内存(最新未落库)，他会话读库 ——
    current() {
        return {
            id: this.session.id,
            startTime: this.session.startTime,
            metadata: this.context.metadata,
            messageCount: this.context.messages.length,
        };
    }

    list() { return Session.list(); }

    query(options = {}) {
        const id = options.id || this.session.id;
        const isCurrent = id === this.session.id;
        const source = options.source || (isCurrent ? 'memory' : 'store');
        if (isCurrent && source === 'memory') return this._queryMemory(options);
        return Session.query(id, options);
    }

    _queryMemory(options = {}) {
        const order = options.order === 'desc' ? 'desc' : 'asc';
        const limit = Math.min(Math.max(1, Number(options.limit) || 50), 200);
        const select = options.select === 'meta' || options.select === 'preview' ? options.select : 'full';
        let arr = this.context.messages.map((m, i) => ({ ...m, message_index: i }));
        if (options.role) arr = arr.filter((m) => m.role === options.role);
        if (Number.isInteger(options.beforeIndex)) arr = arr.filter((m) => m.message_index < options.beforeIndex);
        if (Number.isInteger(options.afterIndex)) arr = arr.filter((m) => m.message_index > options.afterIndex);
        if (order === 'desc') arr = arr.reverse();
        arr = arr.slice(0, limit);
        const items = arr.map((m) => project(m, select));
        return { items, cursor: items.length ? items[items.length - 1].message_index : null, count: items.length };
    }

    // services.session 能力：读同步返回纯数据；写登记意图、宿主在安全点执行。
    _buildServices() {
        const runtime = this;
        return {
            output: this.output,
            session: {
                current: () => runtime.current(),
                list: () => runtime.list(),
                query: (opts) => runtime.query(opts),
                requestNew: () => runtime.requestNew(),
                requestSwitch: (id) => runtime.requestSwitch(id),
            },
        };
    }
}

function project(m, select) {
    if (select === 'meta') {
        return { role: m.role, message_index: m.message_index, created_at: m.created_at, finished_at: m.finished_at };
    }
    if (select === 'preview') {
        const content = typeof m.content === 'string' ? m.content.slice(0, 200) : m.content;
        return { role: m.role, message_index: m.message_index, created_at: m.created_at, finished_at: m.finished_at, content };
    }
    return m;
}

module.exports = SessionRuntime;

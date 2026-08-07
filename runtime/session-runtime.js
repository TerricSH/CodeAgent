const Context = require('../context');
const Session = require('../session');
const tools = require('../tools');
const { createDefaultRegistry } = require('../plugins');
const { buildSystemPrompt } = require('../system-prompt');
const { WorkspaceManager } = require('../workspace');

// 会话运行时：拥有 (session, context, plugins, toolRegistry)，对外暴露当前态。
// 切换 = 两轮之间的原子重建替换（persist 当前 → 物化目标 → 重建三件套 → 切引用）。
// Context 对切换无感知：切换只在本层换引用，不进 Context 内部。
class SessionRuntime {
    constructor({
        output,
        model,
        workspaceManager,
        workspaceRoot,
        plugins,
        registryFactory,
    } = {}) {
        this.output = output;
        // 仅转发宿主能力，不拥有模型生命周期（不切换、不读预算）；可为空（降级）。
        this._model = model || null;
        this.workspaceManager = workspaceManager || new WorkspaceManager({ root: workspaceRoot });
        this._pluginOptions = plugins || {};
        this._registryFactory = typeof registryFactory === 'function'
            ? registryFactory
            : createDefaultRegistry;
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
    async _build(sessionInstance, loaded, options = {}) {
        const capabilities = this._buildCapabilities();
        const plugins = this._registryFactory({
            capabilities,
            plugins: this._pluginOptions,
        });
        const toolRegistry = tools.createRegistry(
            plugins.getTools(),
            { capabilities }
        );
        const systemPrompt = buildSystemPrompt({
            basePrompt: process.env.SYSTEM_PROMPT,
            toolPrompts: toolRegistry.prompts,
        });
        const workspace = this.workspaceManager.status();
        const context = new Context(systemPrompt, {
            sessionId: sessionInstance.id,
            metadata: {
                ...(loaded && loaded.metadata ? loaded.metadata : {}),
                workspaceId: workspace.id,
                workspaceRoot: workspace.root,
            },
            messages: loaded ? loaded.messages : undefined,
            // 不再从模型读预算：SessionRuntime 不拥有模型。token 预算由宿主（mainloop）
            // 从公共 ModelRuntime 同步进来（setMaxContextTokens），会话层对模型无感知。
            resolveExtension: (name) => plugins.resolveApi(name),
        });
        // 插件按新 sessionId hydrate；systemPrompt 动态分段随新会话重建。
        try {
            await plugins.init(context, { hydrate: options.hydrate !== false });
            if (loaded && options.resume !== false) {
                await plugins.onSessionResume(context, {
                    sessionId: loaded.id,
                    previousClosedAt: loaded.endTime || null,
                    messageCount: loaded.messages.length,
                    lastMessage: loaded.messages[loaded.messages.length - 1] || null,
                });
            }
        } catch (error) {
            try {
                await plugins.dispose(context, { reason: 'build-failed' });
            } catch (cleanupError) {
                throw new Error(`${error.message}; plugin cleanup failed: ${cleanupError.message}`);
            }
            throw error;
        }

        this.session = sessionInstance;
        this.context = context;
        this.plugins = plugins;
        this.toolRegistry = toolRegistry;
        this._savedFingerprint = this._fingerprint();
    }

    _fingerprint() {
        const msgs = this.context.snapshotMessages();
        const last = msgs[msgs.length - 1];
        return JSON.stringify({
            messageCount: msgs.length,
            lastChangedAt: last ? (last.finished_at || last.created_at || '') : '',
            metadata: this.context.metadata,
        });
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
    requestWorkspace(root) {
        const workspace = this.workspaceManager.prepare(root);
        this._pending = { type: 'workspace', workspace };
        return workspace.status();
    }
    hasPending() { return Boolean(this._pending); }

    // —— 安全点执行切换：persist 当前 → 重建替换。只返回结构化事件，显示文本归显示层。 ——
    async applyPending() {
        const pending = this._pending;
        this._pending = null;
        if (!pending) return null;

        try {
            this.persist({ force: true });

            if (pending.type === 'workspace') {
                return await this._switchWorkspace(pending.workspace);
            }

            if (pending.type === 'new') {
                await this.plugins.dispose(this.context, { reason: 'session-switch' });
                await this._build(new Session(), null);
                return { type: 'new', id: this.session.id };
            }
            const loaded = Session.load(pending.id);
            if (!loaded) return { type: 'error', id: pending.id, reason: 'not_found' };
            await this.plugins.dispose(this.context, { reason: 'session-switch' });
            const sess = new Session({ id: loaded.id, startTime: loaded.startTime, metadata: loaded.metadata });
            await this._build(sess, loaded);
            return { type: 'switch', id: this.session.id, messageCount: loaded.messages.length };
        } catch (err) {
            // 切换失败不应中断主循环：返回结构化错误事件，文案由显示层呈现。
            if (pending.type === 'workspace') {
                return {
                    type: 'workspace-error',
                    root: pending.workspace?.root || null,
                    detail: err.message,
                };
            }
            return { type: 'error', id: pending.id, reason: 'failed', detail: err.message };
        }
    }

    async _switchWorkspace(workspace) {
        const current = this.workspaceManager.current;
        if (workspace.root === current.root) {
            return { type: 'workspace-switch', changed: false, ...this.workspaceManager.status() };
        }

        const checkpoint = this.workspaceManager.checkpoint();
        const retained = {
            id: this.session.id,
            startTime: this.session.startTime,
            metadata: { ...(this.context.metadata || {}) },
            messages: this.context.snapshotMessages(),
        };
        let rebuilding = false;
        let newBuildReady = false;

        try {
            rebuilding = true;
            await this.plugins.dispose(this.context, { reason: 'workspace-switch' });
            this.workspaceManager.activate(workspace);
            const session = new Session({
                id: retained.id,
                startTime: retained.startTime,
                metadata: retained.metadata,
            });
            await this._build(session, retained, { hydrate: false, resume: false });
            newBuildReady = true;
            this.persist({ force: true });
            return { type: 'workspace-switch', changed: true, ...this.workspaceManager.status() };
        } catch (error) {
            let failure = error;
            if (newBuildReady) {
                try {
                    await this.plugins.dispose(this.context, { reason: 'workspace-rollback' });
                } catch (cleanupError) {
                    failure = new Error(
                        `${error.message}; failed workspace cleanup: ${cleanupError.message}`
                    );
                }
            }
            this.workspaceManager.restore(checkpoint);
            if (rebuilding) {
                try {
                    const session = new Session({
                        id: retained.id,
                        startTime: retained.startTime,
                        metadata: retained.metadata,
                    });
                    await this._build(session, retained, { hydrate: true, resume: false });
                } catch (rollbackError) {
                    throw new Error(
                        `${failure.message}; Workspace rollback failed: ${rollbackError.message}`
                    );
                }
            }
            throw failure;
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

    workspaceStatus() {
        return this.workspaceManager.status();
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

    // 组合根创建能力集合；注册表只会把各消费者显式声明的子集注入进去。
    _buildCapabilities() {
        const runtime = this;
        const prompt = this.output?.prompt;
        const askUser = prompt && typeof prompt.collect === 'function'
            ? (question) => prompt.collect(question)
            : null;
        const workspaceCapabilities = this.workspaceManager.createRuntimeCapabilities({ askUser });
        return {
            ...workspaceCapabilities,
            output: this.output,
            // 模型能力转发：插件（如摘要）经此做一次性补全；宿主未注入则为 null（插件应降级）。
            model: this._model
                ? {
                    complete: (messages, options) => runtime._model.complete(messages, options),
                    chat: (messages, options) => runtime._model.chat(messages, options),
                    info: () => runtime._model.info(),
                }
                : null,
        };
    }

    async dispose(reason = 'close') {
        if (this.plugins && this.context) {
            await this.plugins.dispose(this.context, { reason });
        }
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

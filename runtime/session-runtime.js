const Context = require('../context');
const Session = require('../session');
const tools = require('../tools');
const { createDefaultRegistry } = require('../plugins');
const { buildSystemPrompt } = require('../system-prompt');
const { WorkspaceManager } = require('../workspace');
const AuditWriter = require('./audit-writer');
const auditRepository = require('../data-layer/repositories/audit-repository');
const { messagesFromAudit, cacheEntriesFromAudit, cacheNodeMessages } = require('./audit-messages');
const AuditRenderer = require('./audit-renderer');
const { createAuditedModelCapability } = require('./audited-model');

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
        sessionMetadata,
        basePrompt,
        capabilityOverrides,
        toolFilter,
        auditStore,
    } = {}) {
        this.output = output;
        // 仅转发宿主能力，不拥有模型生命周期（不切换、不读预算）；可为空（降级）。
        this._model = model || null;
        this.workspaceManager = workspaceManager || new WorkspaceManager({ root: workspaceRoot });
        this._pluginOptions = plugins || {};
        this._registryFactory = typeof registryFactory === 'function'
            ? registryFactory
            : createDefaultRegistry;
        this._sessionMetadata = sessionMetadata && typeof sessionMetadata === 'object'
            ? { ...sessionMetadata }
            : {};
        this._basePrompt = basePrompt || null;
        this._traceBasePrompt = this._basePrompt || process.env.SYSTEM_PROMPT || '';
        this._capabilityOverrides = capabilityOverrides && typeof capabilityOverrides === 'object'
            ? capabilityOverrides
            : {};
        this._toolFilter = typeof toolFilter === 'function' ? toolFilter : null;
        this._auditRepository = auditStore || auditRepository;
        this.session = null;
        this.context = null;
        this.plugins = null;
        this.toolRegistry = null;
        this.auditWriter = null;
        this._savedFingerprint = null;
        this._persistQueue = Promise.resolve();
        this._pending = null; // { type:'new' } | { type:'switch', id }
    }

    async start(session = null) {
        await this._build(session || new Session({ metadata: this._sessionMetadata }), null);
        return this;
    }

    // 构建/替换当前会话三件套；loaded 为 null=全新会话，否则为 Session.load 结果。
    async _build(sessionInstance, loaded, options = {}) {
        const previousWriter = this.auditWriter;
        const auditWriter = previousWriter && previousWriter.sessionId === sessionInstance.id
            ? previousWriter
            : new AuditWriter(sessionInstance.id, { repository: this._auditRepository });
        let auditEvents = [];
        if (loaded) {
            auditEvents = await this._auditRepository.readAllEvents({ sessionId: sessionInstance.id });
        }
        const checkpoint = loaded
            ? await this._auditRepository.readCheckpoint(sessionInstance.id)
            : null;
        const restoredCacheEntries = Array.isArray(options.cacheEntries)
            ? options.cacheEntries
            : cacheEntriesFromAudit(auditEvents, checkpoint);
        const cacheState = options.cacheCheckpoint || checkpoint?.state || {};
        const latestFinishedTrace = [...auditEvents].reverse().find(event =>
            event.eventType === 'task.completed' || event.eventType === 'task.failed'
        );
        if (latestFinishedTrace) auditWriter.previousTraceId = latestFinishedTrace.traceId;
        const restoredMessages = messagesFromAudit(auditEvents);
        const capabilities = this._buildCapabilities();
        const plugins = this._registryFactory({
            capabilities,
            plugins: this._pluginOptions,
        });
        const toolRegistry = tools.createRegistry(
            plugins.getTools(),
            {
                capabilities,
                toolFilter: this._toolFilter,
                onBeforeBatch: (context, batch) => plugins.onBeforeToolBatch(context, batch),
                onBeforeExecute: (context, tool, args) => plugins.onBeforeToolExecute(context, tool, args),
            }
        );
        this._traceBasePrompt = this._basePrompt || process.env.SYSTEM_PROMPT || '';
        const systemPrompt = buildSystemPrompt({
            basePrompt: this._traceBasePrompt,
            toolPrompts: toolRegistry.prompts,
        });
        const workspace = this.workspaceManager.status();
        const context = new Context(systemPrompt, {
            sessionId: sessionInstance.id,
            metadata: {
                ...(loaded && loaded.metadata ? loaded.metadata : {}),
                ...(sessionInstance.metadata || {}),
                workspaceId: workspace.id,
                workspaceRoot: workspace.root,
            },
            messages: restoredCacheEntries ? undefined : restoredMessages,
            cacheEntries: restoredCacheEntries || undefined,
            turn: cacheState.turn,
            openDialogueId: cacheState.openDialogueId,
            openToolSpanId: cacheState.openToolSpanId,
            auditWriter,
            loadSource: async (sourceRef, entry) => {
                const currentEvents = await this._auditRepository.readAllEvents({
                    sessionId: sessionInstance.id,
                    eventTypes: ['context.loaded', 'context.updated'],
                });
                return cacheNodeMessages(currentEvents, entry.id, { preferFull: true });
            },
            // 不再从模型读预算：SessionRuntime 不拥有模型。token 预算由宿主（mainloop）
            // 从公共 ModelRuntime 同步进来（setMaxContextTokens），会话层对模型无感知。
            resolveExtension: (name) => plugins.resolveApi(name),
        });
        auditWriter.setCheckpointProvider(() => context.checkpoint());
        auditWriter.setSessionStateProvider(() => ({ metadata: context.metadata }));
        // 插件按新 sessionId hydrate；systemPrompt 动态分段随新会话重建。
        try {
            await plugins.init(context, { hydrate: options.hydrate !== false });
            if (loaded && options.resume !== false) {
                await plugins.onSessionResume(context, {
                    sessionId: loaded.id,
                    previousClosedAt: loaded.endTime || null,
                    messageCount: (restoredMessages || []).length,
                    lastMessage: (restoredMessages || [])[(restoredMessages || []).length - 1] || null,
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
        this.auditWriter = auditWriter;
        this.auditWriter.setCheckpointProvider(() => this.context.checkpoint());
        this.auditWriter.setSessionStateProvider(() => ({ metadata: this.context.metadata }));
        if (this._model && typeof this._model.info === 'function') {
            this.context.setModelProfile(this._model.info());
        }
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

    persist(options = {}) {
        const task = () => this._persistNow(options);
        this._persistQueue = this._persistQueue.then(task, task);
        return this._persistQueue;
    }

    async _persistNow({ force = false, closing = false } = {}) {
        const fp = this._fingerprint();
        const dirty = force || closing || fp !== this._savedFingerprint
            || this.plugins.isDirty() || Boolean(this.auditWriter?.dirty);
        if (!dirty) return this.session.id;
        const id = await this.session.save({
            messages: this.context.snapshotMessages(),
            persistMessages: false,
            metadata: this.context.metadata,
            endTime: closing ? new Date().toISOString() : null,
            persist: async (client) => {
                await this.plugins.persistAll(this.session.id, { client });
                if (this.auditWriter) {
                    await this.auditWriter.flush(this.context.checkpoint(), client);
                }
            },
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

    startTrace(content, payload = {}, options = {}) {
        const policySource = options.policySource || 'direct-user';
        if (!['direct-user', 'internal'].includes(policySource)) {
            throw new TypeError(`Unsupported Trace policy source: ${policySource}`);
        }
        const derivedPolicy = this.plugins.deriveTracePolicy({
            basePrompt: this._traceBasePrompt,
            userContent: policySource === 'direct-user' ? content : '',
            policySource,
        });
        const explicitPolicy = options.tracePolicy && typeof options.tracePolicy === 'object'
            ? options.tracePolicy
            : {};
        const tracePolicy = { ...derivedPolicy, ...explicitPolicy };
        const traceId = this.auditWriter.startTrace({ content, ...payload, policySource, tracePolicy });
        this.context.startTask(traceId, tracePolicy);
        return traceId;
    }

    finishTrace(status = 'completed', payload = {}) {
        this.context.completeTask(this.auditWriter.activeTraceId, `task-${status}`);
        return this.auditWriter.finishTrace(status, payload);
    }

    recordAudit(event) {
        return this.auditWriter.record(event);
    }

    // —— 安全点执行切换：persist 当前 → 重建替换。只返回结构化事件，显示文本归显示层。 ——
    async applyPending() {
        const pending = this._pending;
        this._pending = null;
        if (!pending) return null;

        try {
            await this.persist({ force: true });

            if (pending.type === 'workspace') {
                return await this._switchWorkspace(pending.workspace);
            }

            if (pending.type === 'new') {
                await this.plugins.dispose(this.context, { reason: 'session-switch' });
                await this._build(new Session(), null);
                return { type: 'new', id: this.session.id };
            }
            const loaded = await Session.loadMetadata(pending.id);
            if (!loaded) return { type: 'error', id: pending.id, reason: 'not_found' };
            await this.plugins.dispose(this.context, { reason: 'session-switch' });
            const sess = new Session({
                id: loaded.id,
                startTime: loaded.startTime,
                metadata: loaded.metadata,
                persistedMessageCount: 0,
            });
            await this._build(sess, loaded);
            return { type: 'switch', id: this.session.id, messageCount: this.context.messages.length };
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
            cacheEntries: this.context.snapshotCacheEntries(),
            cacheCheckpoint: this.context.checkpoint(),
            persistedMessageCount: this.session.persistedMessageCount,
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
                persistedMessageCount: retained.persistedMessageCount,
            });
            await this._build(session, retained, {
                hydrate: false,
                resume: false,
                cacheEntries: retained.cacheEntries,
                cacheCheckpoint: retained.cacheCheckpoint,
            });
            newBuildReady = true;
            await this.persist({ force: true });
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
                        persistedMessageCount: retained.persistedMessageCount,
                    });
                    await this._build(session, retained, {
                        hydrate: true,
                        resume: false,
                        cacheEntries: retained.cacheEntries,
                        cacheCheckpoint: retained.cacheCheckpoint,
                    });
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

    async list() { return Session.list(); }

    async exportAudit(options = {}) {
        await this.persist({ force: true });
        const renderer = new AuditRenderer({ repository: this._auditRepository });
        return renderer.export({
            sessionId: options.sessionId || this.session.id,
            traceId: options.traceId,
            fromSequence: options.fromSequence,
            toSequence: options.toSequence,
            outputPath: options.outputPath,
            includeSubagents: options.includeSubagents !== false,
            workspaceRoot: this.workspaceManager.status().root,
        });
    }

    async query(options = {}) {
        const id = options.id || this.session.id;
        const isCurrent = id === this.session.id;
        const source = options.source || (isCurrent ? 'memory' : 'audit');
        if (isCurrent && source === 'memory') return this._queryMemory(options);
        const limit = Math.min(Math.max(1, Number(options.limit) || 50), 200);
        const events = await this._auditRepository.readEvents({
            sessionId: id,
            fromSequence: Number.isInteger(options.fromSequence) ? options.fromSequence : undefined,
            toSequence: Number.isInteger(options.toSequence) ? options.toSequence : undefined,
            eventTypes: options.eventTypes,
            limit,
        });
        return {
            items: events,
            cursor: events.length ? events[events.length - 1].sequence : null,
            count: events.length,
        };
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
        const currentModel = this._model
            ? createAuditedModelCapability(this._model, () => runtime.auditWriter, {
                actor: 'auxiliary-current-model',
            })
            : null;
        const modelResolver = this._model && typeof this._model.resolve === 'function'
            ? Object.freeze({
                resolve: ref => createAuditedModelCapability(
                    runtime._model.resolve(ref),
                    () => runtime.auditWriter,
                    { actor: `auxiliary-model:${ref}` }
                ),
            })
            : null;
        const auditStore = Object.freeze({
            readEvents: options => runtime._auditRepository.readEvents(options),
            readAllEvents: options => runtime._auditRepository.readAllEvents(options),
            verifySession: sessionId => runtime._auditRepository.verifySession(sessionId),
            listAuditSessions: limit => runtime._auditRepository.listAuditSessions(limit),
            indexQueueStats: () => runtime._auditRepository.indexQueueStats(),
        });
        return {
            ...workspaceCapabilities,
            ...this._capabilityOverrides,
            output: this.output,
            // 模型能力转发：插件（如摘要）经此做一次性补全；宿主未注入则为 null（插件应降级）。
            model: currentModel,
            // 按引用创建独立模型能力；不会切换主会话模型，供 Skill Refinement 等角色化流程使用。
            modelResolver,
            auditStore,
        };
    }

    async dispose(reason = 'close') {
        if (this.plugins && this.context) {
            await this.plugins.dispose(this.context, { reason });
        }
        if (this.auditWriter) await this.auditWriter.flush(this.context?.checkpoint());
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

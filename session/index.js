const sessionRepository = require('../data-layer/repositories/session-repository');

class Session {
    constructor(options = {}) {
        // 支持从已加载会话恢复：传入 id/startTime/metadata 即复用旧会话身份（用于会话切换）。
        this.id = options.id || globalThis.crypto?.randomUUID?.() || Date.now().toString(36);
        this.startTime = options.startTime || new Date().toISOString();
        this.metadata = options.metadata || null;
        this.persistedMessageCount = Number.isInteger(options.persistedMessageCount)
            ? Math.max(options.persistedMessageCount, 0)
            : 0;
    }

    async save(options = {}) {
        const endTime = Object.prototype.hasOwnProperty.call(options, 'endTime')
            ? options.endTime
            : new Date().toISOString();
        const messages = Array.isArray(options.messages) ? options.messages : [];
        const metadata = options.metadata !== undefined ? options.metadata : this.metadata;

        await sessionRepository.saveSession({
            id: this.id,
            startTime: this.startTime,
            endTime,
            metadata,
            messages,
            fromMessageIndex: this.persistedMessageCount,
            persistMessages: options.persistMessages !== false,
            persist: options.persist,
        });

        if (options.persistMessages !== false) this.persistedMessageCount = messages.length;
        return this.id;
    }

    static async list() {
        return sessionRepository.listSessions();
    }

    static async load(id) {
        return sessionRepository.loadSession(id);
    }

    static async loadMetadata(id) {
        return sessionRepository.loadSessionMetadata(id);
    }

    static async messages(id, options = {}) {
        return sessionRepository.getSessionMessages(id, options);
    }

    static async query(id, options = {}) {
        return sessionRepository.queryMessages(id, options);
    }

    static async count(id) {
        return sessionRepository.countMessages(id);
    }

    static async close() {
        await sessionRepository.close();
    }
}

module.exports = Session;

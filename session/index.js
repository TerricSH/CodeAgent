const sessionRepository = require('../data-layer/repositories/session-repository');

class Session {
    constructor(options = {}) {
        // 支持从已加载会话恢复：传入 id/startTime/metadata 即复用旧会话身份（用于会话切换）。
        this.id = options.id || globalThis.crypto?.randomUUID?.() || Date.now().toString(36);
        this.startTime = options.startTime || new Date().toISOString();
        this.metadata = options.metadata || null;
    }

    save(options = {}) {
        const endTime = Object.prototype.hasOwnProperty.call(options, 'endTime')
            ? options.endTime
            : new Date().toISOString();
        const messages = Array.isArray(options.messages) ? options.messages : [];
        const metadata = options.metadata !== undefined ? options.metadata : this.metadata;

        sessionRepository.saveSession({
            id: this.id,
            startTime: this.startTime,
            endTime,
            metadata,
            messages,
            persist: options.persist,
        });

        return this.id;
    }

    static list() {
        return sessionRepository.listSessions();
    }

    static load(id) {
        return sessionRepository.loadSession(id);
    }

    static messages(id, options = {}) {
        return sessionRepository.getSessionMessages(id, options);
    }

    static query(id, options = {}) {
        return sessionRepository.queryMessages(id, options);
    }

    static count(id) {
        return sessionRepository.countMessages(id);
    }

    static close() {
        sessionRepository.close();
    }
}

module.exports = Session;

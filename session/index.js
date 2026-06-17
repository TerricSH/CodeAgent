const sessionRepository = require('../data-layer/repositories/session-repository');

class Session {
    constructor(options = {}) {
        this.id = globalThis.crypto?.randomUUID?.() || Date.now().toString(36);
        this.startTime = new Date().toISOString();
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

    static close() {
        sessionRepository.close();
    }
}

module.exports = Session;

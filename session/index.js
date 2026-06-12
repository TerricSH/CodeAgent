const sessionRepository = require('../data-layer/repositories/session-repository');

class Session {
    constructor(options = {}) {
        this.id = Date.now().toString(36);
        this.startTime = new Date().toISOString();
        this.messages = [];
        this.metadata = options.metadata || null;
    }

    add(message) {
        this.messages.push({
            ...message,
            timestamp: new Date().toISOString(),
        });
    }

    save() {
        const endTime = new Date().toISOString();
        sessionRepository.saveSession({
            id: this.id,
            startTime: this.startTime,
            endTime,
            metadata: this.metadata,
            messages: this.messages,
        });
        return this.id;
    }

    static list() {
        return sessionRepository.listSessions();
    }

    static listFromDb() {
        return this.list();
    }

    static load(id) {
        return sessionRepository.loadSession(id);
    }

    static close() {
        sessionRepository.close();
    }
}

module.exports = Session;

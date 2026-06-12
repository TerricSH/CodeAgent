class SystemPrompt {
    constructor(content) {
        this.content = content || '';
    }

    set(content) {
        this.content = content;
    }

    get() {
        return this.content;
    }

    toMessage() {
        if (!this.content) return null;
        return { role: 'system', content: this.content };
    }
}

module.exports = SystemPrompt;

class SystemPrompt {
    constructor(content) {
        this.content = content || '';
        // 动态分段：插件可按 name 维护一段附加内容，toMessage 时拼到 base 之后。
        // 用 Map 保留插入顺序，避免多插件互相覆盖整段 content。
        this.sections = new Map();
    }

    set(content) {
        this.content = content;
    }

    get() {
        return this.content;
    }

    // 新增/更新一个动态分段；text 为空则等价于移除该分段。
    upsertSection(name, text) {
        if (!name) return;
        if (text === undefined || text === null || text === '') {
            this.sections.delete(name);
            return;
        }
        this.sections.set(name, String(text));
    }

    removeSection(name) {
        this.sections.delete(name);
    }

    // 传输态：base content + 各动态分段（按插入顺序）拼接为一条 system 消息。
    compose() {
        const parts = [];
        if (this.content) parts.push(this.content);
        for (const text of this.sections.values()) {
            if (text) parts.push(text);
        }
        return parts.join('\n\n');
    }

    toMessage() {
        const composed = this.compose();
        if (!composed) return null;
        return { role: 'system', content: composed };
    }
}

module.exports = SystemPrompt;

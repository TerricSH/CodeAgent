const ThinkingHandler = require('./ThinkingHandler');
const ContentHandler = require('./ContentHandler');
const ToolCallsHandler = require('./ToolCallsHandler');

class HandlerFactory {
    constructor(output) {
        this.handlers = {};
        this.register('thinking', new ThinkingHandler(output));
        this.register('content', new ContentHandler(output));
        this.register('tool_calls', new ToolCallsHandler(output));
    }

    register(type, handler) {
        this.handlers[type] = handler;
    }

    get(type) {
        return this.handlers[type] || null;
    }

    createState() {
        return { reply: '', inThinking: false, pendingToolCalls: null };
    }
}

module.exports = HandlerFactory;

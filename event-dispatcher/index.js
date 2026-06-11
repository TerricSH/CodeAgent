const ThinkingHandler = require('./ThinkingHandler');
const ContentHandler = require('./ContentHandler');
const ToolCallsHandler = require('./ToolCallsHandler');

class EventDispatcher {
    constructor(output) {
        this.handlers = {};
        this.register('thinking', new ThinkingHandler(output));
        this.register('content', new ContentHandler(output));
        this.register('tool_calls', new ToolCallsHandler(output));
    }

    register(type, handler) {
        this.handlers[type] = handler;
    }

    dispatch(event, state) {
        const handler = this.handlers[event.type];
        if (handler) handler.handle(event, state);
    }

    createState() {
        return { reply: '', inThinking: false, pendingToolCalls: null };
    }
}

module.exports = EventDispatcher;

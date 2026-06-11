const EventHandler = require('./EventHandler');

class ToolCallsHandler extends EventHandler {
    handle(event, state) {
        state.pendingToolCalls = event.calls;
    }
}

module.exports = ToolCallsHandler;

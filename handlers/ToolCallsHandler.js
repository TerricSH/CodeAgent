const ChunkHandler = require('./ChunkHandler');

class ToolCallsHandler extends ChunkHandler {
    handle(event, state) {
        state.pendingToolCalls = event.calls;
    }
}

module.exports = ToolCallsHandler;

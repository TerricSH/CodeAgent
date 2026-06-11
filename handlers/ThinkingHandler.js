const ChunkHandler = require('./ChunkHandler');

class ThinkingHandler extends ChunkHandler {
    handle(event, state) {
        if (!state.inThinking) {
            state.inThinking = true;
            this.output.write('思考中: ');
        }
        this.output.write(event.content);
    }
}

module.exports = ThinkingHandler;

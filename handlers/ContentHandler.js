const ChunkHandler = require('./ChunkHandler');

class ContentHandler extends ChunkHandler {
    handle(event, state) {
        if (state.inThinking) {
            state.inThinking = false;
            this.output.write('\n\nAI: ');
        } else if (!state.reply) {
            this.output.write('AI: ');
        }
        this.output.write(event.content);
        state.reply += event.content;
    }
}

module.exports = ContentHandler;

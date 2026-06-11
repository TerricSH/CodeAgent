const EventHandler = require('./EventHandler');

class ContentHandler extends EventHandler {
    handle(event, state) {
        if (state.inThinking) {
            state.inThinking = false;
            this.output.thinking.renderEnd();
        }
        if (!state.reply) {
            this.output.content.renderStart();
        }
        this.output.content.render(event.content);
        state.reply += event.content;
    }
}

module.exports = ContentHandler;

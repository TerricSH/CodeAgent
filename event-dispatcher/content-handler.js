const EventHandler = require('./event-handler');

class ContentHandler extends EventHandler {
    handle(event, state) {
        if (state.inThinking) {
            state.inThinking = false;
            this.output.thinking.renderEnd();
        }
        if (state.deferContent) {
            state.reply += event.content;
            return;
        }
        if (!state.reply) {
            this.output.content.renderStart();
        }
        this.output.content.render(event.content);
        state.reply += event.content;
    }
}

module.exports = ContentHandler;

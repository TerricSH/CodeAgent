const EventHandler = require('./EventHandler');

class ThinkingHandler extends EventHandler {
    handle(event, state) {
        if (!state.inThinking) {
            state.inThinking = true;
            this.output.thinking.renderStart();
        }
        this.output.thinking.render(event.content);
    }
}

module.exports = ThinkingHandler;

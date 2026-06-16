const ThinkingOutput = require('./thinking-output');
const ContentOutput = require('./content-output');
const ToolOutput = require('./tool-output');
const ErrorOutput = require('./error-output');

class TUIOutput {
    constructor(stream) {
        this.stream = stream || process.stdout;
        this.thinking = new ThinkingOutput(this.stream);
        this.content = new ContentOutput(this.stream);
        this.tool = new ToolOutput(this.stream);
        this.error = new ErrorOutput(this.stream);
    }
}

module.exports = TUIOutput;

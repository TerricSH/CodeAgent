const ThinkingOutput = require('./ThinkingOutput');
const ContentOutput = require('./ContentOutput');
const ToolOutput = require('./ToolOutput');
const ErrorOutput = require('./ErrorOutput');

class CLIOutput {
    constructor(stream) {
        this.stream = stream || process.stdout;
        this.thinking = new ThinkingOutput(this.stream);
        this.content = new ContentOutput(this.stream);
        this.tool = new ToolOutput(this.stream);
        this.error = new ErrorOutput(this.stream);
    }
}

module.exports = CLIOutput;

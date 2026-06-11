const BaseOutput = require('../BaseOutput');

class ErrorOutput extends BaseOutput {
    render(msg) {
        this.writeLine(`\n错误: ${msg}\n`);
    }
}

module.exports = ErrorOutput;

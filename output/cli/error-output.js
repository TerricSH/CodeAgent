const BaseOutput = require('../base-output');
const { labels } = require('./labels');

class ErrorOutput extends BaseOutput {
    render(msg) {
        const errorLabel = labels['label.error'] || '错误';
        const errorMessage = this.colorize(`${errorLabel}: ${msg}`, BaseOutput.colors.red);
        this.writeLine(`\n${errorMessage}\n`);
    }
}

module.exports = ErrorOutput;

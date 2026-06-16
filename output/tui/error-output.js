const BaseOutput = require('../base-output');
const TuiBaseOutput = require('./tui-output');
const { labels } = require('./labels');

class ErrorOutput extends TuiBaseOutput {
    render(msg) {
        const label = labels['label.error'] || '错误';
        this.write('\n');
        this.panel(label, String(msg), BaseOutput.colors.red, BaseOutput.colors.lightRed);
        this.write('\n');
    }
}

module.exports = ErrorOutput;

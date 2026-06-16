const BaseOutput = require('../base-output');
const TuiBaseOutput = require('./tui-output');
const { labels } = require('./labels');

class ToolOutput extends TuiBaseOutput {
    renderCall(name, args) {
        const label = labels['label.toolCall'] || '调用工具';
        this.panel(`${label} ${name}`, JSON.stringify(args, null, 2), BaseOutput.colors.cyan, BaseOutput.colors.gray);
        this.write('\n');
    }

    renderResult(name, result) {
        const label = labels['label.toolResult'] || '工具结果';
        this.panel(`${label} ${name}`, String(result), BaseOutput.colors.blue, BaseOutput.colors.gray);
        this.write('\n');
    }
}

module.exports = ToolOutput;

const BaseOutput = require('../base-output');
const { labels } = require('./labels');

class ToolOutput extends BaseOutput {
    renderCall(name, args) {
        const toolCallLabel = labels['label.toolCall'] || '[调用工具]';
        const toolCall = this.colorize(`${toolCallLabel} ${name}(${JSON.stringify(args)})`, BaseOutput.colors.gray);
        this.writeLine(`\n${toolCall}`);
    }

    renderResult(name, result) {
        const toolResultLabel = labels['label.toolResult'] || '[工具结果]';
        const toolResultHeader = this.colorize(`${toolResultLabel} ${name}:`, BaseOutput.colors.gray);
        this.writeLine(toolResultHeader);
        this.writeLine(this.colorize(result, BaseOutput.colors.gray));
        this.writeLine('');
    }
}

module.exports = ToolOutput;

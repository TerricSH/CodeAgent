const BaseOutput = require('../base-output');

class ToolOutput extends BaseOutput {
    renderCall(name, args) {
        this.writeLine(`\n[调用工具] ${name}(${JSON.stringify(args)})`);
    }

    renderResult(name, result) {
        this.writeLine(`[工具结果] ${name}:`);
        this.writeLine(result);
        this.writeLine('');
    }
}

module.exports = ToolOutput;

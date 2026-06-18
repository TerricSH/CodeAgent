const BaseOutput = require('../base-output');
const { labels } = require('./labels');

class ThinkingOutput extends BaseOutput {
    render(text) {
        this.write(this.colorize(text, BaseOutput.colors.lightGreen));
    }

    renderStart() {
        const thinkingLabel = labels['label.thinking'] || '━━━ 思考中 ';
        this.write(this.colorize(thinkingLabel, BaseOutput.colors.lightGreen));
    }

    renderEnd() {
        const thinkingEndLabel = labels['label.thinkingEnd'] || ' ━━━';
        this.write(this.colorize(thinkingEndLabel, BaseOutput.colors.lightGreen));
        this.write('\n\n');
    }
}

module.exports = ThinkingOutput;

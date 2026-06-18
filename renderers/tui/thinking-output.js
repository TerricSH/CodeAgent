const BaseOutput = require('../base-output');
const TuiBaseOutput = require('./tui-output');
const { labels } = require('./labels');

class ThinkingOutput extends TuiBaseOutput {
    renderStart() {
        const title = labels['label.thinking'] || '思考中';
        this.panelTop(title, BaseOutput.colors.lightGreen);
    }

    render(text) {
        this.panelBody(text, BaseOutput.colors.lightGreen);
    }

    renderEnd() {
        this.panelBottom();
        this.write('\n');
    }
}

module.exports = ThinkingOutput;

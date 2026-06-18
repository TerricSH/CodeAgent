const BaseOutput = require('../base-output');
const TuiBaseOutput = require('./tui-output');
const { labels } = require('./labels');

class ContentOutput extends TuiBaseOutput {
    renderStart() {
        const title = labels['prompt.ai'] || 'AI';
        this.panelTop(title, BaseOutput.colors.lightCyan);
    }

    render(text) {
        this.panelBody(text);
    }

    renderEnd() {
        this.panelBottom();
        this.write('\n');
    }
}

module.exports = ContentOutput;

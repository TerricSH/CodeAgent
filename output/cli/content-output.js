const BaseOutput = require('../base-output');
const { labels } = require('./labels');

class ContentOutput extends BaseOutput {
    renderStart() {
        const aiLabel = labels['prompt.ai'] || 'AI';
        this.write(this.colorize(`${aiLabel}: `, BaseOutput.colors.lightCyan));
    }

    render(text) {
        this.write(text);
    }

    renderEnd() {
        this.writeLine('\n');
    }
}

module.exports = ContentOutput;

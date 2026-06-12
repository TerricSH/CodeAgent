const BaseOutput = require('../base-output');

class ContentOutput extends BaseOutput {
    renderStart() {
        this.write('AI: ');
    }

    render(text) {
        this.write(text);
    }

    renderEnd() {
        this.writeLine('\n');
    }
}

module.exports = ContentOutput;

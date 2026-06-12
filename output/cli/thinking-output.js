const BaseOutput = require('../base-output');

class ThinkingOutput extends BaseOutput {
    render(text) {
        this.write(text);
    }

    renderStart() {
        this.write('思考中: ');
    }

    renderEnd() {
        this.write('\n\n');
    }
}

module.exports = ThinkingOutput;

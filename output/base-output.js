class BaseOutput {
    constructor(stream) {
        this.stream = stream;
    }

    write(text) {
        this.stream.write(text);
    }

    writeLine(text) {
        this.stream.write(text + '\n');
    }

    render() {
        throw new Error('子类必须实现 render 方法');
    }
}

module.exports = BaseOutput;

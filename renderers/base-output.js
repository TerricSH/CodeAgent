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

    // ANSI颜色代码
    static colors = {
        reset: '\x1b[0m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        gray: '\x1b[90m',      // 浅灰色
        lightGreen: '\x1b[92m', // 浅绿色
        lightRed: '\x1b[91m',   // 浅红色
        lightYellow: '\x1b[93m', // 浅黄色
        lightBlue: '\x1b[94m',  // 浅蓝色
        lightMagenta: '\x1b[95m', // 浅洋红色
        lightCyan: '\x1b[96m',  // 浅青色
    };

    // 颜色包装方法
    colorize(text, color) {
        return `${color}${text}${BaseOutput.colors.reset}`;
    }

    render() {
        throw new Error('子类必须实现 render 方法');
    }
}

module.exports = BaseOutput;
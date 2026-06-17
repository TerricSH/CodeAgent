const readline = require('readline');
const BaseOutput = require('../base-output');

// 收集器自带的中性兜底文案；具体业务文案由调用方（插件）经 question.labels 传入。
const DEFAULTS = {
    title: 'Select',
    custom: 'Custom…',
    answer: 'Answer',
    arrowsHint: '(↑/↓ Enter)',
    numberHint: '(enter number)',
    numberFreeHint: '(enter number, or type your own)',
    cancelled: '(cancelled)',
};

// CLI 交互收集：完全独立实现，自包含「渲染 + 输入 + 解析」。
// 不内置任何业务标签，文案全部来自 question.labels（缺省走 DEFAULTS），与具体插件解耦。
// 与 mainloop 共享的 readline 通过 setInput 注入，选择期间 pause、结束 resume，避免按键串扰。
class PromptOutput extends BaseOutput {
    constructor(stream) {
        super(stream || process.stdout);
        this.rl = null;
    }

    setInput(rl) {
        this.rl = rl;
    }

    // 统一接口：返回用户最终答案字符串；用户取消（Ctrl+C 等）返回 null 以与真实答案区分。
    async collect(question) {
        const text = (question && question.text) || '';
        const options = Array.isArray(question && question.options) ? question.options : [];
        const allowFreeform = question ? question.allowFreeform !== false : true;
        const index = question && question.index;
        const total = question && question.total;
        const intro = (question && question.intro) || '';
        const L = { ...DEFAULTS, ...((question && question.labels) || {}) };

        // 开场说明：让用户看到「为什么需要这些信息」，仅在提供时展示。
        if (intro) this.writeLine(`\n${this.colorize(intro, BaseOutput.colors.gray)}`);
        this._renderHeader(text, index, total, L);

        // 无选项 → 纯自由文本输入。
        if (options.length === 0) {
            return this._readLine(L.answer);
        }

        // 非 TTY（管道/重定向）无法进 raw-mode → 降级为编号输入。
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
            return this._collectByNumber(options, allowFreeform, L);
        }

        return this._collectByArrows(options, allowFreeform, L);
    }

    _renderHeader(text, index, total, L) {
        const tag = (typeof index === 'number' && typeof total === 'number')
            ? this.colorize(`[${index}/${total}] `, BaseOutput.colors.gray)
            : '';
        const title = this.colorize(L.title, BaseOutput.colors.lightCyan);
        this.writeLine(`\n${title} ${tag}${text}`);
    }

    // raw-mode 方向键选择。取消返回 null。
    _collectByArrows(options, allowFreeform, L) {
        const items = allowFreeform ? [...options, L.custom] : [...options];
        this.writeLine(this.colorize(L.arrowsHint, BaseOutput.colors.gray));
        // 保存光标到选项区起点；重绘时回到此处并清到屏幕末尾，天然兼容自动换行/多行，无需按行计数。
        this.write('\x1b7');

        return new Promise((resolve) => {
            let selected = 0;

            const draw = () => {
                this.write('\x1b8');   // 回到保存的光标位置
                this.write('\x1b[0J'); // 清除从光标到屏幕末尾
                for (let i = 0; i < items.length; i++) {
                    if (i === selected) {
                        this.writeLine(this.colorize(`❯ ${items[i]}`, BaseOutput.colors.lightGreen));
                    } else {
                        this.writeLine(`  ${items[i]}`);
                    }
                }
            };

            const onKeypress = (str, key) => {
                if (!key) return;
                if (key.ctrl && key.name === 'c') {
                    cleanup();
                    this.writeLine(this.colorize(L.cancelled, BaseOutput.colors.gray));
                    resolve(null);
                    return;
                }
                if (key.name === 'up' || key.name === 'left') {
                    selected = (selected - 1 + items.length) % items.length;
                    draw();
                } else if (key.name === 'down' || key.name === 'right') {
                    selected = (selected + 1) % items.length;
                    draw();
                } else if (key.name === 'return' || key.name === 'enter') {
                    const isCustom = allowFreeform && selected === items.length - 1;
                    cleanup();
                    if (isCustom) {
                        this._readLine(L.answer).then(resolve);
                    } else {
                        resolve(options[selected]);
                    }
                }
            };

            const cleanup = () => {
                process.stdin.removeListener('keypress', onKeypress);
                if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
                process.stdin.pause();
            };

            if (this.rl) this.rl.pause();
            readline.emitKeypressEvents(process.stdin, this.rl || undefined);
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('keypress', onKeypress);
            draw();
        });
    }

    // 降级：打印编号，读取一行；数字命中选项→对应项，否则按自由文本（若允许），非法且不允许自由文本→返回 null（取消）。
    async _collectByNumber(options, allowFreeform, L) {
        for (let i = 0; i < options.length; i++) {
            this.writeLine(`  ${i + 1}. ${options[i]}`);
        }
        this.writeLine(this.colorize(allowFreeform ? L.numberFreeHint : L.numberHint, BaseOutput.colors.gray));

        const answer = await this._readLine(L.answer);
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            return options[n - 1];
        }
        if (allowFreeform) return answer;
        // 不允许自由文本且输入非法 → 返回取消信号，避免误记为首项。
        return null;
    }

    // 复用共享 rl 读取一行；无 rl 时临时建一个并关闭。
    _readLine(promptText) {
        const caret = `${promptText} > `;
        if (this.rl) {
            const rl = this.rl;
            rl.resume();
            return new Promise((resolve) => {
                rl.question(caret, (input) => resolve((input || '').trim()));
            });
        }
        return new Promise((resolve) => {
            const tmp = readline.createInterface({ input: process.stdin, output: this.stream });
            tmp.question(caret, (input) => {
                tmp.close();
                resolve((input || '').trim());
            });
        });
    }
}

module.exports = PromptOutput;

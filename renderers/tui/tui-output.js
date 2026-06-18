const BaseOutput = require('../base-output');

// TUI 边框字符
const CHARS = {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
};

// TUI 输出基类：在 BaseOutput 之上提供面板（边框卡片）绘制能力
class TuiBaseOutput extends BaseOutput {
    static chars = CHARS;

    // 面板宽度，跟随终端列宽并限制在合理范围
    panelWidth() {
        const cols = this.stream.columns || process.stdout.columns || 80;
        return Math.max(24, Math.min(cols, 100));
    }

    // 计算去除 ANSI 颜色码后的可见长度
    visibleLength(text) {
        return String(text).replace(/\x1b\[[0-9;]*m/g, '').length;
    }

    // 绘制面板顶部（带标题）
    panelTop(title, color) {
        const head = `${CHARS.topLeft}${CHARS.horizontal} ${title} `;
        const fill = Math.max(0, this.panelWidth() - this.visibleLength(head) - 1);
        const line = `${head}${CHARS.horizontal.repeat(fill)}${CHARS.topRight}`;
        this.writeLine(this.colorize(line, color));
        this._panelColor = color;
        this._atLineStart = true;
    }

    // 绘制面板内容（支持流式追加，按行补齐左边框）
    panelBody(text, textColor) {
        const borderColor = this._panelColor || BaseOutput.colors.gray;
        const prefix = this.colorize(`${CHARS.vertical} `, borderColor);
        const parts = String(text).split('\n');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            if (part.length > 0) {
                if (this._atLineStart) {
                    this.write(prefix);
                    this._atLineStart = false;
                }
                this.write(textColor ? this.colorize(part, textColor) : part);
            }
            if (!isLast) {
                if (this._atLineStart) this.write(prefix);
                this.write('\n');
                this._atLineStart = true;
            }
        }
    }

    // 绘制面板底部
    panelBottom() {
        if (!this._atLineStart) {
            this.write('\n');
            this._atLineStart = true;
        }
        const color = this._panelColor || BaseOutput.colors.gray;
        const line = `${CHARS.bottomLeft}${CHARS.horizontal.repeat(this.panelWidth() - 2)}${CHARS.bottomRight}`;
        this.writeLine(this.colorize(line, color));
        this._panelColor = null;
    }

    // 一次性绘制完整面板（标题 + 内容 + 底部）
    panel(title, body, color, bodyColor) {
        this.panelTop(title, color);
        this.panelBody(body, bodyColor || color);
        this.panelBottom();
    }
}

module.exports = TuiBaseOutput;

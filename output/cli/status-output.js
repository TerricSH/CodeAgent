const BaseOutput = require('../base-output');
const { labels } = require('./labels');

// 上下文用量状态栏：在每次用户输入前显示「已用/限额」。
// 数据来自 context.usage()（启发式估算，非精确计费）；limit 为空则不显示。
class StatusOutput extends BaseOutput {
    render(usage) {
        if (!usage || usage.limit == null) return;
        const percent = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
        const template = labels['status.context'] || '上下文 {used}/{limit} · 已用 {percent}% · {messages} 条';
        const text = fmt(template, {
            used: fmtNum(usage.used),
            limit: fmtNum(usage.limit),
            remaining: fmtNum(usage.remaining),
            percent,
            messages: usage.messageCount,
        });
        this.writeLine(this.colorize(text, BaseOutput.colors.gray));
    }
}

function fmt(template, vars) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

function fmtNum(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : n;
}

module.exports = StatusOutput;

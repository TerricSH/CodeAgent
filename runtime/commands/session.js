// session 命令：实现统一命令接口 { match, run, presents, present }。
// 逻辑层只返回数据/选择标签；显示文本全部来自显示层 labels（经 ctx.labels 传入），不在此写死。
function fmt(template, vars = {}) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

function match(text) {
    return text.startsWith('/session');
}

function run(text, { runtime, labels = {} }) {
    const parts = text.trim().split(/\s+/);
    const sub = parts[1] || 'help';
    const arg = parts[2];

    switch (sub) {
        case 'list': {
            const list = runtime.list();
            if (!list.length) return { handled: true, message: labels['session.listEmpty'] };
            const item = labels['session.listItem'] || '{id}  {start}';
            const message = list.slice(0, 20).map((s) => fmt(item, { id: s.id, start: s.startTime })).join('\n');
            return { handled: true, message };
        }
        case 'current': {
            const c = runtime.current();
            return { handled: true, message: fmt(labels['session.current'], { id: c.id, start: c.startTime, count: c.messageCount }) };
        }
        case 'new':
            runtime.requestNew();
            return { handled: true };
        case 'use':
            if (!arg) return { handled: true, message: labels['session.usageUse'] };
            runtime.requestSwitch(arg);
            return { handled: true };
        default:
            return { handled: true, message: labels['session.help'] };
    }
}

// 是否由本命令模块负责呈现该事件（来自 runtime.applyPending 的结构化结果）。
function presents(event) {
    return Boolean(event) && (event.type === 'switch' || event.type === 'new' || event.type === 'error');
}

function present(event, { labels = {} } = {}) {
    if (!event) return null;
    if (event.type === 'new') return fmt(labels['session.created'], { id: event.id });
    if (event.type === 'switch') return fmt(labels['session.switched'], { id: event.id, count: event.messageCount });
    if (event.type === 'error') {
        const template = event.reason === 'failed' ? labels['session.opFailed'] : labels['session.notFound'];
        return fmt(template, { id: event.id, detail: event.detail || '' });
    }
    return null;
}

module.exports = { match, run, presents, present };

function fmt(template, vars = {}) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (_, key) => (
        vars[key] != null ? vars[key] : ''
    ));
}

function match(text) {
    return /^\/workspace(?:\s|$)/.test(text);
}

function unquote(value) {
    const text = String(value || '').trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1);
        }
    }
    return text;
}

function run(text, { runtime, labels = {} }) {
    const requestedRoot = unquote(text.slice('/workspace'.length));
    if (!requestedRoot) {
        const current = runtime.workspaceStatus();
        return {
            handled: true,
            message: fmt(labels['workspace.current'] || '当前 Workspace: {root}', current),
        };
    }

    try {
        runtime.requestWorkspace(requestedRoot);
        return { handled: true };
    } catch (error) {
        return {
            handled: true,
            message: fmt(
                labels['workspace.opFailed'] || 'Workspace 切换失败: {detail}',
                { detail: error instanceof Error ? error.message : String(error) }
            ),
        };
    }
}

function presents(event) {
    return Boolean(event) && (event.type === 'workspace-switch' || event.type === 'workspace-error');
}

function present(event, { labels = {} } = {}) {
    if (event.type === 'workspace-switch') {
        const template = event.changed
            ? (labels['workspace.switched'] || '已切换 Workspace: {root}')
            : (labels['workspace.unchanged'] || 'Workspace 未变化: {root}');
        return fmt(template, event);
    }
    return fmt(
        labels['workspace.opFailed'] || 'Workspace 切换失败: {detail}',
        { detail: event.detail || '' }
    );
}

module.exports = { match, run, presents, present };

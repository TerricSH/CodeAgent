const fs = require('fs');
const path = require('path');
const { getLedger } = require('./state');
const { formatItem, formatList } = require('./format');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');
const STATUSES = ['pending', 'in_progress', 'completed', 'blocked'];

const definition = {
    type: 'function',
    function: {
        name: 'task_ledger',
        description: '当前 agent 的轻量任务提醒清单，用于记住多步骤任务中还需要做什么',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    description: '操作类型',
                    enum: ['add', 'list', 'update', 'complete', 'block', 'clear'],
                },
                id: {
                    type: 'string',
                    description: '任务条目 id，update/complete/block 时必填',
                },
                title: {
                    type: 'string',
                    description: '任务标题，add 时必填，update 时可选',
                },
                items: {
                    type: 'array',
                    description: '批量添加任务标题列表，add 时可替代 title',
                    items: { type: 'string' },
                },
                status: {
                    type: 'string',
                    description: '任务状态，update 时可选',
                    enum: STATUSES,
                },
                note: {
                    type: 'string',
                    description: '备注或阻塞原因',
                },
            },
            required: ['action'],
        },
    },
};

async function handler(args, context) {
    const ledger = getLedger(context);
    if (!ledger) return 'task_ledger 不可用';

    try {
        switch (args.action) {
            case 'add': {
                const titles = Array.isArray(args.items) && args.items.length > 0
                    ? args.items
                    : (args.title ? [args.title] : []);
                if (titles.length === 0) return '添加失败: title 或 items 必填';
                const added = titles.map(t => ledger.add(t, args.note || ''));
                return `已添加:\n${added.map(formatItem).join('\n')}`;
            }
            case 'list':
                return formatList(ledger.list());
            case 'update': {
                if (!args.id) return '更新失败: id 必填';
                const item = ledger.update(args.id, {
                    title: args.title,
                    status: args.status,
                    note: args.note,
                });
                if (!item) return `更新失败: 未找到 ${args.id}`;
                return `已更新:\n${formatItem(item)}`;
            }
            case 'complete': {
                if (!args.id) return '完成失败: id 必填';
                const item = ledger.complete(args.id, args.note);
                if (!item) return `完成失败: 未找到 ${args.id}`;
                return `已完成:\n${formatItem(item)}`;
            }
            case 'block': {
                if (!args.id) return '阻塞失败: id 必填';
                const item = ledger.block(args.id, args.note);
                if (!item) return `阻塞失败: 未找到 ${args.id}`;
                return `已标记阻塞:\n${formatItem(item)}`;
            }
            case 'clear':
                ledger.clear();
                return '已清空 task ledger';
            default:
                return `未知 action: ${args.action}`;
        }
    } catch (err) {
        return `task_ledger 执行失败: ${err.message}`;
    }
}

module.exports = { definition, handler, prompt };
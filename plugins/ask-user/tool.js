const fs = require('fs');
const path = require('path');
const { formatPackage, formatPairs } = require('./format');
const labels = require('./labels');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'ask_user',
        description: '需要补充信息时向用户提问；支持一次提多个问题，用户可选选项或自由作答，答案打包返回作为基础信息',
        parameters: {
            type: 'object',
            properties: {
                intro: {
                    type: 'string',
                    description: '可选的开场说明，告诉用户为什么需要这些信息',
                },
                questions: {
                    type: 'array',
                    description: '一批问题，逐个询问后统一返回',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: '问题内容' },
                            options: {
                                type: 'array',
                                description: '可选项（不提供则为纯自由作答）',
                                items: { type: 'string' },
                            },
                            allow_freeform: {
                                type: 'boolean',
                                description: '是否允许用户给出自己的意见（默认 true）',
                            },
                        },
                        required: ['text'],
                    },
                },
            },
            required: ['questions'],
        },
    },
};

async function handler(args, context, ext) {
    if (!ext || typeof ext.askUser !== 'function') {
        return 'ask_user 不可用：当前环境不支持交互式提问';
    }

    const questions = Array.isArray(args.questions) ? args.questions : [];
    if (questions.length === 0) {
        return '提问失败：questions 至少需要一个问题';
    }

    const intro = args.intro || '';
    const pairs = [];
    let cancelled = false;
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i] || {};
        const answer = await ext.askUser({
            text: q.text || '',
            options: Array.isArray(q.options) ? q.options : [],
            allowFreeform: q.allow_freeform !== false,
            intro: i === 0 ? intro : '',
            index: i + 1,
            total: questions.length,
            labels,
        });
        // 用户取消（含非法输入降级）返回 null → 不记录该问题，停止本批提问。
        if (answer === null) {
            cancelled = true;
            break;
        }
        pairs.push({ question: q.text || '', answer: String(answer) });
    }

    // 仅持久化用户真实回答；取消的问题不写入历史，避免被当成基础事实注入。
    if (pairs.length > 0) {
        const ts = new Date().toISOString();
        ext.record({ intro, pairs, ts });
        const content = formatPackage(intro, pairs);
        context.load({
            role: 'system',
            content,
            kind: 'user_instruction',
            sourceRef: `ask-user:${ts}`,
        });
        if (context.auditWriter) {
            context.auditWriter.record({
                eventType: 'user_instruction.received',
                actor: 'user',
                content,
                payload: { questionCount: pairs.length },
            });
        }
    }

    if (cancelled) {
        return pairs.length > 0
            ? `用户取消了其余提问。以下是已收集到的回答：\n\n${formatPairs(pairs)}`
            : '用户取消了提问，未收集到任何信息。';
    }
    return formatPackage(intro, pairs);
}

module.exports = { definition, handler, prompt };

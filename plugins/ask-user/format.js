// ask-user 格式化：把问答记录打包成给模型的工具结果，以及注入系统提示的分段文本。

// 单条问答打包（工具结果用）。
function formatQA(question, answer) {
    return `问：${question}\n答：${answer}`;
}

// 多条问答拼接。
function formatPairs(pairs) {
    return pairs.map(({ question, answer }) => formatQA(question, answer)).join('\n\n');
}

// 工具返回给模型的整批结果。
function formatPackage(intro, pairs) {
    const lines = [];
    if (intro) lines.push(intro);
    lines.push('已收集到用户的回答：');
    lines.push(formatPairs(pairs));
    return lines.join('\n\n');
}

// 注入系统提示的分段文本：汇总历史所有问答，作为模型的基础信息。
function formatSection(records) {
    if (!Array.isArray(records) || records.length === 0) return '';
    const lines = ['## 已收集的基础信息（来自用户）'];
    for (const rec of records) {
        const pairs = Array.isArray(rec.pairs) ? rec.pairs : [];
        for (const { question, answer } of pairs) {
            lines.push(`- ${question} → ${answer}`);
        }
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

module.exports = { formatQA, formatPairs, formatPackage, formatSection };

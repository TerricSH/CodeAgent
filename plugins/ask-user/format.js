const path = require('node:path');
const { loadPromptTemplate } = require('../../prompts/loader');

const renderHistorySystem = loadPromptTemplate(path.join(__dirname, 'prompts', 'history-system.md'));
const renderHistoryItem = loadPromptTemplate(path.join(__dirname, 'prompts', 'history-item.md'));

function formatQA(question, answer) {
    return `问：${question}\n答：${answer}`;
}

function formatPairs(pairs) {
    return pairs.map(({ question, answer }) => formatQA(question, answer)).join('\n\n');
}

function formatPackage(intro, pairs) {
    const lines = [];
    if (intro) lines.push(intro);
    lines.push('已收集到用户的回答：');
    lines.push(formatPairs(pairs));
    return lines.join('\n\n');
}

function formatSection(records) {
    if (!Array.isArray(records) || records.length === 0) return '';
    const items = [];
    for (const record of records) {
        const pairs = Array.isArray(record.pairs) ? record.pairs : [];
        for (const { question, answer } of pairs) {
            items.push(renderHistoryItem({ question, answer }));
        }
    }
    return items.length > 0 ? renderHistorySystem({ items: items.join('\n') }) : '';
}

module.exports = { formatQA, formatPairs, formatPackage, formatSection };

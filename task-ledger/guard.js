function formatOpenItems(items) {
    return items
        .map((item) => `${item.order}. [${item.status}] ${item.id} ${item.title}${item.note ? ` - ${item.note}` : ''}`)
        .join('\n');
}

function buildReminder(context) {
    const ledger = context.taskLedger;
    if (!ledger || !ledger.hasOpenItems()) return null;

    const open = ledger.openItems();
    return [
        '你的 task ledger 仍有未完成条目。继续执行下一条，或标记 blocked 说明原因。',
        '',
        formatOpenItems(open),
    ].join('\n');
}

function shouldContinue(context) {
    const ledger = context.taskLedger;
    if (!ledger || !ledger.hasItems()) return false;
    return ledger.hasOpenItems();
}

module.exports = { shouldContinue, buildReminder };

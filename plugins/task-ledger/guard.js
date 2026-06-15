const { getLedger } = require('./state');
const { formatItem } = require('./format');

function buildReminder(context) {
    const ledger = getLedger(context);
    if (!ledger || !ledger.hasOpenItems()) return null;

    return [
        '你的 task ledger 仍有未完成条目。继续执行下一条，或标记 blocked 说明原因。',
        '',
        ledger.openItems().map(formatItem).join('\n'),
    ].join('\n');
}

function shouldContinue(context) {
    const ledger = getLedger(context);
    if (!ledger || !ledger.hasItems()) return false;
    return ledger.hasOpenItems();
}

module.exports = { shouldContinue, buildReminder };
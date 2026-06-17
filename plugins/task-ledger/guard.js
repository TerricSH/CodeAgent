const { formatItem } = require('./format');

// guard 不再写死插件名，也不从 context 取状态；ledger 由宿主在执行期注入（ext）。
function buildReminder(context, ledger) {
    if (!ledger || !ledger.hasOpenItems()) return null;

    return [
        '你的 task ledger 仍有未完成条目。继续执行下一条，或标记 blocked 说明原因。',
        '',
        ledger.openItems().map(formatItem).join('\n'),
    ].join('\n');
}

function shouldContinue(context, ledger) {
    if (!ledger || !ledger.hasItems()) return false;
    return ledger.hasOpenItems();
}

module.exports = { shouldContinue, buildReminder };
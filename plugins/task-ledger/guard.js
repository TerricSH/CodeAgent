const { formatItem } = require('./format');

// guard 不再写死插件名，也不从 context 取状态；ext 为宿主在执行期注入的 getApi() 返回值（此处即 ledger 实例）。
function buildReminder(context, ext) {
    if (!ext || !ext.hasOpenItems()) return null;

    return [
        '你的 task ledger 仍有未完成条目。继续执行下一条，或标记 blocked 说明原因。',
        '',
        ext.openItems().map(formatItem).join('\n'),
    ].join('\n');
}

function shouldContinue(context, ext) {
    if (!ext || !ext.hasItems()) return false;
    return ext.hasOpenItems();
}

module.exports = { shouldContinue, buildReminder };
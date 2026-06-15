function formatItem(item) {
    const note = item.note ? ` - ${item.note}` : '';
    return `${item.order}. [${item.status}] ${item.id} ${item.title}${note}`;
}

function formatList(items) {
    if (!items.length) return '当前 task ledger 为空';
    return items.map(formatItem).join('\n');
}

module.exports = { formatItem, formatList };
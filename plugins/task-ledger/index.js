const TaskLedger = require('./ledger');
const continuationGuard = require('./guard');
const { NAME, createState } = require('./state');
const tool = require('./tool');

const taskLedgerPlugin = {
    name: NAME,
    scope: 'session',
    tools: [tool],
    continuationGuards: [continuationGuard],

    init(context, config = {}) {
        if (context.hasPluginState(NAME)) return;

        context.setPluginState(NAME, createState(config.ledger || new TaskLedger()));
    },
};

module.exports = taskLedgerPlugin;
const NAME = 'task-ledger';

function createState(ledger) {
    return { ledger };
}

function getLedger(context) {
    const state = context.getPluginState(NAME);
    return state ? state.ledger : null;
}

module.exports = { NAME, createState, getLedger };
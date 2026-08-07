const { definePlugin } = require('../define-plugin');
const tools = require('./tools');

const NAME = 'workspace';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,
    capabilities: { required: ['workspace'] },

    onError(error) {
        throw error;
    },

    init(context, { capabilities } = {}) {
        const { workspace } = capabilities;
        return {
            getApi: () => workspace,
            isDirty: () => false,
        };
    },
});

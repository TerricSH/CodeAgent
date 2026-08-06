const { definePlugin } = require('../define-plugin');
const tools = require('./tools');

const NAME = 'workspace';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,

    onError(error) {
        throw error;
    },

    init(context, { services = {} } = {}) {
        const workspace = services.workspace;
        if (!workspace) throw new Error('Runtime workspace control service is unavailable');
        return {
            getApi: () => workspace,
            isDirty: () => false,
        };
    },
});

const path = require('node:path');
require('dotenv').config();

const providers = require('../model-providers');
const { createModelCapability } = require('../runtime/model-runtime');
const { SkillRefinementService } = require('../skill-refinement');

async function main() {
    const projectRoot = path.resolve(__dirname, '..');
    const localClients = [];
    const defaultClient = providers.resolveDefault();
    const service = new SkillRefinementService('pywright-local-refinement', {
        projectRoot,
        sandboxRoot: path.join(projectRoot, '.code', 'sandboxes'),
    }, {
        defaultModel: createModelCapability(defaultClient, providers.config.default),
        modelResolver: {
            resolve(ref) {
                const client = providers.resolve(ref);
                if (typeof client.dispose === 'function') localClients.push(client);
                return createModelCapability(client, ref);
            },
        },
    });

    try {
        const status = await service.status();
        if (!status.available) {
            throw new Error(status.error || 'No Skill Refinement sandbox backend is available');
        }
        const result = await service.refine({ suiteId: 'pywright-game-completion' });
        console.log(JSON.stringify({
            run: result.run,
            sandboxBackend: result.best?.evaluation?.backend || status.backend,
            models: result.models,
            ranking: result.ranking,
            candidateSkillPath: result.candidateSkill.path,
            rawTrajectoryPath: result.rawTrajectoryPath,
        }, null, 2));
    } finally {
        await service.dispose();
        await Promise.all(localClients.map(client => client.dispose()));
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});

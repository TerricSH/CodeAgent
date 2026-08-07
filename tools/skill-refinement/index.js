const fs = require('node:fs');
const path = require('node:path');
const { requireCapability } = require('../../runtime/capabilities');
const { SkillRefinementService } = require('../../skill-refinement');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'skill_refinement',
        description: 'Evaluate and refine a Skill through isolated, scored agent Rollouts.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'list_suites', 'refine', 'history', 'result'],
                },
                suiteId: {
                    type: 'string',
                    description: 'Host-defined suite identifier required by refine.',
                },
                runId: {
                    type: 'string',
                    description: 'Completed refinement run identifier required by result.',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of runs returned by history.',
                },
            },
            required: ['action'],
        },
    },
};

const capabilities = { required: ['sandboxScope'], optional: ['model'] };

function format(value) {
    return JSON.stringify(value, null, 2);
}

function createHandler(options = {}) {
    const Service = options.Service || SkillRefinementService;
    return async (args = {}, context, injectedCapabilities = {}) => {
        let service = null;
        try {
            const scope = requireCapability(injectedCapabilities, 'sandboxScope');
            service = options.createService
                ? options.createService({ args, context, capabilities: injectedCapabilities })
                : new Service(context?.sessionId, {
                    projectRoot: scope.projectRoot,
                    sandboxRoot: scope.sandboxRoot,
                }, {
                    model: injectedCapabilities.model || null,
                });

            switch (args.action) {
                case 'status':
                    return format(await service.status());
                case 'list_suites':
                    return format(service.listSuites());
                case 'refine':
                    if (context?.metadata?.type === 'subagent') {
                        throw new Error('Subagents may not start Skill Refinement runs');
                    }
                    return format(await service.refine({ suiteId: args.suiteId }));
                case 'history':
                    return format({ runs: service.history(args.limit) });
                case 'result':
                    return format(service.result(args.runId));
                default:
                    throw new Error(`Unsupported Skill Refinement action: ${args.action || '(missing)'}`);
            }
        } catch (error) {
            return format({
                ok: false,
                action: args.action || null,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (service && typeof service.dispose === 'function') await service.dispose();
        }
    };
}

const handler = createHandler();

module.exports = { definition, handler, prompt, capabilities, createHandler };

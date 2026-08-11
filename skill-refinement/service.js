const { normalizeRefinementConfig } = require('./config');
const { SandboxEvaluator } = require('./evaluator');
const { RefinementArtifactRepository } = require('./artifact-repository');
const { RolloutCoordinator } = require('./rollout-coordinator');
const { SkillRefinementOrchestrator } = require('./orchestrator');

class SkillRefinementService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.config = normalizeRefinementConfig(config);
        this.defaultModel = dependencies.defaultModel || null;
        this.modelResolver = dependencies.modelResolver || null;
        this.evaluator = dependencies.evaluator || new SandboxEvaluator(
            this.sessionId,
            this.config,
            { client: dependencies.client }
        );
        this.artifacts = dependencies.artifacts || new RefinementArtifactRepository(
            this.sessionId,
            this.config
        );
        this.rollouts = dependencies.rollouts || new RolloutCoordinator({
            evaluator: this.evaluator,
            artifacts: this.artifacts,
            rolloutExecutor: dependencies.rolloutExecutor,
        });
        this.orchestrator = dependencies.orchestrator || new SkillRefinementOrchestrator(
            this.config,
            {
                artifacts: this.artifacts,
                rollouts: this.rollouts,
                defaultModel: this.defaultModel,
                modelResolver: this.modelResolver,
                skillRefiner: dependencies.skillRefiner,
                slowUpdater: dependencies.slowUpdater,
                metaUpdater: dependencies.metaUpdater,
            }
        );
    }

    get runRoot() {
        return this.artifacts.runRoot;
    }

    async status() {
        return {
            ...await this.evaluator.status(),
            suites: this.listSuites(),
            runRoot: this.runRoot,
            recentRuns: this.history(5),
            modelCapabilities: {
                current: this.defaultModel && typeof this.defaultModel.info === 'function'
                    ? this.defaultModel.info()
                    : null,
                resolverAvailable: Boolean(
                    this.modelResolver && typeof this.modelResolver.resolve === 'function'
                ),
            },
        };
    }

    listSuites() {
        return this.orchestrator.listSuites();
    }

    refine(args) {
        return this.orchestrator.refine(args);
    }

    history(limit) {
        return this.artifacts.history(limit);
    }

    result(runId) {
        return this.artifacts.result(runId);
    }

    dispose() {
        return this.evaluator.dispose();
    }
}

module.exports = {
    SkillRefinementService,
};

const { createRagRuntime } = require('../tools/rag/runtime');
const { SkillAdapter } = require('./adapters');

class SkillRagService {
    constructor(options = {}) {
        this.runtimeFactory = options.runtimeFactory || createRagRuntime;
        this.adapter = options.adapter || new SkillAdapter();
        this.listSkills = options.listSkills;
    }

    async compileInstalled(runtime) {
        const skills = typeof this.listSkills === 'function' ? this.listSkills() : [];
        const results = [];
        for (const skill of skills) {
            const document = this.adapter.document({
                id: skill.name,
                name: skill.name,
                content: `${skill.name}\n${skill.description}\n\n${skill.prompt}`,
                metadata: { description: skill.description },
            });
            results.push(await runtime.compiler.compileText(document));
        }
        return results;
    }

    async search(options = {}) {
        const collection = this.adapter.collection('installed');
        const runtime = this.runtimeFactory({ defaultCollection: collection });
        try {
            await this.compileInstalled(runtime);
            return runtime.query.search({
                query: options.query,
                collection,
                topK: options.limit || 5,
                candidateLimit: options.candidateLimit,
                eventSink: options.eventSink,
            });
        } finally {
            if (typeof runtime.dispose === 'function') await runtime.dispose();
        }
    }
}

module.exports = SkillRagService;

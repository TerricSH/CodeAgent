const fs = require('node:fs');
const path = require('node:path');
const skills = require('../../skills');
const SkillRagService = require('../../rag-core/skill-service');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'skill_search',
        description: 'Search installed Skills using semantic and keyword retrieval, fusion, and reranking.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The concrete task or capability needed.' },
                limit: { type: 'number', description: 'Number of candidates to return (1-20).' },
                candidateLimit: { type: 'number', description: 'Candidates retained before reranking.' },
            },
            required: ['query'],
        },
    },
};

async function handler(args = {}, context) {
    const writer = context.auditWriter;
    if (writer) writer.record({ eventType: 'skill.searched', actor: 'skill-rag', content: args.query });
    const service = new SkillRagService({ listSkills: () => skills.all() });
    const result = await service.search({
        query: args.query,
        limit: args.limit,
        candidateLimit: args.candidateLimit,
        eventSink: (eventType, payload) => {
            if (writer) writer.record({ eventType, actor: 'skill-rag', payload });
        },
    });
    return {
        query: result.query,
        count: result.count,
        candidates: result.results.map(item => ({
            id: item.metadata?.name || item.documentId,
            name: item.metadata?.name || item.title,
            description: item.metadata?.description || null,
            score: item.rerankScore,
            source: item.source,
        })),
    };
}

module.exports = { definition, handler, prompt };

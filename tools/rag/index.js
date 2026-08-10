const fs = require('node:fs');
const path = require('node:path');
const { requireCapability } = require('../../runtime/capabilities');
const { createRagRuntime } = require('./runtime');
const { RagPresenter } = require('./presenter');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'rag',
        description: '索引当前项目源码到 PostgreSQL，或查询已索引的项目知识',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'index_project', 'search', 'list_documents', 'delete_document', 'delete_collection'],
                },
                query: { type: 'string', description: 'search 操作的自然语言查询' },
                collection: { type: 'string', description: '默认使用当前 Workspace collection' },
                topK: { type: 'number', description: 'search 最终结果数，1-20' },
                candidateLimit: { type: 'number', description: '送入 rerank 的候选数，上限 200' },
                limit: { type: 'number', description: 'list_documents 返回数量' },
                documentId: { type: 'string', description: 'delete_document 的文档 ID' },
                extensions: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'index_project 包含的文件扩展名',
                },
                excludeDirectories: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'index_project 额外排除的目录名',
                },
                maxFiles: { type: 'number', description: 'index_project 最大文件数' },
                maxFileBytes: { type: 'number', description: 'index_project 单文件最大字节数' },
            },
            required: ['action'],
        },
    },
};

const capabilities = { required: ['workspace', 'fileSystem'] };

function defaultCollection(args, injectedCapabilities) {
    if (args.collection) return args.collection;
    const workspace = requireCapability(injectedCapabilities, 'workspace');
    const status = workspace.status();
    if (!status || !status.id) throw new Error('Runtime Workspace identity is unavailable');
    return `workspace:${status.id}`;
}

function createHandler(options = {}) {
    const runtimeFactory = options.createRuntime || options.createService || createRagRuntime;
    const presenter = options.presenter || new RagPresenter();
    return async (args = {}, context, injectedCapabilities) => {
        let runtime = null;
        const action = args.action;
        try {
            const collection = defaultCollection(args, injectedCapabilities);
            runtime = runtimeFactory({ defaultCollection: collection });
            let result;
            switch (action) {
                case 'status':
                    result = await runtime.status();
                    break;
                case 'index_project':
                    if (context?.metadata?.type === 'subagent') {
                        throw new Error('Subagents may not index project files');
                    }
                    result = await runtime.compiler.compileProject(
                        { ...args, collection },
                        injectedCapabilities
                    );
                    break;
                case 'search':
                    result = await runtime.query.search({
                        query: args.query,
                        collection,
                        topK: args.topK,
                        candidateLimit: args.candidateLimit,
                        eventSink: (eventType, payload) => {
                            if (context?.auditWriter) {
                                context.auditWriter.record({ eventType, actor: 'project-rag', payload });
                            }
                        },
                    });
                    break;
                case 'list_documents':
                    result = await runtime.query.listDocuments({ collection, limit: args.limit });
                    break;
                case 'delete_document':
                    if (context?.metadata?.type === 'subagent') {
                        throw new Error('Subagents may not delete project documents');
                    }
                    result = await runtime.deleteDocument({ collection, documentId: args.documentId });
                    break;
                case 'delete_collection':
                    if (context?.metadata?.type === 'subagent') {
                        throw new Error('Subagents may not delete RAG collections');
                    }
                    result = await runtime.deleteCollection({ collection });
                    break;
                default:
                    throw new Error(`Unsupported RAG action: ${action || '(missing)'}`);
            }
            return presenter.present(action, result);
        } catch (error) {
            return presenter.presentError(action, error);
        } finally {
            if (runtime && typeof runtime.dispose === 'function') await runtime.dispose();
        }
    };
}

const handler = createHandler();

function effects(args = {}) {
    return ['status', 'search', 'list_documents'].includes(args.action) ? 'read' : 'write';
}

module.exports = { definition, handler, prompt, capabilities, createHandler, defaultCollection, effects };

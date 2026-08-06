const fs = require('node:fs');
const path = require('node:path');
const { requireRuntimeService } = require('../runtime-service');
const { createRagService } = require('./runtime');
const { listProjectFiles } = require('./project-files');

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
                    enum: ['status', 'index_project', 'search', 'list_documents', 'delete_document'],
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

function format(value) {
    return JSON.stringify(value, null, 2);
}

function defaultCollection(args, context) {
    if (args.collection) return args.collection;
    const workspace = requireRuntimeService(context, 'workspace');
    const status = workspace.status();
    if (!status || !status.id) throw new Error('Runtime Workspace identity is unavailable');
    return `workspace:${status.id}`;
}

async function indexProject(args, context, service) {
    if (context?.metadata?.type === 'subagent') {
        throw new Error('Subagents may not index project files');
    }
    const workspace = requireRuntimeService(context, 'workspace');
    const fileSystem = requireRuntimeService(context, 'fileSystem');
    const collection = defaultCollection(args, context);
    const workspaceStatus = workspace.status();
    if (!workspaceStatus || !workspaceStatus.root) {
        throw new Error('Runtime Workspace root is unavailable');
    }
    const files = listProjectFiles(workspaceStatus.root, {
        extensions: args.extensions,
        excludeDirectories: args.excludeDirectories,
        maxFiles: args.maxFiles,
        maxFileBytes: args.maxFileBytes,
    });
    const results = [];

    for (const file of files) {
        try {
            const resolved = fileSystem.resolveExisting(file.path, { type: 'file' });
            const content = fs.readFileSync(resolved, 'utf8');
            const result = await service.ingestText({
                collection,
                source: `workspace:${file.path}`,
                title: file.path,
                content,
                metadata: {
                    type: 'workspace-source',
                    path: file.path,
                    size: file.size,
                },
            });
            results.push({ path: file.path, ok: true, unchanged: Boolean(result.unchanged), chunks: result.chunks || 0 });
        } catch (error) {
            results.push({
                path: file.path,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const succeeded = results.filter(result => result.ok).length;
    const unchanged = results.filter(result => result.ok && result.unchanged).length;
    return {
        collection,
        total: results.length,
        indexed: succeeded - unchanged,
        unchanged,
        failed: results.length - succeeded,
        failures: results.filter(result => !result.ok),
    };
}

function createHandler(options = {}) {
    const serviceFactory = options.createService || createRagService;
    return async (args = {}, context) => {
        let service = null;
        try {
            const collection = defaultCollection(args, context);
            service = serviceFactory({ defaultCollection: collection });
            switch (args.action) {
                case 'status':
                    return format(await service.status());
                case 'index_project':
                    return format(await indexProject(args, context, service));
                case 'search':
                    return format(await service.search({
                        query: args.query,
                        collection,
                        topK: args.topK,
                        candidateLimit: args.candidateLimit,
                    }));
                case 'list_documents':
                    return format(await service.listDocuments({ collection, limit: args.limit }));
                case 'delete_document':
                    if (context?.metadata?.type === 'subagent') {
                        throw new Error('Subagents may not delete project documents');
                    }
                    return format(await service.deleteDocument({ collection, documentId: args.documentId }));
                default:
                    throw new Error(`Unsupported RAG action: ${args.action || '(missing)'}`);
            }
        } catch (error) {
            return format({ ok: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
            if (service && typeof service.dispose === 'function') await service.dispose();
        }
    };
}

const handler = createHandler();

module.exports = { definition, handler, prompt, createHandler, indexProject };

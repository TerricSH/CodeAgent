const crypto = require('node:crypto');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { chunkText, normalizeText } = require('./chunker');
const { listProjectFiles } = require('./project-files');
const { normalizeVector } = require('../../model/vector');
const {
    validateCollection,
    safeString,
    embeddingModel,
} = require('./contracts');

class RagCompiler {
    constructor({ repository, embeddingProvider, config, fileLister, readText } = {}) {
        if (!repository) throw new Error('RAG compiler repository is required');
        if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') {
            throw new Error('RAG compiler embedding provider is required');
        }
        if (!config) throw new Error('RAG compiler config is required');
        this.repository = repository;
        this.embeddingProvider = embeddingProvider;
        this.config = config;
        this.fileLister = fileLister || listProjectFiles;
        this.readText = readText || ((filePath) => fs.readFileSync(filePath, 'utf8'));
    }

    async compileText(options = {}) {
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const content = normalizeText(options.content);
        if (!content) throw new Error('RAG document content is required');
        if (content.length > this.config.maxDocumentChars) {
            throw new Error(`RAG document exceeds ${this.config.maxDocumentChars} characters`);
        }
        const requestedSource = options.source === undefined
            ? undefined
            : safeString(options.source, 2000, 'RAG source');
        const requestedTitle = options.title === undefined
            ? undefined
            : safeString(options.title, 500, 'RAG title');
        const requestedId = safeString(options.documentId, 200, 'RAG documentId');
        let existing = requestedSource
            ? await this.repository.findDocumentBySource(collection, requestedSource)
            : null;
        if (!existing && requestedId) {
            existing = await this.repository.getDocument(collection, requestedId);
        }
        const source = requestedSource === undefined ? existing?.source || null : requestedSource;
        const title = requestedTitle === undefined ? existing?.title || null : requestedTitle;
        const metadata = options.metadata && typeof options.metadata === 'object'
            ? options.metadata
            : existing?.metadata || {};
        const model = embeddingModel(this.embeddingProvider);
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        if (existing && options.replace === false) {
            throw new Error(`RAG document already exists: ${existing.id}`);
        }
        if (existing
            && existing.contentHash === contentHash
            && existing.embeddingModel === model
            && existing.title === title
            && isDeepStrictEqual(existing.metadata, metadata)) {
            return {
                ok: true,
                unchanged: true,
                documentId: existing.id,
                collection,
                contentHash,
            };
        }

        const chunks = chunkText(content, {
            chunkSize: this.config.chunkSize,
            overlap: this.config.chunkOverlap,
        });
        const embeddings = await this.embeddingProvider.embed(chunks.map(chunk => chunk.content));
        if (embeddings.length !== chunks.length) {
            throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
        }

        let dimensions = null;
        const storedChunks = chunks.map((chunk, index) => {
            const embedding = normalizeVector(embeddings[index], `embedding[${index}]`);
            if (dimensions == null) dimensions = embedding.length;
            if (embedding.length !== dimensions) {
                throw new Error(`Embedding dimensions are inconsistent at chunk ${index}`);
            }
            const configuredDimensions = this.config.embedding?.dimensions;
            if (configuredDimensions && embedding.length !== configuredDimensions) {
                throw new Error(
                    `Embedding provider returned ${embedding.length} dimensions; `
                    + `RAG_EMBEDDING_DIMENSIONS is ${configuredDimensions}`
                );
            }
            return { ...chunk, embedding };
        });
        const now = new Date().toISOString();
        const documentId = await this.repository.upsertDocument({
            id: existing?.id || requestedId || crypto.randomUUID(),
            collection,
            source,
            title,
            contentHash,
            metadata,
            embeddingModel: model,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        }, storedChunks);

        return {
            ok: true,
            unchanged: false,
            documentId,
            collection,
            contentHash,
            chunks: storedChunks.length,
            embeddingModel: model,
            embeddingDimensions: dimensions,
        };
    }

    async compileProject(options = {}, capabilities = {}) {
        const { workspace, fileSystem } = capabilities;
        if (!workspace || typeof workspace.status !== 'function') {
            throw new Error('RAG compiler requires the Workspace capability');
        }
        if (!fileSystem || typeof fileSystem.resolveExisting !== 'function') {
            throw new Error('RAG compiler requires the fileSystem capability');
        }
        const workspaceStatus = workspace.status();
        if (!workspaceStatus || !workspaceStatus.root) {
            throw new Error('Runtime Workspace root is unavailable');
        }
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const files = this.fileLister(workspaceStatus.root, {
            extensions: options.extensions,
            excludeDirectories: options.excludeDirectories,
            maxFiles: options.maxFiles,
            maxFileBytes: options.maxFileBytes,
        });
        const results = [];

        for (const file of files) {
            try {
                const resolved = fileSystem.resolveExisting(file.path, { type: 'file' });
                const content = this.readText(resolved);
                const result = await this.compileText({
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
                results.push({
                    path: file.path,
                    ok: true,
                    unchanged: Boolean(result.unchanged),
                    chunks: result.chunks || 0,
                });
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
}

module.exports = RagCompiler;

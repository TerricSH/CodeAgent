const { Pool } = require('pg');
const { keywordText, postgresTsQuery } = require('../../rag-core/keywords');

function validateSchema(value) {
    const schema = String(value || 'codeagent_rag');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) {
        throw new Error('RAG PostgreSQL schema must be a safe identifier up to 63 characters');
    }
    return schema;
}

function quoteIdentifier(value) {
    return `"${value.replace(/"/g, '""')}"`;
}

function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function vectorLiteral(value, dimensions) {
    if (!Array.isArray(value) && !(value instanceof Float32Array)) {
        throw new TypeError('Embedding must be an array of numbers');
    }
    if (value.length !== dimensions) {
        throw new Error(`Embedding dimensions mismatch: expected ${dimensions}, got ${value.length}`);
    }
    const numbers = Array.from(value, Number);
    if (numbers.some((number) => !Number.isFinite(number))) {
        throw new Error('Embedding contains a non-finite value');
    }
    return `[${numbers.join(',')}]`;
}

function versionAtLeast(value, minimum) {
    const current = String(value || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
    const required = String(minimum).split('.').map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
        if ((current[index] || 0) > (required[index] || 0)) return true;
        if ((current[index] || 0) < (required[index] || 0)) return false;
    }
    return true;
}

class RagRepository {
    constructor(config = {}) {
        this.connectionString = config.connectionString || null;
        this.schema = validateSchema(config.schema);
        this.schemaSql = quoteIdentifier(this.schema);
        this.embeddingDimensions = Number.isInteger(config.embeddingDimensions)
            && config.embeddingDimensions > 0
            ? config.embeddingDimensions
            : 1536;
        if (this.embeddingDimensions > 2000) {
            throw new Error('pgvector HNSW vector embeddings support at most 2000 dimensions');
        }
        this.hnswEfSearch = Number.isInteger(config.hnswEfSearch) && config.hnswEfSearch > 0
            ? config.hnswEfSearch
            : 100;
        this.ownsPool = !config.pool;
        this.pool = config.pool || (this.connectionString
            ? new Pool({
                connectionString: this.connectionString,
                max: Number.isInteger(config.maxConnections) ? config.maxConnections : 10,
            })
            : null);
        this.ready = null;
    }

    configured() {
        return Boolean(this.pool);
    }

    info() {
        return {
            backend: 'postgresql+pgvector',
            schema: this.schema,
            configured: this.configured(),
            embeddingDimensions: this.embeddingDimensions,
        };
    }

    async _ensureReady() {
        if (!this.pool) {
            throw new Error('RAG PostgreSQL is not configured: set RAG_POSTGRES_URL or DATABASE_URL');
        }
        if (!this.ready) {
            this.ready = this._initialize().catch((error) => {
                this.ready = null;
                throw error;
            });
        }
        return this.ready;
    }

    async _initialize() {
        const client = await this.pool.connect();
        try {
            await client.query('CREATE EXTENSION IF NOT EXISTS vector');
            const extension = await client.query(
                "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
            );
            const extensionVersion = extension.rows[0]?.extversion;
            if (!versionAtLeast(extensionVersion, '0.8.0')) {
                throw new Error(
                    `RAG requires pgvector >= 0.8.0; found ${extensionVersion || 'unknown'}`
                );
            }
            await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${this.schemaSql}.rag_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${this.schemaSql}.rag_documents (
                    id TEXT PRIMARY KEY,
                    collection TEXT NOT NULL,
                    source TEXT,
                    title TEXT,
                    content_hash TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    embedding_model TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    UNIQUE (collection, source)
                )
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_rag_documents_collection_updated
                ON ${this.schemaSql}.rag_documents(collection, updated_at DESC)
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${this.schemaSql}.rag_chunks (
                    document_id TEXT NOT NULL REFERENCES ${this.schemaSql}.rag_documents(id) ON DELETE CASCADE,
                    collection TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    char_start INTEGER NOT NULL,
                    char_end INTEGER NOT NULL,
                    embedding vector(${this.embeddingDimensions}) NOT NULL,
                    embedding_model TEXT NOT NULL,
                    keyword_text TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (document_id, chunk_index)
                )
            `);
            await client.query(`
                ALTER TABLE ${this.schemaSql}.rag_chunks
                ADD COLUMN IF NOT EXISTS keyword_text TEXT NOT NULL DEFAULT ''
            `);
            await client.query(`
                ALTER TABLE ${this.schemaSql}.rag_chunks
                ADD COLUMN IF NOT EXISTS search_vector tsvector
                GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(keyword_text, ''))
                ) STORED
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection_model
                ON ${this.schemaSql}.rag_chunks(collection, embedding_model)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_hnsw
                ON ${this.schemaSql}.rag_chunks USING hnsw (embedding vector_cosine_ops)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_rag_chunks_keyword_gin
                ON ${this.schemaSql}.rag_chunks USING gin (search_vector)
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${this.schemaSql}.rag_tombstones (
                    collection TEXT NOT NULL,
                    source_ref TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (collection, source_ref)
                )
            `);
            await client.query(`
                INSERT INTO ${this.schemaSql}.rag_settings(key, value)
                VALUES ('embedding_dimensions', $1)
                ON CONFLICT (key) DO NOTHING
            `, [String(this.embeddingDimensions)]);
            const setting = await client.query(`
                SELECT value FROM ${this.schemaSql}.rag_settings
                WHERE key = 'embedding_dimensions'
            `);
            const storedDimensions = Number(setting.rows[0]?.value);
            if (storedDimensions !== this.embeddingDimensions) {
                throw new Error(
                    `RAG PostgreSQL schema uses ${storedDimensions} embedding dimensions, `
                    + `but configuration requests ${this.embeddingDimensions}`
                );
            }
        } finally {
            client.release();
        }
    }

    _mapDocument(row) {
        if (!row) return null;
        return {
            id: row.id,
            collection: row.collection,
            source: row.source,
            title: row.title,
            contentHash: row.content_hash,
            metadata: row.metadata || {},
            embeddingModel: row.embedding_model,
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
        };
    }

    async findDocumentBySource(collection, source) {
        if (!source) return null;
        await this._ensureReady();
        const result = await this.pool.query(`
            SELECT * FROM ${this.schemaSql}.rag_documents
            WHERE collection = $1 AND source = $2
        `, [collection, source]);
        return this._mapDocument(result.rows[0]);
    }

    async getDocument(collection, id) {
        await this._ensureReady();
        const result = await this.pool.query(`
            SELECT * FROM ${this.schemaSql}.rag_documents
            WHERE collection = $1 AND id = $2
        `, [collection, id]);
        return this._mapDocument(result.rows[0]);
    }

    async upsertDocument(record, chunks) {
        await this._ensureReady();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            let documentId = record.id;
            if (record.source) {
                const sourceLockKey = `${record.collection}\n${record.source}`;
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtext($1))',
                    [sourceLockKey]
                );
                const existingSource = await client.query(`
                    SELECT id FROM ${this.schemaSql}.rag_documents
                    WHERE collection = $1 AND source = $2
                    FOR UPDATE
                `, [record.collection, record.source]);
                if (existingSource.rows[0]) documentId = existingSource.rows[0].id;
            }
            const values = [
                documentId,
                record.collection,
                record.source || null,
                record.title || null,
                record.contentHash,
                JSON.stringify(record.metadata || {}),
                record.embeddingModel,
                record.createdAt,
                record.updatedAt,
            ];
            const inserted = await client.query(`
                INSERT INTO ${this.schemaSql}.rag_documents (
                    id, collection, source, title, content_hash, metadata,
                    embedding_model, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE SET
                    collection = excluded.collection,
                    source = excluded.source,
                    title = excluded.title,
                    content_hash = excluded.content_hash,
                    metadata = excluded.metadata,
                    embedding_model = excluded.embedding_model,
                    updated_at = excluded.updated_at
                RETURNING id
            `, values);
            documentId = inserted.rows[0].id;
            await client.query(
                `DELETE FROM ${this.schemaSql}.rag_chunks WHERE document_id = $1`,
                [documentId]
            );

            const batchSize = 500;
            for (let offset = 0; offset < chunks.length; offset += batchSize) {
                const batch = chunks.slice(offset, offset + batchSize);
                const params = [];
                const rows = batch.map((chunk, index) => {
                    const base = index * 10;
                    params.push(
                        documentId,
                        record.collection,
                        chunk.index,
                        chunk.content,
                        chunk.charStart,
                        chunk.charEnd,
                        vectorLiteral(chunk.embedding, this.embeddingDimensions),
                        record.embeddingModel,
                        keywordText(chunk.content),
                        record.updatedAt
                    );
                    return `(
                        $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
                        $${base + 5}, $${base + 6}, $${base + 7}::vector,
                        $${base + 8}, $${base + 9}, $${base + 10}
                    )`;
                });
                await client.query(`
                    INSERT INTO ${this.schemaSql}.rag_chunks (
                        document_id, collection, chunk_index, content, char_start, char_end,
                        embedding, embedding_model, keyword_text, created_at
                    ) VALUES ${rows.join(',')}
                `, params);
            }
            await client.query('COMMIT');
            return documentId;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async searchChunks(collection, embeddingModel, queryEmbedding, limit) {
        await this._ensureReady();
        const queryVector = vectorLiteral(queryEmbedding, this.embeddingDimensions);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL hnsw.iterative_scan = strict_order');
            await client.query(
                "SELECT set_config('hnsw.ef_search', $1, true)",
                [String(this.hnswEfSearch)]
            );
            const result = await client.query(`
                SELECT
                    c.document_id, c.chunk_index, c.content, c.char_start, c.char_end,
                    d.source, d.title, d.metadata, d.updated_at,
                    1 - (c.embedding <=> $3::vector) AS vector_score
                FROM ${this.schemaSql}.rag_chunks c
                JOIN ${this.schemaSql}.rag_documents d ON d.id = c.document_id
                WHERE c.collection = $1 AND c.embedding_model = $2
                  AND NOT EXISTS (
                      SELECT 1 FROM ${this.schemaSql}.rag_tombstones t
                      WHERE t.collection = c.collection
                        AND t.source_ref = d.metadata->>'memoryId'
                  )
                ORDER BY c.embedding <=> $3::vector
                LIMIT $4
            `, [collection, embeddingModel, queryVector, limit]);
            await client.query('COMMIT');
            return result.rows.map((row) => ({
                documentId: row.document_id,
                chunkIndex: row.chunk_index,
                content: row.content,
                charStart: row.char_start,
                charEnd: row.char_end,
                source: row.source,
                title: row.title,
                metadata: row.metadata || {},
                updatedAt: toIso(row.updated_at),
                vectorScore: Number(row.vector_score),
            }));
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async searchKeywordChunks(collection, query, limit) {
        await this._ensureReady();
        const tsQuery = postgresTsQuery(query);
        if (!tsQuery) return [];
        const result = await this.pool.query(`
            SELECT
                c.document_id, c.chunk_index, c.content, c.char_start, c.char_end,
                d.source, d.title, d.metadata, d.updated_at,
                ts_rank_cd(c.search_vector, to_tsquery('simple', $2)) AS keyword_score
            FROM ${this.schemaSql}.rag_chunks c
            JOIN ${this.schemaSql}.rag_documents d ON d.id = c.document_id
            WHERE c.collection = $1
              AND c.search_vector @@ to_tsquery('simple', $2)
              AND NOT EXISTS (
                  SELECT 1 FROM ${this.schemaSql}.rag_tombstones t
                  WHERE t.collection = c.collection
                    AND t.source_ref = d.metadata->>'memoryId'
              )
            ORDER BY keyword_score DESC, d.updated_at DESC
            LIMIT $3
        `, [collection, tsQuery, limit]);
        return result.rows.map(row => ({
            documentId: row.document_id,
            chunkIndex: row.chunk_index,
            content: row.content,
            charStart: row.char_start,
            charEnd: row.char_end,
            source: row.source,
            title: row.title,
            metadata: row.metadata || {},
            updatedAt: toIso(row.updated_at),
            keywordScore: Number(row.keyword_score),
        }));
    }

    async deleteDocument(collection, id) {
        await this._ensureReady();
        const result = await this.pool.query(`
            DELETE FROM ${this.schemaSql}.rag_documents
            WHERE collection = $1 AND id = $2
        `, [collection, id]);
        return result.rowCount > 0;
    }

    async deleteCollection(collection) {
        await this._ensureReady();
        const result = await this.pool.query(`
            DELETE FROM ${this.schemaSql}.rag_documents WHERE collection = $1
        `, [collection]);
        await this.pool.query(`
            DELETE FROM ${this.schemaSql}.rag_tombstones WHERE collection = $1
        `, [collection]);
        return result.rowCount;
    }

    async addTombstone(collection, sourceRef) {
        await this._ensureReady();
        await this.pool.query(`
            INSERT INTO ${this.schemaSql}.rag_tombstones (collection, source_ref, created_at)
            VALUES ($1, $2, now())
            ON CONFLICT (collection, source_ref) DO NOTHING
        `, [collection, sourceRef]);
    }

    async listDocuments(collection, limit = 50) {
        await this._ensureReady();
        const result = await this.pool.query(`
            SELECT d.*, COUNT(c.chunk_index)::integer AS chunk_count
            FROM ${this.schemaSql}.rag_documents d
            LEFT JOIN ${this.schemaSql}.rag_chunks c ON c.document_id = d.id
            WHERE d.collection = $1
            GROUP BY d.id
            ORDER BY d.updated_at DESC
            LIMIT $2
        `, [collection, limit]);
        return result.rows.map((row) => ({
            ...this._mapDocument(row),
            chunkCount: Number(row.chunk_count),
        }));
    }

    async stats() {
        await this._ensureReady();
        const result = await this.pool.query(`
            SELECT
                (SELECT COUNT(*)::integer FROM ${this.schemaSql}.rag_documents) AS documents,
                (SELECT COUNT(*)::integer FROM ${this.schemaSql}.rag_chunks) AS chunks,
                (SELECT COUNT(DISTINCT collection)::integer FROM ${this.schemaSql}.rag_documents) AS collections
        `);
        return {
            documents: Number(result.rows[0].documents),
            chunks: Number(result.rows[0].chunks),
            collections: Number(result.rows[0].collections),
            backend: 'postgresql+pgvector',
            schema: this.schema,
        };
    }

    async close() {
        if (this.pool && this.ownsPool) await this.pool.end();
    }
}

module.exports = RagRepository;
module.exports.validateSchema = validateSchema;
module.exports.vectorLiteral = vectorLiteral;
module.exports.versionAtLeast = versionAtLeast;

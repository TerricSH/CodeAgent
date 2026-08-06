# Local model directories

The default local model directories are:

- `bge-m3/`: local `BAAI/bge-m3` SentenceTransformer weights
- `bge-reranker-base/`: local `BAAI/bge-reranker-base` CrossEncoder weights

Override them with `RAG_LOCAL_EMBEDDING_MODEL` and `RAG_LOCAL_RERANK_MODEL` when needed. These
directories are ignored by Git because model weights are large. `RAG_EMBEDDING_DIMENSIONS` must
match the embedding model output and cannot exceed 2000 when using the pgvector HNSW `vector`
index.

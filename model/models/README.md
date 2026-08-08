# Local model directories

The default local model directories are:

- `bge-m3/`: local `BAAI/bge-m3` SentenceTransformer weights
- `bge-reranker-base/`: local `BAAI/bge-reranker-base` CrossEncoder weights
- `Qwen3-8B/`: local `Qwen/Qwen3-8B` generation model weights
- `DeepSeek-R1-Distill-Qwen-7B/`: local `deepseek-ai/DeepSeek-R1-Distill-Qwen-7B` weights
- `Qwen3-8B-GGUF/`: local official `Qwen/Qwen3-8B-GGUF` Q4_K_M weights
- `DeepSeek-R1-Distill-Qwen-7B-GGUF/`: local `bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF`
  Q4_K_M weights

Override them with `RAG_LOCAL_EMBEDDING_MODEL` and `RAG_LOCAL_RERANK_MODEL` when needed. These
directories are ignored by Git because model weights are large. `RAG_EMBEDDING_DIMENSIONS` must
match the embedding model output and cannot exceed 2000 when using the pgvector HNSW `vector`
index.

The GGUF generation models use Q4_K_M quantization and can be run with `llama.cpp`. On the local
RTX 3080 10GB, run one model at a time with full GPU offload (`-ngl all`) and begin with an 8192
token context (`-c 8192`). Keeping both models fully resident on the GPU at once is not supported by
the available VRAM.

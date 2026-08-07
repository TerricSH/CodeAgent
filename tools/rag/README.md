# RAG Tool

RAG 是 CodeAgent 的一个核心 Tool，不是插件，也不是承载数据库、模型和 Workspace 代码的独立子系统。
它负责把当前项目源码索引到 PostgreSQL，并检索已写入的项目知识。

## 代码边界

RAG 对外仍然只有一个 `rag` Tool，内部按职责拆开：

- `tools/rag/index.js`：解析 action、执行权限检查并把请求路由给对应模块。
- `tools/rag/compiler.js`：发现项目文件、读取文本、切块、生成 Embedding 并写入 Repository。
- `tools/rag/query.js`：生成查询向量、执行 pgvector 候选召回并 rerank。
- `tools/rag/presenter.js`：把编译、查询、文档和管理结果转换为 Tool 输出。
- `tools/rag/service.js`：兼容原 JavaScript API，组装 compiler/query，并管理数据库和模型资源生命周期。
- `tools/rag/contracts.js`：编译与查询共同使用的输入校验，不包含业务流程。
- `data-layer/repositories/rag-repository.js`：PostgreSQL + pgvector 数据访问。
- `model/`：本地 Embedding、rerank、Python Worker 和模型文件。

依赖方向是 `Tool 路由 → compiler/query → Repository 与模型接口`，展示层只接收操作结果，
不访问数据库、模型或 Workspace。Repository 也不依赖 Tool。

默认插件注册表不加载 RAG，也不创建进程级共享实例。Workspace 不保存 RAG 状态，也不提供
`ragScope`。RAG Tool 只读取通用的 Workspace `id` 和 `root`，自行选择项目文件并计算 collection，
然后访问 PostgreSQL；调用结束时释放本地模型 Worker 和连接池。

## 处理流程

```text
编译：项目文件扫描 → 源码切块 → Embedding → PostgreSQL/pgvector
查询：问题 Embedding → HNSW 候选召回 → rerank
展示：编译结果 / 查询结果 / 管理结果 → Tool JSON 输出
```

`index_project` 默认排除 `node_modules`、`.git`、`.code` 和 `workspace` 目录，跳过符号链接、
超大文件和未配置的扩展名。写入来源采用稳定的 `workspace:<relative-path>`，再次索引会更新同一文档，
不会重复插入。

## 配置

```dotenv
RAG_POSTGRES_URL=postgresql://codeagent:codeagent@127.0.0.1:5432/codeagent
RAG_POSTGRES_SCHEMA=codeagent_rag
RAG_DEFAULT_COLLECTION=project

RAG_LOCAL_EMBEDDING_MODEL=E:/codeAgent/model/models/bge-m3
RAG_LOCAL_EMBEDDING_MODEL_ID=bge-m3
RAG_LOCAL_RERANK_MODEL=E:/codeAgent/model/models/bge-reranker-base
RAG_LOCAL_RERANK_MODEL_ID=bge-reranker-base
RAG_EMBEDDING_DIMENSIONS=1024

RAG_LOCAL_PYTHON=python
RAG_LOCAL_DEVICE=cpu
```

可选限制：

- `RAG_CHUNK_SIZE`：切块字符数，默认 `1200`。
- `RAG_CHUNK_OVERLAP`：相邻切块重叠字符数，默认 `200`。
- `RAG_MAX_DOCUMENT_CHARS`：单文档最大字符数，默认 `2000000`。
- `RAG_CANDIDATE_LIMIT`：rerank 候选上限，默认 `30`。
- `RAG_POSTGRES_MAX_CONNECTIONS`：连接池上限，默认 `10`。
- `RAG_HNSW_EF_SEARCH`：HNSW 检索参数，默认 `100`。

本地模型运行环境：

```bash
python -m pip install -r model/requirements-local.txt
npm run test:rag-local-models
```

运行时不会下载模型。`RAG_EMBEDDING_DIMENSIONS` 必须与 Embedding 模型输出维度以及数据库中的
vector 列一致。

## Tool 接口

Tool 名称只有一个：`rag`。通过 `action` 选择操作：

- `status`：检查数据库、pgvector 和模型配置。
- `index_project`：扫描并索引当前项目文件，仅主 agent 可执行。
- `search`：Embedding 召回后 rerank，返回带文件来源和偏移量的结果。
- `list_documents`：列出当前项目 collection 中的文档。
- `delete_document`：按文档 ID 删除，仅主 agent 可执行。

检索内容只作为不可信 Tool 数据返回，不会自动写入 system 消息。

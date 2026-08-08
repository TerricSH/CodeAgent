# CodeAgent

## OpenAI Responses API Provider

Responses models use the OpenAI Responses API. Configure an OpenAI API key in `.env`:

```env
OPENAI_API_KEY=your-openai-api-key
OPENAI_RESPONSES_MODEL=your-model-name
```

Set `default` in `model-providers/config.json` to use it as the main model:

```json
{
  "default": "openai@responses/your-model-name"
}
```

The full generated configuration also contains the vendor definitions; only change
the `default` field in that file. This provider uses an OpenAI Platform API key and
does not reuse interactive login credentials.

一个基础的命令行 AI Agent 实验项目，支持模型对话、工具调用、子 agent、技能提示词、会话保存和可插拔输出层。

## Start

安装依赖：

```bash
npm install
```

启动：

```bash
npm start
```

等价于：

```bash
node mainloop.js
```

终端中输入消息开始对话，输入 `exit` 退出。

## Workspace

Configure one existing directory as the root for project content operations:

```env
WORKSPACE_ROOT=E:/projects/my-project
```

When omitted, the process startup directory is used. `read_file`, `read_files`, `write_file`,
`write_files`, and `list_dir` resolve relative paths inside this root. Lexical, absolute-path,
symbolic-link, and junction
escapes return `WORKSPACE_APPROVAL_REQUIRED` instead of executing. The Agent must then call
`workspace__workspace_request_access`; this Tool asks the user directly and can grant exactly one
matching read, write, or list operation. Chat text and Agent-generated parameters cannot approve
access. `run_command` starts with the Workspace root as its working directory. Memory project
scope and Docker Sandbox paths use the same stable Workspace ID. Use
`workspace__workspace_status` to inspect the active root.

Use the CLI command below to inspect or switch the active Workspace without restarting:

```text
/workspace
/workspace E:/projects/another-project
/workspace "E:/projects/a folder with spaces"
```

Relative switch paths are resolved from the current Workspace. Switching is performed only between
turns: the current session is persisted, session-scoped plugins are disposed, an immutable Workspace
snapshot is activated, and plugins/tools are rebuilt. The conversation is preserved. If rebuilding
fails, the runtime restores the previous Workspace and rebuilds its plugins and tools.

Workspace is a runtime-owned service, not the source of truth inside a plugin. Core file tools receive
only a file-resolution capability, `run_command` receives only a command working-directory scope,
and Memory and Docker Sandbox receive independent project-specific scope values. The Workspace
plugin is only the tool-facing status and approval adapter.

Host shell commands are not an OS sandbox and can still address paths allowed by the host account;
use `docker-sandbox__sandbox_exec` when command-level filesystem isolation is required.

## Model Config

模型配置放在 `.env`：

```env
API_KEY=your-api-key
API_BASE_URL=https://api.example.com/v1
MODEL_NAME=mimo-v2.5
SYSTEM_PROMPT=You are a helpful AI assistant.
OUTPUT_MODE=cli
```

默认厂商走 OpenAI-compatible 接口（见下文 Model Providers）。

## Model Providers

模型接入按「厂商 / 兼容接口 / 模型」组织，位于 `model-providers/`：

- **兼容接口（`interfaces/`）**：某种线格式如何构建请求、解析流、分类成统一事件（`thinking` / `content` / `tool_calls`），并自带默认实现。内置 `openai`（OpenAI 兼容）、`anthropic`（Anthropic 兼容）。
- **厂商（`config.json` 的 `vendors`）**：身份 + 凭证 + **声明它实现哪些接口（可多个）** + 各接口的连接/模型表。厂商通过【组合】选用接口（不是继承），所以同一厂商可同时实现 `openai` 和 `anthropic`。
- **模型**：每个模型的出厂属性（上下文窗口 `maxContextTokens`）。访问链接与窗口属于出厂属性，凭证（apiKey）走 env，使用方不手动拼装。

选型用引用 `厂商[@接口]/模型`：

- `anthropic/claude-sonnet-4-5` —— 用厂商的默认接口（声明里的第一个）。
- `mimo/mimo-v2.5` —— 默认接口 + 指定模型；省略模型则用该接口的 `modelEnv`。
- `mimo@anthropic/<model>` —— 显式选用该厂商的 `anthropic` 接口。

默认厂商由 `config.json` 的 `default` 指定。主 agent 用默认厂商；子 agent 可在 [agents](agents/) 配置里用 `model: '厂商[@接口]/模型'` 指定**完全不同**的厂商/模型（省成本提效），与主 agent 完全隔离。

新增厂商：

1. **纯标准兼容**：在 `model-providers/config.json` 的 `vendors` 加一条，`interfaces` 下列出它支持的接口（各自连接 + 模型表）。无需写代码。
2. **有私货**（如 DeepSeek 加强 tool_call / 推理回传，或 Copilot 特殊鉴权）：在 `model-providers/vendors/<name>.js` 里继承对应接口默认实现、覆写差异点，导出 `{ 接口名: 覆写类 }`，并在该厂商 config 加 `"impl": "<name>"`。

新增一种兼容接口 = 加 `model-providers/interfaces/<name>.js` 并在 `model-providers/index.js` 的 `INTERFACES` 登记。

上下文裁撤（按 token 预算整条递归裁）由 `Context` 统一执行，预算取自所用厂商解析出的 `maxContextTokens`；provider 只负责发送与接口翻译，不做裁撤。

## UI Labels Config

终端文案默认由配置文件管理（每个输出模式各自一份）：

```text
renderers/cli/labels.json
renderers/tui/labels.json
```

可直接修改对应模式的文件自定义终端前缀文案，无需改动代码。

可配置 key：

- `prompt.user`：用户输入前缀
- `prompt.ai`：AI 回复前缀
- `label.thinking`：思考开始标记
- `label.thinkingEnd`：思考结束标记
- `label.toolCall`：工具调用标签
- `label.toolResult`：工具结果标签
- `label.error`：错误前缀

如需环境变量覆盖（优先级高于 JSON 文件），可设置：

```env
UI_LABELS={"prompt.user":"User","prompt.ai":"Bot"}
```

## Features

- 多轮命令行对话
- 流式输出
- thinking / reasoning 输出展示
- OpenAI function calling 工具调用
- 同一轮多个工具并行执行
- 工具调用后自动把结果回传给模型继续生成
- 子 agent 委托执行
- skill 自动激活
- SQLite 会话保存
- CLI/TUI 可插拔输出层
- 终端文案可通过 `renderers/cli/labels.json` 配置

## Skills

当前内置技能：

| 技能名称 | 描述 | 适用场景 |
|---------|------|----------|
| `code-review` | 代码审查 - 分析代码质量、安全性和性能，给出改进建议 | 代码审查、质量检查 |
| `create-project` | 项目创建 - 根据需求从零搭建完整项目结构和代码 | 新项目初始化 |
| `advanced-code-review` | 高级代码审查 - 涵盖多语言框架的深度代码审查 | 多语言项目深度审查 |
| `systematic-debugging` | 系统化调试 - 四阶段调试方法论，强调先找根因再修复 | Bug调试、问题排查 |
| `prompt-master` | 提示词大师 - 为任何AI工具编写精准的提示词 | 提示词优化、AI工具使用 |
| `grill-me` | 代码质询 - 对代码进行深度质询和挑战性审查 | 代码挑战、架构讨论 |
| `git-commit` | Git提交 - 生成规范的Git提交信息 | Git工作流、提交规范 |
| `skill-creator` | Skill creation - bootstrap an unknown Skill through verified recurrent refinement | 未知 Skill 的初始生成与验证迭代 |

### 技能使用方式

技能会根据用户输入自动激活。例如：
- 输入代码审查相关请求时，`code-review` 或 `advanced-code-review` 会自动激活
- 输入调试相关问题时，`systematic-debugging` 会自动激活
- 输入项目创建需求时，`create-project` 会自动激活

### 技能开发规范

每个技能是一个文件夹，放在 `skills/` 目录下，包含：
- `index.js`: 技能定义（名称、描述、提示词加载）
- `prompt.md`: 技能提示词内容

新增技能示例：
```js
// skills/my-skill/index.js
const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'my-skill',
    description: '我的自定义技能',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
```

然后在 `skills/index.js` 中注册新技能。

## Tools

核心工具位于 `tools/`，每个工具一个文件夹。运行时插件也可以通过插件注册表贡献模型可调用工具。

当前内置工具：

- `run_command`: 执行本地命令
- `read_file`: 读取文件
- `read_files`: 批量读取多个文件并逐个返回结果
- `write_file`: 写入文件
- `write_files`: 批量写入多个文件并逐个返回结果
- `list_dir`: 列出目录
- `web_search`: 互联网搜索
- `github_search`: GitHub 搜索
- `activate_skill`: 激活 skill
- `delegate_agent`: 委托子 agent
- `rag`: 将当前项目源码索引到 PostgreSQL，或检索已索引的项目知识
- `skill_refinement`: 通过隔离 Rollout、固定评测和结果综合生成精炼后的 Skill 候选
- `trajectory_extract`: 读取已保存的 JSON/JSONL Agent 过程，清洗为可追溯 span 并另存结果
- `image_inspect`: 通过独立配置的外部视觉模型 API 分析截图或按条件验证截图内容

新增工具规范见 [tools/README.md](tools/README.md)。

## Runtime Plugins

运行时插件用于给会话上下文注入独立能力状态和生命周期钩子，不等同于模型可调用的 `tools/`。

当前内置插件：

- `task-ledger`: 为当前会话初始化任务清单状态，并贡献 `task_ledger` 工具和确定性的 continuation guard。
- `ask-user`: 需要补充信息时贡献 `ask_user` 工具，向用户批量提问（选项或自由作答），并把已收集信息注入系统提示作为基础信息。
- `memory`: 检索当前会话及持久化记忆。
- `auto-compaction`: 在上下文接近预算时生成传输层摘要。
- `docker-sandbox`: 在会话隔离的 Docker 工作区中执行非交互命令。

插件由 `plugins/index.js` 创建默认注册表，并在主会话和子 agent 会话创建后初始化。`Context` 本身只保存消息、系统提示状态和 metadata；插件状态由插件注册表管理。

插件和核心 Tool 通过 `capabilities.required/optional` 显式声明运行时依赖。宿主只在组合根提供
`capabilities`，注册表负责校验必需项，并向每个消费者注入声明过的冻结子集。`Context` 不提供
服务查询入口，插件和 Tool 无法把它当作隐式依赖总线。插件自带的终端文案随插件存放在插件目录内，
不写入核心 `renderers/<mode>/labels.json`。

新增插件规范与接口清单见 [plugins/README.md](plugins/README.md)。

### RAG Tool

RAG 是一个核心 Tool，不是运行时插件。`rag` 的 `index_project` 操作扫描当前 Workspace 的
项目文件，将切块和 Embedding 写入 PostgreSQL + pgvector；`search` 从当前 Workspace 的稳定
collection 中召回并 rerank。检索流程为：

```text
文档切块 → Embedding → pgvector/HNSW 候选召回 → rerank → 带来源的结果
```

代码职责按层拆分：数据库 Repository 位于 `data-layer/`，Embedding、rerank 与模型 Worker
位于 `model/`；`tools/rag/compiler.js` 负责项目编译，`query.js` 负责检索与 rerank，
`presenter.js` 负责结果展示，`index.js` 只负责 Tool action 路由和权限检查。
Embedding 与 rerank 由受管的本机 Python 子进程执行，强制离线模式，不调用外部模型服务。

`rag` 支持 `status`、`index_project`、`search`、`list_documents` 和 `delete_document` 操作。
只有主 agent 可以建立索引或删除文档；子 agent 可以查询和列出文档。

完整配置和边界说明见 [tools/rag/README.md](tools/rag/README.md)。检索内容始终作为不可信工具数据返回，
不会自动注入 system 消息。

### Docker Sandbox

先构建本地沙盒镜像：

```bash
npm run sandbox:build
```

沙盒按命令启动临时容器，工作目录位于 `.code/sandboxes/<session>/workspace`。默认策略包括：

- 禁用网络；
- 根文件系统只读；
- 删除全部 Linux capabilities，并禁止获取新权限；
- 非 root 用户；
- CPU、内存、进程数、执行时间和输出大小限制；
- 不挂载项目根目录、`.env`、`.git` 或 Docker Socket。

插件提供：

- `docker-sandbox__sandbox_status`
- `docker-sandbox__sandbox_exec`
- `docker-sandbox__sandbox_reset`

### Skill Refinement Tool

Skill Refinement 是 SkillOpt 风格的技能精炼能力，不训练模型权重，也不管理梯度、优化器或
checkpoint。宿主在 [`skill-refinement/suites/`](skill-refinement/suites/README.md) 中固定任务、
初始 Skill、评测命令和保护路径；`skill_refinement` Tool 从同一安全快照启动多个隔离 Rollout，
执行固定评测并排名，再根据完整评测证据生成 `refined-skill.md` 候选。

Suite 可分别设置 `templateModel` 和 `reflectionModel`：前者执行 Rollout，后者根据评分证据反思并
生成候选。模型引用由运行时显式解析，不会切换主会话模型；省略时对应角色回退到当前会话模型。

Tool 支持 `status`、`list_suites`、`refine`、`history` 和 `result`。只有主 agent 可以启动
`refine`。源 Skill 不会被自动覆盖，结果和 `raw-rollout-trajectories.jsonl` 只写入：

```text
.code/sandboxes/<session>/skill-refinement-runs/<run-id>/
```

模块边界和 suite 格式见 [skill-refinement/README.md](skill-refinement/README.md)。

### Trajectory Extraction Tool

`trajectory_extract` 不参与 Skill Refinement 的运行流程。Skill Refinement 只保存完整原始
Rollout；需要清洗时，再把 `rawTrajectoryPath` 作为 `trajectory_extract.sourcePath` 传入。
Tool 会将消息、LLM 回复、工具调用/结果、评测、diff 和 reward 转成带来源消息索引与 span ID
的结构化 JSON，并写入独立的 `*.cleaned.json`，不会覆盖原始过程文件。多条 Rollout 会额外生成
带证据 span ID 的横向比较；其中关联与 verifier link 仅表示时序/启发式关系，不宣称因果。

结构化格式与安全边界见 [trajectory-extraction/README.md](trajectory-extraction/README.md)。

### Image Inspect Tool

`image_inspect` 是独立的外接识图 Tool，不复用或切换当前会话模型，也不依赖 RAG、Skill
Refinement、轨迹提取器或插件服务。它支持：

- `status`：检查独立视觉 API 是否已配置；
- `analyze`：分析一张或多张 Workspace 截图；
- `verify`：逐条检查可见验收条件，并返回证据、置信度和代码重新计算的总结果。

外部接口使用 OpenAI-compatible 多模态消息格式，单独读取以下环境变量：

```env
VISION_API_KEY=your-vision-provider-key
VISION_API_BASE_URL=https://vision-provider.example/v1
VISION_MODEL=your-vision-model
```

调用 `analyze` 或 `verify` 会把指定图片发送给该外部服务，因此只应在用户明确要求识图或
验图时使用。图片中的文字按不可信数据处理，不能作为工具指令。配置、限制和返回格式见
[tools/image-inspect/README.md](tools/image-inspect/README.md)。

## Search Config

通用 Web 搜索配置：

```text
search-providers/config.json
```

GitHub 搜索配置：

```text
github/config.json
```

这些配置文件可能包含密钥，默认不提交到 Git。

## Sessions

会话数据保存到 SQLite：

```text
.code/session.sqlite
```

数据访问层位于：

```text
data-layer/
```

`session/` 目录只保留会话领域代码，不存储数据文件。

## Project Structure

运行时发送给模型的提示词保存在各功能目录的 Markdown 文件中，由 `prompts/loader.js` 统一
加载和渲染；JavaScript 不硬编码 system prompt。

```text
mainloop.js              # CLI 主循环
agent-runner.js          # Agent 对话与工具调用循环
client.js                # 默认模型 client（解析自 model-providers）
model-providers/         # 模型接入：厂商/兼容接口/模型（含 interfaces/ 接口与 vendors/ 私货覆写）
model/                   # RAG 本地 Embedding、rerank、Worker 与模型文件
context/                 # 对话上下文
plugins/                 # 运行时插件
skill-refinement/        # SkillOpt 风格的 Rollout、评测、排名和 Skill 候选综合
trajectory-extraction/   # 独立的原始轨迹清洗、span 提取和跨 Rollout 比较
sandbox/                 # Docker 隔离执行的共享基础设施
runtime/                 # Agent 运行时流程辅助模块
session/                 # 会话领域对象
data-layer/              # SQLite/PostgreSQL 数据访问与 repository
workspace/               # Workspace 路径、权限和切换
renderers/               # 输出层插件入口与 CLI/TUI 实现
event-dispatcher/        # 模型事件分发
skills/                  # skill 配置
agents/                  # subagent 配置
tools/                   # 核心工具（包括 rag 与 skill_refinement）
search-providers/        # Web 搜索 provider
github/                  # GitHub API 配置与客户端
```

## Output Plugin

内置两种输出模式：CLI（默认，行内标记风格）与 TUI（边框面板风格）：

```env
# 默认 CLI
OUTPUT_MODE=cli
# 或启用 TUI 面板风格
OUTPUT_MODE=tui
```

`renderers/index.js` 会根据 `OUTPUT_MODE` 加载内置或外部输出插件。内置模式对应 `renderers/<mode>/` 目录（如 `renderers/cli`、`renderers/tui`），每个模式实现相同的输出契约：`thinking` / `content` / `tool` / `error` 子输出，以及可选的 `prompt` 交互收集子输出（`collect(question)`，CLI/TUI 各自独立实现方向键/面板选择）。外部插件可以使用 `codeagent-output-<mode>` 的 npm 包名。

## Notes

- `.env`、搜索配置、GitHub 配置和 `.code/` 数据库都已忽略提交。
- 工具 prompt 会拼接进系统提示词，应保持简短。
- 大工具结果会完整传给模型，终端展示由 output 层决定。
- 终端前缀文案默认读取 `renderers/cli/labels.json`，无需修改代码。

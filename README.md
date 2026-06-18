# CodeAgent

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
output/cli/labels.json
output/tui/labels.json
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
- 终端文案可通过 `output/cli/labels.json` 配置

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
- `write_file`: 写入文件
- `list_dir`: 列出目录
- `web_search`: 互联网搜索
- `github_search`: GitHub 搜索
- `activate_skill`: 激活 skill
- `delegate_agent`: 委托子 agent

新增工具规范见 [tools/README.md](tools/README.md)。

## Runtime Plugins

运行时插件用于给会话上下文注入独立能力状态和生命周期钩子，不等同于模型可调用的 `tools/`。

当前内置插件：

- `task-ledger`: 为当前会话初始化任务清单状态，并贡献 `task_ledger` 工具和确定性的 continuation guard。
- `ask-user`: 需要补充信息时贡献 `ask_user` 工具，向用户批量提问（选项或自由作答），并把已收集信息注入系统提示作为基础信息。

插件由 `plugins/index.js` 创建默认注册表，并在主会话和子 agent 会话创建后初始化。`Context` 本身只保存消息、系统提示状态、metadata 和插件状态，不再直接实例化任务清单。

宿主可在创建注册表时通过 `createDefaultRegistry({ services })` 注入通用能力（如 `services.output` 交互层），这些能力会传给每个插件的 `init(context, { store, config, services })`。宿主只提供通用能力、不感知具体插件；插件自带的终端文案随插件存放在插件目录内，不写入核心 `output/<mode>/labels.json`。

新增插件规范与接口清单见 [plugins/README.md](plugins/README.md)。

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

```text
mainloop.js              # CLI 主循环
agent-runner.js          # Agent 对话与工具调用循环
client.js                # 默认模型 client（解析自 model-providers）
model-providers/         # 模型接入：厂商/兼容接口/模型（含 interfaces/ 接口与 vendors/ 私货覆写）
context/                 # 对话上下文
plugins/                 # 运行时插件
runtime/                 # Agent 运行时流程辅助模块
session/                 # 会话领域对象
data-layer/              # SQLite 与 repository
output/                  # 输出层插件入口与 CLI/TUI 实现
event-dispatcher/        # 模型事件分发
skills/                  # skill 配置
agents/                  # subagent 配置
tools/                   # 工具插件
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

`output/index.js` 会根据 `OUTPUT_MODE` 加载内置或外部输出插件。内置模式对应 `output/<mode>/` 目录（如 `output/cli`、`output/tui`），每个模式实现相同的输出契约：`thinking` / `content` / `tool` / `error` 子输出，以及可选的 `prompt` 交互收集子输出（`collect(question)`，CLI/TUI 各自独立实现方向键/面板选择）。外部插件可以使用 `codeagent-output-<mode>` 的 npm 包名。

## Notes

- `.env`、搜索配置、GitHub 配置和 `.code/` 数据库都已忽略提交。
- 工具 prompt 会拼接进系统提示词，应保持简短。
- 大工具结果会完整传给模型，终端展示由 output 层决定。
- 终端前缀文案默认读取 `output/cli/labels.json`，无需修改代码。

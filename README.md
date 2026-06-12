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

当前使用 OpenAI-compatible chat completions 接口。

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

## Tools

工具位于 `tools/`，每个工具一个文件夹。

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
client.js                # 模型客户端实例
model.js                 # 模型 API 封装
context/                 # 对话上下文
session/                 # 会话领域对象
data-layer/              # SQLite 与 repository
output/                  # 输出层插件入口与 CLI 实现
event-dispatcher/        # 模型事件分发
skills/                  # skill 配置
agents/                  # subagent 配置
tools/                   # 工具插件
search-providers/        # Web 搜索 provider
github/                  # GitHub API 配置与客户端
```

## Output Plugin

默认输出模式是 CLI：

```env
OUTPUT_MODE=cli
```

`output/index.js` 会根据 `OUTPUT_MODE` 加载内置或外部输出插件。外部插件可以使用 `codeagent-output-<mode>` 的 npm 包名。

## Notes

- `.env`、搜索配置、GitHub 配置和 `.code/` 数据库都已忽略提交。
- 工具 prompt 会拼接进系统提示词，应保持简短。
- 大工具结果会完整传给模型，终端展示由 output 层决定。

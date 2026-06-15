# Tool Development Guide

工具是模型可自动调用的本地能力。核心工具放在 `tools/<tool-folder>/` 下，并由 `tools/index.js` 注册。运行时插件也可以贡献工具；这类工具应放在对应插件目录内，由插件注册表交给工具注册表。

## Folder Structure

```text
tools/
  my-tool/
    index.js
    prompt.md
```

## index.js Contract

每个工具的 `index.js` 必须导出：

```js
module.exports = { definition, handler, prompt };
```

字段说明：

- `definition`: OpenAI function calling 格式的工具定义，负责告诉模型工具名、描述和参数结构。
- `handler`: 实际执行函数，可以是同步或异步函数。
- `prompt`: 从同目录 `prompt.md` 读取的简短使用说明。

## Tool Template

```js
const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'my_tool',
        description: '一句话说明工具用途',
        parameters: {
            type: 'object',
            properties: {
                input: { type: 'string', description: '输入内容' },
            },
            required: ['input'],
        },
    },
};

async function handler({ input }, context) {
    return `result: ${input}`;
}

module.exports = { definition, handler, prompt };
```

## prompt.md Rules

`prompt.md` 会被拼进系统提示词，所以必须短。

建议格式：

```md
# my_tool

一句话说明工具能力。

## 限制

- 只写模型必须知道的限制
- 不重复 definition 中已有的参数说明
```

## Registration

新增核心工具后，在 `tools/index.js` 中注册：

```js
const myTool = require('./my-tool');

const tools = [existingTool, myTool];
```

注册后模型会自动看到该工具的 `definition` 和 `prompt`。

`tools/index.js` 默认导出的 `definitions`、`prompts` 和 `execute` 只包含核心工具。插件贡献的工具必须通过工具注册表合并：

```js
const plugins = createDefaultRegistry();
const toolRegistry = tools.createRegistry(plugins.getTools());
```

如果调用 `runAgentLoop` 时用 `options.tools` 过滤工具列表，必须同时传入对应的 `toolRegistry`，否则 runner 会拒绝启动，避免模型看到某个工具但执行器不存在。

## Handler Rules

- 返回值应为字符串，方便作为 `role: tool` 的消息写入上下文。
- 如果返回结构化数据，请在 handler 内转为可读文本。
- 异步工具直接使用 `async function handler(...)`。
- 不要在工具代码里写死 API Key、Token 或密钥。
- 外部服务配置应放到独立配置层，如 `github/config.json` 或 `search-providers/config.json`。
- 工具失败时返回错误字符串，不要直接让进程崩溃。

## Naming Rules

- 文件夹名使用 kebab-case，例如 `github-search`。
- JS 模块文件名使用 kebab-case，例如 `tool-output.js`、`session-repository.js`。
- 类名使用 PascalCase，例如 `ToolOutput`、`SessionRepository`。
- 普通变量和函数使用 camelCase，例如 `loadConfig`、`sessionRepository`。
- function name 使用 snake_case，例如 `github_search`。
- prompt 标题与 function name 保持一致。

## Output

工具执行结果由 output 层决定如何展示。工具只负责返回完整结果，不负责截断或格式化 UI。

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

每个工具的 `index.js` 必须导出基础字段；需要运行时能力时还要导出声明：

```js
module.exports = { definition, handler, prompt, capabilities };
```

字段说明：

- `definition`: OpenAI function calling 格式的工具定义，负责告诉模型工具名、描述和参数结构。
- `handler`: 实际执行函数，可以是同步或异步函数。
- `prompt`: 从同目录 `prompt.md` 读取的简短使用说明。
- `capabilities`: 可选的 `{ required: string[], optional: string[] }` 依赖声明。

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

const capabilities = { required: ['fileSystem'] };

async function handler({ input }, context, injectedCapabilities) {
    const { fileSystem } = injectedCapabilities;
    return `result: ${input}`;
}

module.exports = { definition, handler, prompt, capabilities };
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
const plugins = createDefaultRegistry({ capabilities: runtimeCapabilities });
const toolRegistry = tools.createRegistry(
    plugins.getTools(),
    { capabilities: runtimeCapabilities }
);
```

Tool 注册时会校验 `required` 能力。执行时第三个参数只包含该 Tool 声明过的冻结能力子集；
Tool 不得通过 Context 或其他全局对象动态查询运行时能力。

上述第三参数规则针对核心 Tool。插件贡献的 Tool 第三参数仍是所属插件的 `ext`；插件所需宿主能力
必须由 Plugin 对象声明，并在 `init(..., { capabilities })` 中接收，详见 [插件 SDK](../plugins/README.md)。

如果调用 `runAgentLoop` 时用 `options.tools` 过滤工具列表，必须同时传入对应的 `toolRegistry`，否则 runner 会拒绝启动，避免模型看到某个工具但执行器不存在。

## Handler Rules

Tool 向模型发送的 system prompt 必须放在独立 Markdown 文件中，通过 `prompts/loader.js`
加载或渲染，不得硬编码在 JavaScript 中。

- 返回值应为字符串，方便作为 `role: tool` 的消息写入上下文。
- 如果返回结构化数据，请在 handler 内转为可读文本。
- 异步工具直接使用 `async function handler(...)`。
- 运行时依赖必须通过 `capabilities.required/optional` 声明。
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

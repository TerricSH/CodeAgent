# 插件 SDK 文档

运行时插件用于给会话注入独立能力、状态和生命周期钩子，**不等同于**模型可调用的 `tools/`（工具是插件可贡献的其中一项）。

## 心智模型

> 主程序提供一组运行时能力；插件必须先声明依赖，注册表只注入声明过的能力子集。主程序保持中立、不感知任何具体插件。

公共注入点一览：

| 注入点 | 用途 | 是否必需 |
| --- | --- | --- |
| `tools` | 贡献模型可调用工具 | 可选 |
| `continuationGuards` | 引导对话轮是否继续（控制环） | 可选 |
| `onBeforeTurn / onAfterTurn / onToolResult` | 生命周期钩子 | 可选 |
| `capabilities` 声明与注入 | 取用经过注册表校验的宿主能力子集 | 可选 |
| `context.systemPrompt` 动态分段 | 往系统提示挂/摘内容 | 可选 |
| `store` + 版本信封 | 按 `sessionId` 持久化插件状态 | 可选 |

参考实现：`plugins/task-ledger/`（工具 + guard + 状态）、`plugins/ask-user/`（工具 + 声明式能力 + onBeforeTurn + 状态）。

---

## 1. 注册

只在一处注册，宿主无需任何改动：

```js
// plugins/index.js
const defaultPlugins = [taskLedgerPlugin, askUserPlugin /* , yourPlugin */];
```

宿主在组合根提供可用能力；插件只能收到自己声明的部分：

```js
createDefaultRegistry({ capabilities: { output, model, workspace } });
```

---

## 2. Plugin 对象接口

插件模块默认导出一个对象：

```js
module.exports = {
    name: 'your-plugin',          // string，必填，唯一；用于命名空间与 store 隔离
    scope: 'session',             // string，作用域标识（如 'session' / 'agent'）
    capabilities: {
        required: ['workspace'],  // 缺失时注册立即失败
        optional: ['model'],      // 缺失时不注入
    },

    // —— 工具贡献（二选一）——
    tools: [toolModule],                       // 静态数组
    getTools(context) { return [toolModule]; },// 或动态返回

    // —— continuation guard 贡献（二选一）——
    continuationGuards: [guardModule],
    getContinuationGuards(context) { return [guardModule]; },

    // —— 初始化：返回 extension（见 §3）——
    init(context, { store, config, capabilities }) { /* ... */ return extension; },

    // —— 生命周期钩子（都在 plugin 对象上被调用，可选）——
    async onBeforeTurn(context) {},                 // 每次模型调用前
    async onAfterTurn(context, state) {},           // assistant 回复落定后
    async onToolResult(context, toolCall, result) {}// 每个工具结果写入后
};
```

钩子参数：

| 函数 | 参数 | 时机 |
| --- | --- | --- |
| `onBeforeTurn(context)` | `context` | 发起模型调用前 |
| `onAfterTurn(context, state)` | `state.reply` 等分发态 | assistant 文本回复已写入上下文后 |
| `onToolResult(context, toolCall, result)` | `toolCall = { id, name, arguments }`，`result: string` | 单个工具结果写入后 |

> 钩子在 **plugin 对象**上调用，不在 extension 上。钩子内取状态用 `context.getExtension(name)`（即 §3 的 `getApi()` 返回值）。

---

## 3. Extension 接口（`init` 的返回值）

`init` 返回一个 extension 对象，承载状态与持久化：

```js
init(context, { store, config = {}, capabilities = {} }) {
    const state = /* ... */;
    let dirty = false;

    return {
        getApi() { return api; },          // 工具/guard 在执行期收到的第 3 个参数 ext
        isDirty() { return dirty; },        // 是否有未保存变更（用于节流持久化）
        hydrate(sessionId) { /* 从 store 恢复，失败降级为空，不抛错 */ },
        persist(sessionId) { /* 写入 store，置 dirty=false；宿主在事务内调用 */ },
    };
}
```

`init` 第二参注入项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `store` | `{ read(sessionId)->string\|null, write(sessionId, data) }` | 已按插件 name 隔离的作用域存储 |
| `config` | `object` | 该插件在注册时的配置 |
| `capabilities` | `object` | 仅包含插件显式声明且宿主实际提供的能力（见 §6） |

---

## 4. Tool 接口

工具模块（放在插件目录内）：

```js
module.exports = {
    definition,                      // OpenAI function 格式（type/function/parameters）
    async handler(args, context, ext) { return 'result string'; },
    prompt,                          // markdown 字符串，拼进系统提示，保持简短
};
```

- `handler` 第 3 参 `ext` = 该插件 `getApi()` 的返回值（宿主执行期注入）。
- **返回值必须是字符串**；结构化数据请在 handler 内转可读文本。
- 失败返回错误字符串，不要抛出让进程崩溃。
- 工具名经命名空间化后暴露给模型：`${pluginName}__${functionName}`（分隔符 `__`）。

---

## 5. Continuation Guard 接口

引导「这一轮是否继续」的确定性逻辑：

```js
module.exports = {
    shouldContinue(context, ext) { return Boolean(/* ... */); },   // true → 可能继续
    buildReminder(context, ext) { return '提醒文本' || null; },     // 继续时追加为 user 消息
};
```

- 第 2 参 `ext` 由宿主注入（与工具一致）。
- 评估逻辑：`shouldContinue` 为真且 `buildReminder` 返回非空 → 该轮继续，提醒文本作为新的 user 消息。

---

## 6. 声明式运行时能力

插件不能查询全局服务总线。需要宿主能力时，必须在 Plugin 对象上声明：

```js
capabilities: {
    required: ['workspace'],
    optional: ['output', 'model'],
}
```

注册表在 `register()` 时校验 `required`；缺失会报告插件名和能力名。`init()` 收到的冻结对象只包含
声明过的能力，宿主的其他能力不会泄漏给插件。当前组合根可提供的能力包括：

| 能力 | 形状 | 说明 |
| --- | --- | --- |
| `output` | `Output` 实例 | 输出层；交互收集见下 |
| `model` | 模型完成/流式接口 | 摘要等插件能力 |
| `modelResolver` | `resolve(ref)` 返回独立模型能力 | 需要按角色选择模型且不能切换主模型的流程 |
| `workspace` | Workspace 控制接口 | 状态和一次性授权 |
| `memoryScope` | 项目标识 | Memory 持久化隔离 |
| `sandboxScope` | 沙盒路径 | Docker Sandbox 隔离 |

交互收集契约（可选子输出 `output.prompt`）：

```js
// output.prompt.collect(question) -> Promise<string | null>
// 返回 string = 用户答案；返回 null = 用户取消（Ctrl+C / 非交互非法输入），调用方应据此跳过且不记录。
question = {
    text: string,              // 问题
    options?: string[],        // 选项；不提供 = 纯自由作答
    allowFreeform?: boolean,   // 是否允许用户自定义意见（默认 true）
    intro?: string,            // 开场说明，会展示给用户（建议仅首题传入）
    index?: number,            // 批量提问序号
    total?: number,            // 批量提问总数
    labels?: object,           // 调用方自带文案（见“文案归属”）
}
// output.prompt.setInput(rl)  —— 宿主把共享 readline 交给收集器（核心 IO 组装，非插件职责）
```

> `required` 能力可直接使用；`optional` 能力必须判空降级，例如
> `const prompt = capabilities.output?.prompt?.collect ? capabilities.output.prompt : null`。

---

## 7. `context` 对插件开放的接口（子集）

```js
context.getExtension(name)                       // 取另一插件/自身的 getApi() 结果
context.sessionId                                // 当前会话 id
context.metadata                                 // 会话 metadata（可读写对象）
context.messages                                 // 只读消息副本

// 系统提示动态分段（多插件互不覆盖）
context.systemPrompt.upsertSection(name, text)   // 新增/更新分段；text 为空等价移除
context.systemPrompt.removeSection(name)         // 移除分段
context.systemPrompt.set(content) / get()        // 整段 base 内容
```

---

## 8. 注册表公共方法（宿主侧）

```js
const reg = createDefaultRegistry({ capabilities?, plugins? });
await reg.init(context);                 // 初始化所有插件 + hydrate
reg.getTools(context);                   // 收集命名空间化后的工具
reg.getContinuationGuards(context);      // 收集注入 ext 后的 guard
reg.resolveApi(name);                    // 取某插件 getApi() 结果
await reg.onBeforeTurn(context);
await reg.onAfterTurn(context, state);
await reg.onToolResult(context, toolCall, result);
await reg.persistAll(sessionId, { client }); // PostgreSQL 事务内原子持久化全部插件
reg.isDirty();                           // 任一插件有未保存变更
```

---

## 9. 命名规范

- 文件夹/JS 文件名：kebab-case（`ask-user`、`tool-output.js`）。
- 类名：PascalCase。变量/函数：camelCase。
- 工具 function name：snake_case（`ask_user`）；prompt 标题与 function name 一致。

### 接口命名约定（统一，新插件请遵循）

| 接口类别 | 约定 | 示例 |
| --- | --- | --- |
| 生命周期钩子 | `on<事件>` | `onBeforeTurn` / `onAfterTurn` / `onToolResult` |
| Extension 四件套 | 固定名 | `getApi` / `isDirty` / `hydrate` / `persist` |
| 注册表全局操作 | `<动作>All` | `persistAll` / `hydrateAll` |
| Tool 模块 | 固定名 | `definition` / `handler` / `prompt` |
| Guard 模块 | 固定名 | `shouldContinue` / `buildReminder` |
| 注入的 ext 形参 | 统一命名 `ext` | `handler(args, context, ext)`、`guard(context, ext)` |
| 输出子项方法 | 输出用 `render*`；交互收集用 `collect` | `renderCall` / `renderResult`；`prompt.collect` |

> 例外说明：`output.prompt` 是「输入/收集」语义，故用 `collect`（而非 `render*`）是**有意为之**，不属于命名不一致。

## 文案归属

- 核心 `renderers/<mode>/labels.json` 只放**通用 UI 文案**。
- 插件自带的业务文案放**插件目录内**（如 `plugins/ask-user/labels.js`），经 `collect` 载荷 `question.labels` 传入；收集器仅用自身中性 DEFAULTS 兜底。
- 这样插件删除后，文案随之消失，不污染核心。

---

## 10. 最小骨架

```js
// plugins/your-plugin/index.js
const tool = require('./tool');

const NAME = 'your-plugin';
const VERSION = 1;

module.exports = {
    name: NAME,
    scope: 'session',
    tools: [tool],

    onBeforeTurn(context) {
        const ext = context.getExtension(NAME);
        // 例如：context.systemPrompt.upsertSection(NAME, ext.summary());
    },

    capabilities: { optional: ['model'] },

    init(context, { store, config = {}, capabilities = {} } = {}) {
        const state = [];
        let dirty = false;
        return {
            getApi: () => ({ /* 暴露给 tool/guard 的 api */ markDirty: () => { dirty = true; } }),
            isDirty: () => dirty,
            hydrate: async (sessionId) => {
                if (!store || !sessionId) return;
                try {
                    const env = JSON.parse(await store.read(sessionId) || 'null');
                    if (env && env.version === VERSION && Array.isArray(env.data)) {
                        state.length = 0; state.push(...env.data); dirty = false;
                    }
                } catch { /* 降级保持空 */ }
            },
            persist: async (sessionId, options = {}) => {
                if (!store || !sessionId) return;
                await store.write(
                    sessionId,
                    JSON.stringify({ name: NAME, version: VERSION, data: state }),
                    options
                );
                dirty = false;
            },
        };
    },
};
```

---

## 11. 自检清单

- [ ] 仅在 `plugins/index.js` 注册，未改动 mainloop / delegate-agent 为本插件接线。
- [ ] 所有宿主依赖均写入 `capabilities.required/optional`，未通过 Context 或全局对象动态查询。
- [ ] `optional` 能力缺失时能安全降级；真正必需的能力列入 `required`。
- [ ] 钩子内通过 `context.getExtension(name)` 取状态，不在 plugin 对象上直接持有可变态。
- [ ] 工具 `handler` 返回字符串，失败返回错误串而非抛出。
- [ ] 持久化用版本信封 `{ name, version, data }`，hydrate 对损坏/缺失/版本不符降级为空。
- [ ] 插件自带文案放插件目录，不写入核心 `labels.json`。

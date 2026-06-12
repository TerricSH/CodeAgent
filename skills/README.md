# Skill Development Guide

Skill 是模型可以激活的工作模式。激活后，skill 的提示词会注入系统提示词，改变模型的行为方式。

## Folder Structure

每个 skill 放在 `skills/<skill-name>/` 下：

```text
skills/
  my-skill/
    index.js       # skill 定义
    prompt.md      # skill 提示词
    run.js         # 可选：激活时执行的脚本
```

## index.js Contract

每个 skill 的 `index.js` 必须导出：

```js
module.exports = {
    name: 'my-skill',
    description: '一句话描述这个 skill 做什么',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
    // 可选
    run: require('./run'),
};
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| name | 是 | skill 名称，kebab-case |
| description | 是 | 简短描述，会展示在 activate_skill 工具的可选列表中 |
| prompt | 是 | 激活后注入系统提示词的内容 |
| run | 否 | 激活时自动执行的函数，签名 `run(context)` |

## prompt.md

激活后会被注入到系统提示词的 `<active_skill>` 标签内。应该包含：

- 模型在该模式下的角色定义
- 工作流程或步骤
- 输出格式要求
- 需要使用哪些工具

示例：

```md
你是一个代码审查专家。请对用户提供的代码进行审查，关注以下方面：

- 代码逻辑是否正确
- 是否存在安全隐患
- 性能是否可以优化
```

## run.js（可选执行脚本）

如果 skill 激活时需要执行初始化操作（如扫描项目结构、加载配置、预处理数据），可以提供 `run.js`：

```js
// skills/my-skill/run.js

async function run(context) {
    // 激活时自动执行
    // context 是当前对话上下文，可以读取 sessionId、taskLedger 等

    // 示例：扫描当前目录结构并写入上下文
    const { execSync } = require('child_process');
    const tree = execSync('ls -la', { encoding: 'utf-8' });
    context.addUser(`当前项目结构:\n${tree}`);

    return '初始化完成';  // 返回值会作为工具结果展示
}

module.exports = run;
```

`run` 函数：

- 签名：`async function run(context)`
- 在 `activate_skill` 工具激活该 skill 时自动调用
- 可以操作 `context`（添加消息、读取 taskLedger 等）
- 返回值会作为激活结果的一部分展示给用户
- 如果不需要初始化逻辑，不要提供 `run.js`

## Registration

新增 skill 后，在 `skills/index.js` 中注册：

```js
const mySkill = require('./my-skill');

const skills = [existingSkill, mySkill];
```

注册后模型会在 `activate_skill` 工具的可选列表中看到该 skill。

## Activation

模型通过 `activate_skill` 工具自动激活 skill：

```js
activate_skill({ name: 'my-skill' })
```

激活时：
1. skill 的 `prompt` 注入系统提示词
2. 如果有 `run`，自动执行并返回结果
3. 后续对话模型按该 skill 的模式工作

同一时间只能激活一个 skill，激活新 skill 会替换当前激活的。

## Naming Rules

- 文件夹名使用 kebab-case，例如 `code-review`
- `name` 字段与文件夹名保持一致
- prompt 内容不需要标题，直接写角色和规则

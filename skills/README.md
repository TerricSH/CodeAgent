# Skill Development Guide

Skill 是模型可以按任务需要动态检索并激活的工作模式。基础系统提示词不包含完整 Skill 清单或正文；`skill_search` 使用 Skill RAG 的语义召回与关键词召回、融合和 rerank 返回候选，`activate_skill` 再把选中的 Skill 作为独立 Context 缓存节点加载。

## Folder Structure

每个 skill 放在 `skills/<skill-name>/` 下：

```text
skills/
  my-skill/
    index.js       # skill 定义
    prompt.md      # skill 提示词
```

## index.js Contract

每个 skill 的 `index.js` 必须导出：

```js
module.exports = {
    name: 'my-skill',
    description: '一句话描述这个 skill 做什么',
    prompt: fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8'),
};
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| name | 是 | skill 名称，kebab-case |
| description | 是 | 简短描述，作为 Skill RAG 的候选元数据 |
| prompt | 是 | 激活后加载到独立 `skill` Context 节点的内容 |

## prompt.md

激活后会包装成 system-role 的 `skill` Context 节点。应该包含：

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

## Registration

新增 Skill 只需写入 `skills/<skill-name>/`。`skills/index.js` 会动态发现带 `index.js` 的目录，无需修改中央清单；下次 `skill_search` 前会幂等编译到 Skill collection。

## Activation

模型先检索候选，再按候选 ID 激活 Skill：

```js
skill_search({ query: 'review this security-sensitive change' })
activate_skill({ name: 'my-skill' })
```

激活时：
1. Skill 的 `prompt` 加载为独立 Context 节点；
2. 节点实际进入模型请求时记录 `skill.used`；
3. 不适用时使用 `deactivate_skill` 转冷并记录原因，再继续检索。

同一时间可以激活多个 Skill；它们共享动态 Token 预算，不争用单个 `active-skill` system section。

## Naming Rules

- 文件夹名使用 kebab-case，例如 `code-review`
- `name` 字段与文件夹名保持一致
- prompt 内容不需要标题，直接写角色和规则

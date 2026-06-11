## delegate_agent

将子任务委托给专门的子 agent 执行。

### 限制

- 子 agent 有独立上下文，不共享主对话历史
- 子 agent 只能使用其配置中允许的工具
- 最多 10 轮工具调用

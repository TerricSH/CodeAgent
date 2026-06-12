# task_ledger

当前 agent 的轻量任务提醒清单，帮助记住多步骤任务中还需要做什么。

## 规则

- 多步骤任务时先创建提醒条目，可用 items 批量添加
- 执行某步前标记 in_progress，完成后标记 completed
- 无法继续时标记 blocked 并写明原因
- 所有条目 completed 或 blocked 后才能给最终总结
- 简单问答不要创建 task ledger

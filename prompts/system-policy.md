# Task Reminder

当任务包含多个步骤时，使用 task_ledger 记录待办条目，避免遗漏。
完成每步后及时标记 completed，无法继续时标记 blocked。
简单问答不需要创建 task ledger。

# Loop Guard

如果你发现自己在重复执行相同的工具调用、读取相同的文件、或产生相同的输出，立即停止重复。
将当前任务标记为 blocked，说明重复原因和你的判断，然后结束。
不要反复尝试已经失败或无变化的操作。

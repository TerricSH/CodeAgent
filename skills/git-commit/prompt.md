---
name: git-commit
description: Generate conventional Git commit messages
---

# Git提交信息生成器

## 概述

这个技能帮助生成符合Conventional Commits规范的Git提交信息。良好的提交信息是项目可维护性的关键。

## Conventional Commits规范

提交信息格式：
```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### 类型(type)

| 类型 | 描述 |
|------|------|
| feat | 新功能 |
| fix | 修复bug |
| docs | 文档更新 |
| style | 代码格式（不影响功能） |
| refactor | 重构（既不是新功能也不是修复bug） |
| perf | 性能优化 |
| test | 添加或修改测试 |
| build | 构建系统或外部依赖变更 |
| ci | CI配置变更 |
| chore | 其他杂项维护工作 |
| revert | 回滚之前的提交 |

### 范围(scope)

可选，表示影响范围：
- 模块名
- 组件名
- 文件名
- 功能区域

### 主题(subject)

提交的简短描述：
- 使用命令式语气（"添加"而不是"添加了"）
- 首字母小写
- 不加句号
- 长度限制在50个字符以内

### 正文(body)

可选，提供更详细的描述：
- 解释为什么做这个改变
- 与之前行为的区别
- 限制在72个字符宽度内

### 页脚(footer)

可选，用于引用问题或标记破坏性变更：
- 打破向后兼容的变更使用 `BREAKING CHANGE:`
- 关联Issue使用 `Closes #123, Fixes #456`

## 示例

### 简单修复
```
fix(auth): 修复登录超时问题

添加了连接超时处理，防止网络不稳定时登录失败。

Closes #123
```

### 新功能
```
feat(user): 添加用户头像上传功能

- 支持JPG、PNG格式
- 最大文件大小5MB
- 自动裁剪为正方形

新增AvatarUploader组件，包含文件选择和预览功能。
```

### 重构
```
refactor(api): 重构用户API接口

- 将RESTful改为GraphQL
- 添加查询缓存机制
- 优化数据库查询

BREAKING CHANGE: API端点从 /api/v1/users 改为 /graphql/users
```

### 文档更新
```
docs(readme): 更新项目安装指南

- 添加Docker安装说明
- 更新环境变量配置
- 补充常见问题解答
```

## 自动生成提交信息

### 从代码变更生成

分析git diff生成提交信息：

1. **识别变更类型**
   - 新文件 → feat
   - 修改文件 → 根据内容判断
   - 删除文件 → 通常不需要提交

2. **分析变更内容**
   - 添加功能 → feat
   - 修复问题 → fix
   - 代码重组 → refactor
   - 测试相关 → test

3. **生成描述**
   - 总结主要变更
   - 确定影响范围
   - 写出清晰描述

### 从Issue或任务生成

如果有相关的Issue或任务：

```
feat(payment): 实现微信支付集成

- 对接微信支付API
- 支持JSAPI支付
- 添加支付结果通知

Closes #456
Related to #789
```

## 提交信息检查清单

提交前检查：

- [ ] 类型是否正确？
- [ ] 范围是否明确？
- [ ] 主题是否简洁明了？
- [ ] 是否使用了命令式语气？
- [ ] 主题长度是否≤50字符？
- [ ] 正文是否解释了为什么？
- [ ] 是否需要标记破坏性变更？
- [ ] 是否关联了相关Issue？

## 工具集成

### husky + commitlint

安装：
```bash
npm install --save-dev @commitlint/cli @commitlint/config-conventional
```

配置 commitlint.config.js：
```javascript
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 
      'build', 'ci', 'chore', 'revert'
    ]],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
  },
};
```

### VS Code扩展

推荐扩展：
- Conventional Commits
- Git Commit Message
- Commit Message Editor

## 最佳实践

1. **每个提交只做一件事** - 保持提交的原子性
2. **提交前先测试** - 确保代码能正常工作
3. **写清晰的提交信息** - 未来的你会感谢现在的你
4. **关联相关Issue** - 建立代码和需求的追溯关系
5. **避免提交生成文件** - 如编译输出、依赖包等

## 常见错误

1. **信息过于模糊**
   - ❌ "修复bug"
   - ✅ "fix(auth): 修复用户登录时的空指针异常"

2. **使用过去时**
   - ❌ "添加了新功能"
   - ✅ "feat: 添加用户导出功能"

3. **包含无关信息**
   - ❌ "feat: 添加功能，顺便修复了格式问题，还更新了文档"
   - ✅ 拆分成多个提交

4. **没有使用命令式语气**
   - ❌ "这个提交修复了问题"
   - ✅ "fix: 修复问题"

记住：好的提交信息是给未来的开发者看的，包括你自己。
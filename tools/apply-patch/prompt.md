## apply_patch

事务式应用一个可同时新增、更新、删除多个 UTF-8 文本文件的 patch。工具会先解析并预演全部文件，再暂存和提交；任一路径、上下文或提交步骤失败时，整批保持不变或回滚。

```text
*** Begin Patch
*** Update File: src/example.js
@@
 const before = true;
-const value = 'old';
+const value = 'new';
*** Add File: src/new-file.js
+module.exports = true;
*** Delete File: src/obsolete.js
*** End Patch
```

### 规则

- 更新 hunk 中，上下文行以一个空格开头，新增行以 `+` 开头，删除行以 `-` 开头；`@@ -旧起点,旧行数 +新起点,新行数 @@` 行号范围可选
- 未提供行号时，旧内容必须在文件中唯一匹配；纯新增 hunk 必须提供行号
- 新增文件的每一行以 `+` 开头；删除文件的操作头后不带内容
- 同一 patch 不能重复操作同一路径，也不能操作互为父子的文件路径
- 仅支持 UTF-8 文本，不支持二进制、重命名；相对路径基于当前 Workspace
- 事务保证覆盖正常工具执行期间的失败；进程崩溃或断电不提供跨文件的磁盘级原子提交保证

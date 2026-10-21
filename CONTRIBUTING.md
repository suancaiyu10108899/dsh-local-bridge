# 贡献指南

感谢关注。这是一个早期 alpha，小而聚焦的贡献最有价值。

## 开始前

- 先读 README 和“限制”一节。
- 报 bug 请先开 issue，包含：
  - 预期的行为；
  - 实际发生的情况；
  - 复现步骤；
  - 操作系统、Node 版本、DSH 版本；
  - 相关错误文本（**不要**包含 token、`.local/` 内容或个人信息）。
- 提 feature 请先开一个简短 issue 说明用户问题，再写代码。大而全的未沟通 PR 可能因为维护 alpha 范围而被拒。

## 开发环境

```powershell
node --version   # 22 或 24
node --test
```

测试使用临时目录，不需要运行中的 Hub 或真实 DSH profile。不要提交 `.local/`、日志、token 或机器路径。

## Pull Request

1. 改动小而聚焦。
2. 行为变更要加/改测试。
3. 用户可见变更更新 `CHANGELOG.md`。
4. 跑 `node --test` 并确保通过。
5. 说明改动的边界/风险。

## 范围规则

- 本 alpha 只支持 DSH 侧消息。
- 未经单独设计讨论，不要加入 Codex native queue receiver、MCP App、多目标、无人值守服务或 GUI 承诺。
- “投递”意味着目标对话收到消息并启动 turn；不要把它重新定义为“任务完成”。

## 支持预期

尽力而为，无 SLA。响应可能需要数周。请保持讨论技术化。
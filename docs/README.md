# SmartPerfetto 文档中心

[English](README.en.md) | [中文](README.md)

<!-- i18n-headings: paired -->

这里仅保留当前版本仍需维护的用户、架构、运行时和维护者文档。第一次使用请从
[快速开始](getting-started/quick-start.md)进入；仓库历史由 Git、Issue 和 PR 保留，
不再把完成后的计划、审查报告、研究材料或 Agent 证据作为长期文档提交。

## 使用与运维

- [快速开始](getting-started/quick-start.md)
- [功能总览](getting-started/features.md)
- [基本使用](getting-started/usage.md)
- [配置指南](getting-started/configuration.md)
- [Agent 辅助 GitHub 反馈](getting-started/agent-assisted-feedback.md)
- [Self-Evolution 使用与验收](getting-started/self-evolution.md)
- [Code-Aware Analysis](getting-started/code-aware-analysis.md)
- [多 Trace 分析结果对比](getting-started/multi-trace-result-comparison.md)
- [Android Internals 知识包与私有知识库](getting-started/android-internals-knowledge.md)
- [故障排查](operations/troubleshooting.md)

## 参考手册

- [CLI](reference/cli.md)
- [HTTP/SSE API](reference/api.md)
- [MCP 工具](reference/mcp-tools.md)
- [Skill 系统](reference/skill-system.md)
- [平台兼容与验证边界](reference/platform-compatibility.md)
- [发布流程](reference/release.md)
- [免安装包](reference/portable-packaging.md)
- [Windows 启动器](reference/windows-exe.md)
- 应用更新：[产品提示与更新动作](../README.zh-CN.md#应用更新)、
  [CLI](reference/cli.md#应用更新)、[API](reference/api.md#应用更新)

## 核心架构

- [架构总览](architecture/overview.md)：产品入口、主数据流与输出合约。
- [技术架构](architecture/technical-architecture.md)：组件边界和修改位置。
- [Agent Runtime](architecture/agent-runtime.md)：runtime/provider/session 语义。
- [双 Trace 工作区](architecture/dual-trace-workspace.md)：双窗与 comparison 状态机。
- [私有分析上下文](architecture/private-analysis-context.md)：授权、连续性与删除边界。
- [Self-Improving](architecture/self-improving-design.md)：当前已接入能力与明确未接入能力。
- Self-Evolution 的用户入口、权限、持久化和测试步骤以
  [使用与验收指南](getting-started/self-evolution.md)为准。
- 普通用户把分析 gap 转成外部反馈时，以
  [Agent 辅助 GitHub 反馈](getting-started/agent-assisted-feedback.md)为准；它不会自动
  进入 Self-Evolution 或 GitHub。
- [Data Contract](../backend/docs/DATA_CONTRACT_DESIGN.md)：DataEnvelope、Query Review、
  Analysis Receipt、UI Action 和多端投影。

## 贡献与治理

- [贡献指南](../CONTRIBUTING.md)
- [Agent 入口规则](../AGENTS.md)
- [产品面规则](../.claude/rules/product-surface.md)
- [测试规则](../.claude/rules/testing.md)
- [安全策略](../SECURITY.md)
- [赞助与商业合作](sponsor.md)

## 文档保留规则

- 只提交当前用户操作、架构、运行时或维护流程所依赖的文档。
- 完成后的计划、RFC 实施记录、review、研究材料、演示源码和 Agent evidence 不进仓库；
  仍有效的结论必须合并到上面的核心文档。
- Strategy、Prompt template、Skill SOP、测试 fixture、许可证和预构建 UI 帮助文本虽然使用
  Markdown 扩展名，但属于运行时代码或发布资产，不按普通文档清理。
- `npm run verify:docs` 检查链接、图片、npm script、CLI 覆盖、发布命令以及废弃文档拓扑
  是否重新出现；中英文产品面使用 `npm run verify:i18n` 校验。

## 运行时读取内容

`docs/rendering_pipelines/` 是由固定上游 commit 同步的 Android 17 教学来源，构建会复制到
`backend/dist/rendering_pipelines/`。移动或修改它需要同步 pipeline catalog/Skill 引用，并运行：

```bash
npm run verify:rendering-pipelines
cd backend && npm run validate:skills
```

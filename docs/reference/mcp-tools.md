# SmartPerfetto MCP Tools Reference

[English](mcp-tools.en.md) | [中文](mcp-tools.md)

SmartPerfetto 通过 MCP 风格的工具层把 trace 数据、Skill、知识库、代码索引、对比能力暴露给当前 agent runtime。当前代码不是“固定 N 个工具”的模型，而是：

```text
Tool implementation
  -> backend/src/agentv3/claudeMcpServer.ts
  -> backend/src/agentv3/mcpToolRegistry.ts
  -> runtime-specific allowlist / function-tool adapter
  -> request-visible tool surface
```

`claudeMcpServer.ts` 是工具实现入口；`mcpToolRegistry.ts` 是工具描述、exposure level 和 allowlist 的单一事实源。Claude runtime 直接使用 in-process MCP server；OpenAI runtime 读取同一份 registry 并适配成 OpenAI Agents SDK function tools。

不要把工具总数写死在代码或文档中。新增、删除或改名工具时，以 registry 和测试为准。

## 可见性模型

同一个工具实现集会根据请求场景裁剪：

| Scope | 何时启用 | 典型工具 |
|---|---|---|
| Quick / lightweight | fast 或轻量分析路径 | `execute_sql`, `invoke_skill`, `lookup_sql_schema`, 可选 `fetch_artifact` |
| Full analysis | 完整分析路径 | 数据访问、Skill、知识、baseline、记忆、规划/假设和 artifact 工具 |
| Code-aware | 请求允许本地代码库访问 | `list_codebases`, `lookup_app_source`, `lookup_kernel_source`, `resolve_symbol`, `propose_patch` |
| Comparison | 请求包含 `referenceTraceId` | `execute_sql_on`, `compare_skill`, `get_comparison_context` |

Registry 的 exposure level 用于区分公共/内部/需授权工具；它不等于“外部用户一定能看到”。最终可见集合由 runtime、analysis mode、artifact store、codebase permission、comparison context 和 allowlist 共同决定。

## 工具生命周期

```text
Agent 想调用工具
    │
    ├─ 当前 request 构造 registry 和 allowlist
    ├─ runtime 暴露 request-visible tools
    ├─ full mode 下 execute_sql / invoke_skill 受 plan gate 约束
    ├─ 工具执行 SQL / Skill / lookup / comparison
    └─ 结构化结果进入 SSE、report、snapshot、CLI artifact 或 agent context
```

Full mode 中，`execute_sql` 和 `invoke_skill` 仍要求先提交分析计划；quick mode 走轻量路径，不注入完整 planning/hypothesis 工具面。

## 核心数据工具

| Tool | 作用 | 备注 |
|---|---|---|
| `execute_sql` | 对当前 trace 执行 Perfetto SQL | 支持 summary 模式；大结果会截断或通过 artifact 分页 |
| `invoke_skill` | 执行 YAML Skill 分析管线 | 首选证据收集路径，返回 DataEnvelope / artifacts |
| `list_skills` | 列出可用 Skills | 可按 category 过滤；Skill 数量以文件树为准 |
| `detect_architecture` | 检测当前 trace 的渲染架构 | 影响策略和渲染管线分析 |
| `lookup_sql_schema` | 搜索 Perfetto SQL schema / stdlib index | quick 和 full 都可用 |
| `query_perfetto_source` | 搜索 Perfetto stdlib SQL 源码 | 源码缺失时依赖打包索引兜底 |
| `list_stdlib_modules` | 列出 Perfetto stdlib modules | 避免把完整模块列表塞进系统 prompt |

`execute_sql` 和 `invoke_skill` 是证据入口，不是最终报告入口。最终结论还要经过结果归一化、evidence/claim verification、报告生成、snapshot 和 frontend projection。

## 知识、记忆与 baseline

| Tool | 作用 |
|---|---|
| `lookup_knowledge` | 加载本地性能分析知识、模板或管线说明 |
| `lookup_blog_knowledge` | 查询博客或 Android Internals 背景知识；`source=android_internals_pack` 使用内置签名 Pack，`source=android_internals_wiki` 使用请求白名单中的私有 source id |
| `lookup_aosp_source` | 查询 AOSP 相关源码知识 |
| `lookup_oem_sdk` | 查询 OEM SDK / 厂商相关知识 |
| `lookup_baseline` | 查询历史 baseline |
| `compare_baselines` | 对比 baseline 指标 |
| `recall_project_memory` | 检索项目级记忆 |
| `recall_similar_case` | 检索相似分析案例 |
| `recall_similar_result` | 检索相似 analysis-result snapshot，输出仅可作为 `navigation_hint_only` |
| `recall_patterns` | 检索模式/反模式，通常作为内部分析辅助 |

记忆和知识工具只能辅助当前 trace 分析，不能覆盖当前 trace 的证据。
内置 `android_internals_pack` 固定签名版本和 fingerprint；私有
`android_internals_wiki` 在每次调用时重新检查 scope、权利确认、provider 同意和
active generation。模型可读取预算内脱敏片段；Claude、OpenAI、Pi、OpenCode、Qoder 的
SSE/日志事件只保留版本化引用、哈希、长度、许可、出处和可信度侧车。完整流程见
[Android Internals 知识包与私有知识库](../getting-started/android-internals-knowledge.md)。

## Planning / Hypothesis / Artifact 工具

| Tool | 作用 |
|---|---|
| `submit_plan` | 提交调查计划，解锁 full mode 下的核心证据工具 |
| `update_plan_phase` | 更新当前 phase，并可注入下一阶段提示 |
| `revise_plan` | 证据改变方向时替换计划 |
| `submit_hypothesis` | 记录可验证假设 |
| `resolve_hypothesis` | 标记假设为 confirmed / rejected / unresolved |
| `flag_uncertainty` | 显式记录不确定性或缺失证据 |
| `write_analysis_note` | 写入 session 分析笔记，按配置启用 |
| `fetch_artifact` | 分页读取大型 SQL/Skill artifact，按 artifact store 启用 |
| `lookup_strategy_detail` | 按 plan 工具返回的 detail ref 读取场景策略细节；仅作 informational fallback，不满足 expectedCalls |

这些工具服务于分析纪律和上下文压缩。不要把 artifact 摘要当作完整证据删除；完整 DataEnvelope 仍可进入前端、报告、CLI 或 snapshot。

## Code-Aware 工具

| Tool | 作用 | 边界 |
|---|---|---|
| `list_codebases` | 列出已授权代码库 | 需要 codebase permission |
| `lookup_app_source` | 查询应用源码 | 输出需要 CodeRef 过滤 |
| `lookup_kernel_source` | 查询内核源码 | 输出需要 CodeRef 过滤 |
| `resolve_symbol` | 解析 trace 符号到源码位置 | 保持源码引用可追踪 |
| `propose_patch` | 生成 patch proposal | 必须标记 verified / sketch / unverified |

Code-aware 输出会进入 report/export/snapshot；处理隐私、路径和 patch 状态时不要只验证前端聊天窗口。

## Comparison 工具

| Tool | 作用 |
|---|---|
| `execute_sql_on` | 在 current 或 reference trace 上执行 SQL |
| `compare_skill` | 对 current/reference 并行执行同一 Skill 并对比结果 |
| `get_comparison_context` | 获取 trace pair 元数据、左右/上下窗格映射和 comparison context |

Comparison 工具只在请求包含 `referenceTraceId` 且 comparison context 可用时注册。Raw trace comparison 和 analysis-result comparison 都应复用共享 evidence/report contract，避免 CLI-only 或 frontend-only 的私有输出。

## 工具使用优先级

1. 先确认场景、时间范围、进程身份和渲染架构。
2. 有匹配 Skill 时优先 `invoke_skill`，用 SQL 补缺口或验证关键假设。
3. 大结果通过 artifact 分页，不要把完整表塞进 agent context。
4. 结论必须能回到 trace evidence、Skill output、claim verification 或显式不确定性。
5. Chat 可以简化展示，HTML report、CLI artifacts 和 snapshots 必须保留可审计证据。

## 维护清单

- 工具实现或可见性变化：更新 `claudeMcpServer.ts`、`mcpToolRegistry.ts`、OpenAI adapter 相关测试和本页。
- Code-aware 工具变化：同时检查 `docs/getting-started/code-aware-analysis*.md`。
- Comparison 工具变化：同时检查 comparison docs、CLI docs 和 report/snapshot contract。
- 不要新增静态工具总数；如果需要当前 inventory，请从 registry 或源码 grep 生成。

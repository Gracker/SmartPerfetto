# Critical path 与火焰图

[English](critical-path-and-flamegraph.en.md) | [中文](critical-path-and-flamegraph.md)

<!-- i18n-headings: paired -->

这两个入口在 AI Assistant 面板里直接分析当前 Trace 的一个局部问题：选中 task 在等什么，
以及 CPU 时间花在哪些调用栈上。它们不启动 Agent 分析，结果也不进入对话历史、HTML 报告或
分析结果快照。需要深入追问时，再交给对话。

## 前提

- Trace 已在 AI Assistant 中完成后端绑定（面板显示当前 Trace 已连接）。
- 调用方能读取该 Trace（`trace:read`）。AI 总结额外要求 `agent:run` 权限：只能读 trace
  不足以动用 workspace 的模型。
- AI 总结使用调用方当前的 Provider Manager profile，按 Claude runtime 的一次性调用执行。

## Critical path 等待链

1. 在时间线上选中一个 `thread_state` task（需要有有效时长）。
2. 在 AI Assistant 预置问题旁点击 **Critical path 分析**。
3. 抽屉依次显示：异常判断、唤醒链、关联模块、下一步，以及带 **复制验证 SQL** 的假设。
4. 点击 **在对话中继续追问**，会把只含 id 和数值的问题放进输入框（不会自动发送），由 Agent
   根据 id 重新取证。

结果的读法：

- 头部数字是可归因耗时：其他线程的工作、可运行和不可中断片段。Perfetto 在 IRQ、swapper 和
  io_wait 唤醒处结束关键路径，这些外部 S/I 片段作为“链路末端等待”单独列出，不递归，也不单独
  当作空闲。
- 等待发生在两个 slice 之间且可归因耗时很低时才判断为线程空闲；等待在 slice 内且链路末端是
  对端的事件等待时给出警告，例如锁持有者在等网络。
- 以下情况不会给出等待链，抽屉会说明原因：选中的 task 正在运行；窗口内没有睡眠、不可中断或
  可运行时间；Perfetto 没有返回关键路径（trace 可能缺少 `sched_waking`）；线程在窗口内没有
  调度记录；等待一直持续到 trace 结束。

## 火焰图

1. 打开 AI Assistant 视图中的 **火焰图** 页签，页面会自动读取当前 Trace。
2. 页面先检查 Trace 是否含 CPU 调用栈采样（Perfetto summary tree）；没有采样时提示无法分析。
3. 点击 **分析火焰图数据**，查看自占热点、累计热点、热点路径和归类，以及中文 AI 总结。

后端优先使用仓库中的 Rust 分析器（`rust/flamegraph-analyzer`，可用 `FLAMEGRAPH_ANALYZER_BIN`
指定可执行文件、`FLAMEGRAPH_ANALYZER_TIMEOUT_MS` 调整超时）；不可用时自动回退到 TypeScript
实现，并在警告中说明。火焰图页面和 AI 总结只有中文。

## AI 总结降级

AI 总结（feature `critical_path_ai_summary` / `flamegraph_ai_summary`）在以下情况改为规则兜底
总结，分析本身照常返回，并通过 `aiSummary.fallbackReason` 和 `warnings` 说明原因：AI 被关闭、
调用方没有 `agent:run`、当前 Provider 不是 Claude Agent SDK runtime、凭证缺失、超时或客户端断开。
这两个入口不会因为 AI 关闭而返回 403。请求连接断开时，后端会取消未完成的查询和模型调用。

## 部署与接口

Critical path 抽屉调用 workspace 路由
`POST /api/workspaces/:workspaceId/critical-path/:traceId/analyze`；火焰图页调用
`GET /api/flamegraph/:traceId/availability` 和 `POST /api/flamegraph/:traceId/analyze`。
在 enterprise / OIDC 部署中，旧的 `/api/critical-path/*` 和非 workspace 的 `/api/flamegraph/*`
返回 410，因此火焰图页在该模式下不可用。请求与响应字段见
[API 参考](../reference/api.md)，AI 开关见 [配置指南](configuration.md)。

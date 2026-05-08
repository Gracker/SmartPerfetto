# Enterprise Runtime Isolation Checklist

本文件把 `README.md` §11.11 的 15 个“双窗口双 trace”漏洞项落成可验证清单。每行都对应 `backend/src/scripts/enterpriseRuntimeIsolationChecklist.ts` 的一个稳定 ID，并由 `enterpriseRuntimeIsolationChecklist.test.ts` 检查 README 原文、证据文件和本文档是否同步。指向 `perfetto/` 的证据属于子模块：本地初始化子模块时会检查文件内容；CI backend gate 未 checkout 子模块时至少验证根仓库保留了 `perfetto` gitlink。

验证命令：

```bash
cd backend && npx jest --runInBand src/scripts/__tests__/enterpriseRuntimeIsolationChecklist.test.ts
```

说明：这里验证的是运行时隔离设计验收是否已有自动化证据闭环；§0.4.3 的 100MB/500MB/1GB RSS 实测矩阵仍由 `rss-benchmark.md` 单独跟踪。

| ID | 漏洞 | 验收 | 自动证据 |
| --- | --- | --- | --- |
| `proxy-status-websocket-query` | Proxy 只代理 HTTP `/query` | 企业模式前端 network 不再访问 `127.0.0.1:9100-9900` | `traceProcessorProxyRoutes.test.ts` 覆盖 `/status`、`/query`、`/websocket`；D3 脚本断言前端只走 `/api/tp/:leaseId/*`，不访问裸本地端口；UI panel 使用 `backend-lease-proxy`。 |
| `http-rpc-target-lease-proxy` | `HttpRpcEngine` 仍只接受 port | processor restart 后前端 leaseId 不变 | `HttpRpcTarget` 支持 `direct-port` 与 `backend-lease-proxy`；前端单测覆盖 lease proxy target；proxy route 和 D4 脚本覆盖 restart 后 leaseId 稳定。 |
| `websocket-fifo-query-order` | 同一 WebSocket 内重排 query | 并发 timeline 查询结果不错位 | `HttpRpcEngine` 串行 drain WebSocket response queue；SQL worker 单测覆盖 non-preemptive priority 与同优先级 FIFO；D3 脚本断言 query 结果与原 SQL 关联不串。 |
| `agent-frontend-same-lease-stats` | Agent query 和前端 WebSocket 走两套 processor | 同 trace 的 frontend/agent/report holder 出现在同一 lease stats | D3 脚本断言 `frontend_http_rpc`、`agent_run`、`report_generation` holder 进入 lease stats；agent route 单测覆盖 full analysis lease 选择；metadata route 单测覆盖 report queue 与 shared frontend queue 可观测。 |
| `sse-terminal-events-persisted` | SSE terminal event 不进持久事件表 | 断线发生在 conclusion 和 report 之间也能 replay reportUrl | `agentRoutesRbac.test.ts` 覆盖 terminal SSE event 持久回放；D9 脚本覆盖重启后 `AgentEvent` replay；前端 SSE transport 单测覆盖 `Last-Event-ID`。 |
| `running-run-independent-cleanup` | running run cleanup 只看 SSE client | 长 run 断开 SSE 后仍可恢复 | schema 为 `analysis_runs` 增加 `heartbeat_at` 与索引；trace delete route 单测按 running run / active lease / report holder 阻断；D7/D2 脚本覆盖 running run 与 SSE 独立存活。 |
| `upload-temp-path-unique` | 上传临时文件名冲突 | 两窗口上传同名 trace 不互相覆盖 | metadata route 单测覆盖上传落入 scoped trace storage；D1 脚本断言同名上传生成不同 traceId 与不同文件路径。 |
| `url-upload-streaming` | URL 上传全量 buffer | 大 trace 上传期间第一窗口心跳和 SSE 不超时 | metadata route 单测覆盖 URL response streaming；D2/D3 脚本覆盖 A 窗口 SSE 继续推进、前端 lease heartbeat 仍存在。 |
| `legacy-register-rpc-disabled` | ExternalRpc/register-rpc 兼容路径绕过新 lease | 代码搜索无企业模式可用裸 port 注册路径 | metadata route 单测在 enterprise mode 禁用 legacy direct RPC registration；working trace processor 单测覆盖 ExternalRpc timeout 与 dedicated health query，避免裸路径绕过隔离控制。 |
| `cleanup-draining-audit` | `/api/traces/cleanup` 悬崖 endpoint | running lease 存在时 cleanup 返回 blocked | metadata route 单测覆盖 admin-only、active lease blocked、idle lease draining 与 audit；D7 脚本覆盖 cleanup/delete 被 active lease 和 draining 保护。 |
| `window-scoped-session-storage` | localStorage 跨窗口覆盖 | 双窗口刷新后各自 traceId/sessionId 不变 | session manager 使用 workspace/window scoped `sessionStorage`；单测覆盖不同窗口不互相恢复、proxy mode 按 leaseId 恢复、并发保存 merge。 |
| `report-generation-isolated-priority` | report generation 长 SQL 阻塞前端 | report 生成时前端 P0 query 延迟在阈值内或明确显示 isolated | metadata route 单测暴露 isolated report queue；SQL worker 单测覆盖 P0 在 queued P1/P2 前执行；D3/D7 脚本覆盖 P0 headroom、queued P0 stats 与 report holder 保护。 |
| `single-supervisor-crash-recovery` | processor crash recovery 重启风暴 | crash 后只有一个 restart 序列 | lease processor routing 单测覆盖多 holder crash 只走一个 supervisor restart、失败后进入 failed；D4 脚本覆盖 leaseId 稳定与单 restart sequence。 |
| `timeout-health-admin-drain` | 24h timeout 掩盖挂死 query | 挂死 query 可被管理员标记 lease draining/restart | working trace processor 单测覆盖 24h timeout 默认值与 dedicated health `SELECT 1`；proxy route 单测覆盖 admin drain/restart lease。 |
| `rss-budget-observed-highwater` | RSS budget 估算错误 | 压测记录 RSS，高水位超过预算时拒绝新 lease | RAM budget 单测覆盖 observed RSS 扣减与 admission reject；metadata route 单测暴露 observed processor RSS；RSS benchmark helper 单测约束 required matrix；D10 脚本覆盖拒绝新 lease 时已有窗口不被 OOM 式清理。 |

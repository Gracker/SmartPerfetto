# SmartPerfetto Assistant 90-Day Re-Architecture Plan

## North Star
将 SmartPerfetto 从“分析引擎 + 插件 UI”演进为“带 UI 的智能助手平台”：

- Assistant Core（意图/会话/规划）
- Tool Runtime（工具执行与证据）
- Domain Packs（startup/scrolling/system 等领域包）
- UI Shell（Perfetto 插件 + 后续独立 Web Shell）
- Platform Plane（会话存储、观测、鉴权）

## Milestones

### M1（2026-03-01 ~ 2026-03-30）
目标：切开路由单体，固化 Assistant API 与 SSE 契约

- [x] 引入 `AssistantApplicationService` 统一托管 in-memory session 生命周期
- [x] 引入 `StreamProjector` 统一 SSE headers/connected/error/end/broadcast 逻辑
- [x] 将 `/api/agent/v1/analyze` 的 session create/resume 编排迁移到 application service
- [x] 将 `scene-reconstruct` 主链路从 `agentRoutes.ts` 拆为独立 route module
- [x] 将 `teaching` 从 `agentRoutes.ts` 拆为独立 route/service
- [x] 增加 SSE contract tests（覆盖 `analysis_completed` / `data` / `conversation_step`）

### M2（2026-03-31 ~ 2026-04-29）
目标：Runtime 和领域包收敛

- [x] 统一单一结果契约：`DataEnvelope[] + Diagnostics + Actions`
- [x] `pipelines` 执行链路纳入 SkillEngine 一等步骤类型
- [x] `EntityRegistry` 接管 intent/follow-up/entity capture，减少硬编码
- [x] 将 Decision tree 阈值配置化（manifest/DSL）

### M3（2026-04-30 ~ 2026-05-29）
目标：UI 壳统一与平台化

- [x] Perfetto 插件完整切换 Assistant API v1
- [x] 补最小独立 Web Shell（共享同一事件契约）
- [x] 会话恢复/多轮一致性/观测链路（runId/requestId）打通

## Guardrails

- Assistant HTTP 入口保持单路径 `/api/agent/v1/*`，禁止新增并行别名路径。
- 任何事件字段新增必须同步契约定义和回归测试，避免“实现漂移”。
- 重构期间不引入第二套 SSE 事件协议。

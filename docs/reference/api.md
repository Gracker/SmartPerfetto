# API 参考

[English](api.en.md) | [中文](api.md)

默认后端地址是 `http://localhost:3000`。如需修改后端端口，设置
`SMARTPERFETTO_BACKEND_PORT`。如果设置了 `SMARTPERFETTO_API_KEY`，受保护接口需要：

```http
Authorization: Bearer <token>
```

`SMARTPERFETTO_API_KEY` 是部署运维凭证；企业用户应使用带明确角色和 scope 的持久化
API key。

## OIDC 鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/oidc/login` | 创建签名 state、nonce 和 PKCE，跳转到 OIDC Provider |
| `GET` | `/api/auth/oidc/callback` | 校验回调、建立 HttpOnly Session Cookie，并跳回前端 |
| `GET` | `/api/auth/session` | 返回登录状态、只读 user/tenant/workspace、roles/scopes、过期时间和 CSRF Token |
| `POST` | `/api/auth/onboarding/workspace` | 在 OIDC onboarding 中选择允许的 workspace；需要 Cookie mutation protection |
| `POST` | `/api/auth/logout` | 校验 Cookie Session 的 CSRF Token，撤销 Session 并清除 Cookie |
| `GET` | `/api/auth/api-keys` | 按当前 tenant/workspace scope 列出 API keys；需要 API-key 读取权限 |
| `POST` | `/api/auth/api-keys` | 创建 scoped API key；明文 token 只在创建响应中返回 |
| `POST` | `/api/auth/api-keys/:id/revoke` | 撤销 API key |
| `DELETE` | `/api/auth/api-keys/:id` | 撤销 API key 的兼容入口 |

OIDC Session 是请求身份的唯一来源。浏览器请求必须使用
`credentials: include`，写请求还必须携带 `X-CSRF-Token`。浏览器提供的
tenant/workspace header 不能覆盖 Session 绑定；内置个人工作区模式不提供工作区切换，
不同用户即使看到相同工作区显示名称也不会共享内部 Workspace ID 或数据。

## 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 公开的最小存活状态与版本 |
| `GET` | `/api/runtime-health` | 受鉴权和 `runtime:manage` 权限保护的运行时、模型与 AI 策略诊断 |
| `GET` | `/api/debug` | 受鉴权和 `runtime:manage` 权限保护的开发诊断与 legacy API 使用快照 |

`/api/runtime-health` 会返回顶层 `aiPolicy`，并在 `aiEngine` 中同步 `aiEnabled` 与
`disabledReason`，用于前端和 CLI 判断当前是否允许模型分析。`aiPolicy.aiEnabled=false`
时，trace 上传/读取、SQL、报告、Provider 配置/切换和确定性 Skill 仍可用；模型分析、
resume、场景还原启动、Provider test 和 LLM Skill step 会返回 `403`：

```json
{
  "success": false,
  "code": "AI_DISABLED",
  "retryable": false,
  "feature": "agent_analyze",
  "aiPolicy": {
    "schemaVersion": 1,
    "aiEnabled": false,
    "source": "env"
  }
}
```

## 应用更新

Base path：`/api/application-update`。两个接口都需要鉴权和
`runtime:manage` 权限，更新状态与 AI runtime/provider 健康状态相互独立。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/status` | 返回缓存状态；缓存过期时在后台触发检查，不阻塞 UI |
| `POST` | `/check` | 显式检查；30 秒内重复请求会复用缓存，并合并并发请求 |

响应 schema v1 包含当前 distribution、channel、version、commit、target、
signing mode，以及候选版本、来源、检查时间、stale/LKG 状态和由后端生成的
distribution-specific upgrade action。服务只访问 SmartPerfetto GitHub、npm
registry 或 Docker Hub 的固定 HTTPS endpoint，不接受客户端 URL。设置
`SMARTPERFETTO_UPDATE_CHECK=off` 时返回 `disabled`，不访问网络。

## Trace 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/traces/health` | trace 服务健康状态 |
| `POST` | `/api/traces/upload` | 上传 trace 文件，字段名 `file` |
| `POST` | `/api/traces/upload-url` | 由后端从经过公网 URL 安全校验的 HTTP(S) 地址拉取 trace |
| `GET` | `/api/traces` | 列出已知 trace |
| `GET` | `/api/traces/stats` | trace 统计 |
| `POST` | `/api/traces/cleanup` | 清理 trace |
| `POST` | `/api/traces/register-rpc` | 注册外部 trace_processor RPC |
| `GET` | `/api/traces/:id` | trace 信息 |
| `DELETE` | `/api/traces/:id` | 删除 trace |
| `GET` | `/api/traces/:id/file` | 下载 trace 文件 |
| `POST` | `/api/traces/:id/viewer` | 为当前页面创建隔离的 trace-processor viewer lease |
| `GET` | `/api/traces/leases/:leaseId/connection` | 读取当前页面持有 lease 的安全连接状态 |

上传示例：

```bash
curl -F "file=@trace.pftrace" http://localhost:3000/api/traces/upload
```

列表默认返回最近 100 条，支持 `limit=1..200` 和响应中的不透明 `nextCursor`：

```http
GET /api/traces?limit=100&cursor=<nextCursor>
```

客户端不得解析或自行构造 cursor。`/api/traces/stats` 的 `traces.metadataCount`
表示 workspace 中可见的持久化 trace 总数，而 `traces.count` 表示当前进程中的活跃 trace。

## Workspace-scoped API

新集成优先使用 workspace-scoped 路径。未启用企业/多 workspace 时，旧的全局路径仍可用于本地和兼容场景。

| Base path | 说明 |
|---|---|
| `/api/workspaces/:workspaceId/traces` | workspace 范围内的 trace 上传、列表、删除、下载 |
| `/api/workspaces/:workspaceId/reports` | workspace 范围内的报告读取、导出、删除 |
| `/api/workspaces/:workspaceId/agent` | workspace 范围内的 agent 分析、SSE、多轮、反馈 |
| `/api/workspaces/:workspaceId/providers` | workspace 范围内的 Provider Manager profile |
| `/api/workspaces/:workspaceId/analysis-results` | 分析结果 snapshot 列表、读取、更新 |
| `/api/workspaces/:workspaceId/windows` | 前端窗口 heartbeat 与 active window 状态 |
| `/api/workspaces/:workspaceId/comparisons` | 多分析结果 comparison 创建、读取、stream、导出 |
| `/api/workspaces/:workspaceId/trace-config` | 无副作用 trace config proposal |
| `/api/workspaces/:workspaceId/skill-packs` | 本地目录型 Skill Pack 预检、安装、启停和移除 |
| `/api/workspaces/:workspaceId/batch-traces` | workspace trace set 的确定性 Skill batch、报告导出、snapshot promotion 和 comparison bridge |

## Skill Pack API

Base path: `/api/workspaces/:workspaceId/skill-packs`

所有接口需要 `runtime:manage` 权限。第一版只支持管理员选择本机目录作为来源；
不支持远程 URL、自动同步或 archive 解包。安装会重新执行 preview，通过后只把
manifest 声明的 Skill YAML、SQL fragment 和 docs 复制到受管目录
`backendDataPath('skill-packs', tenantId, workspaceId, packId, version)`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 列出当前 workspace 已安装的 Skill Pack |
| `POST` | `/preview` | 预检本地目录，返回 manifest、Skill ID、fragment、docs 和错误列表，不写入受管目录 |
| `POST` | `/install` | 重新预检本地目录，成功后复制声明资产并写入 `skill_registry_entries` |
| `PATCH` | `/:packId` | 传 `{ "enabled": true | false }` 启用或禁用已安装 pack |
| `DELETE` | `/:packId` | 禁用 pack 并删除受管目录副本，内置 Skill 不受影响 |

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/skill-packs/preview \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{ "sourcePath": "/absolute/path/to/local-skill-pack" }'
```

`smartperfetto-skill-pack.json` 中的每个 asset 必须声明 `kind`、`path`、
`sha256` 和 `sizeBytes`。允许的根目录是 `atomic/`、`composite/`、
`deep/`、`system/`、`comparison/`、`modules/`、`pipelines/`、`fragments/`
和 `docs/`。`strategies/`、`vendors/`、`custom/`、隐藏文件、symlink 和可执行
扩展会被拒绝。Skill ID 与 SQL fragment key 不能覆盖内置内容。

## Batch Trace API

Base path: `/api/workspaces/:workspaceId/batch-traces`

第一版在请求内同步执行确定性 YAML Skill batch。输入必须是当前 workspace 中已经存在的
`traceId`；上传 trace set 仍使用 workspace trace upload API。该 API 不调用 LLM、
不执行 raw batch SQL、不创建远程 worker、不提供浏览器 UI，也不会自动把结果写入
analysis-result snapshot。需要进入 comparison 时必须显式 promotion。

同步 HTTP create 默认最多接收 20 条 trace，可通过
`SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES` 调整。进程内同时执行的 HTTP
batch create 默认最多 2 个，可通过
`SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS` 调整；超过时返回 `429`
和 `batch_trace_api_busy`。离线 CLI batch 的总 trace 上限仍由
`SMARTPERFETTO_BATCH_TRACE_MAX_TRACES` 控制。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/` | `agent:run` | 创建 batch run，body 为 `{ skillId, traceIds, params?, maxConcurrency? }` |
| `GET` | `/` | `report:read` | 列出当前 workspace 的 batch runs |
| `GET` | `/:runId` | `report:read` | 读取单个 batch run |
| `GET` | `/:runId/report/export` | `report:read` | 导出 HTML batch report |
| `POST` | `/:runId/promote-snapshots` | `analysis_result:create` | 将选中的 completed per-trace 结果提升为 analysis-result snapshots |
| `POST` | `/:runId/comparisons` | `comparison:create` | 必要时先提升 snapshot，再创建普通 analysis-result comparison |

创建示例：

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/batch-traces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "skillId": "startup_analysis",
    "traceIds": ["trace-a", "trace-b"],
    "params": { "package": "com.example" },
    "maxConcurrency": 2
  }'
```

响应包含 `{ "success": true, "run": BatchTraceRunV1 }`。`run.perTrace`
保留每条 trace 的完成/失败状态、diagnostics、metric 列表和证据 envelope ID；
`run.aggregate` 保留统计值、outlier ordinals、missing metric 与 failed trace
限制说明。标准 startup / scrolling 指标会映射为 comparison metric key，未映射数字值
只作为 batch-local metric 保存。

Promotion 默认选择所有 completed trace，也可以传 `{ "ordinals": [0, 2] }`。
失败或 unsupported 的 per-trace 结果不会被提升。Comparison bridge 接受
`{ "ordinals": [0, 1], "baselineSnapshotId": "...", "metricKeys": ["startup.total_ms"] }`；
未传 `ordinals` 时使用所有 completed 结果。comparison 仍写入普通
`/api/workspaces/:workspaceId/comparisons` 存储和报告路径，不创建 batch-only 私有对比格式。

## Trace Config Proposal API

Base path: `/api/workspaces/:workspaceId/trace-config`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/proposals` | 根据自然语言生成确定性的 Android trace config proposal |

该接口需要 `trace:write` 权限，但不会调用 LLM、ADB 或 tracebox，也不会录制设备。
响应中的 `proposal.config.textproto` 来自 `smp capture config` 使用的同一个 renderer。

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/trace-config/proposals \
  -H "Content-Type: application/json" \
  -d '{
    "request": "debug startup first frame jank",
    "app": "com.example.app",
    "durationSeconds": 10,
    "categories": ["dalvikviktime"]
  }'
```

响应示例：

```json
{
  "success": true,
  "proposal": {
    "schemaVersion": 1,
    "source": "deterministic",
    "target": "android",
    "preset": "startup",
    "confidence": "high",
    "command": {
      "config": ["smp", "capture", "config", "--preset", "startup"],
      "capture": ["smp", "capture", "android", "--preset", "startup"]
    }
  }
}
```

## Agent v1 主路径

Base path: `/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/analyze` | 启动分析 |
| `POST` | `/conversation` | 启动或继续轻量对话；可选附加 Trace 与已授权源码 |
| `GET` | `/conversation/:sessionId/stream` | 对话 SSE，使用 `runId` 并支持 `Last-Event-ID` 重放 |
| `POST` | `/conversation/:sessionId/cancel` | 取消精确对话 run |
| `GET` | `/conversation/:sessionId/full-handoff` | 读取已建议的完整分析交接 |
| `POST` | `/sessions/:sessionId/runs` | 在已有 session 下启动新 run |
| `GET` | `/:sessionId/stream` | SSE 流 |
| `GET` | `/runs/:runId/stream` | 按 run id 订阅 SSE |
| `GET` | `/:sessionId/status` | 查询状态 |
| `GET` | `/:sessionId/turns` | 获取多轮历史 |
| `GET` | `/:sessionId/turns/:turnId` | 获取单轮详情 |
| `POST` | `/resume` | 恢复已有 session |
| `POST` | `/:sessionId/respond` | 继续或终止 awaiting_user 会话 |
| `POST` | `/sessions/:sessionId/respond` | `respond` 的 session-scoped alias |
| `POST` | `/:sessionId/cancel` | 按精确 `runId` 取消分析 |
| `POST` | `/:sessionId/interaction` | 记录 UI 交互 |
| `GET` | `/:sessionId/focus` | 查询 focus 状态 |
| `GET` | `/:sessionId/report` | 获取分析报告 |
| `DELETE` | `/:sessionId` | 删除 session |
| `POST` | `/:sessionId/feedback` | 提交反馈，进入 self-improving 链路 |
| `POST` | `/:sessionId/external-issue/opportunity` | 从指定持久化 run 检测外部反馈信号 |
| `POST` | `/:sessionId/external-issue/review` | 使用源 run 固定 provider 做无工具 Agent 判断，或返回带短时效服务器证明的安全降级 |
| `POST` | `/:sessionId/external-issue/draft` | 重验 provider pin、服务器 review 证明、用户回答和敏感信息确认后生成未提交 GitHub 草稿 |
| `POST` | `/scene-detect-quick` | 快速场景检测 |
| `POST` | `/teaching/pipeline` | 渲染管线教学 |
| `GET` | `/sessions` | session catalog |
| `GET` | `/logs` | agent logs，受 feature flag 控制 |

Workspace-scoped agent base 为 `/api/workspaces/:workspaceId/agent`，其子路径与上表一致。`/api/agent/v1` 当前仍存在，但会通过 legacy telemetry 标记迁移目标。

### 轻量对话

四个 `/conversation` 接口都要求 `agent:run`，并在每次访问时重验 tenant、workspace、
user owner。`POST /conversation` 返回 `sessionId` 和精确 `runId`；同一 session 的新消息
会先取消旧 run，再占用新 run。没有 `traceId` 时 runtime 不暴露 Trace 工具；传入
codebase/knowledge source 仍须通过与 `/analyze` 相同的权限、注册根目录、权利确认和
provider 发送同意。私有 query、工具正文和错误在进入 SSE 重放或持久化前完成投影。

SSE 终态是 `run_completed` 或 `run_failed`。客户端重连可发送 `Last-Event-ID`，或使用
`lastEventId` query；服务端按单调 `id` 去重重放。只有 outcome 为 `recommend_full` 时，
`full-handoff` 才返回交接，否则返回 `409 FULL_ANALYSIS_NOT_RECOMMENDED`。

### Agent 辅助外部 Issue

三个 M10 POST 都要求 `agent:run` 且 session owner 必须匹配请求上下文。公共请求固定
引用同一完成 run：

```json
{
  "runId": "run-id",
  "runManifestId": "manifest-id",
  "resultSnapshotId": "optional-snapshot-id"
}
```

`opportunity` 返回 `external_issue_opportunity@1` 和确定性 signal。`review` 只在用户
显式触发后运行，返回 `external_issue_review@1`；Agent 只能引用 signal 中已有的
claim/finding/evidence/Skill id。源 provider snapshot 不匹配或 runtime 不支持时，
`source=deterministic_fallback` 且候选只能要求继续验证。

`draft` 还要求前一个完整 review、`candidateId`、最多两个 `answers` 和
`sensitiveDataReviewed=true`，返回 `external_issue_draft@1`、`notSubmitted=true`
以及 HTTPS 浏览器 URL。它不接收 GitHub token，也不调用 GitHub API。传入
`securitySensitive=true` 返回 `PRIVATE_SECURITY_ADVISORY_REQUIRED`。private/code-aware
源分析 fail-closed。完整用户和隐私契约见
[Agent 辅助 GitHub 反馈](../getting-started/agent-assisted-feedback.md)。

启动分析：

```bash
curl -X POST http://localhost:3000/api/agent/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "trace-id",
    "query": "分析滑动卡顿",
    "options": {
      "analysisMode": "auto"
    }
  }'
```

响应会返回 `sessionId`。随后订阅：

```bash
curl -N http://localhost:3000/api/agent/v1/<sessionId>/stream
```

取消必须携带 `/analyze` 回执中的精确 `runId`。缺失、未知或已经不再拥有当前
session 的 run 不会触发 session 级 runtime abort：

```bash
curl -X POST http://localhost:3000/api/agent/v1/<sessionId>/cancel \
  -H "Content-Type: application/json" \
  -d '{"runId":"<runId>"}'
```

取消终态可以先返回给客户端，但同一 session 的下一轮会在被取消的 runtime 真正退出前返回
`409 CANCELLATION_IN_PROGRESS`，避免旧 run 的清理或会话状态污染新 run。

终态 `analysis_completed` 事件可能携带 `analysisReceipt` 和
`uiActionProposals`。`uiActionProposals` 只包含从
DataEnvelope 证据和列点击元数据派生的安全 UI 提案，例如跳转到时间范围、打开证据表
或 `pin_evidence`。其中 `pin_evidence` 只把证据或结果快照收藏到当前 UI 会话并供 `/pins`
查看，不会固定时间线泳道，也不会自动加入后续 AI 上下文。客户端必须等待用户点击后
再执行，不能把它当成自动命令。

支持的 `selectionContext`：

该对象只接受身份和时间边界。旧客户端附带的名称、线程、进程、深度或子项数量会在请求归一化时被丢弃，不会进入 runtime prompt 或证据状态。

```json
{
  "selectionContext": {
    "kind": "area",
    "startNs": 1000000000,
    "endNs": 2000000000
  }
}
```

```json
{
  "selectionContext": {
    "kind": "track_event",
    "eventId": 123,
    "ts": 1000000000
  }
}
```

双 trace 对比需要传 `referenceTraceId`，且不能与 `traceId` 相同。`traceId` 表示基线，`referenceTraceId` 表示对比；两者都可以来自 workspace 历史 Trace。

智能分析通过同一个 `/analyze` 入口启动。第一次请求建议只做场景盘点：

```json
{
  "traceId": "trace-id",
  "query": "/smart",
  "options": {
    "analysisMode": "auto",
    "preset": "smart",
    "smartAction": "preview"
  }
}
```

场景盘点完成后，`analysis_completed` payload 会携带 `smartScenePreview.reportId` 和可选范围。用户选择范围后再次调用 `/analyze`：

```json
{
  "traceId": "trace-id",
  "query": "/smart",
  "options": {
    "analysisMode": "auto",
    "preset": "smart",
    "smartAction": "analyze",
    "smartSelection": {
      "scope": "scene_types",
      "sceneTypes": ["scroll", "inertial_scroll"],
      "reportId": "scene-report-id"
    }
  }
}
```

`smartSelection.scope` 支持 `all`、`scene_types` 和 `scene_ids`。智能分析暂不支持 `referenceTraceId`，也不能作为已有 session 的后续轮次运行。

## Scene Reconstruction

Base path: `/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/scene-reconstruct/preview` | 缓存检查与成本预估，不启动重任务 |
| `GET` | `/scene-reconstruct/report/:reportId` | 获取持久化 SceneReport |
| `POST` | `/scene-reconstruct` | 启动场景还原 |
| `GET` | `/scene-reconstruct/:analysisId/stream` | 场景还原 SSE |
| `GET` | `/scene-reconstruct/:analysisId/tracks` | 获取 tracks |
| `GET` | `/scene-reconstruct/:analysisId/status` | 查询状态 |
| `POST` | `/scene-reconstruct/:analysisId/deep-dive` | 对某个场景深挖 |
| `POST` | `/scene-reconstruct/:analysisId/cancel` | 取消 |
| `DELETE` | `/scene-reconstruct/:analysisId` | 删除 |

该能力受 `FEATURE_AGENT_SCENE_RECONSTRUCT` 控制。

## Skill API

Base path: `/api/skills`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 列出 Skill |
| `GET` | `/:skillId` | Skill 详情 |
| `POST` | `/execute/:skillId` | 执行指定 Skill |
| `POST` | `/analyze` | 自动检测并执行 Skill |
| `POST` | `/detect-intent` | 意图检测 |
| `POST` | `/detect-vendor` | 厂商检测 |

Admin path: `/api/admin`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/skills` | 管理端 Skill 列表 |
| `POST` | `/skills` | 创建 Skill |
| `PUT` | `/skills/:skillId` | 更新 Skill |
| `DELETE` | `/skills/:skillId` | 删除 Skill |
| `POST` | `/skills/validate` | 校验 Skill |
| `POST` | `/skills/reload` | 重新加载 Skill |
| `POST` | `/strategies/reload` | 重新加载策略 |
| `GET` | `/self-improve/metrics` | 自改进指标 |

## Self-Evolution Admin API

Base path: `/api/admin/self-evolution`

所有端点都使用标准 SmartPerfetto 鉴权和请求 scope。提案、operation、overlay 与对账
结果按 `tenantId + workspaceId` 隔离。

| 方法 | 路径 | RBAC | 说明 |
|---|---|---|---|
| `GET` | `/overview` | `self_evolution:read` | 生效/请求配置、持久化、提案/overlay/operation、generation、对账与 L2 状态 |
| `GET` | `/proposals` | `self_evolution:read` | 当前 workspace 的提案列表 |
| `GET` | `/proposals/:proposalId` | `self_evolution:read` | 提案、最近 gate attempt 和 applied revisions |
| `POST` | `/operations/curation` | `self_evolution:curate` | 显式启动一次有界策展，返回 `202 {operationId}` |
| `GET` | `/operations/:operationId/events` | `self_evolution:curate` | SSE replay + live progress；终态后结束 |
| `POST` | `/proposals/:proposalId/gate` | `self_evolution:curate` | 运行固定 validation + holdout paired evaluation |
| `POST` | `/proposals/:proposalId/accept` | `self_evolution:curate` | 人工接受已通过 gate 的提案 |
| `POST` | `/proposals/:proposalId/reject` | `self_evolution:curate` | 人工拒绝提案 |
| `POST` | `/proposals/:proposalId/export` | `self_evolution:export` | 生成本地去标识 contribution bundle，不上传 |
| `POST` | `/proposals/:proposalId/apply` | `self_evolution:apply` | 应用已接受提案；body 必须包含唯一 `actionId` |
| `POST` | `/proposals/:proposalId/revert` | `self_evolution:revert` | 回滚已应用提案；body 必须包含唯一 `actionId` |
| `GET` | `/overlays` | `self_evolution:read` | 当前 workspace 的 overlay registry entries |
| `GET` | `/reconciliation` | `self_evolution:read` | 最近 upgrade reconciliation report |

控制面默认关闭。`SELF_EVOLUTION_ENABLED=true` 才允许策展/gate/接受/拒绝/导出；
apply/revert 还要求 `SELF_EVOLUTION_APPLY=true` 和可写、包外 user data root。依赖
不成立时返回 `503` 并保持 fail-closed；operation 容量耗尽返回 `429`；状态冲突返回
`409`。浏览器必须用 `fetch()` 消费 SSE，确保 Authorization 与 workspace header
继续发送。每个 tenant/workspace 最多同时运行 4 个策展 operation、保留 20 个，
单次运行最长 5 分钟；scope 或全局容量耗尽都返回 `429`。

默认 RBAC 中 Analyst 只有 `self_evolution:read`；Workspace Admin 和 Org Admin
拥有 curate/export/apply/revert。部署运维者的 bootstrap 凭据
`SMARTPERFETTO_API_KEY` 默认是 `org_admin` 并拥有 `*`；企业 API key、SSO 和其他
生产身份继续从持久化绑定解析最小 roles/scopes。
启用方式、控制台顺序、fail-closed 场景和重启验收见
[Self-Evolution 使用与验收](../getting-started/self-evolution.md)。

## Provider Manager API

Legacy base path: `/api/v1/providers`。新集成优先使用
`/api/workspaces/:workspaceId/providers`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 列出 provider profile |
| `GET` | `/templates` | 获取内置 provider 模板 |
| `GET` | `/effective` | 获取当前生效 provider/runtime |
| `GET` | `/:id` | 获取单个 provider |
| `POST` | `/` | 创建 provider |
| `PATCH` | `/:id` | 更新 provider |
| `DELETE` | `/:id` | 删除 provider |
| `POST` | `/deactivate` | 停用 active provider，回到 system default |
| `POST` | `/:id/activate` | 激活 provider |
| `POST` | `/:id/runtime` | 更新 provider runtime pinning |
| `POST` | `/:id/rotate-secret` | 轮换 provider secret |
| `POST` | `/:id/test` | 测试 provider；AI disabled 时返回 `AI_DISABLED` 且不发起 provider 网络请求 |

AI disabled 只阻断 provider connection test。Provider profile 的列表、创建、更新、
删除、激活、停用、runtime pinning 和 secret rotation 仍是配置操作，可以继续使用。

## Codebase / RAG API

Base path: `/api/rag`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/stats` | RAG store 统计 |
| `GET` | `/chunks/:chunkId` | 读取 chunk |
| `DELETE` | `/chunks/:chunkId` | 删除 chunk |
| `POST` | `/search` | 搜索代码/知识 chunk |
| `POST` | `/android-internals/preview` | 预览允许路径内的 Wiki 文章清单，不返回正文 |
| `GET` | `/android-internals/sources` | 列出当前 scope 的外部 Wiki 注册项 |
| `POST` | `/android-internals/sources` | 以独立权利确认和 provider 同意注册 Wiki |
| `POST` | `/android-internals/sources/:id/reindex` | 分阶段重建并原子激活索引 generation |
| `GET` | `/android-internals/sources/:id/audit` | 返回每篇文章的 metadata-only Skill disposition |
| `PATCH` | `/android-internals/sources/:id/consent` | 显式授予或撤销 provider-send 同意 |
| `DELETE` | `/android-internals/sources/:id/index` | 停用 generation 并清除该 source 的全部 chunk |
| `GET` | `/codebases` | 列出已注册 codebase |
| `GET` | `/codebases/directory-picker` | 返回当前后端是否支持本机系统文件夹选择 |
| `POST` | `/codebases/directory-picker` | 打开本机系统选择器并返回短时、当前 scope 绑定的目录授权 |
| `POST` | `/codebases/preview` | 预览 path security gate 接受的文件 |
| `POST` | `/codebases/register` | 注册本机代码库 |
| `GET` | `/codebases/:id` | codebase 详情 |
| `GET` | `/codebases/:id/symbols` | 符号解析 |
| `GET` | `/codebases/:id/excerpt` | 读取已索引片段 |
| `POST` | `/codebases/:id/reindex` | 重新索引 |
| `GET` | `/codebases/:id/audit` | 索引审计 |
| `PATCH` | `/codebases/:id/consent` | 显式授予或撤销 provider-send 同意 |
| `DELETE` | `/codebases/:id` | 退役注册项并删除当前 scope 内的全部 staged/active/superseded generation |

删除 codebase 使用可重试的两阶段生命周期：先在 ingest lease 内把注册项标记为
`deleting`、撤销 provider 同意并切断 active generation，然后清理所有索引分片并删除
注册项。并发重建时返回 `409 CODEBASE_BUSY`；如果物理清理中断，返回
`500 CODEBASE_DELETE_INCOMPLETE`，此时该 codebase 已不可检索、不可重新授权或重建，
重复同一个 `DELETE` 可继续完成清理。已删除或当前 scope 不可见的 ID 返回幂等成功，
且不会泄露其他 tenant/workspace/user 的注册状态。

目录选择接口只在 source/portable、非 enterprise、loopback 监听和 loopback
请求中启用；选择、预览和注册等变更请求还必须携带 loopback Origin。成功选择返回的 `directorySelectionId` 有效期为 5 分钟；调用
`/codebases/preview` 和 `/codebases/register` 时应与相同 `rootPath` 一起传入。
preview 不消费授权；register 会在同步持久化期间独占该授权，成功后永久消费，
持久化失败时保留原有效期供重试。凭证与
tenant/workspace/user 绑定，不能授权其他路径；Docker、远程或无图形环境应使用
手动路径和 `SMARTPERFETTO_CODEBASE_ROOTS`。`GET /codebases` 与
`GET /codebases/:id/audit` 通过 `rootAuthorization` 返回
`native_picker` 或 `configured_allowlist`，但不返回绝对路径；删除 codebase 会撤销
该持久授权。

Android Internals 接口的路径 allowlist、CC 权利确认、可撤销同意、请求级
`options.knowledgeSourceIds` 和 Docker mount 流程见
[Android Internals 外部知识库](../getting-started/android-internals-knowledge.md)。这类私有
chunk 对普通 `/chunks/:id` 和 `/search` 完全不可见；仅专用 source/audit 管理接口返回
当前 scope 内的无正文审计元数据。

源码/RAG 的请求组合、授权指纹和私有输出边界见
[私有分析上下文架构](../architecture/private-analysis-context.md)。

## Analysis Result Comparison API

Workspace base path: `/api/workspaces/:workspaceId/comparisons`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/` | 创建 analysis-result comparison |
| `PATCH` | `/:comparisonId/baseline` | 更新 baseline |
| `GET` | `/:comparisonId/report/export` | 导出 comparison report |
| `GET` | `/:comparisonId` | 获取 comparison |
| `GET` | `/:comparisonId/stream` | 订阅 comparison stream |

Analysis-result snapshot base path: `/api/workspaces/:workspaceId/analysis-results`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 列出 snapshot |
| `GET` | `/:snapshotId` | 读取 snapshot |
| `PATCH` | `/:snapshotId` | 更新 snapshot 元数据 |
| `POST` | `/:snapshotId/similarity` | 查询相似历史 snapshot，可选 case-library hint |

`POST /:snapshotId/similarity` body 支持 `{ "limit": 5, "includeCases": false }`。
`limit` 范围是 1 到 20；`includeCases` 默认 `false`。响应包含
`signature`、`snapshotHints`、`caseHints`、合并的 `hints` 和 `count`。每个
hint 都是 `SimilarityHintV1`，并带有
`allowedUse: "navigation_hint_only"`；它只能作为导航/回看提示，不能作为当前
trace 的诊断证据或 root-cause 证明。接口复用当前 workspace scope、
`analysis_result:read` 权限和 snapshot repository 的可读性规则。

## 报告与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/reports/:reportId` | 获取报告 |
| `GET` | `/api/reports/:reportId/export` | 下载持久化的 HTML 报告 artifact |
| `DELETE` | `/api/reports/:reportId` | 删除报告 |
| `POST` | `/api/export/result` | 导出单个结果 |
| `POST` | `/api/export/session` | 导出 session |
| `POST` | `/api/export/analysis` | 导出分析 |
| `GET` | `/api/export/formats` | 支持格式 |
| `GET` | `/api/export/tenant` | 导出不含 trace 文件正文或 secret 的 tenant compliance bundle |

## Legacy 与兼容接口

以下全局接口仍存在；新的 workspace 产品集成应优先使用上文
`/api/workspaces/:workspaceId/*` 路径：

- `/api/traces/*`，优先迁移到 `/api/workspaces/:workspaceId/traces/*`
- `/api/reports/*`，优先迁移到 `/api/workspaces/:workspaceId/reports/*`
- `/api/agent/v1/*`，workspace 产品优先迁移到 `/api/workspaces/:workspaceId/agent/*`
- `/api/v1/providers/*`，优先迁移到 `/api/workspaces/:workspaceId/providers/*`
- `/api/perfetto-sql/*`
- `/api/template-analysis/*`

仍在维护的辅助 API 包括 `/api/flamegraph/*`、`/api/critical-path/*`、`/api/baselines/*`、`/api/memory/*`、`/api/cases/*`、`/api/ci/*`、`/api/tp/*`、`/api/auth/*`、`/api/tenant/*` 和 `/api/admin/runtime/*`。这些接口面向特定产品面或管理面，调用前应先确认当前部署是否启用了对应 feature / auth。

legacy agent API base 会被 `rejectLegacyAgentApi` 拒绝，避免外部继续接入废弃路径。`/api/advanced-ai/*`、`/api/auto-analysis/*` 和 `/api/agent/v1/llm/*` 这类旧 direct AI route 已移除；统一使用 `/api/agent/v1/analyze`。

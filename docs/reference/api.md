# API 参考

[English](api.en.md) | [中文](api.md)

默认后端地址是 `http://127.0.0.1:3000`。如需修改后端端口，设置
`SMARTPERFETTO_BACKEND_PORT`。Web UI 使用 `/api/workspaces/:workspaceId/*` 路由；对应的全局路径
（`/api/agent/v1/*`、`/api/traces/*`、`/api/reports/*`、`/api/v1/providers/*`）仍可用于本地与兼容
场景，但每个响应都带 `Deprecation: true`、`Sunset: Wed, 30 Jun 2027 00:00:00 GMT` 和指向 workspace
路由的 `Link: <...>; rel="successor-version"`。如果设置了 `SMARTPERFETTO_API_KEY`，受保护接口需要：

```http
Authorization: Bearer <token>
```

`SMARTPERFETTO_API_KEY` 是部署运维凭证；企业用户应使用带明确角色和 scope 的持久化
API key。

## 未处理错误

接口自己声明的错误契约（例如 `{success: false, code, error}`）保持不变。路由没有自行处理、
落到全局兜底的异常，在任何 `NODE_ENV` 下都只返回固定内容：

```json
{"success": false, "code": "unhandled_error", "error": "Internal Server Error", "requestId": "req-…"}
```

HTTP 状态取异常自带的 4xx/5xx 状态，否则为 500。`error` 是该状态的标准名称（如
`Bad Request`、`Payload Too Large`；Node 没有命名的状态码为 `Request failed`），不包含
异常消息和调用栈，请求体 JSON 格式错误也不回显请求内容。`requestId` 就是该请求的请求
ID（见下文），与响应头 `X-Request-Id` 相同。完整的异常消息和调用栈只写入服务端日志的
`[UnhandledError]` 行，用 `requestId` 关联；请求体解析错误附带的原始请求体不写入日志。
没有回显异常消息的调试开关。

`Origin` 不在 `CORS_ORIGINS` 允许列表内的请求（含预检）不是服务端异常：返回 `403`
`{"success": false, "code": "cors_origin_rejected", "error": "This origin is not allowed to call the SmartPerfetto API", "requestId": "…"}`，
不带 `Access-Control-Allow-Origin`，服务端日志只记一条带 origin 的警告。没有 `Origin` 的请求（curl、服务间调用）不受影响。

## 请求 ID

每个请求在进入后端时确定唯一一个请求 ID，所有响应（包括 CORS 拒绝、请求体解析失败、
404 和未处理错误）都带 `X-Request-Id` 响应头，并通过 CORS 暴露给浏览器。ID 依次取调用方的
`X-Request-Id`、`X-Correlation-Id`、`X-Amzn-Trace-Id` 请求头中第一个清洗后非空的值（只保留
`A-Z a-z 0-9 . _ : -`，最长 128 字符），都没有时生成 `req-<毫秒时间戳>-<随机十六进制>`。
同一个 ID 用于鉴权请求上下文、Agent 接口返回的 `requestId`、分析 run 的观测信息、
Trace Processor 代理的 WebSocket 升级和服务端日志。请求体里的 `requestId` 字段不参与解析。

## 路由级失败

接口（含 `backend/src/controllers/` 实现的 SQL、Skill、Skill 包和批量 trace 接口）自己捕获的
下游失败（存储、文件系统、trace processor、密钥库、导出、模型调用等）统一返回：

```json
{"success": false, "code": "report_read_failed", "error": "Failed to get report", "requestId": "req-…"}
```

`code` 稳定，标识失败的操作（如 `report_export_failed`、`provider_operation_failed`、
`trace_processor_proxy_failed`），调用方应按 `code` 判断而不是 `error` 文本。`error` 是固定文案，
不包含异常消息；`requestId` 与 `X-Request-Id` 的取值规则同上。异常消息和调用栈只写入该路由的
服务端日志行，用 `requestId` 关联。

SmartPerfetto 自己为调用方编写的错误保留可操作的文案，形状相同但 `error` 是该文案、HTTP 状态
取错误自己的状态，个别错误另带结构化的 `details`（如 Agent 分析参数）。它们在后端是
`PublicRequestError` 的领域子类，每个路由只回显自己列出的子类，其他异常一律固定文案；这类错误
若是 5xx（如系统目录选择器打不开），原因同样写入服务端日志。逃逸到全局错误处理的这类错误沿用自身
状态码，文案仍按全局规则固定。例如：

- Provider Manager 输入（`provider_invalid_request` 400、`provider_not_found` 404）与 providers.json
  不可读（`provider_store_unreadable` 409）、trace 列表分页（`INVALID_TRACE_LIST_PAGE`）、Agent 日志级别
  （`invalid_log_level`）、Agent 分析参数、RAG 检索参数（`invalid_rag_search_input`）、目录选择器
  （`DIRECTORY_*`）和企业工作区管理（`enterprise_admin_invalid_request` 400、`enterprise_admin_forbidden`
  403、`enterprise_admin_not_found` 404、`enterprise_admin_conflict` 409）。
- 对话：`CONVERSATION_NOT_FOUND` 404、`CONVERSATION_QUERY_REQUIRED` 400、会话上下文变化
  （`CONVERSATION_TRACE_CHANGED`、`CONVERSATION_PROVIDER_CHANGED`、
  `CONVERSATION_PROVIDER_SNAPSHOT_CHANGED`、`ANALYSIS_CONTEXT_CHANGED_RESTART_REQUIRED`；源码或知识源授权
  在恢复时失效为小写的 `analysis_context_changed_restart_required`）409、
  `RUN_ALREADY_ACTIVE` 409、`CANCELLATION_IN_PROGRESS` 409、停止已不在运行的 run 为
  `CONVERSATION_RUN_NOT_ACTIVE` 409。状态由错误类型决定，不再按消息文本匹配。
- URL 上传：`INVALID_TRACE_URL` 400、`TRACE_URL_TIMEOUT` 504、`TRACE_URL_REDIRECT_INVALID` 502。
- 知识策展（baseline、case、memory 晋升）、企业 API Key 创建、OIDC 登录被拒
  （`oidc_subject_tenant_conflict` 403）、trace 采集配置建议、反馈写入
  （输入校验与目标缺失/矛盾 400，supersede/幂等冲突 409）、代码库和外部知识源的字段校验
  （代码库管理接口统一为 `CODEBASE_*`，含 `CODEBASE_METADATA_INVALID`、`PENDING_GENERATION_ID_INVALID`）、
  批量 trace 请求（`error` 可带 `:` 之后的字段名、数量或 Skill 类型，如
  `invalid_batch_trace_limit:trace_count:2>1`；Skill 与工作区 Skill 包冲突为 409）。
- Skill 包：清单、资产或包内 Skill 定义无效、不可安装 400，资产在预览后变化、同版本内容
  已变化（`installed_pack_content_hash_mismatch`）、与工作区 Skill/片段冲突 409，包不存在 404；`error`
  是原因码，可带 `:` 之后的包内相对路径、字段名或 Skill id。持久化失败等内部原因一律固定文案。

RAG 管理接口背后的服务把机器可读的原因码作为异常消息抛出（如 `root_outside_allowlist`、
`source_chunk_limit_exceeded:5000`）。只有逐个列入调用方可处理清单的原因码（源码路径、知识根、
索引生命周期、授权与使用权确认，见 `ragAdminRoutes.ts` 的 `CALLER_FACING_RAG_REASONS`）会被回显为
`code` 和 `error`，去掉第一个 `:` 之后的细节（可能是 id、路径、大小或被排除的条目数），原始消息以
warn 级别写入日志；未列入的原因码（即使前缀相同，如存储损坏、暂存计数不一致、子进程失败）和不是
原因码的消息一律固定文案。自进化接口沿用 `{success: false, error: <code>}` 形状，返回
SmartPerfetto 自己为调用方编写的错误保留可操作的文案：形状相同，`error` 为该文案，HTTP 状态取错误自身的
状态，少数错误（Agent analyze 参数）另带结构化 `details`。后端里它们是 `PublicRequestError` 的领域子类，
每个路由只回显它列出的子类，其他异常一律返回固定文案。5xx 的这类错误（系统目录选择器无法打开）仍会记录原因；
逃到全局错误处理器的，状态码保留，文案用处理器的固定文案。例如：

- Provider Manager 输入（`provider_invalid_request` 400、`provider_not_found` 404）与无法读取的
  providers.json（`provider_store_unreadable` 409）、trace 列表分页（`INVALID_TRACE_LIST_PAGE`）、Agent
  日志级别（`invalid_log_level`）、Agent analyze 参数、RAG 检索输入（`invalid_rag_search_input`）、目录选择器
  （`DIRECTORY_*`）和企业工作区管理（`enterprise_admin_invalid_request` 400、`enterprise_admin_forbidden` 403、
  `enterprise_admin_not_found` 404、`enterprise_admin_conflict` 409）。
- 对话：`CONVERSATION_NOT_FOUND` 404、`CONVERSATION_QUERY_REQUIRED` 400，对话上下文已变化
  （`CONVERSATION_TRACE_CHANGED`、`CONVERSATION_PROVIDER_CHANGED`、`CONVERSATION_PROVIDER_SNAPSHOT_CHANGED`、
  `ANALYSIS_CONTEXT_CHANGED_RESTART_REQUIRED`，恢复时源码或知识授权已不成立则为小写的
  `analysis_context_changed_restart_required`）409、`RUN_ALREADY_ACTIVE` 409、`CANCELLATION_IN_PROGRESS` 409，
  停止已不活跃的 run 为 `CONVERSATION_RUN_NOT_ACTIVE` 409。状态码由错误类型决定，不再匹配消息文本。
- URL 上传：`INVALID_TRACE_URL` 400、`TRACE_URL_TIMEOUT` 504、`TRACE_URL_REDIRECT_INVALID` 502。
- 知识策展（baseline、case、记忆提升）、企业 API Key 创建、被拒绝的 OIDC 登录（`oidc_subject_tenant_conflict`
  403）、trace config proposal、反馈写入（输入校验与目标缺失或矛盾 400，supersede/幂等冲突 409）、代码库与外部
  知识源字段校验（代码库管理使用 `CODEBASE_*`，含 `CODEBASE_METADATA_INVALID` 与 `PENDING_GENERATION_ID_INVALID`），
  以及批量 trace 请求（`error` 可在 `:` 后带字段名、数量或 Skill 类型，如
  `invalid_batch_trace_limit:trace_count:2>1`；与 workspace Skill Pack 冲突的 Skill 为 409）。
- Skill Pack：manifest、asset 或 pack 内 Skill 定义无效，或 pack 不可安装 400；asset 自预检后被改动、已安装版本
  内容变化（`installed_pack_content_hash_mismatch`），或与 workspace Skill / fragment 冲突 409；未知 pack 404。
  `error` 为原因码，可在 `:` 后带 pack 内相对路径、字段名或 Skill id。持久化等内部失败返回固定文案。

RAG 管理背后的服务以机器原因码作为异常消息（`root_outside_allowlist`、`source_chunk_limit_exceeded:5000`）。
只有逐项列为调用方可处理的原因码（源码路径、知识库根目录、索引生命周期、同意与使用权确认；
`ragAdminRoutes.ts` 的 `CALLER_FACING_RAG_REASONS`）会作为 `code` 与 `error` 返回，并去掉第一个 `:` 之后的细节
（id、路径、大小或排除项数量），原始消息记 warn 日志；未列出的原因码（无论前缀，如存储损坏、暂存分片数不一致、
子进程失败）以及不是原因码的消息都返回固定文案。Self-Evolution 保持 `{success: false, error: <code>}` 形状，
返回完整的小写原因码（只含 `a-z 0-9 _ : -`，可带 `:` 之后的 id），其他异常为 `self_evolution_request_failed`。

后续通过其他接口读到的失败记录同样不含异常消息：对比 run 的 `error` 为 `Comparison failed`；
租户清理任务（`GET /api/tenant/purge/:jobId`）的 `error` 只保留清理窗口未到和 tombstone 不存在
两种文案，并附 `errorCode`（`tenant_purge_window_open`、`tenant_tombstone_not_found`、
`tenant_purge_failed`）；报告生成失败时 `reportError` 为 `report generation failed`；上传后
trace_processor_shell 加载失败时返回 `trace_processor_shell could not load the trace`。trace
上传接口的 `details` 只用于 URL 被拒和文件过大这类我们写的说明，不再携带异常消息。通过 API 提交的
批量 trace 中，单个 trace 失败时 `error` 和诊断只保留原因码（否则为 `batch_trace_failed`；Skill 执行返回失败时为 `batch_skill_failed`），CLI
本地批量运行保留完整消息；代码库重建索引结果中每个被跳过文件的 `reason` 只保留原因码（否则为
`source_file_unreadable`）。企业模式下 SSO 会话或 API Key 解析出错时 401 只返回固定说明。此前已经
写入的记录保留原文。

分析 run 的失败在所有者能读到的每个出口都走同一个投影（`projectAnalysisFailure`）：Agent 分析的
`error` SSE 事件、`/status` 和 analyze/run 启动响应的 `error`、对话的 `run_failed` 事件与已保存的
run。运行时或模型服务出错（如鉴权、额度）时返回失败结果，其自身原因随结果交给所有者。run 抛出的异常
只保留 SmartPerfetto 为所有者写的失败文案（授权已变化、provider 不存在或不可读、AI 已关闭、trace
processor lease 或内存准入）或纯原因码（如 `analysis_history_parent_not_authorized`，不带 `:` 之后的
细节）；其余任意异常（SQLite、文件系统等）返回 `分析未能完成，服务端已记录错误（请求 ID：<id>）。`
（英文输出时为英文），原因只按该 ID 写入服务端日志。使用私有知识（源码、外部知识源）的 run 还会经过
其自身的输出 guard，会话已撤销时文案被抑制，日志只记录错误类型。

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
curl -F "file=@trace.pftrace" \
  http://127.0.0.1:3000/api/workspaces/default-workspace/traces/upload
```

下表中的 `/api/traces/*` 在 `/api/workspaces/:workspaceId/traces/*` 下有同样的子路径。

列表默认返回最近 100 条，支持 `limit=1..200` 和响应中的不透明 `nextCursor`：

```http
GET /api/traces?limit=100&cursor=<nextCursor>
```

客户端不得解析或自行构造 cursor。`/api/traces/stats` 的 `traces.metadataCount`
表示 workspace 中可见的持久化 trace 总数，而 `traces.count` 表示当前进程中的活跃 trace。

响应里的 trace 记录（上传、上传失败、列表、详情、viewer）不含服务器文件路径（`path`、
`filePath`）；客户端按 `id` 访问 trace。

## Workspace-scoped API

新集成优先使用 workspace-scoped 路径。未启用企业/多 workspace 时，旧的全局路径仍可用于本地和兼容场景。

| Base path | 说明 |
|---|---|
| `/api/workspaces/:workspaceId/traces` | workspace 范围内的 trace 上传、列表、删除、下载 |
| `/api/workspaces/:workspaceId/reports` | workspace 范围内的报告读取、导出、删除 |
| `/api/workspaces/:workspaceId/agent` | workspace 范围内的 agent 分析、SSE、多轮、反馈 |
| `/api/workspaces/:workspaceId/providers` | workspace 范围内的 Provider Manager profile |
| `/api/workspaces/:workspaceId/analysis-results` | 分析结果 snapshot 列表、读取、更新 |
| `/api/workspaces/:workspaceId/windows` | 前端窗口 heartbeat 与 active window 状态；窗口按 (用户, windowId) 标识，其他用户的窗口只以“指向你可读分析结果”的形式列出 |
| `/api/workspaces/:workspaceId/comparisons` | 多分析结果 comparison 创建、读取、stream、导出 |
| `/api/workspaces/:workspaceId/trace-config` | 无副作用 trace config proposal |
| `/api/workspaces/:workspaceId/skill-packs` | 本地目录型 Skill Pack 预检、安装、启停和移除 |
| `/api/workspaces/:workspaceId/batch-traces` | workspace trace set 的确定性 Skill batch、报告导出、snapshot promotion 和 comparison bridge |
| `/api/workspaces/:workspaceId/critical-path` | 选中 `thread_state` 的 Critical path 等待链分析，见下文 [Critical path 等待链](#critical-path-等待链) |

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
curl -X POST http://127.0.0.1:3000/api/workspaces/default-workspace/skill-packs/preview \
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
curl -X POST http://127.0.0.1:3000/api/workspaces/default-workspace/batch-traces \
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
curl -X POST http://127.0.0.1:3000/api/workspaces/default-workspace/trace-config/proposals \
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
| `GET` | `/conversation/:sessionId` | 读取对话状态与最近 200 条历史 |
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
| `GET` | `/logs` | 列出 agent session 日志 |
| `GET` | `/logs/:sessionId` | 读取一个 session 的日志，可按 `level`、`component`、`search`、`limit` 过滤 |
| `GET` | `/logs/:sessionId/errors` | 只读该 session 的错误日志 |
| `GET` | `/logs/metrics/summary` | 汇总最近 `days` 天（默认 7）的 session 指标 |
| `POST` | `/logs/cleanup` | 删除早于 `maxAgeDays`（默认 7）的日志文件 |
| `GET` / `PUT` | `/admin/log-level` | 读取或设置进程日志级别；`PUT {level: null}` 恢复 `LOG_LEVEL` 默认值 |

Workspace-scoped agent base 为 `/api/workspaces/:workspaceId/agent`，其子路径与上表一致。`/api/agent/v1` 当前仍存在，响应带上文所述的 `Deprecation` / `Sunset` / `Link` 头，并计入 legacy telemetry。

`/logs*` 受 `FEATURE_AGENT_LOGS_API`（默认开启）控制，关闭时返回 503 `FEATURE_DISABLED`；只有
`org_admin` 角色或 `*` scope 的调用方可访问，其他调用方得到 404。`/admin/log-level` 的读取和设置都需要 `runtime:manage` 权限（日志级别作用于整个进程），缺权限返回 403。

### 轻量对话

五个 `/conversation` 接口都要求 `agent:run`，并在每次访问时重验 tenant、workspace、
user owner。`POST /conversation` 返回 `sessionId` 和精确 `runId`；同一 session 的新消息
会先停止旧 run 并至多等待一个复核停止看门狗时长（见下文）让它提交，再占用新 run。没有 `traceId` 时 runtime 不暴露 Trace 工具；传入
codebase/knowledge source 仍须通过与 `/analyze` 相同的权限、注册根目录、权利确认和
provider 发送同意。私有 query、工具正文和错误在进入 SSE 重放或持久化前完成投影。

`GET /conversation/:sessionId` 返回 `status`、`traceContext`、最近 200 条 `history`（更早的条数在
`historyOmittedMessages`，来源授权已不可用而隐藏的条数在 `historyUnavailableMessages`）、
`recoveryStatus`、进行中 run 的 `activeRunId`，以及最近一轮来源可读时的 `pendingQuestion`、
`recommendedFullAnalysis` 与 `fullHandoff`。源码派生的消息在返回前经 owner 凭据过滤。

语义复核一旦发出，流先发送一次 `provisional_answer`（`message` 为经 owner 投影的最终正文，
`verification: "pending"`）：正文已定稿、可以阅读，但核验结论尚未产生；客户端应保持 run
活跃，不写入历史，等 `run_completed` 用同一条消息补上结论。答案出现后的第一次取消只停止
复核并立即返回 `{success: true, sessionId, runId, status: "review_stop_requested"}`；随后
run 带着 `cancelled_by_user` 未核验原因提交本轮，流以 `run_completed` 送达，历史与用户读到
的正文一致。第二次取消是强制停止：在同一看门狗时限内等待该提交，然后返回已落定的结果类型
（`status: "answered"` 等，或 `"cancelled"`）。答案出现前的取消是完整取消，返回
`status: "cancelled"`，除取消标记外不保存任何内容。看门狗
（`SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS`，默认 15000，不低于 10000）只在这类停止时启动；
到时 run 仍未提交时，把用户读到的正文存为不完整回合（`completion.status: incomplete`、
`terminationReason: "review_not_finished"`、断言核验 `not_checked`），沿用该 run 自己的来源
分区，然后中止 run。私有知识 run、授权已被撤销或已失去 session 的 run 不保存该正文，直接取消。
历史读取与预览把这种回合呈现为不完整。每个 run 只有一次终态写入：descriptor 与本轮记录在同一个
SQLite 事务中提交，已是终态的回合不会被再次写入。
只有 `✓` 仍可达或有义务需要复核时才会发出复核（见下文 `/analyze` 的说明）；不需要复核时不发送
`provisional_answer`，也没有复核进度，答案直接随 `run_completed` 出现。

runtime 声明 `draftAnswerStreaming` 能力（当前为 Claude 与 OpenAI）时，定稿前模型正在写的答案
会以 `runtime_update` 形式实时发送：`update.type` 为 `answer_token`（`content` 为
`{token, runId, attempt}`，已剥离声明 sidecar、经 owner 投影、按约 200 ms / 256 字合并）或
`answer_segment_reset`（`{runId, attempt}`，撤回此前显示的草稿，例如模型随后调用了工具、
续写或重试）。草稿只供显示：客户端丢弃 `attempt` 更旧的事件，`provisional_answer` 或
`run_completed` 在同一条消息上替换它，停止时草稿换成取消提示；它不进入重放缓冲、历史或
任何持久化，断线重连不会重放。其他 runtime 不发送草稿。进度标签只来自 `progress` 类型的
`runtime_update`。

`run_completed` 表示 run 已经结束，回答可立即展示，流随即关闭；它携带 `outcome`。
失败的 run 以 `run_failed` 结束。客户端重连可发送 `Last-Event-ID`，或使用
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
curl -X POST http://127.0.0.1:3000/api/agent/v1/analyze \
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
curl -N http://127.0.0.1:3000/api/agent/v1/<sessionId>/stream
```

取消必须携带 `/analyze` 回执中的精确 `runId`。缺失、未知或已经不再拥有当前
session 的 run 不会触发 session 级 runtime abort：

```bash
curl -X POST http://127.0.0.1:3000/api/agent/v1/<sessionId>/cancel \
  -H "Content-Type: application/json" \
  -d '{"runId":"<runId>"}'
```

取消终态可以先返回给客户端，但同一 session 的下一轮会在被取消的 runtime 真正退出前返回
`409 CANCELLATION_IN_PROGRESS`，避免旧 run 的清理或会话状态污染新 run。

先交付、后核验：语义复核发出时，流发送一次 `conclusion`，`data` 为
`{conclusion, provisional: true, verification: "pending"}`。正文与之后
`analysis_completed` 的正文一致（复核不能改写正文，终态只会追加完整性提示），但核验
结论和 `!`/`~` 等终态标记只来自 `analysis_completed`。客户端应保持 run 活跃（加载态、
停止按钮、会话锁），在收到 `analysis_completed` 时替换同一条消息；若在此之前收到
`error`、`analysis_cancelled` 或断流，保留正文并标为未完成核验。runtime 自身的
`conclusion` 不再转发。私有知识 session 的这条事件只进内存重放缓冲，不写入
持久化事件库。scene 运行不发送它。

答案草稿：runtime 具备 `draftAnswerStreaming` 能力（当前为 Claude 与 OpenAI）时，定稿前
流会发送只供显示的 `answer_token`（`data` 为 `{token, runId, attempt}`，已剥离声明 sidecar、
经 owner 投影、按约 200 ms / 256 字合并）和 `answer_segment_reset`（`{runId, attempt}`：
撤回已显示的草稿，发生在模型响应开始、同一响应里已写出文字后又调用工具、以及续写/重试之前）。
客户端丢弃 `attempt` 更旧或属于其他 run 的事件，收到 reset 时清空草稿；临时或最终
`conclusion` 在同一条消息上替换草稿，停止、错误或断流时草稿被丢弃（停止时换成取消提示），
草稿本身从不写入浏览器存储。所有 session 的草稿事件都不带 SSE `id`、不进内存重放缓冲，也不
写入持久化事件库，重连不会重放。使用注册源码或知识库的 session 只向本人发送草稿，并且经过
owner 投影；被拆在多个 token 或多行里的凭据，会一直扣住到完整为止。该投影一旦需要脱敏或丢弃
任何内容，本次 run 的草稿就用 `answer_segment_reset` 撤回，之后不再发送草稿，最终化时收到
投影后的正文。其他 runtime 不发送草稿。

复核只在 `✓` 仍可达或有义务需要它时才发出：报告型交付、存在选区、有源码访问或声明里
有源码字段、调查要求已解析且至少一条不能由证据台账直接判为不适用、至少一条声明断言在
"复核完美通过"的假设下能得到 `passed`（即 `✓` 仍可达），或零断言的纯确认回合。其余回答
（包括没有声明、零断言的事实回答、断言无法得到有限证明的回答）不发复核：断言核验记为
`partial`，未核验原因为 `not_required`，终态为 `~`，不会是 `✓`。这是接受的残余风险：只有复核
才能发现的矛盾此时不会被发现（答案保持 `~` 而不是 `!`）；有限证明得出的 `unsupported` 仍给出 `!`。此时流不发送临时
`conclusion` 和复核进度，而是在最终化完成后、报告与快照生成前发送一次普通 `conclusion`
（`data` 只有 `conclusion`，没有 `provisional`/`verification`），结论判定仍只随
`analysis_completed` 到达；客户端立即按最终答案显示它（没有待核验标记），但同样保持 run
活跃直到 `analysis_completed`；私有知识 session 同样只进内存重放缓冲。声明不合格时复核同样
不发送，未核验原因保持 `invalid_declarations`。

`conclusion` 之后对同一 `runId` 的取消只停止复核：返回 `200`，`status` 为非终态的
`review_stop_requested`，`runStatus: "running"`；run 继续完成，复核记为
`not_checked` / `cancelled_by_user`（非报告回合为 `~`，报告回合因
`report_assessment_not_checked` 为 `!`），并照常发送 `analysis_completed` 与持久化。
"停止并改问"应等待该 `analysis_completed` 后再发送新问题。临时答案之后的第一次取消总是只停核验
（复核已结束时为空操作，结论照常保留）；对同一 `runId` 的第二次取消视为强制停止：先在第一次
取消启动的复核停止看门狗时限内等待 run 提交，再走完整取消（`analysis_cancelled`）。若 run 在
这段时间内提交，强制停止返回 `200`、`status: "completed"`、`outcome: "committed"`；
若未提交，非私有且授权仍有效的 run 把用户读到的正文存为未核验的不完整回合
（`terminationReason: "review_not_finished"`，随 `analysis_completed` 及报告发布），取消返回
`200`、`status: "completed"`、`outcome: "review_not_finished"`；否则完整取消。两种 `completed`
情况下该回合都随 `analysis_completed` 送达。没有第二次取消时
看门狗同样生效。

终态 `analysis_completed` 事件可能携带 `analysisReceipt`、
`uiActionProposals` 和经安全投影的 `conclusionContract.sourceUseDecision` /
`sourceClaimBindings` 与 `sourceClaimVerificationResult`。`sourceUseDecision` 区分
selected / queried / used codebase、status / reason code 和搜索 coverage；
`sourceClaimBindings` 把 claim 关联到本轮源码引用和同一 claim 的 Trace 证据。
`sourceClaimVerificationResult`（`source_claim_verifier@2`）的 `claims[].status` 为
`invalid|unbound|location_only|source_only|trace_linked`，`citations[]` 记录正文
写出的源码位置与本轮引用的比对（`verified_body|located|unmatched|ambiguous`）；
历史结果可能仍是带 `mechanismStatus` 的 `@1`。`CodeRef` 只能解释机制，不能单独
提高现象或根因置信度；`metadata_only` 为 locate-only。投影不包含绝对 root、
snippet、检索 query 或模型自由文本 binding reason。

选用了知识库的运行还携带 `knowledgeUse`（`knowledge_use@1`；缺失表示未记录，
不表示零次使用）：`sources[]` 列出实际交付了内容的知识库（`knowledgeBaseId`、
`kind`、固定的索引 `generation`、去重的 `deliveredReferenceCount`），`citations[]`
把答案里写出的每个 `kb:路径#L起-L止` 分级为 `delivered`（正文已交付）、`located`
（只交付了位置）、`unmatched` 或 `ambiguous`。它只是背景，不是 trace 证据，任何判决
都不读取它；strict 投影保留 sources、删除 citations。回执可能携带
`nonEvidenceContext.knowledgeReferenceCount`，旧回执没有该字段。

重建索引不再撤销会话或运行：授权指纹（格式 `acf2:`）只覆盖同意、选择范围、生命
周期与删除。索引工具检查本次运行固定的代次，索引被重建时返回
`codebase_index_generation_changed`（`action_required: use_search_codebase`）、
Android Internals Wiki 的 `knowledge_index_generation_changed`，或文档知识库固定代次
已被回收或不完整时的 `knowledge_index_unavailable`；注册表未变而已存数据丢失的索引同样
拒绝。`acf2` 之前记录的会话、对话和历史不再
匹配：会话会重新开始一次，对话无法恢复，此前源码派生的历史不再进入模型上下文。

`uiActionProposals` 只包含从
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

选了代码库时，`options.sourceDepth` 可取 `auto`（默认）、`locate` 或 `mechanism`，只决定本次 run 的源码额度，不授予任何访问：`locate` 用于找到代码位置，`mechanism` 允许读足够多的代码解释机制；`auto` 按本轮意图判断的源码需求（只需定位或不需源码 → `locate`，要解释实现 → `mechanism`），意图未给出时按预算（完整 → `mechanism`，快速 → `locate`）；`metadata_only` 封顶 `locate`。实际深度及其来源记在 `sourceUseDecision.depth`。额度值在 `backend/strategies/source-depth-policy.yaml`，非法值返回 `SOURCE_DEPTH_INVALID`。轻量对话（`/conversation`）中某一轮给出的 `sourceDepth` 沿用到后续轮次，并随会话恢复。

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
| `GET` | `/scene-reconstruct/:analysisId/status` | 查询状态；`result.narrative` 与 `/:sessionId/status` 的 `conclusion` 是同一份经 owner 投影的正文（仅场景回放类查询返回场景回放摘要），`error` 同样经投影 |
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

`POST /detect-vendor`（body `{traceId}`）从 trace `metadata` 解析设备身份，不扫描
slice，结果按 trace 身份缓存。响应 schema `trace_vendor@1`：

| 字段 | 说明 |
|---|---|
| `schemaVersion` | `trace_vendor@1` |
| `vendor` | `pixel`、`xiaomi`、`oppo`、`vivo`、`honor`、`huawei`、`samsung`、`aosp`、`other`、`unknown` |
| `brand` | 仅 `vendor = other` 时出现，归一化后的品牌（如 `nubia`） |
| `confidence` | 数值：high 0.9、medium 0.7、low 0.4；`vendor = unknown` 或查询失败为 0 |
| `vendorConfidence` | `high`、`medium`、`low` |
| `soc` | `qualcomm`、`mtk`、`google_tensor`、`samsung_exynos`、`unknown` |
| `os` | `android`、`harmonyos`、`unknown` |
| `source` | `metadata_manufacturer`、`metadata_fingerprint`、`soc_model`、`trace_os`、`none`、`query_failed` |
| `evidence` | 所用的 manufacturer、fingerprint brand、SoC 型号、SDK，以及冲突标记（`manufacturerBrandMismatch`、`osConflict`；多个设备身份冲突时为 `scopeConflict` 加各 scope 的 `scopeIdentities`） |

契约变更：`aosp` 现在只表示 AOSP / generic 构建；没有身份信息的 trace 返回
`unknown`（旧版本返回 `aosp`），查询失败返回 `unknown` + `source: query_failed`。
`harmonyos` 不再是 `vendor` 值，只会出现在 `os`，且仅当格式检测判定为 HarmonyOS
并且 trace 中没有任何 Android 身份时才出现。`POST /execute/:skillId` 与
`POST /analyze` 的响应只在识别到 OEM 时（`vendor` 不是 `aosp`、`unknown`、`other`）
带 `vendor` 字段。

Admin path: `/api/admin`

| 方法 | 路径 | RBAC | 说明 |
|---|---|---|---|
| `GET` | `/skills` | `agent:run` | 管理端 Skill 列表（仅元数据） |
| `GET` | `/skills/:skillId` | `runtime:manage` | Skill 定义与原始 YAML；`filePath` 为相对 Skills 根目录的路径（`composite/<id>.skill.yaml`） |
| `POST` | `/skills` | `runtime:manage` | 创建自定义 Skill（企业模式下禁用） |
| `PUT` | `/skills/:skillId` | `runtime:manage` | 更新自定义 Skill（企业模式下禁用） |
| `DELETE` | `/skills/:skillId` | `runtime:manage` | 删除自定义 Skill（企业模式下禁用） |
| `POST` | `/skills/validate` | `runtime:manage` | 校验 Skill YAML，不保存 |
| `POST` | `/skills/reload` | `runtime:manage` | 重新加载进程级 Skill 注册表 |
| `GET` | `/vendors` | `agent:run` | 厂商 ID 及其覆盖的 Skill |
| `GET` | `/vendors/:vendor/overrides` | `runtime:manage` | 厂商覆盖及原始 YAML |
| `POST` | `/strategies/reload` | `runtime:manage` | 重新加载策略 |
| `GET` | `/self-improve/metrics` | `audit:read` | 自改进指标 |

内置 Skill 目录就是 Agent 自己的工具目录，能运行 Agent 的调用方就能列出它；原始 Skill 内容、
服务端校验、重新加载和写入属于管理运行时的分析内容。缺少权限返回 `403`
`{success: false, error: 'Forbidden', details}`。无密钥本地模式和运维 API Key 拥有全部权限。

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
| `GET` | `/reconciliation` | `self_evolution:read` | 最近 upgrade reconciliation report；issue `message` 只返回错误码或按 `reasonCode` 的固定文案，`contentHash` 标识存储的报告 |

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
| `*` | `/android-internals/*` | 已移除，返回 410（`migration.fallback` 为 `/api/rag/knowledge`）；改用下面的 `/knowledge/*`。旧版 Wiki 连接器注册的知识源仍由 `GET /knowledge` 列出（`kind: android_internals_wiki`，已停用、不可选），可用 `DELETE /knowledge/:sourceId` 删除 |
| `GET` | `/knowledge` | 列出当前 scope 的全部外部知识源（含 `kind`、`description`、`documentCount`、`hasActiveIndex`、`retired`），不返回根路径；`retired: true` 的旧版 Wiki 记录只能撤销同意或删除，授予同意返回 409 `KNOWLEDGE_SOURCE_RETIRED` |
| `POST` | `/knowledge/preview` | 预览文档集合（`rootPath`，可选 `directorySelectionId`）：可入库篇数、section/chunk 数与按原因分类的跳过数；0 篇返回 400 `KNOWLEDGE_COLLECTION_EMPTY` |
| `POST` | `/knowledge/register` | 注册文档集合（`rootPath`、`rightsAcknowledged: true`，可选 `directorySelectionId`、`displayName`、`description` ≤280 字、`attribution`、`license`、`sendToProvider`）；省略 `sendToProvider` 保留既有同意 |
| `PATCH` | `/knowledge/:sourceId/consent` | `{sendToProvider: boolean}` 显式授予或撤销该知识源的 provider-send 同意，返回 `/knowledge` 列表同款投影 |
| `POST` | `/knowledge/:sourceId/reindex` | 分批建本地 SQLite FTS 索引并原子激活新 generation；只需权利确认，不需要 provider-send 同意 |
| `POST` | `/knowledge/:sourceId/search` | 管理端试搜索 `{query, topK?}`：返回标题、相对路径、标题路径、行号与摘录 |
| `DELETE` | `/knowledge/:sourceId` | 先写 tombstone 立即撤销访问，再删除索引文件（Wiki 为 chunk）与注册项；失败可重试 |
| `GET` | `/codebases` | 列出已注册 codebase；`rootAvailable` 不可用时附固定原因 `unavailableReason`；附 `contentDisclosure` |
| `GET` | `/codebases/directory-picker` | 返回当前后端是否支持本机系统文件夹选择 |
| `POST` | `/codebases/directory-picker` | 打开本机系统选择器并返回短时、当前 scope 绑定的目录授权；可选 `purpose: "codebase" \| "knowledge"` 只决定对话框标题，源码库与知识库共用同一种选择 |
| `POST` | `/codebases/preview` | 用与索引相同的 selection policy 预览源码文件与枚举覆盖率 |
| `POST` | `/codebases/register` | 注册本机代码库；不授予 provider-send：`sendToProvider: true` 返回 400 `CODEBASE_CONSENT_DISCLOSURE_REQUIRED`，不写入注册项、不消费目录选择；注册后用返回的 `contentDisclosure` 调 `PATCH /codebases/:id/consent`（`authorizeContent`） |
| `GET` | `/codebases/:id` | codebase 详情（含 `rootAvailable` / `unavailableReason`、`contentDisclosure`） |
| `GET` | `/codebases/:id/symbols` | 符号解析 |
| `POST` | `/codebases/:id/reindex` | 重新索引；request body 仍可用有界 `pathPrefix` 兼容输入，CLI `reindex` 无此选项 |
| `GET` | `/codebases/:id/audit` | 索引审计 |
| `PATCH` | `/codebases/:id/consent` | 四选一：`authorizeContent: true` 加 `contentDisclosureToken` 一次授权所披露的当前范围与全部语言（推荐）；`sendToProvider: false` 撤销（`true` 返回 400 `CODEBASE_CONSENT_DISCLOSURE_REQUIRED`，不改变任何状态：它会不经披露地恢复上一次授权的旧范围与旧语言）；用 `authorizeAvailableExtensions: true` 只授权新语言；用 `authorizeCurrentSelection: true` 只授权当前路径范围 |
| `POST` | `/codebases/:id/selection/preview` | 不保存，按与保存相同的枚举预览新 include prefix / exclude glob 命中的文件（`complete` / `partial` / `unavailable`），只返回相对路径 |
| `PATCH` | `/codebases/:id/selection` | 修改 include prefix / exclude glob；保存时重新枚举，完整枚举为零命中返回 400 `CODEBASE_SELECTION_EMPTY_MATCH`；可带 `expectedSelectionPolicyRevision` 做 CAS（不一致返回 409 `CODEBASE_SELECTION_STALE`） |
| `POST` | `/codebases/:id/pending/accept` | 回传 `candidateGenerationId`、`selectionPolicyRevision` 和 `grantRevision`，以 CAS 显式接受被截断的候选 generation |
| `POST` | `/codebases/:id/pending/reject` | 回传 `candidateGenerationId`，以 CAS 拒绝候选 generation 并清理 staged chunks |
| `DELETE` | `/codebases/:id` | 退役注册项并删除当前 scope 内的全部 staged/active/superseded generation |

preview、register 和 reindex 共用同一份源码选择策略；响应会报告
`enumerationBackend`、`backendFidelity`、`enumerationComplete`、`deterministic`、
已枚举/已选择文件与字节数，以及明确的截断原因。Git ignore 只参与候选召回，
不会扩大 provider 授权；最终源码正文必须同时满足当前 selection policy 与 consent grant。
成功的 AOSP/OEM preview 在可选 manifest 元数据不可用时保留枚举结果，并返回
`manifestUnavailableReason`；`codebase_root_realpath_drift` 仍然阻塞。注册项摘要通过
`providerGrantScopeCurrent` 表明当前 path filter/exclude glob 是否与冻结授权一致。
任何 selection 变化都会推进 `indexGeneration`，使在旧范围下开始的索引任务（包括首次
索引）无法激活；只有原先存在 active generation 时才把 `reindexRequired` 设为
`selection_scope_changed`，从未建过索引的库不再显示它。旧注册表中的
`selection_scope_narrowed` 仍兼容读取。

provider-send 授权只覆盖它被授予时的范围，且必须与当前 selection 完全一致，不存在
"部分授权"。修改 selection 时：若能证明新范围包含在原授权内（每个新 include prefix 位于
某个已授权 prefix 之下或原授权为整库，不进入原授权未包含的噪声目录，且原有排除仍被排除），
授权随之收窄为新范围（`grantRevision` 递增）；否则（含无法证明）自动撤销 provider-send
同意，需要重新授权。语言不属于路径选择，授权保留原语言集合。

`authorizeContent: true` 是唯一的统一授权动作：开启 provider-send，并把授权设为当前
include prefixes/exclude globs 与该类型全部语言。列表与详情返回
`contentDisclosure: {token, includePrefixes, excludeGlobs, extensions}`：三个列表就是
`authorizeContent` 将写入授权的规范化范围与该类型的全部语言（而不只是
`availableNotConsentedExtensions` 那部分新语言），`token` 由 selection revision 与这三个列表的
摘要组成。请求必须以请求体字段 `contentDisclosureToken` 携带调用方所展示披露的 `token`，
缺少时返回 400 `CODEBASE_CONSENT_DISCLOSURE_REQUIRED`；披露之后若范围被修改或新版本增加了
语言，返回 409 `CODEBASE_CONSENT_DISCLOSURE_STALE`，授权状态不变。调用方应展示同一次响应里的
这三个列表并提交同一个 `token`；收到 409 stale 后重新读取、
重新展示、由用户重新确认，不要自动换用新 token 重试。与当前完全相同的重复提交
不改变 consent hash 或 `grantRevision`，因此不会打断会话；已撤销时再次 `sendToProvider: false`、
已覆盖全部语言时再次 `authorizeAvailableExtensions` 同样是幂等的。两个窄动作保持原有边界和前置条件，不会被扩大成统一动作：
`authorizeAvailableExtensions: true` 只加入新版本增加的语言（`availableNotConsentedExtensions`），
`authorizeCurrentSelection: true` 只把当前路径范围写入授权并保留原语言；两者都要求已开启
provider-send，绝不会替用户开启正文发送。若已有活动索引，新增语言会把
`reindexRequired` 设为 `provider_language_scope_expanded`。

`selection/preview` 与保存使用同一套枚举：`complete` 的计数是精确值（完整零命中即证明
选择为空）；`partial` 是提前停止的遍历给出的下界；`unavailable` 附 `unavailableReason`
（根目录原因码或 `enumeration_failed`）。只有 `complete` 的零命中会拒绝保存。

`rootAvailable` 与 `unavailableReason` 来自统一的根目录判定，按固定顺序取第一个原因：
`deleting`、`root_missing`、`root_identity_changed`、`root_not_directory`、
`outside_allowlist`、`unreadable`。分析启动、运行期能力与每次按需读取使用同一判定。
发起分析（`/analyze`、`/sessions/:id/runs`、对话）时，若所选源码库未通过判定，返回 409 并附
`codebases: [{codebaseId, reason}]`，每个失败的库一个固定原因、根目录原因优先于模式原因：
任一根目录失败为 `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE`，否则为
`ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED`（`consent_required`）或
`ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE`（`consent_scope_stale`，`provider_send` 授权与当前
选择不一致）。不存在的库仍为 404，缺少 `codebase:read` 仍为 403。授权过期时按需源码调用以
`provider_grant_scope_stale` 拒绝。

`register` 仍接受 `commitHash` 作为旧调用方的注册兼容元数据，但它不是
索引来源的权威证明。每次 reindex 从真实 checkout 读取 Git `HEAD`、未提交/
未跟踪状态和所选文件内容，产生 `indexedRevision`、`indexedDirty`、
`commitProvenance` 和 `contentFingerprint`。这些 audit 字段才是当前索引的来源
契约。

不完整或非确定性的枚举不会激活索引。确定性但被 file/byte budget 截断的重建在已有
完整 active generation 时只写入 `pendingGeneration`；接受时必须回传列表/详情中的
`candidateGenerationId`、`selectionPolicyRevision` 和 `grantRevision`，拒绝时必须回传
`candidateGenerationId`。候选 ID 是并发 replacement 的 CAS：如果待处理候选已被更新、
接受、拒绝或过期，旧 ID 的操作会失败，不会误操作新候选。候选保留 7 天，列表读取会
惰性过期并清理 staged chunks。没有旧 active generation 时，截断索引可作为明确标有
`activeIndexCoverage.complete=false` 的可用降级结果。

删除 codebase 使用可重试的两阶段生命周期：先在 ingest lease 内把注册项标记为
`deleting`、撤销 provider 同意并切断 active generation，然后清理所有索引分片并删除
注册项。并发重建时返回 `409 CODEBASE_BUSY`；如果物理清理中断，返回
`500 CODEBASE_DELETE_INCOMPLETE`，此时该 codebase 已不可检索、不可重新授权或重建，
重复同一个 `DELETE` 可继续完成清理。已删除或当前 scope 不可见的 ID 返回幂等成功，
且不会泄露其他 tenant/workspace/user 的注册状态。

目录选择接口只在 source/portable、非 enterprise、loopback 监听和 loopback
请求中启用；选择、预览和注册等变更请求还必须携带 loopback Origin。成功选择返回的 `directorySelectionId` 有效期为 5 分钟；调用
`/codebases/preview` 和 `/codebases/register` 时应与相同 `rootPath` 一起传入。
preview 不消费授权；register 在整个注册期间独占该授权（根目录校验、源码枚举和写入注册项
都在独占期内），成功后永久消费；失败（包括完整枚举为零命中）时若授权尚未过期则恢复供重试，
已在注册期间过期则不再恢复。凭证与
tenant/workspace/user 绑定，不能授权其他路径；Docker、远程或无图形环境应使用
手动路径和 `SMARTPERFETTO_CODEBASE_ROOTS`。注册进行中并发重放同一
`directorySelectionId` 返回 400 `DIRECTORY_SELECTION_NOT_FOUND`。后端会保留这项授权来源以支持后续
reindex 与删除，但 `GET /codebases`、`GET /codebases/:id` 和
`GET /codebases/:id/audit` 的安全管理响应都不暴露 `rootAuthorization`、绝对路径或原始
运行时错误。删除 codebase 会撤销持久目录授权。

文档知识库使用同一种目录选择：`/knowledge/preview` 与 `/knowledge/register` 带上
`directorySelectionId` 和相同 `rootPath`（同样只接受 loopback Host、socket 与 Origin，
否则 403 `DIRECTORY_PICKER_UNAVAILABLE`），preview 不消费；register 在整个注册期间独占
（异步预览与写入注册项都在独占期内），成功后消费，失败时按同样的过期规则恢复。
注册后知识源记录 `native_picker` 渠道（按 owner scope 隔离的来源记录，不写入任何共享
配置），只有该来源自己的根目录在之后的 reindex 中免于 `SMARTPERFETTO_KNOWLEDGE_ROOTS`
检查，每次读取仍校验目录身份、权限与链接边界；删除知识源即撤销。只带 `rootPath` 的请求
（包括同一用户对同一目录的再次注册）只受 `SMARTPERFETTO_KNOWLEDGE_ROOTS` 约束，不会继承
任何 picker 授权；通过它重新注册会把记录的渠道换成配置白名单。知识库响应与错误不返回
绝对路径或 `rootAuthorization`。读取所选目录失败（如子目录无权限、目录被并发删除）时，
这些知识库路由与 codebase 的 preview/register/reindex 只返回固定错误码与 `requestId`，
服务端日志只记录 errno、syscall 与源码栈帧，不记录路径。

Android Internals Wiki 以文档知识库接入，见
[把 Android Internals Wiki 作为知识库使用](../getting-started/android-internals-knowledge.md)。

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

Skill 结果行可以用同行的 `<列名>_definition` 字符串声明该指标列的口径，snapshot
把它保存为指标 `source.metricDefinition`。两个 snapshot 的同一指标声明不同（含一方未声明）时，
comparison 不计算 delta（`deltaValue: null`、`assessment: "unknown"`），并在
`matrix.warnings` 与结论 `uncertainty` 中写明两侧口径。未声明的历史指标之间照常比较。

`cpu.big_core_pct` 另有生产者合同（`backend/src/services/comparisonMetricProducerContract.ts`），
不再按列名取第一个 `big_core_pct`：

- 口径 `main_thread_running:core_tier_group:prime+big+medium@3`：所选事件窗口内**一个**主线程
  Running 时间中大核组（超大/大/中核）的占比，且该线程没有落在未分类核上的时间。它描述被选中的那一个
  启动或慢输入事件，不是整场分析的汇总。
- 只认这些来源（按信封的顶层 `skillId` + 展示 `stepId`）：`startup_detail` / `click_response_detail`
  的 `cpu_core_analysis`，以及 `startup_analysis.analyze_startups`、
  `click_response_analysis.analyze_slow_events` 迭代项里的 `cpu_core_analysis` 分节（`source.section`
  与 `source.itemIndex` 记录是哪一项）。其他 Skill 的同名列、`type: skill` 嵌套步骤、raw SQL、
  前端预查询和参考 trace 一侧的信封都不是候选。
- 第一个返回行的候选单元决定结果：必须恰好一行、行内 `big_core_pct_definition` 等于上述口径、
  `main_thread_count = 1`、未舍入的 `unknown_core_ns = 0`（数值类型）。不满足时指标以
  `value: null` 与 `missingReason: "producer_contract:<原因>"`（`ambiguous_population`、
  `definition_mismatch`、`unknown_core_time`、`unknown_core_time_unverified`、`value_unavailable`）
  存入 snapshot，不会改取后面另一个线程、事件或信封的值；comparison 把它列为缺失并给出该原因。
- 只有双方都是准入生产者按当前口径声明的值才计算 delta。历史值按来源分类后一律不计算 delta，
  warning 写明类别：`legacy_admitted_producer`（准入生产者的旧值，未核对未知核时间）、
  `outside_contract`（其他 Skill 步骤，含 `cpu_profiling` 早先的 `@2` 声明）、`non_skill_source`。

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

仍在维护的辅助 API 包括 `/api/flamegraph/*`、`/api/critical-path/*`、`/api/baselines/*`、`/api/memory/*`、`/api/cases/*`、`/api/ci/*`、`/api/tp/*`、`/api/auth/*`、`/api/tenant/*` 和 `/api/admin/runtime/*`。这些接口面向特定产品面或管理面，调用前应先确认当前部署是否启用了对应 feature / auth。`/api/cases/*` 的读取只需登录；新建、删除、发布、归档与边的增删要求 `self_evolution:curate`，curator 与 reviewer 取自登录身份，请求体中的名字不被采用。学习产生的 case 已退役：以 `learned:` 开头的 id 与学习来源的 case 不再返回，写入会被拒绝。分析只读取 published / reviewed、已 `redacted` 且带有策展证明的 case：新建与 publish 时，服务端为 case 的当前内容签发证明；archive 只保留 case 原有的准入，不会让 case 进入分析。返回的每条 case 都附带 `analysisAdmitted` 与 `curation`（issuer、actor、issuedAt），POST 请求体里的这两个字段会被忽略。引入准入之前写入的 case 需要补戳：reviewed case 用 GET 读回后原样 POST，published case 重新 publish。

legacy agent API base 会被 `rejectLegacyAgentApi` 拒绝，避免外部继续接入废弃路径。`/api/advanced-ai/*`、`/api/auto-analysis/*` 和 `/api/agent/v1/llm/*` 这类旧 direct AI route 已移除；统一使用 `/api/agent/v1/analyze`。`/api/perfetto-sql/*` 已移除，所有部署模式下都返回 410：场景端点（如 `/startup`、`/scrolling`）改用请求体相同（`{traceId, packageName}`）的 `POST /api/skills/execute/<skillId>`（enterprise 部署下该接口同样要求 workspace 路由），响应的 `migration.successor` 给出对应路径；`/sql`、`/tables`、`/functions`、`/skills`、`/analyze`、`/input`、`/buffer-flow`、`/systemserver` 没有直接替代，`migration.fallback` 指向 workspace agent 接口。`/api/template-analysis/*` 同样返回 410；`/auto`、`/four-quadrant`、`/cpu-core`、`/frame-stats` 都没有请求体相同的替代，只给出 `migration.fallback`。`/api/sessions/*` 返回 410：它是不按所有者过滤的旧会话存储接口，`migration.successor` 给出按所有者鉴权的替代路径（`GET /api/sessions` → `/api/agent/v1/sessions`，`GET /api/sessions/:id` → `/api/agent/v1/:id/turns`，`DELETE /api/sessions/:id` → `/api/agent/v1/:id`），`/export` 没有替代。`/api/sql/*` 也返回 410：`/tables` 返回的是固定的五张表摘录而不是当前 trace 的 schema，`/generate` 只做正则模板匹配或返回预置 SQL，并不读取任何 trace；两者都没有请求体相同的替代，`migration.fallback` 指向 workspace agent 接口，由 agent 读取实际 schema 并执行 SQL。

### Critical path 等待链

`POST /api/workspaces/:workspaceId/critical-path/:traceId/analyze` 服务于 AI Assistant 中选中 `thread_state` 后的 Critical path 抽屉，路径中的 workspace 必须与调用方上下文一致（否则 404）。旧的全局接口 `POST /api/critical-path/:traceId/analyze` 行为相同，但 enterprise / OIDC 部署下固定返回 410 `ENTERPRISE_WORKSPACE_ROUTE_REQUIRED`。Trace 必须属于调用方 workspace，且调用方需要 `trace:read`。请求体与响应的类型定义在 `backend/src/types/criticalPathContract.ts`，由 `npm --prefix backend run generate:frontend-types` 生成到插件的 `generated/` 中，`npm --prefix backend run check:types` 检查二者一致。

请求体为 `threadStateId`，或 `utid` + `startTs` + `dur`（可选 `endTs`），另可带 `maxSegments`、`recursionDepth`、`recursionEnabled`、`segmentBudget`、`includeAi`、`question`、`outputLanguage`。

成功返回 `{success: true, analysis, presentationAnalysis, aiSummary}`。阻塞时长、占比、模块归因和 `chainSegmentCount` / `chainWaitMs` / `waitClassTotalsMs` 覆盖完整的顶层等待链（最多 5000 个原始栈段；超过时 `truncated: true` 并在 `warnings` 中说明只覆盖截断前部分），递归子链不重复计入；`wakeupChain` 只是展示前缀（`maxSegments`）。时长先按纳秒求和再换算，外部占比不会因舍入超过 100%。结果里的模块、异常、建议、警告、原因、唤醒提示和假设都带稳定 id（`moduleIds` / `moduleId`、`anomalies[].id` + `params` + `evidenceItems`、`recommendationIds`、`warningCodes`、`reasonItems`、`directWaker.hintCodes`、`hypotheses[].params` + `noteCodes`），文字只在输出时按语言渲染：`presentationAnalysis` 按请求语言渲染；`analysis` 是同一结果的 zh-CN 渲染，已弃用（仅为兼容旧客户端保留，后续版本移除），新客户端只读 `presentationAnalysis`；`longestSegment` 给出整条链最长的可归因段。新增 `totalsNs`（`blocking`、`chainWait`、`waiting`，整数纳秒；窗口即 `task.dur`，自身时间为 `task.dur - blocking`），`quantification.counterfactual` 新增 `longestSegmentDurNs`、`bestCaseDurationNs`、`maxSavingNs`；对应的 ms 字段都由这些纳秒值各自换算一次。未传 `maxSegments` / `recursionDepth` / `segmentBudget` 时使用引擎的 `CRITICAL_PATH_DEFAULTS.ui`（160 / 2 / 16）。以下情况 `aiSummary` 返回规则兜底总结（`generated: false`），并附 `fallbackReason` 和本地化的 `warnings`：AI 被关闭（feature `critical_path_ai_summary`）、调用方没有 `agent:run`（`permission_denied`，只读 trace 不足以动用模型）、当前 Provider 不是 Claude Agent SDK runtime、凭证缺失、超时、客户端断开。模型失败的原始错误只写入服务端日志。AI 关闭不会让该接口返回 403。客户端断开会取消进行中的模型调用，也会取消尚未完成的 trace 查询，此时不再返回响应。

等待链的时间按每段的 `pathRole` 分账：`work`（Running）、`runnable`（R/R+）、`device_wait`（D/DK）、`event_wait`（S/I）、`other`。Perfetto 在其他线程的每个 S/I/D 段处终止唤醒链（该线程由中断、idle 任务或 io_wait 唤醒，没有可追的唤醒者），所以这些段是链路末端，不会被递归展开；递归只展开 `work` 段。头部数字是 `attributableMs` / `attributablePercentage`（其他线程运行、可运行与不可中断等待）；`blockingMs` / `externalBlockingPercentage` 是链路覆盖，包含 `eventWaitMs` / `eventWaitPercentage`（链路末端其他线程的可中断睡眠）。`totalsNs` 额外给出 `work`、`runnable`、`deviceWait`、`eventWait`、`other`、`attributable`，且 `work + runnable + deviceWait + eventWait + other = blocking`、`chainWait = deviceWait + eventWait`。`longestSegment` 和反事实估计只取可归因段；`longestEventWait` 单独给出最长的链路末端等待及其唤醒来源类别。`rootWait` 说明选中线程自身等待（选中行，或区间模式下最长的等待 slice）与其 slice 的关系：`in_slice`（附 `enclosingSlice`）、`between_slices`（前后都有 slice）、`no_slice_data`（某一侧没有 slice，无法区分空闲）。异常 `idle_wait` 只在 `between_slices` 且可归因占比很低时出现，表示空闲而非卡顿；`peer_event_wait` 在链路末端等待占窗口一半以上且等待不在两个 slice 之间时出现，指向那个在等网络、定时器或设备的线程。`unavailableReason` 另有 `no_thread_state_in_window`（区间内该线程没有任何 thread_state 行，不代表空闲）和 `wait_open_at_trace_end`（选中等待到 trace 结束都没结束且没有可追的链）；仍未结束的行（`dur = -1`）按 trace 结束截断分析，并带 `wait_open_at_trace_end` 警告。`threadStateId` 为 0 是合法的行号。

失败返回 `{success: false, code, error}`，`error` 已本地化：

| 状态 | `code` | 含义 |
|---|---|---|
| 400 | `invalid_trace_id` | traceId 含有安全字符集以外的字符 |
| 400 | `invalid_request_body` | 请求体未通过校验，附 `issues` |
| 400 | `invalid_thread_state_id`、`missing_selector`、`non_positive_duration`、`invalid_integer`、`invalid_name` | 选择参数不可用 |
| 404 | `trace_not_found` | Trace 不存在，或不属于调用方 |
| 404 | `thread_state_not_found` | Trace 中没有该 thread_state |
| 500 | `critical_path_failed` | 其他失败；原始错误只写入服务端日志 |

### 火焰图

`GET /api/flamegraph/:traceId/availability` 返回 trace 是否含 CPU 调用栈采样（Perfetto summary tree）；`POST /api/flamegraph/:traceId/analyze` 返回 `{success: true, analysis, aiSummary}`。两者都是全局非 workspace 接口（enterprise / OIDC 下 410），与 Critical path 一样先校验 traceId 和请求体、再校验 trace 属于调用方并要求 `trace:read`，然后才加载 trace。请求体可带 `startTs`、`endTs`、`packageName`、`threadName`、`sampleSource`、`maxNodes`、`minSampleCount`、`includeAi`、`question`；未声明字段会被丢弃。缺少 summary 模块或表的 trace processor 返回 `available: false`；其他查询失败重试一次后返回 500。`aiSummary`（feature `flamegraph_ai_summary`）的兜底规则与 Critical path 相同，包括 `agent:run` 要求和 `fallbackReason`；输出只有中文。客户端断开会取消未完成的查询和模型调用。失败返回 `{success: false, code, error}`，`code` 为 `invalid_trace_id`、`invalid_request_body`、`trace_not_found` 或 `flamegraph_failed`。原 `POST /api/flamegraph/:traceId/summarize`（把客户端提交的分析结果发给模型）已删除，没有调用方。

# Enterprise Multi-Tenant 方案 Review

## 0. Review 元信息

- 评审对象：`docs/features/enterprise-multi-tenant/README.md`（852 行）
- 评审日期：2026-05-08
- 评审方：Claude Opus 4.7（1M context）+ Codex（session `019e05ac-0fbd-7db1-bd23-17605c7a35c4`）
- 评审方式：双轨独立审查 → 合并整理。Claude 先做架构层 review，Codex 在不看 Claude 输出的前提下基于代码取证独立 review，最后合并

### 用户硬性约束（Review 的关键前提）

1. **一步到位做企业级部署**，不做"三用户问题独立 hotfix"中间形态
2. **规模上限约 100 人**：同时在线 30-50 人，并发 agent 分析 5-15 个，trace 元数据几千个
3. **不堆 SaaS 规模中间件**：不要 Postgres HA / Redis Streams / NATS / Vault HA / 多 API pod / Object Storage（必需场景之外）
4. **预期部署形态**：单节点或少量节点 / 本地文件系统或单节点对象存储（可选）/ 单 SQLite 或单 Postgres / 进程内队列
5. **可向上兼容**：保留 abstraction 接口预留扩展，但**不**为未来兼容性现在引入大依赖

---

## 1. 总体评价

方向对、领域模型清晰、对当前代码的诊断准确度约 80%。但全文按 SaaS 多租户平台尺度规划——在 100 人规模下大量组件是过度设计。

主要问题不在"想错了什么"，而在**尺度感**：把 SaaS 平台标准配置全套搬过来，对 100 人企业版形成沉重工程债。

需要在两个层面调整：
- **降级**：把 SaaS 级中间件从主线移到"未来扩展附录"
- **重组**：P0-P6 线性阶段改为 4 条并行主线

---

## 2. 事实校正（必须先于建议讨论）

文档对"当前实现"的描述大体准确，但有几处事实错误会误导后续工程决策。这些是 Codex 直接读代码取证后发现的：

### 2.1 agent routes 实际有 authenticate

文档第 3.2 表格暗示 `/api/agent/v1/*` 与 `/api/traces/*` 一样"无鉴权"。实际上 `agentRoutes.ts` 已经挂载 `authenticate` middleware，问题是：
- dev fallback 注入 `dev-user-123`（`auth.ts:60`）
- sessionId 没有 owner guard

→ **修正第 3.2 表格**："agent route 已有 API key 鉴权层，但缺资源 owner guard；并发场景下任何用户拿到 sessionId 都能访问/恢复/操作他人 session"。不要写成"完全没鉴权"。

### 2.2 前端 SSE 是 fetch-stream，不是 EventSource

文档（以及 Claude 第一轮 review）都隐含假定前端用 EventSource。Codex 实测当前是 `fetch + ReadableStream`。后果对鉴权路线影响很大：

| 假设 | 鉴权方案 |
|---|---|
| EventSource（错） | 必须走 httpOnly cookie；Bearer 不能带 |
| fetch-stream（实际） | Bearer header 可以正常带；浏览器 SSO 可走 short-lived access token |

→ **修正第 9.3 节**：明确锚定 fetch-stream，鉴权主路径走 `Authorization: Bearer <token>`，无需走 cookie。重连和 `Last-Event-ID` 需要前端自实现（EventSource 内置功能在 fetch-stream 下不存在）。

### 2.3 Skill 数量已过期

文档第 1 节背景与 `CLAUDE.md` 都写"87 atomic + 29 composite + 28 pipelines + 18 modules + 8 vendor overrides"。Codex 实测当前仓库：

- **126** atomic
- **33** composite
- **33** pipelines
- 18 modules
- 8 vendor overrides

→ 同步更新文档与 `CLAUDE.md`。这影响第 5.2 节"Skill 资源归属"以及多租户化的复杂度判断（数字越大，路 A "v1 禁止 custom skill" 越合理）。

### 2.4 Custom Skill loader 不闭环

`backend/skills/custom/` 有 admin CRUD endpoint 写入路径，但 SkillManager 的 loader 没加载该目录。当前代码已存在悬挂功能：**写得进、读不出**。

→ 这不是多租户化的新问题，是**已存在的 bug**。多租户化前必须先决定：v1 关闭 custom skill 功能并修 loader 闭环（清理 dead admin endpoint），或在主线 D 一并修 loader 闭环。

### 2.5 Legacy AI 路径未列入触点

文档第 21 节"代码触点"漏列了几个 legacy AI 入口：

- `/api/agent/v1/llm` DeepSeek proxy（`agentRoutes.ts`）
- `/api/advanced-ai` in-memory OpenAI sessions（`advancedAIRoutes.ts`）
- `/api/auto-analysis`（`autoAnalysis.ts`）
- `agent/core/ModelRouter` 的 DeepSeek 默认路径
- `aiChatRoutes.ts`

这些都**没有** RequestContext / ProviderSnapshot / owner guard 概念。在企业版部署时必须明示处置策略：
- 直接废弃（企业模式下禁用对应 route）
- 接入新 RequestContext + ProviderSnapshot + owner guard

→ **修正第 21 节**：列入所有 legacy 入口，每个都标注处置策略。

### 2.6 prepareSession 只比较 providerId，不比较 config

ProviderSnapshot 不变量章节（第 9.2 + 10.1）的具体 bug 点：

- 当前 `prepareSession` 只比较 `agentRuntimeProviderId` 决定是否复用 `sdkSessionId`
- 如果管理员修改了**同一个 providerId** 的 config（例如改 model、改 timeout、改 base URL）
- resume 会拿旧 SDK session 配新 provider config → SDK session 错位、model 切换、timeout 变化都可能发生

这是 P0 级别的工程缺口。文档需要在 9.2 + 10.1 写清不变量并定义 snapshot 内容（详见 §4.1）。

---

## 3. 架构层面：过度设计的降级清单（按 100 人规模）

### 3.1 第 5.1 总体架构图：6 个组件应从主线移除

按 100 人规模重新评估第 5.1 列出的 10 个组件：

| 组件 | 100 人规模评估 | 处置 |
|---|---|---|
| API Gateway / BFF | 单 pod 不需要独立网关 | **降级**为 Express middleware 链 |
| SSE Gateway | 单 API 进程直接出 SSE 即可 | **删除** |
| Agent Runtime Workers（独立进程） | 同进程 background worker pool 足够 | **降级**为同进程 background queue |
| Job Queue（Redis/NATS） | 100 并发 5-15 个分析，进程内 EventEmitter + DB shadow 足够 | **降级**为 SQLite/PG append-only `analysis_runs` 表 + 进程内调度器 |
| Trace Processor Lease Manager | **保留**——这是隔离正确性的基础，不是规模组件 | 实现可以是单进程内状态机 |
| Trace Processor Worker Pool | **保留**——但单机 N=5-10 worker 即可 | 保留，降低 worker 数 |
| Postgres | SQLite-WAL 或单 Postgres 都行；不需要 HA | **保留**（单实例），HA 移到附录 |
| Redis | 100 人不需要分布式锁/缓存 | **删除**（或仅作为可选缓存层） |
| Object Storage | 本地 fs `data/` 目录就够；单节点 MinIO 选配 | **降级**为本地 fs adapter，MinIO 选配 |
| Vault / KMS | OS keyring + libsodium-encrypted file 足够 | **降级**为 local secret store |

→ **第 5.1 架构图重画一版"100 人版"**：单 API + 同进程 worker + SQLite + 本地 fs + encrypted secrets + 进程内 lease manager。原 SaaS 版图作为附录保留。

`★ Insight ─────────────────────────────────────`
"必须保留"的两个组件——TraceProcessorLease + ProviderSnapshot——是隔离正确性的不变量，与规模无关。100 人企业版省不了这两个；省的是给它们撑场的中间件（Redis/NATS/Vault）。
`─────────────────────────────────────────────────`

### 3.2 第 13 节存储方案：合并为单一档位

不要分 Tier 1 / Tier 2 双档（维护两套不划算），合并为单档位：

```
权威元数据  → SQLite (WAL) 或 单 Postgres（二选一，看运维偏好）
大文件     → 本地 fs `data/{tenantId}/{workspaceId}/...`
凭证       → libsodium-encrypted file + OS keyring 解密 master key
事件流     → SQLite/PG `agent_events` append-only 表 + 自增 cursor
job queue  → 进程内 PriorityQueue + DB persistent shadow（重启可恢复）
缓存       → in-memory LRU（不引入 Redis）
schema 索引 | per-trace 内存 cache + DB metadata（无外部依赖）
```

**接口预留向上兼容点**（不实现，只留 abstraction）：
- `ObjectStore` interface（本地 fs 实现 / 可换 S3 实现）
- `SecretStore` interface（encrypted file / 可换 Vault）
- `EventStream` interface（SQLite append-only / 可换 Redis Streams）
- `JobQueue` interface（进程内 / 可换 NATS/SQS）

这样：今天用本地实现，明天 HA 时换 adapter 实现，业务代码零改动。但**不要**今天就实现两套 adapter——只写当前需要的。

### 3.3 第 14.3 企业 HA 部署：移到附录

100 人规模下不需要 HA。整节移到 `docs/features/enterprise-multi-tenant/appendix-ha.md`，并在主文档加一句：

> 当前文档目标规模为约 100 人企业版，HA 形态超出本目标范围，作为未来扩展参考见附录。

### 3.4 第 15 节 P0-P6：从线性阶段改为 4 条并行主线

按"100 人 + 一步到位"目标，P0-P6 不应该线性等。建议改为 4 条**可并行**主线：

#### 主线 A：身份与权限
- `RequestContext` middleware
- `Organization / Workspace / User / Membership / ApiKey` 表
- OIDC SSO 接入 + API key 共存
- RBAC + owner guard 全路由覆盖
- Onboarding flow（首次 SSO → workspace selection）

#### 主线 B：存储与持久化
- `sessionPersistenceService` 加 `tenant_id / workspace_id / owner_user_id` 列
- 报告 / memory / case / baseline 加 scope
- 凭证从 `data/providers.json` → encrypted local secret store
- `logs/claude_session_map.json` → DB `runtime_snapshots`
- `logs/reports/*` → 本地 fs `data/{tenant}/{workspace}/reports/` + DB metadata
- 旧 → 新双写双阶段迁移（详见 §4.7）

#### 主线 C：运行时隔离
- `TraceProcessorLease` + scoped cleanup（取代全局 cleanup）
- per-trace SQL queue（先 benchmark 再决定串行/并发）
- `ProviderSnapshot` per-session 固化（首轮决定，后续 turn 沿用）
- 进程内 analysis run queue + heartbeat + ref-count
- active run / lease 生命周期保护（cleanup 不能误杀，详见 §4.5）

#### 主线 D：控制面与合规
- `audit_events` 表 + 关键操作埋点
- tenant / workspace / member / quota / provider 管理 UI
- 配额超额降级策略（详见 §5.3）
- 数据导出 + tenant 删除（GDPR，详见 §5.4）
- 审计日志查询界面
- Custom skill 闭环修复（关 admin 或修 loader，详见 §5.2）
- Legacy AI 路径处置（废弃或接入，详见 §5.1）

四条主线**可并行**，共同支撑同一个里程碑发布。原 P0（观测）不再独立成阶段，作为贯穿全程的回归基线（RequestContext + audit + dashboard 共同提供）。

`★ Insight ─────────────────────────────────────`
线性 P0→P6 在"还没决定要做企业版"的探索阶段是对的（先观测再投资）；一旦决定一步到位，并行主线更适合 100 人规模。每条主线 1-2 工程师并行 6-10 周即可达到 GA。
`─────────────────────────────────────────────────`

---

## 4. 边界情况补全

### 4.1 ProviderSnapshot 多轮 resume 不变量【P0】

**当前代码风险**（Codex 实测）：`prepareSession` 只比较 `agentRuntimeProviderId`，不比较 provider config 内容。如果管理员改了同一个 providerId 的 model / timeout / base URL / secret，resume 会拿旧 SDK session 配新 config——产生 SDK session 错位、model 不匹配、timeout 变化等问题。

**文档需补充的不变量**（写到 §9.2 + §10.1）：

```
ProviderSnapshot {
  snapshotId: hash(providerId + runtimeKind + resolvedModels + resolvedTimeouts + secretVersion + baseUrl)
  providerId, runtimeKind, resolvedModels, resolvedTimeouts
  secretRef, secretVersion
  baseUrl
  createdAt
}
```

- ProviderSnapshot **per-session** 固化（首轮决定，后续所有 turn 沿用）
- resume 时校验 snapshot hash 一致才允许复用 `sdkSessionId`
- 不一致时：开新 SDK session（保留对话上下文，丢弃 SDK 内部 session id）+ 提示用户"provider 配置变更，已自动开启新 LLM session"
- 跨 provider 的多轮（UI 切 provider）：必须新建 SmartPerfetto session（这一条 `CLAUDE.md` 已写在前端 `agentSessionId` 清空规则里）

### 4.2 trace_processor SQL 串行化的决策路径【P1】

第 8.2 默认串行的判断方向对，但需要先 benchmark：

- 当前 `WorkingTraceProcessor.query()` 没有 per-trace mutex，只记录 `activeQueries`
- 代码注释明确指出 concurrent preload 在大 trace 上会让 trace_processor_shell socket hang up
- agentv3 一次 turn 可能触发多 SQL（invoke_skill 内部本身就是多 SQL）；串行会显著放大延迟

**建议工程路径**（写到 §8.2）：

1. 实现 per-trace queue（默认串行）作为安全底
2. benchmark：1 / 2 / 4 并发查询 × 5 / 10 / 15 agent run × 大 / 中 / 小 trace
3. 根据结果决定：全局串行 / per-trace 串行+per-lease 并发 / per-trace 并发
4. 写到 capability registry，后续可动态调整

### 4.3 SSE 浏览器鉴权方案锚定 fetch-stream【P0】

由于前端实际是 `fetch + ReadableStream`（详见 §2.2），鉴权方案应：

- **主路径**：`Authorization: Bearer <token>` header
  - 浏览器：SSO session token（短期 access token，定期刷新）
  - CLI / Server-to-Server：企业 API key
- **重连**：自实现 `Last-Event-ID` 协议
  - 服务端 SSE 每个 event 带 `id: <自增 cursor>`
  - 客户端断线后用 `Last-Event-ID` header 续读
  - 后端从 `agent_events` 表 cursor 后开始推
- **不**走 httpOnly cookie 路线（虽然作为补充也可，但 fetch-stream 下不必要）

### 4.4 大 trace 文件路径【P1】

- 当前上传限制 500MB（`simpleTraceRoutes.ts:16`）
- URL 上传会先 `arrayBuffer()` 全量进内存——这是**当前 bug**，GB 级会 OOM
- `trace_processor_shell` 需要本地文件路径，**不**支持从 stream / object store 直接读

→ 即使未来加对象存储，路径也必须是：

```
upload   → stream to local fs (chunked) → metadata in DB
analyze  → worker 从 local fs 直接读
（如果未来切对象存储）→ stream from object store to worker local cache → 再交给 trace_processor
```

不能在文档里暗示"trace_processor 直接 stream from object store"——SQL 引擎不支持。

→ **修正第 8.1 trace 生命周期图**：fetch trace object → write to worker local cache → trace_processor open local file。

### 4.5 scoped cleanup 必须有生命周期保护【P0】

第 8.2 改"全局 cleanup → scoped cleanup"方向对，但必须加保护规则。当前代码（Codex 实测）：

- 全局 cleanup 能清 trace_processor
- session cleanup 对**无 SSE 的 running/pending session 仍然回收**——这是 bug 来源之一

**建议补"资源生命周期保护规则"小节**（新增到 §8.3 之后）：

```
保护规则：
1. running run 不可被任何 cleanup 删除
2. active TraceProcessorLease 不可被任何 cleanup 删除
3. 正在生成 report 的 artifact 不可被任何 cleanup 删除
4. 上述资源持有方必须发 heartbeat（默认每 30s）
5. heartbeat 超时（默认 5 min）才视为 stale 可清

删除流程：
- 删除 tenant/workspace/trace 必须先 draining：
  a. 拒绝新 run
  b. 等 running run 结束 / 显式 cancel
  c. 等 active lease 释放 / 显式 evict
  d. 再执行实删（tombstone + async purge）
- 整个 draining 期间发 audit event
```

### 4.6 第 18 节验收标准的并发数字与目标不符【P1】

第 18 节第 10 条写"压测覆盖至少 50 个并发用户、100 个并发 analysis run"——和目标"30-50 在线、5-15 并发分析"不一致。

→ **改为**：

> 压测覆盖：50 在线用户 / 同时 5-15 个 running run / 排队若干 pending run / 几千个 trace 元数据 / 几百次/天 LLM 调用，记录 p50/p95 延迟、错误率、worker 利用率和 LLM 成本。

### 4.7 数据迁移单向性【P0】

第 16.2 dry-run 提了但回滚不真实。建议改写：

```
迁移阶段：
P-A 双写：旧 JSON 仍是权威 + 新 DB 同步写（读仍走 JSON）
       期：1 个版本（约 4-6 周）
       回滚：删 DB，恢复纯 JSON

P-B 切读：DB 是权威，旧 JSON 进入只读模式
       期：1 个版本（约 4-6 周）
       回滚：切回 P-A（DB 数据保留，读切回 JSON）

P-C 退役：删除旧 JSON 写入路径，DB 唯一权威
       期：永久
       回滚：仅靠迁移前 filesystem snapshot + DB snapshot restore；不承诺可靠从 DB 反向转回 JSON

迁移前必备：
- filesystem snapshot（整机 / 关键目录）
- DB snapshot（pg_dump / sqlite copy）
- audit log 记录迁移开始时间 + 数据指纹
```

不要承诺"迁移后可以从 DB 转回 JSON"——这不现实。

---

## 5. 遗漏风险补全

### 5.1 Legacy AI 路径处置【P0】

代码里仍存活的 legacy AI 入口（除 agentv2 外）：

| 入口 | 文件 | 当前状态 | 处置选项 |
|---|---|---|---|
| `/api/agent/v1/llm` DeepSeek proxy | `agentRoutes.ts` | 无 RequestContext | 废弃 / 接入 |
| `/api/advanced-ai` | `advancedAIRoutes.ts` | in-memory OpenAI sessions | 废弃（推荐）|
| `/api/auto-analysis` | `autoAnalysis.ts` | 无 RequestContext | 废弃 |
| `/api/agent/v1/aiChat` | `aiChatRoutes.ts` | 无 ProviderSnapshot | 接入 ProviderSnapshot |
| `agent/core/ModelRouter` DeepSeek 路径 | `agent/core/` | 全局配置 | 接入 ProviderSnapshot |

→ **修正第 21 节代码触点**：列入所有 legacy 入口，每条标注处置策略。**推荐**：v1 全部废弃（企业模式下 route 直接 `404`），减少 surface area。

### 5.2 Skill 多租户化【P0】

100 人企业版的常见需求：上传私有 skill。两条路必须二选一明示：

**路 A：v1 禁止 custom skill（推荐）**
- 关闭 `skillAdminRoutes.ts` 的写 endpoint
- 修复 loader 闭环（清 dead `backend/skills/custom/` admin 写路径）
- 优势：范围可控；SQL 安全 / 版本管理 / 审计 / 优先级 / 跨租户冲突一律不用做

**路 B：workspace-scoped skill registry**
- skill 元数据加 `tenantId / workspaceId / scope / visibility / version`
- loader 加载 system + workspace 私有 skill
- 上传时 SQL 安全扫描（拒绝 DROP / DELETE / 跨表恶意查询）
- 版本管理 + 回滚
- 调用审计

→ 推荐路 A 作为 v1，路 B 作为后续 feature。**文档必须明示选择**，不要含糊。

### 5.3 配额超额的退化策略【P1】

文档 §8.3 提了"queued/backpressure"但没说具体策略：

| 触发条件 | 退化行为 |
|---|---|
| Tenant/workspace 并发 cap 触顶 | 排队 pending + 显示队列位置；不自动降级 |
| 单 run cost cap（LLM 预算）触顶 | 当前 turn 完成后输出 partial conclusion + `quota_exceeded` 终态；**不**自动降级 fast mode |
| Tenant 月度预算触顶 | preflight admission 拒绝新 run；running run 完成后停发；管理员加额度恢复 |
| Fast/Full mode 自动降级 | 仅 run 开始前根据策略（用户选 auto + 当前剩余预算 < 阈值）；run 中途**禁止**降级 |
| Trace processor worker pool 满 | 排队 pending；worker heartbeat 超时才回收 |

→ **第 8.3 加这个表格**。

### 5.4 数据可携带性 / GDPR 删除【P1】

100 人企业版必须支持：

**Tenant export bundle**（一键打包）：
- trace manifest（不包括 trace 文件本身，太大；提供 signed URL 列表 + 7 天有效期）
- reports（HTML + JSON）
- sessions / runs / turns
- memory / case / baseline 私有数据
- audit 子集
- provider metadata（**去除 secrets**）
- 全包 SHA256 checksum + tenant identity proof

**Tenant 删除流程**：
- tombstone：DB 立即标删，保留 7 天硬删窗口（防误操作）
- async purge：后台 job 清对象 / cache / DB 实记
- audit proof：删除完成后输出审计证明（删除时间 / 操作者 / 数据指纹 hash）

→ 第 6 章领域模型加 `TenantTombstone` 实体；第 11.3 审计加 export / purge 事件类型。

### 5.5 Onboarding 流程【P1】

文档没有 user journey。100 人企业版必须有：

```
首次访问 → 检测 SSO session
   ↓ 无 session
SSO 跳转（OIDC IdP）
   ↓ 回调 + claims
创建/匹配 UserIdentity
   ↓
解析 tenant：
  a. 按邮箱域（@company.com → tenant lookup）
  b. SSO claim（idp 直接传 tenant id）
  c. 显式邀请 token
  d. 都失败 → 跳"join tenant"页面
   ↓
解析 workspace 列表（按 membership）
   ↓
workspace selection：
  a. 单 workspace 自动进入
  b. 多 workspace 显示选择
  c. 默认 workspace 偏好（localStorage）
  d. 无 workspace → 提示联系管理员
   ↓
provider scope 选择（可选）
   ↓
进入主界面（trace 列表）
```

→ 新增 §15 "Onboarding flow"（插在分阶段计划之前）。

### 5.6 兼容期"两套权限模型"的清退 timeline【P1】

第 17.2 提了风险但没给清退方案。建议：

```
v1.0 (GA)：所有旧 API 强制经 RequestContext 包装层 + owner guard
           旧端点保留可用，记 deprecation telemetry header
           response 返回 `Deprecation: true` + `Sunset: <date>`

v1.1 (3 个月后)：旧端点回 410 Gone
              强制走新 workspace-scoped path
              telemetry 报告 < 5% 残留调用才允许 sunset
```

→ 第 12.2 加 deprecation timeline 表。

### 5.7 ScreenSnapshot 之外的隐性全局状态【P1】

Codex 提示当前还有几处全局/进程内状态需在文档触点列入：

- `analysisPatternMemory` 全局文件
- `ragVectorStore` 全局
- `caseLibrary / caseGraph` 全局
- `baselineStore` 全局
- `mcpToolRegistry` 全局工具注册（按 tenant 是否需要不同工具集？）

→ 第 21 节代码触点应补这几个。多数可以跟 memory 一样按 `workspaceId` 过滤；少数（mcpToolRegistry）需要决定是按 tenant 隔离还是全局共享。

---

## 6. 必改清单（按优先级）

### P0（必须改才能动工）

1. **修复事实错误**：
   - agent routes 鉴权状态（§3.2 表格）
   - 前端 SSE 实现是 fetch-stream（§9.3）
   - Skill 数量 126/33/33/18/8（§1 + `CLAUDE.md`）
   - Custom skill loader 闭环说明（§5.2）
   - prepareSession 只比 providerId 的 bug 写到 §9.2
2. **第 5.1 架构图重画 100 人版**，删除 6 个 SaaS 组件
3. **第 13 节存储方案合并**为单档位（SQLite/PG + 本地 fs + encrypted secrets + 进程内 queue）
4. **第 14.3 HA 部署移到附录**
5. **第 15 节 P0-P6 重组**为 4 条并行主线（A 身份 / B 存储 / C 运行时 / D 控制面）
6. **ProviderSnapshot per-session 不变量**写清（§9.2 + §10.1）
7. **SSE 鉴权锚定 fetch-stream Bearer**（§7.2 + §9.3）
8. **scoped cleanup 加 ref-count + heartbeat + draining 三道闸门**（§8.2 + §8.3 之后新增小节）
9. **Legacy AI 路径处置**（§21 完整列表 + 推荐 v1 废弃）
10. **Skill 多租户化路 A/B 选择**（推荐路 A，新增章节）
11. **数据迁移改双写双阶段**（§16.2 重写）

### P1（应改但不阻塞 P0）

1. trace_processor SQL benchmark 路径写明（§8.2）
2. 大 trace 文件 materialize 路径（§8.1 trace 生命周期图）
3. 配额超额退化策略表（§8.3）
4. 数据可携带性 + GDPR 删除（§11 + 领域模型加 `TenantTombstone`）
5. Onboarding 流程（新增 §15）
6. 兼容期 deprecation timeline（§12.2）
7. 第 18 节验收数字校正（5-15 running 而非 100 concurrent）
8. 隐性全局状态（pattern memory / RAG / case / baseline / mcpToolRegistry）补入触点（§21）

### P2（可考虑改）

1. 接口 abstraction 预留（`ObjectStore / SecretStore / EventStream / JobQueue`），不实现，只为日后 HA 留口
2. Capability registry 暴露 trace_processor 并发能力，后续动态调整
3. 审计日志 retention 默认值（建议 90 天 / 1 年 / 7 年三档）
4. 第 8.3 队列按 tenant / workspace / trace lease / run / report / cleanup 五类分别设计粒度（当前文档列了表但没给参数）

---

## 7. 总结

这份方案的判断方向是对的，缺的不是架构能力，而是**尺度感**。把 SaaS 多租户平台的标准配置全套搬来，在 100 人规模下变成沉重工程债。

核心调整：
1. **降级**：砍掉 SSE Gateway / Redis / Object Storage / Vault / 多 pod / HA Postgres 等 6 个 SaaS 组件
2. **合并**：存储方案合为 SQLite/PG + 本地 fs + encrypted secrets 单档位
3. **重组**：P0-P6 线性阶段 → 4 条并行主线（身份 / 存储 / 运行时 / 控制面）
4. **修事实**：先修 agent route 鉴权状态、前端 SSE 实现、Skill 数量、prepareSession bug、custom skill loader 闭环这 5 项事实错误，再讨论建议
5. **填关键不变量**：ProviderSnapshot per-session / SSE 鉴权 / scoped cleanup 保护 / Legacy 处置 / Skill 多租户化路 A/B 选择是 P0 必填

修完上述 P0 + P1，文档才能作为可执行的工程蓝图进入实施。

---

## 8. Codex review-of-review 修正记录（双窗口 bug 诊断追溯）

本节是用户提出"当前是否支持双窗口同时分析两个 trace"的具体痛点后，Claude 第一轮诊断 → Codex 第二轮独立审查 → 反驳并修正的成果。属于"运行时隔离"主线 C 的具体落地依据。

### 8.1 用户报告的现象

单浏览器开两个窗口同时分析两个不同 trace。第一个窗口正常；第二个窗口打开时，**第一个窗口前端报"AI 后端连接已断开"**。重启 backend 后单窗口正常，双窗口并发翻车。

### 8.2 Claude 第一轮诊断的错误（Codex 直接反驳）

| Claude 第一轮判断 | Codex 取证反驳 | 结论 |
|---|---|---|
| 嫌疑 2：`POST /api/traces/cleanup` 被 backend 内部触发 | `cleanupOldAndIdleTraces` 要求 `uploadAge > 2h 且 idle > 30min`（`traceProcessorService.ts:546-586`），且明确不调 Factory.cleanup()；前端没调 `/api/traces/cleanup` | **撤回** |
| 嫌疑 3：`trace_processor_shell` C++ 多实例并发 race | `perfetto/src/trace_processor/shell/server_subcommand.cc:102-150` 每进程独立 TraceProcessor 和 Rpc，没有跨进程 lock/WAL/signal 共享 | **降级"待证假设"** |
| Quick fix Step 2：`Date.now() - p.createdAt > 60_000` | `WorkingTraceProcessor` 当前**没有** `createdAt` 字段；60s 时窗也挡不住"长 SQL 中第二窗口上传"场景 | **改写**（先加字段，且改为 active session 保护） |
| 主线 C "TraceProcessorLease + ref-count 能彻底解决嫌疑 1/2" | lease 必须**同时**覆盖 4 类 owner（frontend HTTP_RPC / backend agent run / report generation / manual register-rpc），少一类都不解决；且 lease 自身会引入"泄漏永不回收"的新 bug | **改写不变量**（见 §8.5） |

### 8.3 Codex 找到的 P0 真凶（Claude 完全漏掉）

#### P0 真凶 A：查询超时无条件自杀 trace_processor

`workingTraceProcessor.ts:425-434`：

```typescript
const timeoutId = setTimeout(() => {
  console.error(`Query exceeded ${queryTimeoutMs}ms; destroying processor`);
  req?.destroy();
  this.destroy();   // ← 直接杀掉整个 trace_processor
}, traceProcessorConfig.queryTimeoutMs);  // 默认 60s
```

**这才是"重启 backend 后双窗口必现"的最强解释**：第二个窗口上传/解析 trace 时 backend Node.js 进程 CPU/IO 吃紧 → 第一个 trace 的 SQL 被拖到 60s wall-clock 超时 → backend 主动 `destroy()` 第一个 processor → 窗口 A 下次发 SQL 收到 connection refused → 前端断开。

不需要 5 个残留 processor，不需要 cleanup endpoint 被触发——单纯 wall-clock 超时就足以引爆。

#### P0 真凶 B：单 trace 内 fire-and-forget stdlib loader 与用户 SQL 自并发

`workingTraceProcessor.ts:345-365`：第一次 `query()` 会 fire-and-forget 启动 critical stdlib loader，**然后立刻执行用户 SQL**——两个并发请求打同一个单线程 trace_processor_shell。

代码注释自己承认（`workingTraceProcessor.ts:210-212`）：单线程 trace_processor 被并发请求压住会 socket hang up。

这意味着即使在单窗口场景，第一次查询也可能因为这个自并发翻车。双窗口场景下两个 trace 的 fire-and-forget 一起跑，雪上加霜。

### 8.4 Codex 补充的 P1 漏点

| P1 漏点 | 代码位置 | 后果 |
|---|---|---|
| `ExternalRpcProcessor.activeQueries` 永远是 0 | `workingTraceProcessor.ts:814-848` | 前端通过 HTTP_RPC 直接打的查询不计入 activeQueries → 前端正在用的 trace 在 backend LRU 视角下永远是 idle → LRU 一旦触发**必然**杀活跃前端 |
| `createFromExternalRpc` 不去重 | `workingTraceProcessor.ts:791-806` | 每次 register-rpc 都塞新 wrapper，几次窗口刷新后 size 推到 5 → 触发 LRU |
| `smartperfetto-pending-backend-trace` 全局 localStorage key | `types.ts:487-491` | 第二个 tab 覆盖第一个 tab 的 pending state → 第一 tab 刷新后 recover 失败 → 重复 register-rpc → 加重 wrapper 泄漏 |
| `smartperfetto-ai-sessions` 全量 read-modify-write 没锁 | `session_manager.ts:221-271` | 两个 tab 同时保存 session 互相覆盖 |

### 8.5 修正后的双窗口诊断优先级

| 优先级 | 根因 | 代码位置 |
|---|---|---|
| **P0** | 查询超时无条件 destroy() 前端 owned processor | `workingTraceProcessor.ts:425-434` |
| **P0** | 单 trace 内 fire-and-forget stdlib loader 自并发 | `workingTraceProcessor.ts:345-365`, 210-212 |
| P1 | ExternalRpcProcessor.activeQueries 永远 0 → LRU 必杀活跃前端 | `workingTraceProcessor.ts:814-848` |
| P1 | createFromExternalRpc 不去重 → wrapper 泄漏 → 推 size 到 5 | `workingTraceProcessor.ts:791-806` |
| P1 | LRU eviction 触发条件（依赖前面 P1） | `workingTraceProcessor.ts:693-705` |
| P1 | localStorage pending-backend-trace 全局 key 跨 tab 覆盖 | `types.ts:487-491` |
| P2 | localStorage smartperfetto-ai-sessions 全量覆盖无锁 | `session_manager.ts:221-271` |
| ~~原嫌疑 2~~ | 撤回（cleanup endpoint 不会被自动触发） | - |
| ~~原嫌疑 3~~ | 降级"待证假设"（perfetto 上游无证据） | - |

### 8.6 Quick Fix 路径（Codex 推荐版）

#### 必做（P0）

1. **`executeHttpQuery` 超时改策略**：超时只 abort 当前 req，**不**无条件 destroy() 共享给前端的 processor；区分 backend-owned query 和 frontend-visible HTTP_RPC lease——前者超时杀进程 OK，后者只 abort 当前请求；连续多次超时再考虑 destroy
2. **消除 fire-and-forget 自并发**：所有 HTTP `/query` 串进 per-processor mutex，或等 stdlib loader done 再让用户 SQL 进
3. **`createFromExternalRpc` 按 port 去重**：已有 wrapper 的端口直接复用

#### 应做（P1）

4. **LRU eviction 加 owner-aware 保护**：`ExternalRpcProcessor` 不参与 LRU 或加单独配额；不能因为 `activeQueries=0` 就被清；同时给 `WorkingTraceProcessor` 加 `createdAt` 字段，`age < 60s` 不清作为兜底
5. **`smartperfetto-pending-backend-trace` 改 per-window 隔离**：用 sessionStorage 或 key 加 windowId namespace
6. **session_manager 全量覆盖加 mtime 锁**：read 时记 lastModified、write 时 CAS，冲突时合并而非覆盖

#### 加固（不解决根因，仅减少误炸面）

7. 禁用/admin-only `POST /api/traces/cleanup`（只是安全加固，前端不依赖）
8. 双窗口 e2e 测试矩阵：
   - 干净 backend 双窗口（基线）
   - 已有 5 个 processor/wrapper 后再上传（LRU 边缘）
   - 第一窗口长 SQL 运行中第二窗口上传（超时 race 场景）
   - 断言：第一窗口 PID/port 未变 + SSE 不断 + UI 不出现断开 banner

### 8.7 修正后的"方案能不能解决"判断

| 嫌疑 | 主线 C 设计的对应改造 | 修正后判断 |
|---|---|---|
| **P0 查询超时自杀** | lease 设计**额外加规则**："timeout 只 abort query，不 destroy frontend-owned lease" | 不加这条**不解决**；加了 LGTM |
| **P0 单 trace 自并发** | per-trace queue 默认串行 | **LGTM** |
| **P1 LRU + activeQueries=0** | ref-count 必须把 frontend HTTP_RPC 也算 ref | 只算 backend agent run **不解决** |
| **P1 register-rpc 泄漏** | lease 按 owner 去重 | **LGTM** |
| **P1 localStorage 跨 tab** | 主线 A 前端状态 namespace **再加 windowId** | 不加 windowId **不解决** |
| **P2 perfetto 上游 race** | 待证假设 | 先做完上面 6 条复现验证再说 |

### 8.8 方案需要新增的不变量（直接补到 README.md 主文档 §8）

1. **TraceProcessorLease 必须覆盖 4 类 owner**：frontend HTTP_RPC、backend agent run、report generation、manual register-rpc。少一类都不解决双窗口 bug
2. **lease 必须配 4 件套防泄漏**：TTL heartbeat（默认 30s）+ stale lease reaper（5 min 无心跳清）+ 强制上限（per-trace ≤ N）+ 可观测 stats endpoint
3. **timeout 不杀 frontend-owned lease 的硬规则**：query timeout 只 abort 当前 req；连续 3 次 timeout 才考虑降级 lease 状态
4. **全局 load 限流**：同时加载大 trace ≤ 1 个、active processors 2-5 个、超过排队（per-trace queue 不够覆盖多 trace 资源竞争）
5. **前端状态 namespace 必须含 windowId**：`tenantId:userId:workspaceId:windowId`，否则双窗口 localStorage 互相覆盖
6. **register-rpc 按 port 去重**：相同 port 的 ExternalRpcProcessor 复用，不创建新 wrapper

### 8.9 Codex 第二轮 session id

`019e05ac-0fbd-7db1-bd23-17605c7a35c4`（同第一轮，resume 复用上下文）

### 8.10 代码取证细节（后续动手的精确蓝图）

读完 `backend/src/services/workingTraceProcessor.ts`（940 行）后确认的精确事实，作为后续真正动手 patch 时的最小改动集。这一节是"知道精确在哪里改、改多少行"的预算单。

#### 实证 1：`ExternalRpcProcessor.activeQueries` 从未递增

- 定义：`workingTraceProcessor.ts:818` —— `public activeQueries = 0;`
- 全文 `grep activeQueries` 共 8 处：
  - line 148/156/360/374/402 都是 `WorkingTraceProcessor._activeQueries` 的私有读写
  - line 695 是 LRU eviction 读取
  - line 818 是 `ExternalRpcProcessor` 的初始化（公有字段）
- **没有任何地方递增 ExternalRpcProcessor.activeQueries**
- 后果：前端通过 HTTP_RPC 直接打的查询不计入此字段 → ExternalRpc wrapper 在 LRU 视角下永远 idle → line 695 `find(([, p]) => p.activeQueries === 0)` 必然命中
- 修复锚点：(a) 给 `ExternalRpcProcessor` 加 `query()` 包装，在 `_execRaw` 前后递增/递减 `activeQueries`；或 (b) 在 LRU 处按 `instanceof ExternalRpcProcessor` 跳过

#### 实证 2：fire-and-forget stdlib loader 双发位置

| 类 | 行号 | 代码 |
|---|---|---|
| `WorkingTraceProcessor` | 354 | `this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();`（**无 await**） |
| `ExternalRpcProcessor` | 845 | 相同模式，**无 await** |

紧接着：
- WorkingTraceProcessor line 360-362 立即 `executeHttpQuery(sql)`
- ExternalRpcProcessor line 848 立即 `return this._execRaw(sql);`

两个 HTTP 请求并发打**单线程** trace_processor_shell。代码自己注释（line 210-212）已承认这种竞争会让大 trace（200MB+）socket hang up。

修复锚点：在 `query()` 入口加：

```typescript
if (this._criticalModulesLoadPromise) {
  await this._criticalModulesLoadPromise;
}
```

或在 `_execRaw` / `executeHttpQuery` 外面加 per-processor mutex（更彻底）。

#### 实证 3：`createFromExternalRpc` 按 traceId 而非 port 作 Map key

`workingTraceProcessor.ts:805`：

```typescript
this.processors.set(traceId, processor as any);
```

后果分两种：
- **同 traceId 多次 register-rpc** → set 会**覆盖**前一个 wrapper（GC 回收，不泄漏 size）
- **不同 traceId 但同一个 port**（譬如双窗口 backend 复用端口的边缘 case）→ 塞**两个**指向同一端口的 wrapper → size 累加 → 触发 LRU

修复锚点：在 set 之前先按 port 反查现有 wrapper：

```typescript
for (const [existingTraceId, p] of this.processors) {
  if (p instanceof ExternalRpcProcessor && p.httpPort === port) {
    return p as ExternalRpcProcessor;  // 复用
  }
}
```

或维护 `port → processor` 反向 index。

#### 实证 4：`destroy()` 路径会释放端口

`workingTraceProcessor.ts:610-667`：

- 调 `getPortPool().release(this.traceId)`
- 通过 `proc.once('close', ...)` 在子进程退出后释放（line 644-647）
- killTimer 兜底（line 630-640）

副作用：timeout 触发的 `destroy()` 会把端口释放回 pool。第二个 trace 启动时可能立刻拿到刚释放的端口——日志会混淆排查（看上去像"端口冲突"但实际是端口复用）。

修复锚点：timeout 改为只 abort req 后，`destroy()` 仍可保留作为"连续 N 次 timeout 才触发"的兜底。不需要动 destroy() 本体，只动 timeout 触发器。

#### 实证 5：background preload 已被移除但没移彻底

`workingTraceProcessor.ts:210-212` 注释：

> Background preload was removed because it competes with Agent queries for the single-threaded trace_processor_shell, causing socket hang ups on large traces (200MB+).

但 fire-and-forget critical stdlib loader（实证 2）**和它本质是同一类问题**——只是从 22 个 modules 缩到 3 个 critical modules、并且改成 sequential 一次一个。

修复方向是对的，但**没移彻底**——critical modules 仍在 fire-and-forget 模式。修复锚点同实证 2。

#### 实证 6：`maxProcessors = 5` 默认且未走 config

`workingTraceProcessor.ts:675`：

```typescript
private static maxProcessors = 5;
```

- 没有从 `traceProcessorConfig` / env 读取
- 双 trace 场景下 size=2 远低于 5
- **LRU 在干净 backend + 双 trace 时不会触发**（前提：register-rpc 不重复，实证 3）
- 但只要 1 次同 port 重复（实证 3 触发），size 就累加

修复锚点：实证 3 修了之后此处不必动；可顺手把 `5` 改为从 config 读，便于运维调高。

#### 实证 7：`executeHttpQuery` wallClockTimer 真正杀进程

`workingTraceProcessor.ts:425-440`：

```typescript
wallClockTimer = setTimeout(() => {
  logger.warn('TraceProcessor', `Query exceeded ${queryTimeoutMs}ms; destroying processor ${this.id}`);
  req?.destroy();
  this.destroy();   // ← P0 真凶：杀整个 processor
  finish({...error: 'Query timeout'});
}, traceProcessorConfig.queryTimeoutMs);
```

修复锚点：

```typescript
wallClockTimer = setTimeout(() => {
  logger.warn(...);
  req?.destroy();
  this._consecutiveTimeouts = (this._consecutiveTimeouts ?? 0) + 1;
  if (this._consecutiveTimeouts >= 3) {
    this.destroy();  // 连续 3 次超时才真杀
  }
  finish({...error: 'Query timeout'});
}, traceProcessorConfig.queryTimeoutMs);
```

成功的 query 在 finish 处重置 `_consecutiveTimeouts = 0`。这样单次慢 SQL 不会断前端，但 trace_processor 真挂死时仍然能被回收。

#### 实证 8：完整 P0/P1 修复最小改动文件清单

| 修复 | 文件 | 行号 | 改动量 |
|---|---|---|---|
| **P0-A** timeout 不杀 lease（实证 7）| `workingTraceProcessor.ts` | 425-440 + 加 `_consecutiveTimeouts` 字段 | ~15 行 |
| **P0-B** stdlib loader 串 mutex（实证 2/5）| `workingTraceProcessor.ts` | 345-365, 840-848 | ~10 行（加 await） |
| **P0-C** `createFromExternalRpc` 按 port 去重（实证 3）| `workingTraceProcessor.ts` | 791-807 | ~15 行 |
| **P1-A** LRU 跳过 `ExternalRpcProcessor`（实证 1）| `workingTraceProcessor.ts` | 692-705 | ~5 行 |
| **P1-B** `WorkingTraceProcessor` 加 `createdAt` 字段（兜底）| `workingTraceProcessor.ts` | 132-167 + LRU 处 | ~5 行 |
| **P1-C** `ExternalRpcProcessor.query()` 包装 `activeQueries`（实证 1 替代方案）| `workingTraceProcessor.ts` | 840-849 | ~10 行 |
| **P1-D** `smartperfetto-pending-backend-trace` 加 windowId namespace | `types.ts` + `ai_panel.ts` 写入点 | 487-491 + 调用方 | ~10 行 |
| **P1-E** `session_manager` 加 mtime 锁 | `session_manager.ts` | 221-271 | ~20 行 |

**合计约 90 行改动**，**P0 部分集中在一个 backend 文件**（约 40 行），可作为主线 C 的第一个 PR。前端 P1-D/E 各自独立，可作为后续 PR。

#### 实证 9：`workingTraceProcessor.ts` 是巨石文件，应只动锚点不重构

940 行承担 5 类职责：
1. `getTraceProcessorPath` / `killOrphanProcessors`（启动期工具）
2. `WorkingTraceProcessor` 启动子进程 + HTTP query
3. `WorkingTraceProcessor` stdlib 预加载
4. `TraceProcessorFactory` LRU eviction
5. `ExternalRpcProcessor` external RPC wrapper

主线 C 真正动手时建议：
- **第一波（P0/P1 fix）**：只在锚点改最小集，不动结构
- **第二波（lease 重写）**：把 5 类职责拆成 3 个文件——`traceProcessorWorker.ts`（启动+query）/ `traceProcessorLeaseManager.ts`（lease+ref-count+heartbeat+LRU）/ `externalRpcWrapper.ts`（external RPC）；这才是 review §3.4 主线 C 的完整落地

不要在第一波里做第二波的事——会把 P0 修复延期到第二波完成。

#### 实证 10：项目 CLAUDE.md 强制测试约束

后续真正动手时，按 `CLAUDE.md` 的"Verification table"：

- 此次改动属于 "Touches mcp / memory / report / agent runtime" 类（trace_processor 是 agent runtime 核心依赖）
- Done condition：`cd backend && npm run test:scene-trace-regression` 必须通过 6 个 canonical traces
- 改 trace_processor 后还应跑双窗口 e2e（review §8.6 加固 #8 的测试矩阵）—— 这个目前没有现成脚本，需要 `verifyAgentSseScrolling.ts` 改并发版

PR 落地前必须 `npm run verify:pr` 通过。

---

## 9. 最优解 v2：trace_processor 资源模型设计（设计 1 修正版）

### 9.1 背景

用户明确放弃 hotfix 路径，要求一步到位的最优解，并提议"每个 worker 持有自己的 trace_processor，互相不影响"。Claude 第一轮给的"设计 1"（每 trace 一个独立 processor + maxProcessors=20 全局上限）只是把 LRU 换成 quota，**没有真正解决"什么是合适的资源粒度"的根本问题**。

本节是修正后的最优解，对应原 README.md §8 "Trace 与 trace_processor 架构"的全面替换提案。

### 9.2 设计 1 的 6 个问题（必须修正）

| # | 问题 | 后果 |
|---|---|---|
| 1 | 进程数硬顶（`total_quota: 20`）是**伪资源限制**——不对应任何物理量 | 全大 trace 会 OOM；全小 trace 会浪费容量；同样"1 个进程"代价相差 10 倍 |
| 2 | 没说清"同一 trace 多个 holder"的共享语义 | 100 人企业常见多用户共享 trace；配合 mutex 串行后用户 B 会等用户 A agent run 跑完几分钟 |
| 3 | trace 启动时间损失（5-15s）没纳入考虑 | 超过 quota 排队可能让用户"上传完一直转圈" |
| 4 | 所有子进程跑在 backend 主进程下，CPU 互相挤压 | 主进程 CPU 满 → 双窗口 bug 真凶 A "60s timeout" 触发的根本机制 |
| 5 | query 没有优先级 | 前端即兴查询（< 100ms）和 agent run 长查询（数秒）混队，短查询体验差 |
| 6 | trace_processor crash 后无 fail-over 设计 | C++ 二进制会 crash，agent run / 前端会话需要明确恢复策略 |

### 9.3 修正后的 6 条不变量

#### 不变量 1：quota 按 RAM 而非进程数

```yaml
trace_processor:
  total_memory_budget_pct: 70           # 用 70% 物理 RAM
  per_lease_memory_estimator:
    estimate: trace_file_size × 1.5     # 经验系数（待 benchmark 校准）
    cap_min: 200 MB                      # 即使空 trace 也保底
    cap_max: 8 GB                        # 单 trace 不超过此（更大要拆）
  warn_at_pct: 80
  reject_at_pct: 95
```

acquire 时检查：`sum(estimated_memory) + new_estimate <= budget`。这才是物理资源的真实门槛。

**待校准**：`trace_file_size × 1.5` 是经验值，需要在 6 个 canonical traces 上 benchmark 得到 SmartPerfetto 实际系数。

#### 不变量 2：明确共享语义 + isolated 逃生口

```
默认共享模式（per-trace 一个 processor）:
  同一 trace_id → 同一 lease → 同一 processor
  N 个 holder（agent run / frontend HTTP_RPC / report generation / register-rpc）共享
  内部 mutex 串行（不变量 4 优先级队列规则下）

逃生口（per-lease isolation flag, opt-in）:
  agent run 启动时可声明 isolated=true
  → 强制为该 run 启一个独立 processor（额外 RAM 配额）
  → 用例：长跑 report generation 不想被前端 timeline 打断
```

100 人规模下 95% 时间用共享模式（省 RAM），关键长任务用 isolated。

**默认值**：共享模式（节省 RAM 在 100 人规模下优先于响应延迟）。

#### 不变量 3：进程拓扑分层

```
┌──────────────────────────────────┐
│ Node.js backend 主进程            │
│  ├─ API / Express                 │
│  ├─ Agent runtime / SDK           │
│  └─ TraceProcessorSupervisor      │
│      （只做 lease 簿记，不查询）  │
└────────┬─────────────────────────┘
         │ IPC (HTTP localhost)
         ▼
┌──────────────────────────────────┐
│ trace_processor_shell 子进程 × N │
│  独立 OS process                  │
│  独立内存空间                     │
│  crash 不影响主进程               │
│  CPU 调度由 OS 决定               │
└──────────────────────────────────┘
```

**关键规则**：主进程**不参与** SQL 执行，只做 lease 簿记和 IPC 转发。这样 agent runtime 的 CPU 压力不会拖累 trace_processor_shell 响应——双窗口 bug 真凶 A 的触发条件消失。

待 Codex 验证：当前实现是不是已经这样（子进程 spawn + HTTP IPC），还是有其他耦合点导致主进程压力影响子进程响应。

#### 不变量 4：优先级队列取代 FIFO mutex

```typescript
class TraceProcessorWorker {
  private queue = new PriorityQueue<QueryTask>();

  async query(sql: string, priority: 'P0' | 'P1' | 'P2' = 'P1'): Promise<QueryResult> {
    return this.queue.enqueue({sql, priority, ...});
  }
}

// 优先级语义
P0: 前端即兴查询（timeline / 用户问答）— 短查询，预期 < 500ms
P1: Agent run 内 SQL — 中查询，< 10s
P2: Report generation / 大批量分析 — 长查询，可被 P0 排到后面

// 关键规则
- 当前正在执行的 query 不会被中断（perfetto 单线程不支持中断）
- 新进 P0 query 插队到下一个执行位（P1/P2 后排）
- P2 之间允许"切片让出"——跑 5s 后主动 yield 让 P0 进来
```

**待 Codex 验证**：trace_processor_shell 是否真的不支持中断当前查询？P2 切片让出在 perfetto 当前 HTTP RPC 协议下是否可实现？

#### 不变量 5：lease 状态机 + crash recovery

```
Lease state machine:
  pending → starting → ready → idle ⇄ active
                                ↓
                              draining → released
                                ↓
                              crashed → restarting → ready
                                          (自动重启 ≤ 3 次)

Lease 持有者类型（必须覆盖 4 类，少一类不解决双窗口 bug）:
  - frontend_http_rpc  { windowId, sessionId }
  - agent_run          { runId, sessionId }
  - report_generation  { reportId }
  - manual_register    { source }

Crash recovery:
  trace_processor_shell exit code != 0
    → lease.state = crashed
    → 通知所有 holder：raise QueryError('processor crashed')
    → 自动重启策略：≤ 3 次内自动 restarting
    → 超过 3 次 → lease.state = failed

Holder 行为:
  agent run     → 当前 turn 失败、提示用户重试
  frontend      → 显示"trace_processor 异常重启中" + 自动 reconnect
  report gen    → fail report、可重试

Lease lifecycle:
  ref_count == 0 → 启动 idle 定时器
  idle_ttl 内 ref_count > 0 → 取消定时器
  idle_ttl 到期 → 释放 processor + lease
  默认 idle_ttl: 30 min（待用户确认是否合适）

Heartbeat（保护 active lease 不被误清）:
  holder 持有 lease 期间每 30s 发 heartbeat
  60s 无 heartbeat → 该 holder 被视为 stale，从 holders set 移除
  stale reaper 周期：30s
```

#### 不变量 6：query timeout 与 processor health check 拆分

**用户硬性要求**：query timeout = 24 小时

**设计变更**：

```yaml
# 单次 SQL 的 wall-clock 上限（用户要求）
query_timeout_ms: 86400000   # 24 小时

# 独立机制：processor 健康检查
processor_health_check:
  ping_interval_ms: 60000    # 每 60s 跑一次 SELECT 1
  ping_timeout_ms: 10000     # ping 单次 10s 超时
  consecutive_failures_threshold: 3  # 连续 3 次失败才标 stale
  on_stale: 'restart_lease'  # 触发 lease 重启而不是杀 processor
```

#### 6.1 关于"放一会就连不上"的真根因议题（必须排查）

用户描述的现象"放了一会后端就连接不上"，**不一定是 query timeout 引起的**。可能根因清单：

| 候选根因 | 排查方法 | 修复方向 |
|---|---|---|
| query timeout=60s 杀 processor | backend log 是否出现 `Query exceeded ${queryTimeoutMs}ms; destroying processor` | 改 24h（用户已要求）|
| TraceProcessorService idle TTL 回收（uploadAge>2h 且 idle>30min） | log 是否出现 `Cleaning up X old and idle traces` | 改回收策略：有 active lease 的 trace 不回收 |
| HTTP keepalive 断开（主进程或子进程侧） | 抓包 / 看 `socket hang up` 错误 | keepalive 调长 / 重连 |
| trace_processor_shell 子进程被 OS / cgroup 杀（OOM、idle suspend） | `dmesg` / 子进程 exit code | OOM 改 quota，suspend 改 nice/affinity |
| 笔记本休眠 / 网络断开后未自动重连 | 系统是否进过 sleep | 前端检测网络恢复主动 reconnect |
| `cleanupOldAndIdleTraces` 误删 | log 是否出现 trace 删除事件 | 检查触发路径，已确认目前不会自动触发，但需复核 |

**结论**：24h query timeout 是用户的硬性要求，落地。但**真正的"放一会连不上"根因必须独立排查**——不能假设 24h 就解决了。Codex 应该 review 这个清单并质疑或补充。

### 9.4 完整架构图

```
┌────────────────────────────────────────────────────┐
│ Backend Main Process (Node.js)                     │
│                                                    │
│  API Layer (Express)                               │
│        │                                           │
│  Agent Runtime (SDK / OpenAI Agents)              │
│        │                                           │
│  TraceProcessorSupervisor                          │
│   ├─ LeaseManager                                  │
│   │   ├─ memory budget enforcement                 │
│   │   ├─ ref-count tracking                        │
│   │   ├─ heartbeat / stale reaper                  │
│   │   └─ crash recovery state machine              │
│   ├─ PriorityRouter                                │
│   │   └─ P0/P1/P2 query routing                    │
│   └─ ProcessSupervisor                             │
│       └─ spawn / monitor / restart child procs     │
└──────────────────┬─────────────────────────────────┘
                   │ IPC (HTTP localhost:9100-9900)
                   ▼
┌────────────────────────────────────────────────────┐
│ trace_processor_shell 子进程池                      │
│                                                    │
│  Process A → trace_alpha (lease, holders=[A1,B1]) │
│  Process B → trace_beta  (lease, holders=[B2])    │
│  Process C → trace_gamma (lease, holders=[A2])    │
│  ...                                               │
│  受 total_memory_budget 控制                       │
│  Idle 30min 后自然回收                             │
│  Crash 时自动重启（≤ 3 次）                         │
└────────────────────────────────────────────────────┘
```

### 9.5 双窗口 bug 覆盖度

| 双窗口 bug 根因 | 哪条不变量解决 |
|---|---|
| timeout 自杀 processor | 不变量 6（24h timeout + 独立 health check）|
| stdlib loader 自并发 | 不变量 4（priority queue + per-processor 串行）|
| ExternalRpcProcessor.activeQueries=0 | 不变量 5（lease ref-count 取代 LRU）|
| register-rpc 泄漏 | 不变量 5（lease 按 traceId 唯一 + holder set）|
| localStorage 跨 tab | §8.6 已写 windowId namespace（保留）|
| 主进程 CPU 压力拖慢子进程响应 | 不变量 3（进程拓扑分层）|
| trace_processor crash 无 fail-over | 不变量 5（state machine + 自动重启）|
| 长 agent run 阻塞前端短查询 | 不变量 4（priority queue P0 插队）|
| 用户报告"放一会连不上"的真根因 | 9.3 不变量 6.1（独立排查清单，**Codex 待 review**）|

9/9 全覆盖（前提：9.3 不变量 6.1 的真根因排查完成）。

### 9.6 待 Codex review 的关键质疑点

发给 Codex 的 review prompt 应聚焦：

1. **RAM 配额可行性**：`trace_file_size × 1.5` 系数对 SmartPerfetto 实际场景准不准？需要 benchmark 哪些 trace？
2. **优先级队列在单线程 perfetto 下可行性**：trace_processor_shell HTTP RPC 是否支持中断当前 query？P2 切片让出是否可实现？
3. **24h query timeout 是否治标**：用户报告"放一会连不上"是否真的因 60s timeout 引起？9.3 §6.1 的真根因清单是否完整？
4. **进程拓扑分层是否当前已有**：当前 `WorkingTraceProcessor` 是 spawn + HTTP IPC 模式，已经分层；还是有其他耦合让主进程压力影响子进程？
5. **crash recovery 自动重启 3 次**：是否合理？trace 文件大时重启需 5-15s × 3 次 = 45s 不可用，对前端 UX 影响怎么处理？
6. **共享 vs isolated 默认值**：100 人规模下默认共享是否对？isolated opt-in 的判定规则（哪些 run 应该 isolated）？
7. **idle_ttl=30min 是否合适**：用户笔记本休眠场景下，30min 后 lease 被回收，醒来 trace 消失——这是用户问题还是设计问题？
8. **memory budget 70%**：是否有更精确的 sizing 公式（考虑 Node.js 主进程占用 + OS 保留 + 突发）？

### 9.7 与原 README.md 主文档的关系

本 §9 是原 README.md §8 "Trace 与 trace_processor 架构"的**完整替换提案**。原 §8 的内容：
- §8.1 trace 生命周期：保留，但加 review §4.4 大文件 materialize 路径
- §8.2 TraceProcessorLease 状态机：被 §9.3 不变量 5 替换（增加 crashed/restarting 状态 + 4 类 holder 不变量）
- §8.3 查询调度与 backpressure：被 §9.3 不变量 1 + 不变量 4 替换（RAM quota + priority queue）

Codex review 通过后，本 §9 应直接合并入 README.md 主文档 §8，并把"设计演化"作为附录"设计决策记录"保留在 README-review.md。

---

## 10. Codex review §9 反馈与必修（v2 → v3 演化）

### 10.1 总评

> "§9 方向比第一版强，但**现在还不能称'最优解'**。最大问题是把几个尚未被代码证明的假设写成不变量：RSS 1.5x、P2 可切片让出、主进程不拖慢 TP、24h timeout 能解决'放一会断开'。这些目前都站不住。§9.5 的'9/9 全覆盖'结论过于乐观。"

§9 不能直接合并入 README.md 主文档，必须先吸收下面的修正进入 §11 v3。

### 10.2 Codex 取证发现的事实错误（必须先修）

#### 错 1：不变量 3 "主进程不参与 SQL 执行" **事实不准**

当前实现已经是 `spawn child_process + HTTP localhost`（`workingTraceProcessor.ts:188`），这部分**早就有了**。但 Node 主进程仍承担：
- 发 HTTP 请求 / 接完整响应 / `Buffer.concat` / decode（`workingTraceProcessor.ts:410`）
- timeout 维护
- agent tool 调度

第二个 trace 上传时，Node 主进程还要处理：
- 全量 buffer 上传文件
- 文件写入磁盘
- metadata query
- child process load 监控

**所以主进程 CPU 压力仍会拖慢"响应被读取/解析/返回"的路径**。§9 说"双窗口 timeout 触发条件消失"是过度承诺。

→ **必修**：§9 不变量 3 的措辞改为"独立 SQL worker / lease owner / 稳定代理端点 / backpressure / RSS 监控 / 不在 API 主事件循环里处理大结果"，不要写"主进程不参与"。

#### 错 2：HTTP RPC 不支持 cancel/abort，"P2 切片让出" **不可实现**

Codex 直接读 perfetto C++ 源码：
- 内部有 `InterruptQuery()`：`perfetto/src/trace_processor/trace_processor_impl.cc:956`
- 但**只在 stdio 模式 SIGINT 调用**：`perfetto/src/trace_processor/shell/server_subcommand.cc:118`
- HTTP `/query` 只暴露同步入口：`perfetto/src/trace_processor/rpc/httpd.cc:210`，**没有 per-query cancel/abort endpoint**

→ P0 插队**只能影响"还没 dispatch 的下一个 query"**，不能抢占正在跑的 SQL。如果当前 query 是 60s+，P0 必须等满。

→ **必修**：§9 不变量 4 改为 **non-preemptive priority queue**，明确"当前 query 不可中断"。把长 agent / report 拆成多个 bounded SQL step，让 P0 只在 step 边界插入；否则用 isolated processor。100 人规模下，**FIFO 或 non-preemptive priority + per-query timeout 更诚实**。

#### 错 3：1GB trace 资源模型与上传链路 **不一致**

不变量 1 讨论 1.5x RAM 配额、cap_max=8GB，但当前：
- 上传上限 500MB：`simpleTraceRoutes.ts:16`
- URL 上传会 `arrayBuffer()` 全量进 Node 内存：`simpleTraceRoutes.ts:216`

**讨论 1GB RSS 前，必须先做流式上传/落盘**，否则资源模型连入口都不成立。

→ **必修**：§9 增加"上传链路 stream 化"前置依赖，cap_max 在 stream 化完成前不能 > 500MB。

#### 错 4：ExternalRpcProcessor._execRaw 没有 timeout

24h timeout 配置只覆盖 `WorkingTraceProcessor.executeHttpQuery`。`ExternalRpcProcessor._execRaw()` (`workingTraceProcessor.ts:882`) **完全没 timeout**——前端通过 register-rpc 注册的 trace 路径上的查询永远不超时。

→ **必修**：§9 不变量 6 加一句"24h timeout 必须同时覆盖 WorkingTraceProcessor 和 ExternalRpcProcessor 两条路径"。

#### 错 5：浏览器直连 raw trace_processor port **与 lease 模型天然冲突**

Codex 指出的根本性问题：**只要前端拿的是裸 port `127.0.0.1:9100-9900`，lease manager 就很难隐藏 restart、迁移、隔离、限流**。

具体场景：
- crash recovery 重启 processor 后端口可能变 → 前端不知道 → 直连失败
- isolated 模式给 agent run 单独 processor → 前端用的是另一个 port → lease 视图分裂
- 限流 / 排队 → 前端绕过 backend 直接打 TP，限流不生效

→ **必修**：§9 必须显式决策："保留裸 port 接受脆弱生命周期" vs "backend proxy 或稳定端口复用"。100 人企业版应选**后者**——浏览器经 backend proxy 访问 trace_processor，不暴露裸 port。

### 10.3 P0 设计议题（按 Codex 意见修正）

#### P0-A: RAM 配额改"启动后实测 RSS"

不变量 1 的 `trace_file_size × 1.5` 没有代码或文档依据。当前代码也没有 child RSS 采集。

**修正方向**：
```
入场前用粗估值（e.g., trace_file_size × 1.5 或 max(200MB, ...)）作为 admission control
但 lease 实际占用按"启动后实测 RSS + peak buffer + query headroom"动态调整
benchmark 必须覆盖：
  - 场景：scroll / startup / anr / memory / heapprofd / vendor 大 trace
  - 大小：100MB / 500MB / 1GB
  - 链路：本地文件 vs URL 上传
  - 阶段：load peak vs steady RSS
```

#### P0-B: 优先级队列简化为 non-preemptive

不变量 4 改为：

```
non-preemptive priority queue:
  - 当前正在执行的 query 不可中断（perfetto 单线程限制）
  - 新进 P0 query 插队到下一个执行位（P1/P2 后排）
  - 取消"P2 切片让出"语义（HTTP RPC 不支持）

补偿机制（解决"P0 等长 query"问题）:
  - long-running SQL 必须在调用方拆分为 bounded step（per step < 5s）
  - 调用方在 step 边界主动让出（释放 mutex 让下一个 query 进入）
  - 关键长任务（report generation / heavy skill）走 isolated processor，不与前端交互查询共享
```

#### P0-C: 24h timeout 落地 + 独立 health check

用户硬要求 query timeout = 24h，落地。但配套必修：

```yaml
query_timeout_ms: 86400000  # 24h（用户要求）
                            # 必须同时覆盖 WorkingTraceProcessor 和 ExternalRpcProcessor

# 独立 health check（不能用 SELECT 1 走同一个 query 通道）
processor_health_check:
  liveness:                # 进程是否存活
    method: 'process.kill(pid, 0)'  # OS 层信号探测
    interval_ms: 30000
  rpc_accept:              # HTTP server 是否接受连接
    method: 'TCP connect to localhost:port'
    interval_ms: 30000
  query_responsive:        # 是否能跑短 SQL（独立 RPC connection，不入主队列）
    method: 'SELECT 1 on dedicated health channel'
    interval_ms: 60000
    timeout_ms: 10000
  consecutive_failures_threshold: 3
  on_stale: 'restart_lease_via_supervisor'
```

**关键**：不能用 SELECT 1 走主 query 通道——长 query 跑时 ping 排队会被误判 dead。

#### P0-D: "放一会连不上"真根因排序（Codex 修正）

Codex 修正了 §9.3 §6.1 的根因清单：

| 候选 | Codex 判断 | 修正 |
|---|---|---|
| query timeout 60s 杀 processor | 高嫌疑（**双窗口场景**主因）| 24h fix 落地 |
| TraceProcessorService idle TTL | **不是自动真凶**（需 upload age > 2h **且** idle > 30min，且非自动调用）| 撤回此条 |
| HTTP keepalive / websocket | 可能（浏览器直连 TP port 后**休眠再唤醒**特别典型）| 必查 |
| OS / cgroup kill | 可能但**当前无观测** | 需加 child RSS / exit reason 日志 |
| 笔记本休眠 | 可能（打断 websocket / SSE / heartbeat）| **"放一会"场景的最强嫌疑** |
| cleanupOldAndIdleTraces | **不是自动真凶**；但 `/api/traces/cleanup` 是悬崖 endpoint | 关闭悬崖（已在 §8.6 加固 #7）|

**Codex 最终判断**：
- **双窗口场景** → 优先怀疑 60s query timeout + 同 TP 内并发 / 排队 + Node wall-clock timeout 误杀
- **"放一会"场景** → 更像 websocket / 笔记本休眠 / child 被 OOM 杀，**不应直接归因 idle TTL**

→ **必修**：§9.3 §6.1 真根因清单按上面修正；24h timeout 不能假设解决"放一会"场景。

#### P0-E: 进程拓扑分层 = 独立 SQL worker

不变量 3 的真实修正方向：

```
Layer 1: API gateway main process (Node.js)
  - Express / SSE / agent tool 调度
  - 不读取/解析大 SQL 结果（避免 Buffer.concat + decode 阻塞 event loop）

Layer 2: SQL worker（独立 Node.js worker_thread 或子进程）
  - 持有 lease / 维护 priority queue
  - 发 HTTP 给 trace_processor_shell
  - decode 大结果 + 流式回传给 main process
  - 通过 MessagePort / IPC 与 main process 通信

Layer 3: trace_processor_shell（已有）
  - perfetto C++ 进程
  - 单线程 SQL 执行
```

这样 main process CPU 压力（agent runtime / SDK / SSE）不影响 Layer 2 的查询响应。

#### P0-F: 浏览器到 trace_processor 走 backend proxy

```
当前形态:
  Browser ──direct──> trace_processor_shell:9100

最优形态:
  Browser ──HTTP──> Backend proxy /api/tp/{leaseId}/query
                      ↓
                  Lease lookup → 当前 worker 端口
                      ↓
                  trace_processor_shell:<dynamic_port>
```

收益：
- crash 后 worker restart 换端口 → 前端不感知（leaseId 稳定）
- isolated 模式切换 → 前端不感知
- 限流 / 排队 / 鉴权 → 全部在 backend proxy 一层做

代价：
- 多一跳 HTTP，增加 ~5-10ms 延迟
- 100 人规模可接受

→ **必修**：§9 增加不变量 7 "Browser → backend proxy → trace_processor"。

#### P0-G: idle_ttl 笔记本休眠场景

固定 30min idle_ttl 对笔记本休眠不友好——用户午饭回来 trace 消失。

**修正**：

```
holder 类型分级 idle_ttl:
  frontend_http_rpc:
    visible:  idle_ttl = 4h（窗口可见）
    hidden:   idle_ttl = 8h（窗口隐藏但 tab 仍存在）
    closed:   立即释放 holder（tab 关闭事件）
  agent_run:
    跟随 backend session/run lifecycle，不单独设 ttl
    run 结束/cancel → 释放 holder
  report_generation:
    跟随 job lifecycle
    job complete/fail → 释放 holder
  manual_register:
    idle_ttl = 1h（兜底）

holder heartbeat 区分:
  frontend visible:  心跳 30s（活跃）
  frontend hidden:   心跳 5min（节能）
  frontend offline:  心跳停止 30min 内仍保留 holder（重连 grace）
                      30min 后才转 stale
  agent/report:      不依赖心跳，靠 backend session 状态

笔记本唤醒后:
  前端检测网络恢复 → 主动 acquire lease
  如果 lease 已释放 → 自动 reload trace（用户感知为"几秒延迟"）
  如果 lease 还在 → 直接复用（无延迟）
```

→ **必修**：§9 不变量 5 加 holder 类型分级 idle_ttl。

#### P0-H: 上传链路 stream 化

不变量 1 讨论 GB trace，但当前 500MB 上限 + URL 全量 buffer。必须先做：

```
1. URL 上传改流式：fetch + ReadableStream → write to disk → metadata
2. 本地上传上限：移除 500MB 硬上限，改为 RAM budget 关联（譬如 < total_memory_budget × 0.3）
3. 大 trace（> 1GB）必须流式落盘后再启 trace_processor
```

→ **必修**：§9 在不变量 1 前加"前置依赖：上传链路 stream 化"。

### 10.4 P1 设计议题

#### P1-A: crash recovery backoff + supervisor 单点重启

```
backoff 1s → 5s → 15s + jitter
holders 不应各自重试 → 单 lease supervisor 重启
当前 TraceProcessorService.recoveryInProgress 已有 per-trace 串行恢复思路
（traceProcessorService.ts:263），可以吸收
agent run 语义：
  单次 SQL crash → 重试当前 tool 一次
  重启失败 → fail 当前 turn
  默认不 fail 整个 run（除非 lease state = failed）
```

#### P1-B: shared vs isolated 自动判定

不变量 2 改为不只是 opt-in，加自动判定规则：

```
isolated 自动触发条件（任一满足）:
  - run 类型 = full / report / heavy skill
  - 预估查询 > 阈值（譬如单次 SQL > 5s）
  - 共享队列长度 > 5
  - 用户正在交互（前端有 active query in last 30s）
  - trace size 允许复制一份内存
  - quota 余量 > 当前 trace 内存估算

shared 默认（其他场景）:
  - fast mode run
  - 短 SQL
  - 多用户只读同一 trace timeline

UI 必须显示 lease 状态原因:
  - "排队中（队列第 3）"
  - "独立 worker（避免阻塞前端）"
  - "共享 worker"
  - "内存不足，请等其他用户释放"
```

#### P1-C: memory budget 70% 改动态

```
budget 动态计算:
  available = container_memory_limit (cgroup) || OS_total
  available -= node_main_process_rss  // process.memoryUsage().rss
  available -= upload_in_flight_reserve  // 估算
  available -= os_safety_reserve  // 1-2GB
  budget = available × 0.85

  小机器（< 16GB）:  更保守，0.6
  中机器（16-32GB）: 0.75
  大机器（> 32GB）:   0.85
```

### 10.5 LGTM 项

Codex 明确认可的方向：
- ✅ 用 lease/refcount 替代全局 cleanup
- ✅ 用内存预算替代固定 maxProcessors=5
- ✅ shared 默认 + isolated 逃生口的方向
- ✅ TraceProcessorSupervisor 把 lease 簿记从查询路径抽出

### 10.6 §9 不变量逐条状态

| 不变量 | 状态 | 原因 |
|---|---|---|
| 1. RAM 配额 | **部分采纳，需修正** | 接受方向；具体数字（1.5x、cap_max 8GB）需 benchmark；需先做上传 stream 化 |
| 2. 共享语义 + isolated 逃生口 | **部分采纳** | 默认 shared LGTM；isolated 改自动判定，不只 opt-in |
| 3. 进程拓扑分层 | **驳回原措辞，重写** | 当前已是 spawn + HTTP，不是新增；真正缺的是独立 SQL worker（worker_thread）+ backend proxy |
| 4. 优先级队列 | **部分采纳，降级** | 改 non-preemptive；删除"P2 切片让出"；长任务必须在调用方拆 step |
| 5. lease + crash recovery | **部分采纳，加分级 ttl** | 状态机 + 4 类 holder LGTM；idle_ttl 30min 改 holder 类型分级；backoff 1s/5s/15s + 单 supervisor 重启 |
| 6. query timeout + health check 拆分 | **部分采纳** | 24h timeout 落地，但必须覆盖 ExternalRpcProcessor；health check 不能用 SELECT 1 走主通道，改 liveness + accept + dedicated channel |
| **新 7. backend proxy（来自 P0-F）** | **必加** | 浏览器到 TP 不能走裸 port；lease 才能隐藏 restart/迁移/限流 |

### 10.7 v3 设计大纲（待实施）

按上述修正，v3 应包含：

```
0. 前置依赖（必须先做）:
   - 上传链路 stream 化（URL 流式 + 本地 500MB 上限解除）
   - benchmark trace_processor_shell RSS 校准估算系数

1. 进程拓扑（v3 不变量 1）:
   Browser ──proxy──> Backend Main ──IPC──> SQL Worker ──HTTP──> trace_processor_shell

2. Lease 模型（v3 不变量 2）:
   每 trace 一个 lease + 一个 worker
   4 类 holder（frontend_http_rpc / agent_run / report_generation / manual_register）
   分级 idle_ttl

3. 资源管理（v3 不变量 3）:
   RAM budget 动态计算（按机器档位）
   admission control 用粗估，运行中按实测 RSS 调整

4. 调度（v3 不变量 4）:
   non-preemptive priority queue（P0/P1/P2 只影响下一个 query）
   长任务调用方主动拆 step
   关键长任务用 isolated worker

5. 超时与健康（v3 不变量 5）:
   query timeout 24h（覆盖 WorkingTrace + ExternalRpc 两路径）
   独立 health check（liveness + RPC accept + dedicated SELECT 1 channel）

6. Crash recovery（v3 不变量 6）:
   单 supervisor 重启（不让 holder 各自重试）
   backoff 1s/5s/15s + jitter
   ≤ 3 次失败转 failed
   leaseId 稳定（端口隐藏在 backend proxy 后）

7. 共享 vs isolated（v3 不变量 7）:
   自动判定规则（不只是 opt-in）
   UI 透明显示状态
```

### 10.8 真根因独立排查任务（必须并行）

24h query timeout 不解决"放一会连不上"——必须独立排查。任务清单：

1. **加观测**（无侵入）:
   - child process exit code + signal + RSS 高水位写入日志
   - HTTP keepalive timeout / socket disconnect 事件埋点
   - 浏览器 visibility / online events 埋点
   - lease state transition 日志
2. **复现**（用户场景）:
   - 笔记本场景：开 trace → 锁屏 30min → 唤醒 → 测 reconnect 行为
   - 长 idle 场景：开 trace → 不动 30min → 测连接状态
   - 双窗口场景：第一窗口长 SQL 中第二窗口上传 → 测第一窗口断开时机
3. **判定**：根据上面观测数据定位真根因，再决定修复方向（vs. 现在的"假设是 timeout 改 24h"）

### 10.9 与原方案的合并策略

- README-review.md 保留完整演化路径（§8 双窗口诊断 → §9 设计 1 修正版 → §10 Codex 反馈）作为决策档案
- README.md 主文档 §8 应替换为 §10.7 的 v3 大纲
- 但 v3 大纲落地前必须完成 §10.8 真根因排查 + §10.2 上传 stream 化 + RSS benchmark 三个前置依赖

### 10.10 Codex session id

`019e05ac-0fbd-7db1-bd23-17605c7a35c4`（同前两轮，resume 复用上下文）

---

## 附：评审过程记录

- Claude 第一轮独立 review：从架构尺度感、事实校验、ProviderSnapshot / SSE / cleanup / agentv2 / Skill / 数据迁移等角度提出 12 项调整建议
- Codex 独立读代码取证（read-only sandbox），发现 5 项事实错误（agent route 实际有 authenticate / 前端 SSE 实际是 fetch-stream / Skill 数量过期 / Custom skill loader 不闭环 / prepareSession 只比 providerId）+ 提出"4 条并行主线"重组建议
- 合并整理：以 Codex 的事实校正为前提（避免在错误前提上讨论），以 Codex 的并行主线 + Claude 的具体降级清单作为重组方案，按 P0 / P1 / P2 优先级输出

Codex session id：`019e05ac-0fbd-7db1-bd23-17605c7a35c4`（如需追问可继续 resume）

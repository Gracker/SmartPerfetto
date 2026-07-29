# Self-Improving 运行契约

**状态**：Self-Evolution V1 已接入生产控制面并默认关闭；legacy 组件边界见下文
**最后核对**：2026-07-30
**权威源**：生产启动代码、类型、配置解析和测试；本文不保存 PR/实施历史

Self-Improving 的目标是让历史分析结果在受控边界内改善后续分析，同时不把模型输出
直接升级成事实、代码或公共知识。Web UI、CLI、API、四种 runtime、报告、snapshot
和私有知识投影仍遵守[产品面规则](../../.claude/rules/product-surface.md)。

## 当前能力矩阵

| 能力 | 当前状态 | 启用边界 |
|---|---|---|
| FeedbackEventV1 与可逆投影 | 已接入 | scope JSONL 是唯一事实源；`effective_feedback` 增量投影；private feedback 物理隔离 |
| Pattern memory | 已接入 | `intrinsicStatus` 与 `feedbackProjectionStatus` 分离；读取 effective status |
| Legacy FeedbackPipeline | 已退役 | 旧 `feedbackPipeline.ts` 已删除，不再存在第二套“反馈→学习产物”状态机 |
| Curated/runtime Skill Notes 注入 | 已接入，默认关闭 | `SELF_IMPROVE_NOTES_INJECT_ENABLED=1`；quick path 预算默认 0 |
| Case Evolution capture/review/retrieve | 已接入，全部默认关闭 | 后端启动时读取 `CASE_EVOLUTION_*`；依赖关系校验失败时会降级或拒绝 |
| Legacy ReviewWorker | 组件和单测存在，未接入应用启动 | `SELF_IMPROVE_REVIEW_ENABLED` 只影响已显式构造的 worker |
| Strategy auto-patch | 组件和单测存在，未接入应用启动 | 不读取 `SELF_IMPROVE_AUTOPATCH_ENABLED`，不能作为产品能力启用 |
| Skill SQL auto-patch | 不支持 | 没有生产入口，不允许模型直接修改 Skill SQL |
| Self-Evolution manifest / feedback / eval corpus | 已接入，默认关闭 | `SELF_EVOLUTION_ENABLED=true`；private feedback 与 public curation 物理隔离 |
| 显式策展与提案生命周期 | 已接入，默认关闭 | 只处理 effective public feedback；每次人工触发最多生成一个有界提案 |
| 固定 paired evaluation gate | 已接入，默认关闭 | 所有 evidence run 必须共享同一 pinned 环境，再运行 baseline/candidate；validation 与 holdout 都不可缺失 |
| Overlay apply / reconcile / rollback | 已接入，默认关闭且 fail-closed | 还需 `SELF_EVOLUTION_APPLY=true` 和可写、包外 user data root |
| 管理 API、SSE 与 UI | 已接入 | 独立 RBAC；设置页 `自进化 / Evolution` 控制台 |
| 贡献包导出 | 已接入 | 只允许 public evidence；持久化去标识 artifact，不自动上传 |
| 外部 L2 judge | 未配置 | 必须逐次明确授权；当前没有环境变量、provider 调用或后台任务 |

“组件存在”不等于“产品已启用”。对外说明、配置示例和运维判断必须以上表和
`backend/src/index.ts` 的实际启动链为准。

## Self-Evolution V1 控制闭环

生产路径保持“统计假设”和“上线资格”分离：

```text
public feedback
  -> explicit bounded curation
  -> draft proposal
  -> fixed validation + holdout paired replay
  -> human accept or reject
  -> optional deidentified local contribution bundle
  -> explicit apply
  -> immutable overlay artifact + generation publish
  -> reconciliation / explicit revert
```

在线反馈统计只用于形成 `hypothesis_only` 提案，不能替代 paired replay。评测固定
runtime、provider、model、output language、tool allowlist、registry fingerprint 和
overlay generation；baseline 与 candidate 使用同一 case 集、预算和并发策略。任何一侧
失败、case split 缺失、registry 漂移或持久化不可用都会阻止 gate/apply。

提案状态按 revision 单向推进：

```text
draft(1) -> gated(2) -> accepted|rejected(3)
accepted(3) -> applied(4) -> reverted(5)
```

apply/revert 使用调用方提供的幂等 `actionId`，经 proposal action saga、artifact store、
overlay registry 和 reconciler 发布 generation。启动或升级时会再次对账；孤儿、
fingerprint drift、验证失败和 publish failure 都进入 reconciliation report，不会静默
继续生效。apply 前会从持久化 Gate attempt 重新加载候选物化与 paired replay proof，
复验候选、treatment artifact、完整 treatment contract，并要求 overlay payload 与
treatment entries 一一对应；调用方临时构造的任意 artifact 不能越过该绑定。

`set_metadata` 的 allowlist 字段按叶路径整体替换，不做深合并。当前叶路径是
`meta.description`、`meta.tags`、`triggers.keywords` 和 `triggers.patterns`。
其中 `triggers.keywords` 整体是一个叶路径：只提交 `zh` 会清除原有 `en`，反之亦然；
需要保留双语关键词时，overlay 必须同时重述 `zh` 与 `en`。

### 隐私、授权与 RBAC

- private feedback 写入独立路径，策展源只打开 public effective feedback；
- `self_evolution:read` 读取 overview、提案、overlay 和对账；
- `self_evolution:curate` 显式启动策展、读取该 scope 的 SSE、运行 gate 和接受/拒绝；
- `self_evolution:export`、`self_evolution:apply`、`self_evolution:revert` 相互独立；
- 操作与 SSE 按 tenant/workspace 隔离；每个 scope 最多同时运行 4 个并保留 20 个，
  单次最长 5 分钟，终态事件最多保留 15 分钟；进程内最多保留 100 个 operation，
  每个最多 64 个事件；
- contribution bundle 只落本地、去标识且要求所有 evidence run 都来自 public
  effective feedback；不会自动提交到仓库或远端；
- L2 judge 当前固定返回 `not_configured /
  explicit_external_judge_consent_required`。增加外部 judge 前必须设计版本化 rubric、
  采样/争议策略和逐次明确授权，不能复用普通 provider 同意。

## 已接入的生产数据流

### Pattern memory

完整与 quick 分析路径可以保存有界 pattern。Provenance schema 可以携带 run、session、
turn 和 trace 内容身份；当前主 runtime 写入 session/turn，并按 `traceFeatures` 相似度和
可选 `bucketKey` 去重。正向、负向与 quick bucket 分开存储，避免短期经验污染长期结果。

Pattern 的生命周期状态与反馈投影分开持久化。active feedback 仍保留时间语义：

```text
provisional
  -> confirmed       正向反馈或自动确认
  -> rejected        负向反馈
  -> disputed        短期内出现相反反馈
  -> disputed_late   已确认后出现迟到反证，仅降低信任并留审计
```

Quick pattern 只有在 scene/architecture/domain 相容、相似度和 insight 重合满足门槛、
full-path 验证通过且没有负向状态时，才能创建新的长期 pattern。它不是原样搬运。

反馈写入按 `(tenantId, workspaceId)` 单写者分配 sequence，先 fsync append-only
JSONL，再推进 `effective_feedback` 与 dirty-target revision。崩溃不会回滚事实日志；
下一次 append 或离线 `npm run self-evolution:feedback-migrate -- --rebuild` 会幂等补投影。
旧 pattern 的当前状态一次性冻结为 `intrinsicStatus`，旧反馈不可撤销。旧
`candidate_feedback` 表自 M2 起只作历史审计源，不再写入；迁移仅把该表中旧流程
已接受的 `short` 行规范化追加到事实日志，旧 JSONL 中的 mis-tap、重复或写库失败
记录继续保留审计但不进入有效投影。

### Skill Notes

`runtimeSkillNotes.ts` 只在 `SELF_IMPROVE_NOTES_INJECT_ENABLED=1` 时构造注入预算。
Curated baseline 和 runtime notes 都必须经过容量、去重和 token 裁剪；quick path 的
`SELF_IMPROVE_QUICK_NOTES_BUDGET` 默认为 0，并受实现上限约束。

Runtime note 晋升到受版本控制的 curated baseline 需要人工操作：

```bash
cd backend
npm run skill-notes:promote -- <skillId> <noteId> --dry-run
npm run skill-notes:promote -- <skillId> <noteId>
npm run test:scene-trace-regression
```

### Case Evolution

Case Evolution 是当前接入后端生命周期的独立管线：

```text
analysis result
  -> bounded candidate capture
  -> SQLite outbox
  -> optional SDK review worker
  -> optional sidecar / case-library ingest
  -> optional retrieval
  -> optional prompt background context
```

后端启动会调用 `startCaseEvolutionWorker()`，关闭时会停止 worker 并关闭 outbox。
所有 flag 默认关闭，并按依赖关系逐级启用：

- `CASE_EVOLUTION_REVIEW_ENABLED` 需要 `CASE_EVOLUTION_CAPTURE_ENABLED`；
- `CASE_EVOLUTION_NOTES_WRITE_ENABLED` 和 `CASE_EVOLUTION_INGEST_ENABLED` 需要 review；
- `CASE_EVOLUTION_PROMPT_INJECT_ENABLED` 需要 `CASE_EVOLUTION_RETRIEVE_ENABLED`；
- `CASE_EVOLUTION_INCLUDE_DRAFTS` 需要 retrieve 与 prompt inject 同时开启。

Review 输出必须经过 schema/关系类型/证据引用验证和匿名化。检索命中只是待当前 trace
证据验证的背景，不会自动成为 claim evidence。发布或撤回 learned case 使用专用 CLI，
不能直接改运行时数据库或生成 YAML。

## Failure taxonomy 与证据边界

`FailureCategory` 和 `computeFailureModeHash()` 使用稳定枚举字段建立失败身份。模型生成
的症状描述只用于解释和审计，不能参与 hash。负向 pattern、review note 和 supersede
marker 可以共享 failure identity，但各自保留来源、scope 和状态。

任何学习产物都必须满足：

- 不把外部知识、历史 case 或模型总结当成当前 trace 测量值；
- 保留 run/session/trace、producer、evidence/artifact 和时间信息；
- 未知 failure category 不触发自动 supersede；
- 负向或 disputed 反馈降低或阻止注入；
- workspace/private scope 不能跨边界提升；公共化需要显式人工动作；
- 内容扫描器拒绝 prompt injection、路径逃逸、凭据和不可控 patch 内容。

## 组件级 Review 与 Patch 边界

`backend/src/agentv3/selfImprove/` 仍包含 outbox、review SDK、strategy fingerprint、
supersede、phase-hint renderer 和 worktree runner。这些是可测试组件，不代表生产启动：

- Legacy `ReviewWorker` 没有在 `backend/src/index.ts` 构造；
- `SELF_IMPROVE_NOTES_WRITE_ENABLED` 和 `SELF_IMPROVE_AUTOPATCH_ENABLED` 没有生产读取点；
- Strategy patch 只允许模板化 `phase_hints`，模型不能提交任意 YAML；
- worktree、内容扫描、fingerprint 和测试通过也只生成候选变更，永不自动 merge；
- Skill SQL patch 没有可用入口。

要启用任何组件级路径，必须先补齐应用生命周期、凭据、资源上限、workspace/RBAC、
监控、Docker/portable 行为和回滚验证，再更新本文与用户配置文档。

## 存储与安全

| 数据 | 当前位置 | 边界 |
|---|---|---|
| Pattern memory | `backendLogPath()` 下的 analysis pattern stores | 默认 `backend/logs`，可由 `SMARTPERFETTO_BACKEND_LOG_DIR` 重定向 |
| Legacy review outbox | `backend/data/self_improve/self_improve.db` | 组件级 SQLite outbox |
| Supersede markers | `backend/data/self_improve/supersede.db` | 组件级 strategy 状态 |
| Case Evolution outbox | `backend/data/self_improve/case_evolution.db` | 生产生命周期可选 worker |
| Runtime Skill Notes | backend runtime logs/data path | 不进 git |
| Curated Skill Notes | `backend/skills/curated_skill_notes/` | 人工晋升并随代码评审 |
| Phase hint templates | `backend/strategies/phase_hint_templates/` | 受控模板，不是自由 YAML patch |
| Run manifests | user data `self_improve/run_manifests.db` | scope/run 身份与 pinned runtime 事实源 |
| Feedback event/index | user data `self_improve/` 下的 public/private 日志与 `feedback_index.db` | append-only 事件；private 目录不进入策展 |
| Eval corpus | user data `self_improve/eval.db` 与 `eval-corpus/` | immutable case artifact 与 split 元数据 |
| Proposals / gate attempts | user data `self_improve/proposals.db` | revision、gate session、channel artifact 和 action saga |
| Overlay artifacts / registry | user data `self_improve/overlays/objects/` 与 `evolution_registry.db` | content-addressed artifact、generation 与 reconciliation |
| Contribution bundles | user data `self_improve/contribution-bundles/` | 本地去标识归档；不自动上传 |

SQLite 路径通过 `backendDataPath()` 解析，不应从进程 cwd 拼接。写入使用事务/原子替换、
lease 和有界重试；损坏或未初始化的可选 store 不能让主分析路径崩溃。私有分析输出必须
经过统一 security projection，不能把 query、路径、知识正文或 provider 内容写入公共
report/snapshot。

## 运维入口

健康快照：

```bash
curl -H "Authorization: Bearer $SMARTPERFETTO_API_KEY" \
  http://localhost:3000/api/admin/self-improve/metrics
```

该端点继续使用既有 `audit:read` 权限，并向原响应追加 `selfEvolution.operational`，
聚合 proposal/overlay/generation/reconciliation、运行中 operation 和 L2 judge 状态。
它是观测面，不会自动启用组件。响应中的 warning 需要结合当前 flag 与启动日志判断。

Self-Evolution 控制面使用单独 base path：

```text
/api/admin/self-evolution
```

浏览器入口位于 **AI Assistant Settings → 自进化 / Evolution**。SSE 客户端使用
`fetch()` 读取流，以便继续发送 Authorization 与 workspace headers；不要改成无法携带
这些 header 的原生 `EventSource`。运维端点和 RBAC 矩阵见
[API 参考](../reference/api.md)。

历史 pattern 的一次性迁移：

```bash
cd backend
npm run self-improve:migrate-failure-mode-hash
npm run self-improve:migrate-failure-mode-hash -- --apply
```

迁移前先备份当前 backend data path；先 dry-run，再 apply。

## 修改位置

| 责任 | 权威源码 |
|---|---|
| Pattern 保存、反馈、确认与注入 | `backend/src/agentv3/analysisPatternMemory.ts` 及其调用方 |
| Failure taxonomy | `backend/src/agentv3/selfImprove/failureTaxonomy.ts` |
| Skill Notes 运行时预算 | `backend/src/agentRuntime/runtimeSkillNotes.ts` |
| Legacy review/patch 组件 | `backend/src/agentv3/selfImprove/` |
| Case Evolution 配置与 worker | `backend/src/services/caseEvolution/` |
| Worker 启动/停止 | `backend/src/index.ts` |
| 指标端点 | `backend/src/routes/strategyAdminRoutes.ts` |
| Self-Evolution lifecycle / stores / gate / overlay | `backend/src/services/selfEvolution/` |
| Self-Evolution 管理控制面 | `backend/src/routes/selfEvolutionAdminRoutes.ts` |
| Self-Evolution UI | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/self_evolution_*` |

新增 flag 或生产入口时，必须先改配置解析/校验和生命周期测试，再更新本文；不要在文档里
声明源码没有读取的环境变量。

## 验证

Self-Improving 或 Case Evolution 改动至少按影响面运行：

```bash
cd backend
npm run typecheck
npm run test:self-evolution
npx jest --runInBand src/services/caseEvolution
npm run test:scene-trace-regression
```

控制台 UI 改动还要运行 Perfetto UI typecheck/相关 unit tests，在
`./scripts/start-dev.sh` 中完成浏览器验证，再用 `./scripts/update-frontend.sh`
更新仓库根目录的 committed prebuild。

Strategy/Skill 或公开证据合约变化还要遵守
[测试规则](../../.claude/rules/testing.md)和
[Skill 规则](../../.claude/rules/skills.md)。合入前运行仓库总门禁：

```bash
npm run verify:pr
```

禁止用旧的测试数量、历史 commit 或某次 review 结论代替当前命令结果。

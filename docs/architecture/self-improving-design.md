# Self-Improving 运行契约

**状态**：部分能力已接入生产路径，其余组件默认关闭或尚未接入
**最后核对**：2026-07-28
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

“组件存在”不等于“产品已启用”。对外说明、配置示例和运维判断必须以上表和
`backend/src/index.ts` 的实际启动链为准。

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

该端点聚合 pattern、Skill Notes、legacy outbox/supersede 和 Case Evolution 状态。它是
观测面，不会自动启用组件。响应中的 warning 需要结合当前 flag 与启动日志判断。

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

新增 flag 或生产入口时，必须先改配置解析/校验和生命周期测试，再更新本文；不要在文档里
声明源码没有读取的环境变量。

## 验证

Self-Improving 或 Case Evolution 改动至少按影响面运行：

```bash
cd backend
npm run typecheck
npx jest --runInBand src/agentv3/selfImprove
npx jest --runInBand src/services/caseEvolution
npm run test:scene-trace-regression
```

Strategy/Skill 或公开证据合约变化还要遵守
[测试规则](../../.claude/rules/testing.md)和
[Skill 规则](../../.claude/rules/skills.md)。合入前运行仓库总门禁：

```bash
npm run verify:pr
```

禁止用旧的测试数量、历史 commit 或某次 review 结论代替当前命令结果。

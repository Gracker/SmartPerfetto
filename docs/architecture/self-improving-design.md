# Self-Improving 运行契约

**状态**：Self-Evolution V1 已接入生产控制面并默认关闭；M10 外部反馈是独立用户面；
legacy 组件边界见下文
**最后核对**：2026-10-01
**权威源**：生产启动代码、类型、配置解析和测试；本文不保存 PR/实施历史

Self-Improving 的目标是让历史分析结果在受控边界内改善后续分析，同时不把模型输出
直接升级成事实、代码或公共知识。Web UI、CLI、API、五种 runtime、报告、snapshot
和私有知识投影仍遵守[产品面规则](../../.claude/rules/product-surface.md)。
面向部署者和管理员的启用、权限、用户影响与测试步骤见
[Self-Evolution 使用与验收](../getting-started/self-evolution.md)；本文只维护运行时
和数据契约。

## 当前能力矩阵

| 能力 | 当前状态 | 启用边界 |
|---|---|---|
| FeedbackEventV1 与可逆投影 | 已接入 | scope JSONL 是唯一事实源；`effective_feedback` 增量投影；private feedback 物理隔离 |
| Pattern memory | 已接入 | `intrinsicStatus` 与 `feedbackProjectionStatus` 分离；读取 effective status |
| Legacy FeedbackPipeline | 已退役 | 旧 `feedbackPipeline.ts` 已删除，不再存在第二套“反馈→学习产物”状态机 |
| Curated/runtime Skill Notes 注入 | 已接入，默认关闭 | `SELF_IMPROVE_NOTES_INJECT_ENABLED=1`；quick path 预算默认 0 |
| 学习 case（capture/review/ingest） | 已退役 | 管线、worker、CLI 与指标端点已删除；旧数据不再被读取、导出或写入，见下文 |
| 人工 case 准入与读取 | 已接入 | 分析只读取策展证明有效的 case；终结召回需 `CASE_EVOLUTION_RETRIEVE_ENABLED`，背景注入另需 `CASE_EVOLUTION_PROMPT_INJECT_ENABLED`（均默认关闭）；`recall_similar_case` 与 similarity case hint 按需读取 |
| Legacy ReviewWorker / review SDK | 已删除 | 从未接入应用启动；旧 review outbox 只保留只读计数（见存储与安全），`SELF_IMPROVE_REVIEW_ENABLED` 没有读取点 |
| Strategy auto-patch | 已删除 | 只能生成不参与运行时的 `phase_hints`；`SELF_IMPROVE_AUTOPATCH_ENABLED` 没有读取点 |
| Skill SQL auto-patch | 不支持 | 没有生产入口，不允许模型直接修改 Skill SQL |
| Self-Evolution manifest / feedback / eval corpus | 已接入，默认关闭 | `SELF_EVOLUTION_ENABLED=true`；private feedback 与 public curation 物理隔离 |
| 显式策展与提案生命周期 | 已接入，默认关闭 | 只处理 effective public feedback；每次人工触发最多生成一个有界提案 |
| 固定 paired evaluation gate | 已接入，默认关闭 | 所有 evidence run 必须共享同一 pinned 环境，再运行 baseline/candidate；validation 与 holdout 都不可缺失 |
| Overlay apply / reconcile / rollback | 已接入，默认关闭且 fail-closed | 还需 `SELF_EVOLUTION_APPLY=true` 和可写、包外 user data root |
| 管理 API、SSE 与 UI | 已接入 | 独立 RBAC；设置页 `自进化 / Evolution` 控制台 |
| 贡献包导出 | 已接入 | 只允许 public evidence；持久化去标识 artifact，不自动上传 |
| Agent 辅助外部反馈 | 已接入，独立于 Self-Evolution | 从已完成源 run 检测机会，固定原 provider/runtime 做无工具 triage，用户确认后只打开未提交 GitHub 草稿 |
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
- M10 外部反馈只额外读取同一 run 的 effective public negative feedback 作为
  `user_reported_inaccuracy` 信号，不读取 proposal，也不触发策展、gate、apply 或
  contribution bundle。private/code-aware 源 run fail-closed；送入外部 triage
  Provider 的信号和公开草稿都经过统一 public-artifact 扫描与去标识，安全问题只允许
  转到 private advisory；
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

学到的经验只在能证明由公开 run 写入时才会被读取。产品在派发时按 run 自己在准入时固定的
私有上下文标记签发学习权限，并绑定 runId（`services/security/durableLearning.ts`）；
私有、unknown 和回放等没有权限的 run 都不写入。store 在保存时给条目盖准入戳
`learningAdmission`；读取、合并、淘汰和租户导出只认带戳的条目，没有戳的条目最先被淘汰，
并随 TTL 过期。SQL 修正对遵循同一规则。私有 run 与公开 run 读取同一批已准入经验。

反馈写入按 `(tenantId, workspaceId)` 单写者分配 sequence，先 fsync append-only
JSONL，再推进 `effective_feedback` 与 dirty-target revision。崩溃不会回滚事实日志；
下一次 append 或离线
`npm --prefix backend run self-evolution:feedback-migrate -- --rebuild`
会幂等补投影。
旧 pattern 的当前状态一次性冻结为 `intrinsicStatus`，旧反馈不可撤销。学习 case 退役后，
`case_candidate` 只保留历史解码：新反馈不能以它为目标（HTTP 400
`case candidate feedback is retired`，store 报 `feedback_target_retired`，撤回旧反馈也一样），
迁移不再读取学习 case outbox 的 `candidate_feedback` 表；事实日志里已有的候选反馈照常解码、
重建和 catch-up，但不进入有效反馈、统计与待投影目标，也不会被标成已应用。旧 JSONL 中的
mis-tap、重复或写库失败记录继续保留审计但不进入有效投影。

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

### 人工 case 与学习 case 的退役

Case 知识只来自人工策展：Markdown 经 `npm --prefix backend run ingest:cases` 导入（与
`validate:cases` 共用同一校验），或经 `/api/cases` 写入。读取只需登录；写入、删除、发布、
归档和边的增删要求 `self_evolution:curate`，curator 与 reviewer 取自登录身份，请求体里的
名字不被采用。分析只读取策展证明有效的 case（见下文"策展准入"）。两个开关都默认关闭：

- `CASE_EVOLUTION_RETRIEVE_ENABLED`：Web 分析终结前，用本次 trace 自己的帧簇数据
  （`scrolling_analysis` 的 `batch_frame_root_cause`）匹配人工 case 的证据签名。命中由
  `finalizeAnalysisResult` 在 contract 完成 owner 投影之后、任何交付绑定之前写入
  `conclusionContract.caseRecommendations`，这是新结果推荐的唯一来源；其 `evidenceRefs` 是签名
  所读的 Trace 证据，`matchedSignatures` 单列签名名。这是签名匹配，不是 claim 验证，报告也
  这样标注。召回失败只记日志（固定文案），结果不带推荐。召回不进入语义复核，也不决定报告
  要求：模型在写答案时看不到命中，scrolling 因此不再有引用 case 的要求，`strong_case_retrieval`
  条件已退役（自定义策略仍声明时按 `invalid_condition` 处理）。CLI、对话与 scene run 不召回。
- `CASE_EVOLUTION_PROMPT_INJECT_ENABLED`：把已准入的 case 作为背景注入 system prompt，需要检索
  同时开启。

`recall_similar_case`（模型按需调用）与 similarity case hint（用户按需请求）不受这两个开关
控制，库里没有已准入 case 时返回空。

### 策展准入

分析只读取 curator 为其当前内容背书过的 case（`backend/src/services/security/caseCuration.ts`）。
旧的 `/api/cases` 只要求登录、按请求体原样保存（包括 `source` 与 reviewer），所以记录里的字段证明
不了背书。证明（attestation）存放在记录之外：knowledge DB 中是 `memory_entries` 行信封的
`attestation`，本地 case 文件中是与 `cases` 并列的 `attestations`。请求体只能塑造记录；写入方不
重新设置证明就会丢掉它，按固定字段重建信封的旧版本与只写 `{schemaVersion, cases}` 的旧版本
`persist()` 都是如此。直接修改存储文件或数据库、备份与恢复属于可信的运营操作。证明是结构性的，
不签名：本地模式没有持久密钥，CLI 与服务端不共享密钥，轮换 API key 或 SSO 密钥会让全部 case 失效。

只有两处签发证明：`/api/cases` 的写入（要求 `self_evolution:curate`，`issuer: curator_api`，
`actor` 为登录身份），以及运营者运行的 Markdown ingest（`issuer: markdown_ingest`，由命令入口签发
一次）。证明绑定整条记录规范化 JSON 的 sha256，任何不经签发路径的修改都会让它失效，只改状态也
一样；`actor` 与 `issuedAt` 只是审计信息。

- 保存是完整策展，签发。API 保存的 `curatedBy` 是登录身份，请求体里的 `analysisAdmitted` 与
  `curation` 被丢弃。
- publish 是 reviewer 对当前内容的签字，签发，也是已发布旧 case 的补戳入口。
- archive 是维护：只有原先已准入的 case 才为归档后的内容重签。dual-write 下文件与 DB 两份副本在
  文件锁内一起判定，一份的有效证明不能替另一份补位；cutover 之后以 DB 副本为准。
- 重新 ingest 时，只有当前副本带有效证明、且 Markdown 内容（title、tags、findings、knowledge，
  不含绝对路径 sourceFile）不变，才沿用此前经 API 提升的状态、curator 与 curatedAt；否则按
  Markdown 自身声明处理并告警。没有人证明过的状态提升（例如引入准入之前写入的）不会被沿用。
- Markdown 自己声明的 curator 与内容都不变时，curatedAt 沿用上次导入的时间。

准入（`isAnalysisAdmittedCase`）要求状态为 published 或 reviewed、`redactionState` 为 `redacted`
（作者或 curator 的共享声明；Markdown 写了 curator 才视为 redacted），且证明有效。所以没写
curator、也没有可沿用的已证明策展的 Markdown case 不会被读取。删掉 Markdown 的 curator 并不撤销
已有的 API 策展；要撤销，用 `/api/cases` 把它改回草稿或删除。签发即授权：该存储范围内的每个 run，私有 run 也在内，都可以把
case 的分析字段放进 prompt 与工具结果，进而发给该 run 的 AI provider。存储范围在 DB 中是
workspace 的全部用户，在本地 case 文件与 dual-write 的读取侧是该存储路径的单一共享库。

背景注入、召回器（终结命中、`recall_similar_case` 证据分支、similarity case hint）与
`recall_similar_case` 标签召回（进程内与独立 MCP 共用）都只经过 `CaseLibrary.listAdmittedCases`。
`GET /api/cases` 仍返回全部 case，每条附带 `analysisAdmitted` 与 `curation`（issuer、actor、
issuedAt）。dual-write 的文件写入在 DB COMMIT 之前完成，不是跨介质的原子提交；副本分歧在下一次
写入时被发现。

升级之后，引入准入之前写入的 case 不再被分析读取，直到补戳：Markdown case 重新运行
`ingest:cases`；经 API 写入的 reviewed case 用 GET 读回后原样 POST；published case 重新
`POST /api/cases/:caseId/publish`。补戳就是为当前内容背书，应先复核。分析读取跳过这类 case 时
每个进程告警一次，只报数量。撤销 curator 权限不会追溯失效他已背书的内容。

从分析结果学出 case 的管线（capture → outbox → review worker → sidecar / ingest，以及
promote、rederive、retract CLI 和 `/api/admin/case-evolution/metrics`）已删除：它无法证明
来源 run 是公开的，而且生产格式的 id 会被它自己的匿名化改写。其余
`CASE_EVOLUTION_*` 键（`ENABLED`、`CAPTURE_ENABLED`、`REVIEW_ENABLED`、`NOTES_WRITE_ENABLED`、
`INGEST_ENABLED`、`INCLUDE_DRAFTS` 及 worker、队列、预算类数值）不再解析，任何取值都不会
阻止启动；仍被设置的键在启动时各告警一次。RunManifest 的 feature flag 记录
`caseRetrievalEnabled` 与 `caseBackgroundInjectionEnabled`，取值来自实际门控所用的同一读取；
旧 manifest 里的 `caseEvolutionEnabled` / `caseEvolutionPromptInjectEnabled` 只是历史记录，
没有读取方。

已写入各 store 的学习数据不迁移、不清除，由读取侧排除（`backend/src/services/retiredCaseData.ts`）。
识别依据：CaseNode 的 source 为 `runtime_analysis_candidate` 或 id 以 `learned:` 开头；
`case_library` chunk 的 chunkId 以 `case:learned:` 开头，或 uri 以 `case://learned/`、
`case://learned:`（Markdown 往返后的形式）开头；边的 id 以 `case-learned-edge:` 开头，或任一
端点是退役 case（按 id 前缀，或按同 scope case store 的节点来源）。CaseLibrary、RagStore、
CaseGraph 的全部读取（get / list / search / stats / related / size）在文件、dual-write 与 DB
各阶段都排除它们，SQL 检索在取候选之前排除，所以它们不占候选名额；只剩退役 chunk 的索引按
空索引处理。租户导出不带它们的内容。普通 id 的退役节点是它那些普通边唯一的退役依据，所以
这个依据失效时一律失败关闭：case store 读不了（文件损坏或 DB 行无法解码）时，图的读取与写入
直接报错，而不是把它当作没有退役节点；经 `DELETE /api/cases/:caseId` 删除退役 case 时，先在当前
阶段写入的每个副本里删掉与它相连的边（按端点匹配，边 id 并不唯一），再删节点，图的任一副本读
不了就拒绝删除、保留节点。各 store 的写入入口拒绝退役数据（`retired_case_data_write_refused`），
`learned:` 是 Markdown case 的保留前缀；删除仍然允许。新结果不带学习来源：受理新结果时
（`canonicalizeAnalysisResult`），不论 contract 来自声明还是 runtime，推荐字段整体去掉，只有
上面的服务端召回能再写入，而召回命中不带学习来源。恢复的历史结果与报告照常展示原有推荐与来源。

这个承诺只覆盖已升级实例的活跃知识读取：未升级的进程仍按旧代码读自己的数据，所以发布验收
要求所有对外实例完成升级。退役数据仍留在原处：本地 `rag_store.json` 的文件大小与 chunk 数
预算在过滤之前检查，超出预算照旧 fail-closed。需要物理清理时，先停止所有后端进程，再在
实际运行目录（不是仓库相对路径）删除：数据根（`SMARTPERFETTO_BACKEND_DATA_DIR`，默认
`<cwd>/data`）下的 `self_improve/case_evolution.db` 及其 `-wal` / `-shm`，日志根
（`SMARTPERFETTO_BACKEND_LOG_DIR`，默认 `<cwd>/logs`）下的 `case_candidates/`，以及这些文件的
备份。store 中的学习 case 与边可以在线用 `DELETE /api/cases/:caseId`、
`DELETE /api/cases/edges/:edgeId` 删除；它们的 RAG chunk 不再经 `/api/rag` 暴露，留在原处不会被
读取。

Case 适用的渲染架构由 `context.app_architecture` 声明，词表就是架构检测器的
`RENDERING_ARCHITECTURE_TYPES` 的小写拼写（`standard`、`flutter`、`compose` 等）。可写
`any`、单个架构或不重复的架构列表；`unknown` 不是声明。`validate:cases` 要求每个
Markdown case 都写这个字段，值不在闭集内就判定失败。背景注入、`recall_similar_case` 和报告推荐检索都用
`services/caseArchitecture.ts` 的同一个判定：trace 架构未知时不按架构过滤；trace 架构
已知时，只有声明了 `any` 或包含该架构的 case 才算适用。没有声明、或者声明了闭集外的值
（比如这份契约之前入库的 `android_view_standard`）都不适用，需要重跑
`npm run ingest:cases` 更新。不带 case knowledge 的手工 case 按 App/Device/CUJ key
检索，不受这个判定约束。

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

`backend/src/agentv3/selfImprove/` 仍包含 review outbox 的只读计数、strategy
fingerprint 和 supersede。这些是可测试组件，不代表生产启动：

- Legacy `ReviewWorker` 与 review SDK 已删除，它们从未在 `backend/src/index.ts` 构造；
  review outbox 只剩只读视图，供指标端点统计旧数据，产品不再创建或写入它；
- `SELF_IMPROVE_NOTES_WRITE_ENABLED` 没有生产读取点；
- 组件级 strategy patch（phase-hint renderer、patch applier、worktree runner）已删除：
  它只能生成 `phase_hints`，而 `phase_hints` 不参与分析运行时。Self-Evolution 的
  `phaseHints` 注入同理：提案、门控、应用、对账都会成功，
  但注入结果不改变任何一次分析的行为。需要影响运行时的注入请用 `skillNotes`
  （由五个 runtime 消费），需要绑定实际取证的义务请用场景的
  `investigation_contract`；`phase_hints` 的持久化结构保留是为了兼容既有 overlay；
- 内容扫描、fingerprint 和测试通过也只生成候选变更，永不自动 merge；
- Skill SQL patch 没有可用入口。

要启用任何组件级路径，必须先补齐应用生命周期、凭据、资源上限、workspace/RBAC、
监控、Docker/portable 行为和回滚验证，再更新本文与用户配置文档。

## 存储与安全

| 数据 | 当前位置 | 边界 |
|---|---|---|
| Pattern memory | `backendLogPath()` 下的 analysis pattern stores | 默认 `backend/logs`，可由 `SMARTPERFETTO_BACKEND_LOG_DIR` 重定向 |
| Legacy review outbox | `backend/data/self_improve/self_improve.db` | 只读；写端已删除，只有指标端点读取旧数据的计数 |
| Supersede markers | `backend/data/self_improve/supersede.db` | 组件级 strategy 状态 |
| 学习 case outbox（已退役） | 数据根下 `self_improve/case_evolution.db` | 不再打开；清理方法见上文 |
| Runtime Skill Notes | backend runtime logs/data path | 不进 git |
| Curated Skill Notes | `backend/skills/curated_skill_notes/` | 人工晋升并随代码评审 |
| Run manifests | user data `self_improve/run_manifests.db` | scope/run 身份与 pinned runtime 事实源 |
| Feedback event/index | user data `self_improve/` 下的 public/private 日志与 `feedback_index.db` | append-only 事件；private 目录不进入策展 |
| Eval corpus | user data `self_improve/eval.db` 与 `eval-corpus/` | immutable case artifact 与 split 元数据 |
| Proposals / gate attempts | user data `self_improve/proposals.db` | revision、gate session、channel artifact 和 action saga |
| Overlay artifacts / registry | user data `self_improve/overlays/objects/` 与 `evolution_registry.db` | content-addressed artifact、generation 与 reconciliation |
| Contribution bundles | user data `self_improve/contribution-bundles/` | 本地去标识归档；不自动上传 |
| M10 外部反馈 | 不创建独立事实库；默认路径仅额外持久化完成态 `analysis_completed` 证据 | 按请求从持久化源 run 与同 run effective public negative feedback 解析信号与 review；只返回 `notSubmitted` 草稿，不写 GitHub |

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
`patterns.*` 经 `analysisPatternMemory.ts` 读取，与调用者 workspace 的 run 读取同一存储
（DB 权威时读 DB）和同一 scope：`total`/`byStatus` 只计已准入条目，未准入条目只计入
`quarantined`，不参与状态统计。
它是观测面，不会自动启用组件。响应中的 warning 需要结合当前 flag 与启动日志判断。

Self-Evolution 控制面使用单独 base path：

```text
/api/admin/self-evolution
```

浏览器入口位于 **AI Assistant Settings → 自进化 / Evolution**。SSE 客户端使用
`fetch()` 读取流，以便继续发送 Authorization 与 workspace headers；不要改成无法携带
这些 header 的原生 `EventSource`。运维端点和 RBAC 矩阵见
[API 参考](../reference/api.md)，端到端人工验收见
[Self-Evolution 使用与验收](../getting-started/self-evolution.md)。

历史 pattern 的一次性迁移：

```bash
cd backend
npm run self-improve:migrate-failure-mode-hash
npm run self-improve:migrate-failure-mode-hash -- --apply
```

迁移前先备份当前 backend data path；先 dry-run，再 apply。脚本经模式记忆模块遍历每个
分区（旧文件整体一次，DB 逐分区），只改写已准入条目（持 store 锁，DB 写入开启后同写 DB）；未准入条目原样保留，报告
只给出数量，不引用其文本。dry-run 只读打开数据库（不建库、不迁移、不改数据）；存储文件无法解析时
只报告 "store is not valid JSON"，不引用原文；DB 里解不出的桶行会被报告（指标给出 warning，迁移报错），
而不是记为空，运行时读取仍把它当作空桶；权威副本
写入失败时 `--apply` 报错退出，DB 副本保持不变。

## 修改位置

| 责任 | 权威源码 |
|---|---|
| Pattern 保存、反馈、确认与注入 | `backend/src/agentv3/analysisPatternMemory.ts` 及其调用方 |
| Failure taxonomy | `backend/src/agentv3/selfImprove/failureTaxonomy.ts` |
| Skill Notes 运行时预算 | `backend/src/agentRuntime/runtimeSkillNotes.ts` |
| Legacy review/patch 组件 | `backend/src/agentv3/selfImprove/` |
| Case 检索、背景注入与配置 | `backend/src/services/caseEvolution/` |
| 人工 case 的策展准入 | `backend/src/services/security/caseCuration.ts`、`backend/src/services/caseLibrary.ts` |
| 学习 case 的退役判定 | `backend/src/services/retiredCaseData.ts` |
| Worker 启动/停止 | `backend/src/index.ts` |
| 指标端点 | `backend/src/routes/strategyAdminRoutes.ts` |
| Self-Evolution lifecycle / stores / gate / overlay | `backend/src/services/selfEvolution/` |
| Self-Evolution 管理控制面 | `backend/src/routes/selfEvolutionAdminRoutes.ts` |
| Self-Evolution UI | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/self_evolution_*` |
| M10 信号、Agent triage、校验与草稿 | `backend/src/services/externalIssueReporting/` |
| M10 HTTP 控制面 | `backend/src/routes/agentExternalIssueRoutes.ts` |
| M10 UI | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/external_issue_reporting.ts` 与 `ai_panel.ts` |

新增 flag 或生产入口时，必须先改配置解析/校验和生命周期测试，再更新本文；不要在文档里
声明源码没有读取的环境变量。

## 验证

Self-Improving 或 case 改动至少按影响面运行：

```bash
cd backend
npm run typecheck
npm run test:self-evolution
npm run test:external-issue-reporting
npm run test:cases
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

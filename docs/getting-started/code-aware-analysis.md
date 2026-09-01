# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis 让 SmartPerfetto 在分析 trace 时按需引用本机代码库，把调用栈、native frame 或 kernel symbol 映射到 `CodeRef`。注册只是让代码库成为可选项，不会自动附加到任何 session；用户必须在当前分析中显式选择。注册且仍可访问的路径会立即可用，并可直接使用有界的 `search_codebase` / `read_codebase_file`；不要求先建立 SmartPerfetto 索引。索引是可选的语义/符号检索与 patch 加速层。默认输出只展示 `referenceId` 或 `chunkId`、相对路径、行号和 symbol；源码正文不写入 session、报告或导出。

## 启用方式

1. 启动后端：`./start.sh`。
2. 在 Perfetto UI 打开 AI Assistant settings，进入 `Codebases`。
3. 添加代码库时优先点击“选择文件夹”，再运行 preview。显示名称可留空，默认使用文件夹名。
4. 注册后即可选择并开始分析。SmartPerfetto 的 `reindex` 是可选加速项，仍用于语义/符号检索和 patch 流程；它与可选的外部代码图加速相互独立。
5. 分析时使用 code-aware 模式，或在 CLI 传入 `--code-aware metadata_only|provider_send` 和 `--codebase-id <id>`。

CLI 示例：

```bash
cd backend
npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --dry-run

npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --exclude-glob '**/generated/**'

# 可选：构建索引以启用语义/符号检索与 patch
npm run cli:dev -- codebase reindex cb_xxx
npm run cli:dev -- codebase symbols MainActivity --codebase-id cb_xxx

npm run cli:dev -- run --format json \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  ../Trace/real/android-startup-heavy/trace.pftrace \
  "结合源码定位启动慢原因"
```

已注册的 codebase 或知识源不会自动暴露给 session。实际组合规则如下：

| 本次选择 | 有效行为 |
|---|---|
| 不传任何 ID | 普通 trace-only；`fast` 可以保持轻量路径 |
| 只传 `--codebase-id` | 默认 `metadata_only`，并切换到完整分析 runtime |
| `--code-aware metadata_only` + codebase ID | 只使用 `CodeRef` 元数据，完整分析 runtime |
| `--code-aware provider_send` + codebase ID | 仅双重授权通过时发送筛选后的片段，完整分析 runtime |
| `--code-aware off` + codebase ID | 输入无效，直接拒绝，不静默忽略源码配置 |
| 只传 `--knowledge-source-id` | 使用已授权的私有外部 RAG，完整分析 runtime |
| codebase ID + knowledge source ID | 源码与外部 RAG 同时参与，同一隐私投影和完整分析 runtime |

源码 codebase 只要求已注册根目录仍可访问；缺少 active generation 或索引分片不会阻止分析。外部知识源仍是 RAG 数据源，因此仍要求已授权且索引完成。注册路径被移动、卸载或删除时，Web/CLI 会返回 `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE`，恢复原路径或重新注册即可。

这里的“完整分析 runtime”意味着即使显式请求 `--analysis-mode fast`，只要选择了源码、私有 RAG 或 reference trace，系统也会解析为 `full`，避免在轻量路径里静默丢失能力。`provider_send` 需要两层授权：注册 codebase 时启用 `--send-to-provider`，且本次分析显式选择 `--code-aware provider_send`。

## 什么时候使用源码

选中源码并不意味着每个问题都必须读代码。完整分析会先用 Trace、Skill 和 SQL 建立事实锚点，然后按下面的契约决定：

- 已选 codebase 且存在可查询的 trace 锚点时，必须执行一次有界源码检索/读取，或在查询前用 `record_source_use_decision` 记录结构化的终止原因。不能只因为“感觉不需要”就静默跳过。
- 只问 trace 中数量事实的问题可记录 `not_needed`，且不调用源码工具。没有可查询锚点时记录 `no_queryable_anchor`；权限不允许时记录 `disallowed`。
- 当前 strategy registry 发现的 19 个可路由场景都通过 `source-investigation-policy.yaml` 继承同一份默认策略；测试按 registry 遍历，而不维护第二份场景清单。`startup`、`scrolling`、`anr`、`interaction` 和 `scroll_response` 还有更具体的锚点配置。

每次分析保留 `SourceUseDecisionV1`：

| 字段 | 含义 |
|---|---|
| `status` | `pending` / `attempted` 是过程态；查询可形成 `located` / `corroborated`，也可以结束为 `not_needed`、`disallowed`、`no_queryable_anchor`、`ambiguous_candidates`、`not_found_complete`、`search_incomplete` 或 `unverified` |
| `reasonCode` | 只保留受控的结构化原因码；模型自由文本原因不进入安全输出 |
| `selectedCodebaseIds` | 本次请求显式选择的代码库 |
| `queriedCodebaseIds` | 实际发起过检索的代码库 |
| `usedCodebaseIds` | 实际产生安全 `CodeRef` 的代码库 |
| `coverageComplete` / `incompleteReasons` | 区分完整无命中与超时、遍历错误等不完整搜索；只有前者才能支持“源码中不存在” |

## 取证顺序与可选代码图

默认分析顺序如下：

1. 先用当前 trace、匹配的 Skill 和 Perfetto SQL 确认性能现象、时间范围、线程、slice 与 symbol。这些才是性能结论的主证据。
2. 如果后端发现用户已经安装且当前可用的本地 GitNexus，AI 可以调用 `query_code_graph` / `inspect_code_symbol` 导航候选调用关系和 symbol。代码图只是可选定位加速，不是 trace 证据，也不是源码事实。
3. 用无需索引的 `search_codebase` 缩小到相对文件与行号，并在当前 consent 允许时用有界的 `read_codebase_file` 核对实际源码。任何影响结论的图关系都必须完成这一步；若权限不允许读取，则保留 `verificationRequired`，不得把候选关系升级为已验证结论。

结论使用双证据语义：Trace/Skill/SQL 证明现象在本次 trace 中发生，`CodeRef` 解释可能的实现机制。`CodeRef` 单独不能提高现象或根因的置信度。`SourceClaimBindingV1.mechanismStatus` 只允许 `corroborated`、`compatible`、`ambiguous` 或 `unverified`；其中 `corroborated` 要求同一 claim 同时具有已核验的 trace 发生证据和 `provider_send` 正文/索引证据。`metadata_only` 只能定位，不能把机制升级为 `corroborated`。

`code_pinpoint` Skill 可以先从 trace 中产生更稳定的源码候选锚点：`hot_slices` 只把符合保守规则的 App 主线程 Trace label 升级为 source query hint，其他 slice 只作 generic anchor；可选的 `native_symbols` 从 CPU profiling 样本提取 function/module/build-id。两者都只缩小查询范围，不代替当前 trace 证据或后续有界源码核对。

Web 对话的自动源码补充使用更严格的工具面：只开放 `list_codebases`、`search_codebase` 和 `read_codebase_file`，不开放代码图、索引检索、Trace、shell 或 patch 工具。普通 dormant 主分析不会获得任何源码工具，因此代码库大小不会增加主分析的模型轮次。

`query_code_graph` 和 `inspect_code_symbol` 只返回元数据：`codebaseId`、相对 `CodeRef`、脱敏后的 process/symbol 元数据、`graph.freshness` 与 `graph.verificationRequired`，不返回源码正文或绝对根目录。注册项配置了 `pathFilters` 或 `excludeGlobs` 时，SmartPerfetto 会省略无法证明路径范围的全仓 process 摘要，仍保留已通过授权过滤的相对 `CodeRef`。GitNexus 未安装、不可用、版本不兼容、超时或调用失败时，图工具会返回结构化不可用结果（`success=false` 与 `unsupportedReason`）；索引陈旧时只返回标有 `freshness="stale"` 的导航元数据。AI/策略在这两种情况下都会继续使用现有 `search_codebase` / `read_codebase_file` 路径，注册、选择和 trace 分析不会因此失败。SmartPerfetto 不会安装、打包、再分发 GitNexus，也不会自动创建或刷新它的索引。

GitNexus 是独立的第三方可选工具。其[官方项目](https://github.com/abhigyanpatwari/GitNexus)和 [npm 包](https://www.npmjs.com/package/gitnexus)目前声明使用 [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)。启用前请自行审阅上游条款并确认你的使用方式符合许可，尤其是商业场景；这不是法律建议。

## 支持的代码库

| kind | 用途 | 必要信息 |
|---|---|---|
| `app_source` | App Java/Kotlin/R8 反查 | 源码文件夹；build ID 与路径范围可选 |
| `aosp` | AOSP framework/native 热路径 | 源码文件夹、`licenseTag`；build ID 与路径范围可选 |
| `kernel_source` | binder/scheduler/mm/io 等 kernel 根因 | 源码文件夹、`vendor`、至少一个 `path-filter`；license tag 可选 |
| `oem_sdk` | OEM / chipset SDK 资料 | 源码文件夹、`vendor`、`licenseTag`；build ID 与路径范围可选 |

源码枚举按 `ripgrep > git > node-walk` 的能力阶梯运行，并在 preview、CLI 与索引审计中返回实际 backend、fidelity 和 coverage。`.git`、`.hg`、`.svn`、`.repo` 与证书/密钥文件始终排除；`node_modules`、`build`、`Pods` 等噪声目录只有在 path filter 显式指向其中时才会进入候选集。AOSP preview 会读取有界的 `.repo/manifest.xml` 元数据，提供 project/group 范围按钮，但 `.repo` 对象库本身永不作为源码遍历。Manifest 缺失表示没有可用的范围建议；读取、解析或身份校验失败会返回 `manifestUnavailableReason`，不会否决已经完成的文件枚举。只有 codebase root 身份漂移仍会阻止 preview。

`.gitignore`、`.ignore` 和 `.rgignore` 只影响枚举召回，不是 provider 授权边界。授权是动态路径范围：当前 selection policy 与注册时冻结的 consent grant 永远取交集。扩大 path filter 或放宽 exclude glob 不会自动扩大 provider 授权；`providerGrantScopeCurrent=false` 时，新增范围先以 metadata-only 使用，用户可显式点击“授权当前范围”。产品升级新增的 Dart、TypeScript、Swift、Objective-C 等语言也可以先用于 `metadata_only` 定位，但已有注册项必须显式点击“授权新语言”后才能发送正文；授权新语言会在已有活动索引上提示重建，以补齐可能缺失的语言。

索引覆盖被拆成独立状态。完整、确定性的候选可直接激活；若已有完整索引，新的确定性截断结果会进入 pending，用户可接受或丢弃，旧完整索引保持服务。枚举超时、遍历错误或不确定结果永不自动激活。索引仍是可选加速，pending 或失败不会阻止 live root 的按需搜索。

Docker 镜像内安装 `ripgrep` 和 `git`。portable 不额外打包 ripgrep：它会在结果中报告 capability，并在缺少 rg/git 时使用有界 `node-walk`，标记 `backendFidelity=degraded`。完成的 node walk 不会伪装成枚举截断；后端 fidelity 与 coverage 完整性分别报告。不得把不完整覆盖表述为“源码中不存在”。

通常不需要手动填写提交版本。每次建立索引时，SmartPerfetto 会从实际 checkout 自动读取
Git `HEAD`，并单独记录工作区是否包含未提交或未跟踪修改；非 Git 目录使用内容指纹。
旧 CLI/API 调用方仍可在注册时传 `--commit` / `commitHash`，但这只是兼容的 caller-supplied 注册元数据，不是索引来源的权威证明。每次 `reindex` 都会从真实 checkout 重新生成 `indexedRevision`、`indexedDirty`、`commitProvenance` 和 `contentFingerprint`。CLI `smp codebase reindex <id>` 不接受 `pathPrefix`；路径范围用 `smp codebase selection` 管理。HTTP reindex 仍保留有界 `pathPrefix` request body 作为兼容能力。

本机 source checkout 和 portable app 在 loopback 模式下可由后端打开 macOS、Windows
或 Linux 的系统文件夹选择器。选择结果会生成一个 5 分钟有效、绑定当前
tenant/workspace/user 且只能消费一次的授权；它只授权该次注册及这个注册项后续的
reindex，不会扩大进程全局 allowlist。后端会保留这项授权来源，但安全的
list/detail/audit 响应不暴露它、绝对路径或原始运行时错误；删除注册项会同时撤销
这项持久授权。Docker、远程/共享后端、无图形会话或没有
受支持选择器的平台会保留手动输入，此时必须填写后端实际可访问且已通过
`SMARTPERFETTO_CODEBASE_ROOTS` 授权的路径。

## 管理与会话生命周期

Web UI 的 `Codebases` 页不只用于注册：它会展示 root 是否可用、selection/grant revision、活动索引与覆盖、待处理 candidate、provider 授权范围是否过期、工作区与内容指纹。用户可以完整替换 path filter / exclude glob，启用或撤销 provider-send，授权新语言或当前路径范围，用 CAS 接受/拒绝精确 pending generation，reindex，查看安全 audit，以及删除注册项和其全部索引代次。

任何改变当前授权或可用内容的成功操作都会递增仅前端使用的 `authorizationEpoch`，退役旧后端 Agent session，并在新安全边界内重置对话。这个 epoch 不发送给后端。只拒绝一个尚未激活的 pending candidate 不会改变当前授权。

## 安全边界

- `metadata_only`：模型可按需搜索，但只看到相对路径、行号和 `referenceId`，不能读取源码正文。
- `provider_send`：只有本次显式选中、注册时同意 `sendToProvider`，且目标相对路径同时被当前 selection 与 consent grant 允许时，才能搜索和读取有界、脱敏后的片段。selection/grant revision 不一致时，新增范围保持 metadata-only，已授权交集不被扩大。
- 按需工具受注册 path filter、exclude glob、文件类型、单文件大小、结果数、读取行数和 secret 脱敏约束；绝对 root 始终留在后端信任边界内，不进入工具结果、模型上下文、报告或导出。
- 代码图结果始终是 metadata-only。报告、snapshot 和 CLI artifact 只能保留安全名称/ID 与相对 `CodeRef`，不能保留原始源码或把图关系写成 trace 证据。
- 系统文件夹选择器的变更请求必须同时具有 loopback Host、socket 与 Origin；只读能力探测可省略 Origin。选择器在 Docker、enterprise 或非 loopback 监听模式下关闭；目录绝对路径和 `rootAuthorization` 不会出现在 codebase list/detail/audit 响应中。
- 私有源码/知识分析的原始 query、中间推理、工具参数和检索正文不写入 session、日志、报告或导出；Claude 本地 transcript 与 OpenAI Responses 存储会关闭，也不会读写跨会话 pattern、verifier 或 SQL 修复学习。最终结论与确定性 trace 证据会经过统一隐私投影；多轮连续性仅由当前进程内的受限会话上下文提供。
- 旧 RAG chunk 不受 code-aware 规则破坏；`app_source`、`kernel_source` 或 `registryOrigin=codebase_registry` 的 chunk 缺少 codebase metadata 时会 fail-closed。
- 旧 `/api/rag/chunks/:id` 和 `/api/rag/search` 对 code-aware chunk 返回 hash/长度等 sanitized 信息，不返回源码正文。
- Web UI 的“删除源码库”会先撤销检索与 provider 授权，再清理当前 scope 内的全部索引代际；删除中断时可安全重试。已经发送给 provider 的历史内容无法由本地删除操作撤回。
- Patch 只分三态：`verified`、`sketch`、`unverified`。本次改动仍要求先由 indexed lookup 获得 `chunkId`；按需工具的 `referenceId` 不直接授权 patch。`sketch` 和 `unverified` 不给 copyable diff。
- SSE、HTML report、CLI JSON/Markdown/HTML、analysis-result snapshot 和报告/snapshot API 共用同一安全源码 provenance 投影，不保留绝对 root、snippet 正文、检索 query 或模型自由文本原因。Web chat 内的折叠回执更严格：只保留 mode、status/reason code、coverage、selected/queried/used ID 和去重后的 mechanism status，不保留 `CodeRef`。回执只能绑定当前 run 的消息，不会回填到旧结论。

## 验证

常用验证命令：

```bash
npm --prefix backend run verify:codebase-aware
npm --prefix backend run verify:code-aware-semantic-delta
npm --prefix backend run test:report-contracts
```

本机完整 E2E 会使用：

- `Trace/real/android-startup-heavy/trace.pftrace`
- `Trace/real/android-startup-light/trace.pftrace`
- 本机 `HighPerformanceFriendsCircle` checkout

E2E 覆盖两条路径：

- 未给 session 配置 codebase：Light trace 正常完成，报告不出现 `CodeRef` / code-aware section。
- 给 session 配置 HighPerformanceFriendsCircle：Heavy/Light trace 正常完成，报告和导出里出现 `CodeRef`，例如 `MainActivity.kt`、`LoadSimulator.kt` 的相对路径与行号；报告不得出现绝对 root path 或源码正文。

缺少本机资产时可用环境变量覆盖：

```bash
SMARTPERFETTO_E2E_HEAVY_TRACE=/path/heavy.pftrace \
SMARTPERFETTO_E2E_LIGHT_TRACE=/path/light.pftrace \
SMARTPERFETTO_E2E_APP_REPO=/path/HighPerformanceFriendsCircle \
npm --prefix backend run verify:codebase-aware
```

`verify:code-aware-semantic-delta` 会在 `backend/test-output/code-aware-semantic-delta/deterministic-summary.json` 写入本机确定性结果。它用真实 `trace_processor_shell`、注册/审计路由、按需与索引 handler、claim/source-binding verifier 覆盖 A0–A4：A0 不选源码，A1 `metadata_only` 且无索引，A2 `provider_send` 且无索引，A3 建索引，A4 故意选错代码库。其中 A1/A2 专门证明“无索引也能分析”，A4 必须拒绝跨 selection 的 `CodeRef`。

这个本机 gate 不调用真实 provider，也不代表模型质量验收。配置好凭证后，可另行运行：

```bash
node backend/scripts/run-deepseek-agent-e2e.cjs \
  --suite code-aware-semantic-delta \
  --runtime all \
  --repeat 5
```

真实 Claude、OpenAI、Pi、OpenCode 和 Qoder 的结果必须分别报告 `PASSED`、`FAILED` 或 `REAL PROVIDER NOT AVAILABLE`；缺少凭证不是通过。

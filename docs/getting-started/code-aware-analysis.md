# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis 让 SmartPerfetto 在分析 trace 时按需引用本机代码库，把调用栈、native frame 或 kernel symbol 映射到 `CodeRef`。注册且仍可访问的路径可直接用于有界搜索和读取，不要求先建立索引。Web 的“添加并用于分析”同时完成明确的授权和本次选择；“仅添加”只登记代码库，之后仍需选择。索引是可选的语义/符号检索与 patch 加速层。分析结果及其中引用的源码可以随本地历史、报告和导出保存。

## 启用方式

1. 启动后端：`./start.sh`。
2. 在 Perfetto UI 打开 AI Assistant settings，进入 `Codebases`。
3. 点击“选择文件夹”，按需填写额外排除路径；名称默认使用文件夹名。类型、允许访问的路径范围、构建信息等位于高级设置。
4. 点击“添加并用于分析”，允许分析模型按需接收授权范围内的脱敏片段。当前是仅定位模式时，按钮为“添加并用于定位”，不会改为正文模式。“仅添加”不改变本次选择，也不新增正文授权。
5. 开始分析，无需构建索引。索引和审计保留在高级设置。CLI 使用 `--code-aware metadata_only|provider_send` 和 `--codebase-id <id>` 显式选择。

关闭源码模式时，“添加并用于分析”只启用新库；已有正文模式时追加新库，已有仅定位模式时保持仅定位。旧的未启用选择或仅定位权限不会因此升级。

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
| 只传 `--codebase-id` | 默认授权 `metadata_only`，保留请求的 Fast/Auto/Full 模式 |
| `--code-aware metadata_only` + codebase ID | 模型可按需定位源码，只接收 `CodeRef` 元数据 |
| `--code-aware provider_send` + codebase ID | 可在当前授权范围内按需搜索、读取有界且脱敏的片段；授权与当前选择范围不一致时拒绝启动（`ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE`），重新授权即可 |
| `--code-aware off` + codebase ID | 视为未选择源码：丢弃这些 ID，不授权任何源码访问 |
| 只传 `--knowledge-source-id` | 使用已授权的私有外部 RAG，保留请求的分析预算模式 |
| codebase ID + knowledge source ID | 使用本次选择授权的源码与知识源，并遵守各自访问边界 |

源码 codebase 只要求已注册根目录仍可访问；缺少 active generation 或索引分片不会阻止分析。外部知识源仍是 RAG 数据源，因此仍要求已授权且索引完成。注册路径被移动、卸载、删除或移出 allowlist 时，Web/CLI 会返回 `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE`，并给出每个库的固定原因（如 `root_missing`、`outside_allowlist`），恢复原路径或重新注册即可。

修改源码库的选择范围时，可证明的收窄会让发送授权随之收窄；其他变化会撤销发送授权，需要重新授权：`smp codebase authorize-content` 先显示将授权的具体范围与 token，再用 `--confirm <token>` 授权（API 为 consent 接口的 `authorizeContent: true` 加 `contentDisclosureToken`）。实际的授权或范围变化会让正在进行的对话重新开始；重复提交相同授权、修改未选中的库或在别处重建索引都不会打断它。

分析预算和证据权限相互独立：选择源码、对比 Trace 或私有 RAG 不会把请求的 `fast|auto` 自动升级为 `full`。`provider_send` 需要两层授权：注册后用 `smp codebase authorize-content` 查看并确认披露范围（Web 端为“添加并使用”在注册后按返回的披露授权），且本次分析显式选择 `--code-aware provider_send`。注册本身不能授权正文发送。

## 什么时候使用源码

选中源码会把已授权工具提供给本轮模型，不会把整个代码库注入上下文，也不会根据问题中的关键词决定授权。Web、API、CLI 和五种生产 runtime 共用这一边界：

- 模型根据问题和 Trace 锚点决定是否搜索、读取。需要实现解释时，可明确要求“结合已选源码核对实现”；纯量化问题可以由 Trace 回答。
- 调用遵守当前运行预算、路径过滤、正文授权和结果容量限制。主流程不隐式套用固定的 1 次搜索、2 次读取、6 秒策略。
- 没有发生调用时，回执不会声称已使用源码。模型先声明不需要源码、后来实际调用时，使用记录仍持续更新。
- 源码选择或授权变化受会话身份与授权指纹检查约束，不能沿用失效的私有上下文。
- 授权指纹只覆盖同意、选择范围、生命周期与删除，不含索引代次：别处重建索引不会中断会话或对话，也不会隐藏历史。每次运行固定所选索引的代次；分析途中索引被重建时，索引查找工具会明确拒绝（`codebase_index_generation_changed`，改用无需索引的 `search_codebase`），不会把它当成“没有命中”。固定代次的已存 chunk 或文件丢失时同样明确拒绝。文档知识库在保留的上一代仍完整时继续服务本次运行。

> **升级说明（一次性）**：授权指纹改为 `acf2` 格式。升级前保存的指纹不再与新值相等，也不会被改写：选用了源码或知识库的已有会话会在下一轮重新开始一次；无法恢复升级前的对话（请开新对话）；升级前源码派生的历史仍保存在本地，但不再进入模型上下文。

每次分析保留 `SourceUseDecisionV1`：

| 字段 | 含义 |
|---|---|
| `status` | 记录未调用、已尝试、已定位、可用正文或搜索不完整等状态，不等同于机制核验结果 |
| `reasonCode` | 受控结构化原因码；模型自由文本理由不进入安全输出 |
| `selectedCodebaseIds` | 本次显式选择的代码库 |
| `queriedCodebaseIds` | 实际发起过源码工具调用的代码库 |
| `usedCodebaseIds` | 实际产生安全 `CodeRef` 的代码库；仅定位也可能出现在这里 |
| `coverageComplete` / `incompleteReasons` | 检索覆盖是否完整；读取指定窗口不表示搜索不完整，不完整搜索不能证明源码不存在 |

工具返回的 `sourceReferences[].id` 可直接用于 `sourceClaimBindings[].sourceReferenceIds`。引用只能来自本轮实际返回且属于本次选择的代码库；模型自造引用或歧义别名不被接受。达到引用容量时，工具明确返回限制，不会继续交付无法核验的引用。Web 回执区分定位、已提供片段和实际核验结果，不把模型的机制声明当作核验通过。

分析过程展示工具调用、结果摘要和模型提供的分析说明；结论可以引用源码。原始工具载荷不会直接灌入聊天或日志。

引用源码会增加检索、读取和额外模型分析步骤，流程和耗时会相应增加。相关片段发送给当前配置的 AI 服务，包括公司内部服务；该服务是否留存内容取决于其配置与政策，SmartPerfetto 不承诺第三方零留存。

“未通过检查”是结果可靠性与完整性状态，例如证据不足、源码引用与 Trace 不匹配、报告覆盖不完整或运行未完成。结果仍可阅读，并保留具体原因和质量标记；它不是隐私审查结论。

## 取证顺序与可选代码图

默认分析顺序如下：

1. 先用当前 trace、匹配的 Skill 和 Perfetto SQL 确认性能现象、时间范围、线程、slice 与 symbol。这些才是性能结论的主证据。
2. 如果后端发现用户已经安装且当前可用的本地 GitNexus，AI 可以调用 `query_code_graph` / `inspect_code_symbol` 导航候选调用关系和 symbol。代码图只是可选定位加速，不是 trace 证据，也不是源码事实。
3. 用无需索引的 `search_codebase`（结果按声明行、trace 调用点优先排序并带上下文）或按文件名查找的 `find_codebase_files` 缩小到相对文件与行号，并在当前 consent 允许时用有界的 `read_codebase_file` 核对实际源码。任何影响结论的图关系都必须完成这一步；若权限不允许读取，则保留 `verificationRequired`，不得把候选关系升级为已验证结论。

结论使用双证据语义：Trace/Skill/SQL 证明现象在本次 trace 中发生，`CodeRef` 解释可能的实现机制。`CodeRef` 单独不能提高现象或根因的置信度。模型只声明 claim 绑定了哪些源码引用和同一 claim 的 Trace 证据；每个依赖源码的结论的状态由服务端根据本轮实际返回计算：`源码解释 + Trace 证据`（读过正文且有同一 claim 的已核验 Trace 证据）、`源码解释（未与 Trace 关联）`、`未读取实现`（只有搜索命中或元数据）、`未绑定引用`，以及使答案失败的 `引用无效`。回答中写出的 `path:L10-L20` 位置也逐个与本轮返回比对。`metadata_only` 只能定位。

源码深度决定一轮能检索和读取多少源码：`locate`（快速定位）只找到相关代码的位置，`mechanism`（机制分析）读够实现来解释现象。默认 `auto` 按问题判断（只需定位或不需源码时定位，要解释实现时机制分析），判断不出时按分析预算；也可用 CLI 的 `--source-depth` 或 API 的 `options.sourceDepth` 指定。仅元数据模式最多定位。每轮在分析过程中显示一行「本轮源码深度」及其来源；只有机制分析会提供补丁建议工具。两档都会对答案做语义复核。

`code_pinpoint` Skill 可以先从 trace 中产生更稳定的源码候选锚点：`hot_slices` 只把符合保守规则的 App 主线程 Trace label 升级为 source query hint，其他 slice 只作 generic anchor；可选的 `native_symbols` 从 CPU profiling 样本提取 function/module/build-id。两者都只缩小查询范围，不代替当前 trace 证据或后续有界源码核对。

索引、代码图和按需读取是不同能力。没有索引时仍可搜索和读取；代码图不可用时仍可根据 Trace 锚点定位源码。只有实际返回并通过核验的引用可用于机制绑定。

`query_code_graph` 和 `inspect_code_symbol` 只返回元数据：`codebaseId`、相对 `CodeRef`、脱敏后的 process/symbol 元数据、`graph.freshness` 与 `graph.verificationRequired`，不返回源码正文或绝对根目录。注册项配置了 `pathFilters` 或 `excludeGlobs` 时，SmartPerfetto 会省略无法证明路径范围的全仓 process 摘要，仍保留已通过授权过滤的相对 `CodeRef`。GitNexus 未安装、不可用、版本不兼容、超时或调用失败时，图工具会返回结构化不可用结果（`success=false` 与 `unsupportedReason`）；索引陈旧时只返回标有 `freshness="stale"` 的导航元数据。AI/策略在这两种情况下都会继续使用现有 `search_codebase` / `read_codebase_file` 路径，注册、选择和 trace 分析不会因此失败。SmartPerfetto 不会安装、打包、再分发 GitNexus，也不会自动创建或刷新它的索引。

GitNexus 是独立的第三方可选工具。其[官方项目](https://github.com/abhigyanpatwari/GitNexus)和 [npm 包](https://www.npmjs.com/package/gitnexus)目前声明使用 [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)。启用前请自行审阅上游条款并确认你的使用方式符合许可，尤其是商业场景；这不是法律建议。

可选索引达到容量时，本次索引回滚并保留旧索引。界面分别显示索引状态和经过实时根目录检查的按需可用状态；目录被移动、权限失效或不在允许范围时，不会承诺仍可读取。“允许访问的源码范围”同时限制索引和按需访问；排除路径也是正文授权边界的一部分。

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

- `metadata_only`：模型可按需搜索，但只看到相对路径、行号和引用 `id`，不能读取源码正文。
- `provider_send`：只有本次显式选中、注册时同意 `sendToProvider`，且目标相对路径同时被当前 selection 与 consent grant 允许时，才能搜索和读取有界、脱敏后的片段。selection/grant revision 不一致时，新增范围保持 metadata-only，已授权交集不被扩大。
- 按需工具受注册 path filter、exclude glob、文件类型、单文件大小、结果数、读取行数和凭据脱敏约束；绝对 root 始终留在后端信任边界内，不进入工具结果、模型上下文、报告或导出。凭据脱敏按整份文件的语法识别，只替换凭据的值（凭据命名的键与赋值、凭据 getter 的返回值、`Bearer`/`Basic`、已知前缀令牌、JWT、PEM 私钥、凭据命名的标记元素与属性，以及启发式识别的无键随机串），保留键名、标识符和每个换行，行号不变；只以 `token` 结尾的名字（窗口、帧、词法或模型流的 token）只在值看起来像凭据时才替换。按需读取立即使用这些规则；此前建立的索引仍是旧规则（会连同键名整段替换），重建索引后才使用新规则。
- 代码图结果始终是 metadata-only。报告、snapshot 和 CLI artifact 可以保留相对 `CodeRef` 及分析引用的源码，但不能把图关系写成 Trace 证据。
- 系统文件夹选择器的变更请求必须同时具有 loopback Host、socket 与 Origin；只读能力探测可省略 Origin。选择器在 Docker、enterprise 或非 loopback 监听模式下关闭；目录绝对路径和 `rootAuthorization` 不会出现在 codebase list/detail/audit 响应中。
- 原始 query、工具参数和完整检索载荷不额外写入日志；provider transcript、跨会话学习等后台边界保持独立。用户可见的分析结果和源码引用可以保存在本地历史、报告和快照中。私有知识库正文仍受其独立过滤规则约束。
- 旧 RAG chunk 不受 code-aware 规则破坏；`app_source`、`kernel_source` 或 `registryOrigin=codebase_registry` 的 chunk 缺少 codebase metadata 时会 fail-closed。
- 旧 `/api/rag/chunks/:id` 和 `/api/rag/search` 对 code-aware chunk 返回 hash/长度等 sanitized 信息，不返回源码正文。
- Web UI 的“删除源码库”会先撤销检索与 provider 授权，再清理当前 scope 内的全部索引代际；删除中断时可安全重试。已经发送给 provider 的历史内容无法由本地删除操作撤回。
- Patch 只分三态：`verified`、`sketch`、`unverified`。本次改动仍要求先由 indexed lookup 获得 `chunkId`；按需工具的 `referenceId` 不直接授权 patch。`sketch` 和 `unverified` 不给 copyable diff。
- SSE、HTML report、CLI JSON/Markdown/HTML、analysis-result snapshot 和报告/snapshot API 共用用户结果投影，保留源码引用及具体校验原因；日志和公开材料使用严格投影。Web 折叠回执仍只保留 mode、status/reason code、coverage、selected/queried/used ID 和 mechanism status，不保留 `CodeRef`，且只绑定当前 run。

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
- 给 session 配置 HighPerformanceFriendsCircle：Heavy/Light trace 正常完成，报告和导出里出现 `CodeRef`，例如 `MainActivity.kt`、`LoadSimulator.kt` 的相对路径与行号；报告不得暴露绝对 root path；用户结果允许保留源码引用，日志和公开材料仍不得包含原始源码。

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

排查单个失败场景时，可以先运行诊断预检；它不替代五轮矩阵，也不会把未覆盖的建议语义标为已验收：

```bash
node backend/scripts/run-deepseek-agent-e2e.cjs \
  --suite code-aware-semantic-delta --runtime openai-agents-sdk \
  --preflight --query-id explicit-source-location --condition A2
```

`A0` 不选源码，`A2` 只注册，`A3` 注册并索引。诊断保留实际工具调用、源码引用及完成与核验状态；仅调用成功不算结论通过。主回答的篇幅通过提示词引导，OpenAI 请求默认不添加应用层输出上限，Claude 流式回答也不会因超过累计字符阈值被截断。结构化结论的解析和回退显示会保留全部有效条目，保存历史也不会按固定正文字符数截尾。需要显式设置 `OPENAI_MAX_OUTPUT_TOKENS` 时必须为正整数；服务商自身的限制仍然生效，调整预算不改变验收标准。

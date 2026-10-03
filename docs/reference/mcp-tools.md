# SmartPerfetto MCP Tools Reference

[English](mcp-tools.en.md) | [中文](mcp-tools.md)

SmartPerfetto 通过 MCP 风格的工具层把 trace 数据、Skill、知识库、代码索引、对比能力暴露给当前 agent runtime。当前代码不是“固定 N 个工具”的模型，而是：

```text
Tool implementation
  -> backend/src/agentv3/claudeMcpServer.ts
  -> backend/src/agentv3/mcpToolRegistry.ts
  -> runtime-specific allowlist / function-tool adapter
  -> request-visible tool surface
```

`claudeMcpServer.ts` 是工具实现入口；`mcpToolRegistry.ts` 是工具描述、exposure level 和 allowlist 的单一事实源。Claude runtime 直接使用 in-process MCP server；OpenAI runtime 读取同一份 registry 并适配成 OpenAI Agents SDK function tools。

不要把工具总数写死在代码或文档中。新增、删除或改名工具时，以 registry 和测试为准。

## 可见性模型

同一个工具实现集会根据请求场景裁剪：

| Scope | 何时启用 | 典型工具 |
|---|---|---|
| Quick / lightweight | fast 或轻量分析路径 | `execute_sql`, `invoke_skill`, `lookup_sql_schema`, 可选 `fetch_artifact` |
| Full analysis | 完整分析路径 | 数据访问、Skill、知识、baseline、记忆、规划/假设和 artifact 工具 |
| Code-aware | 请求允许本地代码库访问 | `list_codebases`、无索引搜索/读取、可选代码图导航、indexed lookup 与 patch 工具 |
| Comparison | 请求包含 `referenceTraceId` | `execute_sql_on`, `compare_skill`, `get_comparison_context` |

Registry 的 exposure level 用于区分公共/内部/需授权工具；它不等于“外部用户一定能看到”。最终可见集合由 runtime、analysis mode、artifact store、codebase permission、comparison context 和 allowlist 共同决定。

## 工具生命周期

```text
Agent 想调用工具
    │
    ├─ 当前 request 构造 registry 和 allowlist
    ├─ runtime 暴露 request-visible tools
    ├─ full mode 下 execute_sql / invoke_skill 受 plan gate 约束
    ├─ 工具执行 SQL / Skill / lookup / comparison
    └─ 结构化结果进入 SSE、report、snapshot、CLI artifact 或 agent context
```

Full mode 中，`execute_sql` 和 `invoke_skill` 仍要求先提交分析计划；quick mode 走轻量路径，不注入完整 planning/hypothesis 工具面。

## 核心数据工具

| Tool | 作用 | 备注 |
|---|---|---|
| `execute_sql` | 对当前 trace 执行 Perfetto SQL | 支持 summary 模式；大结果会截断或通过 artifact 分页。摘要结果（显式请求，或在有 artifact store 时超过 50 行自动）按关注度顺序给出 `sampleRows: {rowIndex, values}`，`rowIndex` 是该行在完整结果中从 0 起的行号，并带 `rowShape: "indexed_rows@1"`；较小的原始结果以及没有 artifact store 时的结果，仍是按结果顺序从第 0 行开始的普通 `rows`（最多前 200 行） |
| `invoke_skill` | 执行 YAML Skill 分析管线 | 首选证据收集路径，返回 DataEnvelope / artifacts |
| `list_skills` | 列出可用 Skills | 可按 category 过滤；Skill 数量以文件树为准 |
| `detect_architecture` | 检测当前 trace 的渲染架构 | 影响策略和渲染管线分析 |
| `analyze_wait_chain` | 分析某线程在某区间的运行/可运行/睡眠/不可中断分布、最长等待、唤醒来源和递归唤醒链 | 复用 critical-path 引擎；`wake_source_class` 是候选标签不是根因。头部数字是 `attributableMs` / `attributablePercentage`（其他线程运行、可运行与不可中断等待）；`blockingMs` 是链路覆盖，含 `eventWaitMs`（链路末端其他线程的可中断睡眠，Perfetto 在此终止唤醒链，`topWaits[].terminal: true`）。`rootWait.context`（`in_slice` / `between_slices` / `no_slice_data`）配合异常 `idle_wait`（等待位于两个 slice 之间且可归因占比低：空闲，不是卡顿）和 `peer_event_wait`（链路终止于其他线程等待网络、定时器或设备：这就是阻塞点）解读；`longestAttributable`、`longestEventWait` 分别给出最长的可归因段和最长的链路末端等待，`anomalies[].id` 为稳定 id。`available: false` 时带 `unavailableReason`（`task_state_running`、`no_waiting_time`、缺 `sched_waking` 时的 `no_critical_path_stack`，或选中等待到 trace 结束都未结束的 `wait_open_at_trace_end`）。严格 schema 迫使模型填写的占位值（`""`、`"null"`、utid/tid/upid/pid 为 0、`main_thread: false`、0..0 区间）按未提供处理；`thread_state_id` 0 是合法行号。`thread_state_id` 与指定线程/进程或区间不一致时：若另给了线程和完整区间，忽略该行并带 `thread_state_id_ignored_conflict` 警告；否则拒绝 `selector_conflict`（附 `threadStateOwner`、`requestedThread`、`conflicts`）。线程在区间内没有任何 thread_state 行时拒绝 `no_thread_state_in_window`（`action_required: choose_thread_with_sched_data`，附 `processHasSchedData` 和至多 5 个有调度数据的候选线程）。拒绝都带 `action_required`，不计入工具失败率。默认值由引擎的 `CRITICAL_PATH_DEFAULTS.agent` 决定（展示 200 段、递归 1 层、子段预算 16），`max_segments` / `recursion_depth` 可覆盖；等待链本身已沿唤醒者逐级追溯，递归只在其他线程的最长段内重跑关键路径。除段表外还保存一行摘要表（`summaryArtifactId` / `summaryEvidenceRefId`），投影中的头部数字逐字取自该行（含 `attributable_ns` / `event_wait_ns`），`exactNs` 给出对应的纳秒精确值；段表带 `path_role` 列；`*_ns`、`start_ts`、`dur_ns`、`utid` 带 native producer 语义，数值断言引用它们可被确定性验证，四舍五入的 `*_ms`、占比和计数不带语义 |
| `lookup_sql_schema` | 搜索 Perfetto SQL schema / stdlib index | quick 和 full 都可用 |
| `query_perfetto_source` | 搜索 Perfetto stdlib SQL 源码 | 源码缺失时依赖打包索引兜底 |
| `list_stdlib_modules` | 列出 Perfetto stdlib modules | 避免把完整模块列表塞进系统 prompt |

`execute_sql` 和 `invoke_skill` 是证据入口，不是最终报告入口。最终结论还要经过结果归一化、evidence/claim verification、报告生成、snapshot 和 frontend projection。

## 知识、记忆与 baseline

| Tool | 作用 |
|---|---|
| `lookup_knowledge` | 加载本地性能分析知识、模板或管线说明 |
| `lookup_blog_knowledge` | 查询博客或 Android Internals 背景知识；`source=android_internals_pack` 使用内置签名 Pack，`source=android_internals_wiki` 使用请求白名单中的私有 source id |
| `lookup_aosp_source` | 查询 AOSP 相关源码知识 |
| `lookup_oem_sdk` | 查询 OEM SDK / 厂商相关知识 |
| `lookup_baseline` | 查询历史 baseline |
| `compare_baselines` | 对比 baseline 指标 |
| `recall_project_memory` | 检索项目级记忆 |
| `recall_similar_case` | 检索相似分析案例 |
| `recall_similar_result` | 检索相似 analysis-result snapshot，输出仅可作为 `navigation_hint_only` |
| `recall_patterns` | 检索模式/反模式，通常作为内部分析辅助 |

记忆和知识工具只能辅助当前 trace 分析，不能覆盖当前 trace 的证据。
内置 `android_internals_pack` 固定签名版本和 fingerprint；私有
`android_internals_wiki` 在每次调用时重新检查 scope、权利确认、provider 同意和
active generation。模型可读取预算内脱敏片段；Claude、OpenAI、Pi、OpenCode、Qoder 的
SSE/日志事件只保留版本化引用、哈希、长度、许可、出处和可信度侧车。完整流程见
[Android Internals 知识包与私有知识库](../getting-started/android-internals-knowledge.md)。

## Planning / Hypothesis / Artifact 工具

| Tool | 作用 |
|---|---|
| `submit_plan` | 提交调查计划，解锁 full mode 下的核心证据工具 |
| `update_plan_phase` | 更新当前 phase，并可注入下一阶段提示 |
| `revise_plan` | 证据改变方向时替换计划 |
| `submit_hypothesis` | 记录可验证假设 |
| `resolve_hypothesis` | 标记假设为 confirmed / rejected / unresolved |
| `flag_uncertainty` | 显式记录不确定性或缺失证据 |
| `write_analysis_note` | 写入 session 分析笔记，按配置启用 |
| `fetch_artifact` | 分页读取大型 SQL/Skill artifact，按 artifact store 启用。`detail="rows"` 返回 `rows: {rowIndex, values}`，`rowIndex = offset + 位置`（整个 artifact 内的行号），并带 `rowShape: "indexed_rows@1"`；`detail="full"` 保持原始结构 |
| `lookup_strategy_detail` | 按 plan 工具返回的 detail ref 读取场景策略细节；仅作 informational fallback，不满足 expectedCalls |

这些工具服务于分析纪律和上下文压缩。不要把 artifact 摘要当作完整证据删除；完整 DataEnvelope 仍可进入前端、报告、CLI 或 snapshot。

## Code-Aware 工具

| Tool | 作用 | 边界 |
|---|---|---|
| `list_codebases` | 列出已授权代码库 | 需要 codebase permission |
| `search_codebase` | 在已注册 live root 中做有界文本/symbol 搜索 | 不要求 SmartPerfetto 索引；只接受已选 codebase 和相对 path prefix |
| `read_codebase_file` | 读取已注册 root 内的有界行范围 | `metadata_only` 不返回正文；`provider_send` 仍要求双重 consent 和脱敏 |
| `find_codebase_files` | 按文件名、路径子串或 glob 查找已注册文件 | 只返回相对路径，不读文件、不签发源码引用；`metadata_only` 下可用 |
| `query_code_graph` | 用可选本地代码图导航相关流程与 symbol | metadata-only；仅当所选库有 GitNexus 索引时提供 |
| `inspect_code_symbol` | 查看候选 symbol 的有界关系与位置 | metadata-only；关系必须再由有界源码读取验证；仅当有 GitNexus 索引时提供 |
| `lookup_app_source` | 查询应用源码 | 输出需要 CodeRef 过滤；仅当所选库有 active index 时提供 |
| `lookup_kernel_source` | 查询内核源码 | 输出需要 CodeRef 过滤；仅当有 active index 时提供 |
| `resolve_symbol` | 解析 trace 符号到源码位置 | 保持源码引用可追踪；仅当有 active index 时提供 |
| `propose_patch` | 生成 patch proposal | 必须标记 verified / sketch / unverified；仅当有 active index 时提供 |

每个 run 的 MCP server 一次性判定所选库各自的能力（`search`、`read_body`、`index`、`graph`），只有某个所选库具备图谱或 active index 时才注册对应工具。同一份事实连同本轮源码深度和初始额度，以 `source_authorization` 数据段进入系统提示（`codebases[]`：`id`、`displayName`、`kind`、`pathScope`——`whole_root` 或 `registered_filters`，从不列出过滤规则本身——以及 `capabilities`）。调用指定了不具备该能力的库时，在触达任何源码之前拒绝：`unsupportedReason: codebase_index_unavailable | codebase_graph_unavailable`，`action_required: use_search_codebase`。源码使用状态只按实际调用记录，不再有由模型声明的源码使用决策工具。

五个无索引/图导航工具都需要 codebase permission，并使用当前请求已选择的代码库。只有恰好选择一个 codebase 时才可省略 `codebase_id`；选择多个时必须明确指定：

- `search_codebase`：必填 `query`；可选 `codebase_id`、相对 `path_prefix`、`file_glob`（`*`、`?`、整段 `**`；不含 `/` 时匹配任意深度的文件名）、`case_sensitive`（缺省 smart-case：查询含大写字母才区分大小写）、`context_lines`（0–5，默认 2）和 `max_results`（1–30，默认 12）。
- `read_codebase_file`：必填相对 `file_path`；可选 `codebase_id`、`start_line` 或 `around_line`（以该行为中心，二者互斥）和有界 `max_lines`。
- `find_codebase_files`：必填 `pattern`（文件名子串、含 `/` 的路径子串或 glob）；可选 `codebase_id`、相对 `path_prefix` 和 `max_results`（1–50，默认 20）。
- `query_code_graph`：必填 `query`；可选 `codebase_id` 和有界 `max_results`。
- `inspect_code_symbol`：必填 `symbol`；可选 `codebase_id`、相对 `file_path` 和有界 `max_relations`。

格式合法但不被 selection policy 接纳的路径或 `path_prefix`（在注册过滤范围外、位于排除目录下、非源码扩展名的文件路径；`provider_send` 下还包括不在 provider-send 授权内）返回策略拒绝：`success=false`、`unsupportedReason` 和 `action_required` 指令，例如 `locate_path_with_search_codebase`、`retry_search_without_path_prefix`，或用于授权范围外前缀的 `continue_without_this_path_prefix`。拒绝结果不回显请求路径，也不暴露注册过滤规则或 root，并且不带 backend 或覆盖率字段，因此不能支撑"源码中不存在"的结论。成功的搜索会给出 `coverageScope`（`codebase`，或前缀收窄了注册范围时为 `path_prefix`）；只有覆盖整个代码库的完整搜索才能支撑"不存在"。`provider_send` 搜索若因授权范围隐去了命中，会返回 `coverageComplete=false` 与 `searchIncompleteReason=provider_grant_scope`。格式错误的路径和不可读文件仍是工具失败。

搜索先收集遍历到的全部命中，再确定性排序（该名字的声明行、trace section 调用点、整词与大小写精确匹配优先；test/generated/build 路径最后；再按路径与行号），只把排名靠前的候选经路径网关重新读取核对后返回。每条结果的 `lineRange` 含 `context_lines` 上下文，`matchLines` 标出命中行，同一文件相邻命中合并为一个窗口。`moreResults` 只表示还有未展示的命中（分页），不代表覆盖不完整；`traversal`（`complete`、`stopped_at_cap`、`timed_out`、`error`）说明遍历是否提前停止，只有 `complete` 且没有被授权范围隐去的命中时 `coverageComplete` 才为 true。按需搜索扫描不超过 16 MiB 的文件（`scope.maxFileBytes`），读取上限 4 MiB；命中落在两者之间的文件时只返回位置并标 `bodyUnavailable: "file_too_large"`，读取这类文件返回 `source_file_too_large`。索引入库仍沿用 200 KiB 上限。

源码额度按 run 计、由 `sourceDepth` 选档（`source-depth-policy.yaml`）：搜索类调用（`search_codebase`、`find_codebase_files`、图谱工具、`resolve_symbol`、命中已注册库的索引 lookup）与 `read_codebase_file` 各有次数，调用到达源码时扣次数（失败不退）；token 按实际下发计，超出时搜索保留排名靠前的结果、读取保留前面的行（其余为分页），一点都放不下才返回 `budget_exceeded` 拒绝；图谱工具与 `resolve_symbol` 只返回元数据，超额时整块保守拒绝（在签发任何引用之前）。每个源码工具结果都带 `budget: {searchesLeft, readsLeft, tokensLeft}`；单次读取行数受档位上限约束。检索到的知识正文（Knowledge Pack、私有知识、博客检索）用单独的 token 池；`lookup_knowledge` 返回的内置方法论模板属于产品提示内容，不计入。`CodeLookupLedger` 只做审计与 patch 授权，不再参与额度。

每条结果带签发的引用 `id`，与 `sourceReferences[].id` 相同，是模型唯一应引用的 id（内部 `referenceId` 不再下发）。搜索命中为 `lookupKind: search_hit`，只定位代码；读取窗口（`body`）或索引片段才是正文证据，读取窗口完整覆盖某个命中的范围时，该命中也算已读正文。来源使用状态按最强发现推导，不再被一次不完整搜索钉死；run 级 `coverageComplete` 单调，否定性源码结论以它为准。

模型只收到一份正文：带真实行号的 `numberedText`；原始文本留在内部，用于回显登记、计费与来源追踪。读取结果的 `window.enclosingSymbol` 是窗口起点向上最近的声明行（启发式）；文件不存在时，`candidates` 列出范围内同名文件的相对路径（至多 5 个，`provider_send` 下不越出授权范围）。工具抛出的失败只把形如 `source_*` 的无路径错误码交给各 runtime，其余一律为 `source_tool_failed`。

注册且仍可访问的 root 立即满足 `search_codebase` / `read_codebase_file`，不要求 SmartPerfetto active generation。`query_code_graph` / `inspect_code_symbol` 只会尝试用户已经安装并已有索引的本地 GitNexus；SmartPerfetto 不打包、再分发、安装、要求或自动建索引；所选库都没有 `.gitnexus` 索引时图工具不提供。GitNexus 程序缺失、不兼容、超时或调用失败会让图工具返回结构化不可用结果（`success=false` 与 `unsupportedReason`）；陈旧索引只返回标有 `freshness="stale"` 的导航元数据。AI/策略在这两种情况下都继续调用现有无索引搜索/读取工具，而不是阻断分析。

按需 `search_codebase` / `read_codebase_file` 与 indexed lookup 使用同一条披露谓词：
相对路径必须同时满足当前 selection policy 和注册时 consent grant。`.gitignore` 只决定
候选召回；它不是授权。新版本新增的扩展名必须由用户再次授权，不能由旧 consent
静默继承。

图工具输出只包含 `codebaseId`、相对 `CodeRef`、脱敏后的 process/symbol 元数据、`graph.freshness` 和 `graph.verificationRequired`。注册项配置了 `pathFilters` 或 `excludeGlobs` 时，会省略无法证明路径范围的全仓 process 摘要，并保留已授权的相对 `CodeRef`。代码图元数据既不是当前 trace 证据，也不是已经核对的源码事实；任何影响结论的关系都必须再用有界 `read_codebase_file` 验证，当前权限不允许读取时必须保持未验证状态。绝对 root 始终留在后端信任边界内。Code-aware 输出会进入 report/export/snapshot 时，只能保留安全名称/ID 与相对 `CodeRef`，不能保留原始源码；处理隐私、路径和 patch 状态时不要只验证前端聊天窗口。

源码结论使用双证据：Trace/Skill/SQL 证明本次发生，`CodeRef` 证明实现机制。
`CodeRef` 单独不能提高发生/根因置信度。绑定状态只能是 `corroborated`、
`compatible`、`ambiguous` 或 `unverified`；`corroborated` 要求同一 claim 的已验证 trace 发生证据
与 `provider_send` body/indexed 证据。`metadata_only` 只能产生 locate-only 引用。

GitNexus 是独立的第三方可选工具，其[官方项目](https://github.com/abhigyanpatwari/GitNexus)和 [npm 包](https://www.npmjs.com/package/gitnexus)目前声明使用 [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)。使用前必须自行审阅上游条款；这不是法律建议。

## Comparison 工具

| Tool | 作用 |
|---|---|
| `execute_sql_on` | 在基线或对比 trace 上执行 SQL；兼容参数值为 current/reference。其摘要结果把带行号的 `sampleRows` 与 `rowShape: "indexed_rows@1"` 放在 `summary` 内 |
| `compare_skill` | 对基线/对比并行执行同一 Skill；兼容角色为 current/reference |
| `get_comparison_context` | 获取 trace pair 元数据、左右/上下窗格映射和 comparison context |

Comparison 工具只在请求包含 `referenceTraceId` 且 comparison context 可用时注册。Raw trace comparison 和 analysis-result comparison 都应复用共享 evidence/report contract，避免 CLI-only 或 frontend-only 的私有输出。

## 工具使用优先级

1. 先确认场景、时间范围、进程身份和渲染架构。
2. 有匹配 Skill 时优先 `invoke_skill`，用 SQL 补缺口或验证关键假设。
3. Trace/Skill/SQL 已经指向具体实现时，才把可选代码图用于候选导航；不能用图关系替代 trace evidence。
4. 已选源码且有可查询锚点时，用无索引 `search_codebase` 缩小范围，并在 consent 允许时用有界 `read_codebase_file` 核对影响结论的候选关系；否则先记录结构化 source-use stop 决策。
5. 大结果通过 artifact 分页，不要把完整表塞进 agent context。
6. 结论必须能回到 trace evidence、Skill output、claim verification 或显式不确定性。
7. Chat 可以简化展示，HTML report、CLI artifacts 和 snapshots 必须保留可审计证据。

## 维护清单

- 工具实现或可见性变化：更新 `claudeMcpServer.ts`、`mcpToolRegistry.ts`、OpenAI adapter 相关测试和本页。
- Code-aware 工具变化：同时检查 `docs/getting-started/code-aware-analysis*.md`。
- Comparison 工具变化：同时检查 comparison docs、CLI docs 和 report/snapshot contract。
- 不要新增静态工具总数；如果需要当前 inventory，请从 registry 或源码 grep 生成。

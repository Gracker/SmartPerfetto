# 功能总览

[English](features.en.md) | [中文](features.md)

<!-- i18n-headings: paired -->

这份文档面向 SmartPerfetto 使用者，说明它大概能做什么、从哪里触发、输出结果是什么。安装和配置步骤见 [快速开始](quick-start.md) 和 [配置指南](configuration.md)。

## 1. Perfetto UI 内的 AI Assistant

SmartPerfetto 在 Perfetto UI 中内置 AI Assistant 面板。用户加载 `.pftrace` 或 `.perfetto-trace` 后，可以直接用自然语言提问，例如：

```text
分析启动性能
分析滑动卡顿
帮我看看这个 ANR
这段选区里主线程为什么卡住？
```

入口：

- 打开 `http://localhost:10000`。
- 加载 Trace。
- 打开 SmartPerfetto AI Assistant 面板。
- 选择 `fast`、`full` 或 `auto` 分析模式。
- 输入问题并发送。

效果：

- AI 会调用后端 TraceProcessor、SQL、Skill 和场景策略进行分析。
- UI 会流式展示进度、SQL/Skill 证据、表格结果和最终结论。
- 结论应能追溯到具体时间段、线程、slice、SQL 行或 Skill 结果。

### 浏览器 Trace 工具与本地 WASM

提交的 Perfetto 前端还提供一组直接在浏览器中运行的 trace 探索能力：

- Trace Doctor 诊断视图，以及统一的 Stack Samples / flamegraph 入口。
- 原始多 trace 打开/合并、Video Frames，以及 Pixel 输入生命周期与 CUJ 视图。
- 实验性的 Memscope/OOM 视图；只有 trace 含所需数据且相应实验能力可用时才显示。
- 本地 WASM 可解析 zstd 压缩 trace 和 `strace -ttt` 输入，并支持一次执行多条 SQL
  statement 的 Perfetto UI 查询场景。

这些能力属于浏览器本地时间线和 Perfetto 插件。原始多 trace 打开/合并不同于
SmartPerfetto 的双 Trace AI 对比；WASM 新能力也不会自动扩展后端 AI、Skill、CLI 或
HTML 报告。后者继续使用发布包固定的 native `trace_processor_shell`，只有完成独立
升级与五平台验证后才会吸收同名能力。

### 智能分析模式

智能模式适合一条 trace 覆盖完整测试脚本的情况，例如冷启动、热启动、滑动、点击、Back/Home、亮灭屏和再次启动混在一起。它不会一开始就深钻所有场景，而是先在主 AI 面板中输出场景盘点：

- 按时间顺序列出识别到的启动、滑动、惯性滑动、点击、导航、设备状态、ANR 等场景。
- 标出哪些场景可以进入深钻，哪些只是 marker 或上下文证据。
- 提供 `全部`、`启动`、`滑动`、`点击`、`导航`、`设备`、`ANR` 等范围按钮。
- 用户选择范围后，才运行对应的启动分析、滑动分析或其他深钻，并沿用单独选择该场景时的证据与结论契约。

## 2. 常见性能场景分析

SmartPerfetto 内置 Android 性能分析场景，适合从 trace 中快速定位问题。

| 场景 | 可以问什么 | 典型输出 |
|---|---|---|
| 启动 | `分析启动性能`、`启动慢在哪里` | 启动阶段拆解、主线程阻塞、关键 slice、耗时指标 |
| 滑动/Jank | `分析滑动卡顿`、`这次滑动 FPS 怎么样` | FPS/Jank 指标、慢帧列表、UI/RenderThread/调度原因 |
| ANR | `帮我看看这个 ANR` | 主线程等待、Binder/锁/调度线索、可疑根因 |
| 交互延迟 | `点击后为什么响应慢` | 输入到绘制链路、主线程与渲染线程延迟 |
| 内存/CPU | `看下内存压力`、`CPU 为什么这么高` | 进程/线程维度统计、调度与资源占用证据 |
| 渲染管线 | `分析这段渲染链路` | App、Framework、SurfaceFlinger、HWC/GPU 相关证据 |

效果：

- 轻量问题可以用 `fast`。
- 启动、滑动、ANR、复杂渲染根因建议用 `full` 或 `auto`。
- 对于不确定结论，SmartPerfetto 会保留 uncertainty 或要求更多证据，而不是把推测写成事实。

## 3. 选区和上下文追问

SmartPerfetto 会把 Perfetto UI 中的 area selection 或 track event selection 传给 AI Assistant。你可以先在时间线上选中一段，再问：

```text
只看我选中的这段时间，为什么 UI thread 变慢？
这个 slice 前后有没有 Binder 或调度问题？
```

入口：

- 在 Perfetto 时间线上选中时间范围或事件。
- 在 AI Assistant 中提问。

效果：

- AI 会优先围绕选区分析。
- 适合把大 trace 缩小到一次点击、一次滑动、一帧或一个可疑 slice。
- 多轮追问会复用当前 session，适合逐步收敛根因。

## 4. 证据表格、Skill 结果和可追溯结论

SmartPerfetto 的输出通常分成三类：

- SQL 结果：来自 `trace_processor_shell` 的精确查询结果。
- Skill 结果：来自内置 YAML Skill 的结构化分析，通常按 L1-L4 从概览到深层根因展开。
- Agent 结论：AI 基于 SQL、Skill、策略和 verifier 生成的解释。

效果：

- 适合把“看到一堆 timeline”变成可读的根因链路。
- 关键数值应该有来源，不应只出现在自然语言里。
- 复杂分析会尽量给出优化方向、验证方式和残留不确定性。

## 5. HTML 分析报告

AI 分析完成后，后端会生成 HTML report。

入口：

- 在 AI Assistant 中完成一次分析。
- 从 UI 返回的报告入口打开。
- 后端也提供通用报告接口 `/api/reports/:reportId`。

效果：

- 把本次分析的问题、证据、结论和建议整理成可阅读报告。
- 适合分享给团队、贴到 issue、保存为回归分析记录。

## 6. Trace 实时对比

Trace 实时对比用于在同一个 AI 对话中，把当前页面的 current Trace 与一条 workspace 历史 reference Trace 放进可自由换位的双窗，让 AI 同时查询两条 Trace。

入口：

- 在 AI Assistant 顶部点击 `compare_arrows`。
- `打开双窗` 会立即打开 current + 空 reference 的双窗壳，不需要先经过历史 Trace picker。
- 两个窗口都有 selector。任一窗口都可选择 current 或历史 Trace；如果在 current 所在窗口选择历史 Trace，current 会原子移动到另一个窗口。
- 历史选项以 Trace filename 为主；只有同名 Trace 需要区分时才追加上传时间和文件大小，不再把内部 id 当作主名称。
- 选择历史 Trace 后，它成为唯一 reference。仍然只支持“当前页面的 current parent + 一个历史 reference”，不支持任意两个历史 Trace 互相对比。
- 可以切换横向/纵向、拖动分隔条、最大化/最小化任意一边，或把某一边在新标签页打开。
- 双窗工具栏常驻明确的“AI 助手”按钮，用于收起或恢复对话面板；操作不会关闭双窗，也不会重新加载任一 Trace。
- 布局切换、最大化/最小化以及 AI Panel 的隐藏/再次显示不会重新加载双窗 iframe。只有显式退出双窗、当前 Trace unload 或 workspace 切换才销毁它们。
- `退出双窗` 会释放视觉窗口，但可以继续保留双 Trace AI 上下文；`退出对比` 会清空 reference Trace。
- 继续提问，例如 `对比当前 trace 和参考 trace 的滑动差异`、`左边启动为什么慢`、`上面的 trace 和下面的 trace 频率差异是什么`。

效果：

- AI 可以在同一次分析中访问 current/reference 两条 raw trace。
- AI Panel 会把 current/reference、left/right、top/bottom、当前激活侧、双窗是否打开、分隔比例、最大化/最小化状态一起传给后端。
- 用户说“左边、右边、上面、下面、current、reference”时，AI 会按当前实际窗口映射解析到对应 Trace；双窗退出后仍可继续用 current/reference 提问。
- 适合临时对比两条已加载或可访问的 Trace。
- 这个模式偏实时分析，不是跨窗口、跨用户的持久结果对比。

完整操作模型见 [双 Trace 工作区操作模型](../architecture/dual-trace-workspace.md)。

## 7. 多 Trace 分析结果对比

多 Trace 分析结果对比用于比较已经完成的 AI 分析结果。它不要求另一个 Perfetto UI 窗口继续打开。

入口：

- 完成至少两次 AI 分析，等 AI Assistant 顶部出现 `Ready result` 或 `Partial result`。
- 快捷方式：直接在 AI 输入框里说 `对比一下另外一份`，或用结果标题旁的 `Result ID` 指定对象，例如 `对比 AR-1234abcd`。
- 点击顶部 `fact_check` 图标打开“分析结果对比”。
- 选择一个 `基线` 和一个或多个 `候选`。
- 可选：把 private 结果 `共享` 为 workspace 可见。
- 可选：点结果行上的 `travel_explore` 查看相似 snapshot / case hint，
  这些 hint 只作为 `navigation_hint_only`。
- 点击 `开始对比`。

效果：

- 输出 baseline/candidate 的标准指标矩阵和 delta。
- 支持启动耗时、FPS/Jank 等可标准化指标。
- 支持 2 个或更多 snapshot。
- 支持在开始正式对比前查看相似历史结果提示，但不会把相似度当作诊断证据。
- 当存在唯一的其他候选结果时，AI 可以直接从自然语言请求触发对比；对象不唯一时会要求选择。
- 输出显著变化数量，并提供 HTML comparison report。

完整说明见 [多 Trace 分析结果对比](multi-trace-result-comparison.md)。

## 8. Android Internals 知识

SmartPerfetto 把 Android Internals 背景知识分成两个明确来源：

- 随 npm、Docker、源码和 portable 分发的签名 Knowledge Pack，离线可用，并可通过
  TUF stable channel 检查或安装更新；
- 用户显式允许的私有 checkout，受路径、权利、provider 同意和请求级 source id
  约束。

入口：

- CLI：`smp knowledge-pack status`、`smp knowledge-pack update --check`。
- AI 分析：内置 Pack 由 runtime 在需要时检索；私有 source 必须在本次请求显式选择。
- 管理 API：`/api/rag/android-internals/*` 只管理私有 checkout。

效果：

- Pack/私有知识只作为 background knowledge，不能伪装成当前 trace 的 SQL/Skill 证据。
- 报告保留来源、版本、fingerprint 和 snippet hash；日志/SSE 不投影正文片段。
- 更新不会让运行中的 session 静默换版本；撤回会要求创建新分析上下文。

完整说明见 [Android Internals 知识包与私有知识库](android-internals-knowledge.md)。

## 9. Code-Aware 本机源码分析

Code-Aware Analysis 允许用户把本机 App、AOSP、kernel 或 OEM SDK 源码注册给 SmartPerfetto。分析时模型默认只看到 `CodeRef` 元数据，不直接接触源码正文。

入口：

- AI Assistant 设置面板中的 `Codebases` 页：preview、register、reindex、audit。
- CLI：`smp codebase preview/register/reindex/symbols`。
- 分析时显式传入 `--code-aware metadata_only` 和 `--codebase-id <id>`，或在 UI 中选择已注册代码库。

效果：

- 把调用栈、native frame 或 kernel symbol 映射到相对文件路径、行号和 symbol。
- 报告展示 `CodeRef`，源码正文只通过受控 excerpt endpoint 临时读取。
- 未给 session 配置 codebase 时，普通 trace-only 分析路径保持不变。

完整说明见 [Code-Aware Analysis](code-aware-analysis.md)。

## 10. Provider 管理和运行时切换

SmartPerfetto 支持在 UI 中管理模型 provider，也支持通过 `.env` 配置。

入口：

- AI Assistant 设置面板中的 `Providers` 页。
- `backend/.env` 或 Docker 根目录 `.env`。
- AI 输入框旁的 provider/runtime 切换入口。

效果：

- 可以接入 Anthropic、Claude/Anthropic-compatible provider、OpenAI/OpenAI-compatible provider。
- UI 中激活的 Provider Manager profile 优先于 `.env`。
- 受保护的 `/api/runtime-health` 会显示当前 credential source，便于排障；
  公开 `/health` 只提供 readiness 与版本。

完整配置见 [配置指南](configuration.md)。

## 11. 受控 Self-Evolution

Self-Evolution 把有效的公开反馈变成可审阅提案，并在固定 validation/holdout case
上配对比较 baseline 与 candidate。功能默认关闭，只面向有权限的维护者和管理员。

入口：

- 普通分析完成后的勾/叉反馈。
- **AI Assistant Settings → 自进化 / Evolution** 控制台。
- `/api/admin/self-evolution` 管理 API。

效果：

- 每次分析用不可变 RunManifest 固定归因和 overlay generation。
- private feedback 只存本地私有路径；只有 effective public feedback 可被显式策展。
- 提案必须通过固定 paired evaluation 并由人接受，才能显式 apply；overlay 可对账、
  可 revert，不会自动 commit、push 或调用 GitHub。
- 未配置包外持久化、缺少权限或 gate 失效时 fail-closed；默认状态不会改变普通分析。

完整操作与验收步骤见 [Self-Evolution 使用与验收](self-evolution.md)。

## 12. Agent 辅助 GitHub 反馈

完成分析后，SmartPerfetto 会从该 run 的持久化回执、证据和运行归因中检测可能值得
反馈或贡献的信号。用户点击后，独立 Agent 判断是否适合公开反馈、影响面是什么、
用户能贡献什么，以及仍缺什么证据。

- 支持当前和历史完成消息，不读取当前 session 的临时 result。
- review 固定到源 run 的 provider/runtime snapshot；不匹配时明确降级，不切换模型。
- Agent 输出必须引用真实 signal/claim/evidence/Skill，并经过固定校验和脱敏。
- private/code-aware 分析禁用公开反馈；安全问题改走 private advisory。
- 只生成可预览 GitHub 草稿，绝不自动提交或触发 Self-Evolution。

操作、隐私边界和测试见
[Agent 辅助 GitHub 反馈](agent-assisted-feedback.md)。

## 13. 自动化、API 和 CLI

除了 UI，SmartPerfetto 也提供 workspace API、CLI 和 MCP 工具，适合自动化场景。

入口：

- Workspace API：[API 参考](../reference/api.md)，用于 batch trace、显式 snapshot
  promotion、comparison bridge 和 trace-config proposal。
- CLI：[CLI 参考](../reference/cli.md)，用于本机 session、batch、capture 和 report
  自动化。
- MCP/Agent host：[MCP 工具参考](../reference/mcp-tools.md)，使用 request-scoped
  工具面接入兼容 host。

效果：

- 可以把 Trace 分析接入脚本、CI、批处理或内部平台。
- `smp batch skill` 可以对有界本机 trace 集运行确定性 Skill 并导出 JSON/HTML；
  workspace batch API 还支持显式 snapshot promotion 和 comparison bridge。
- `smp capture suggest/config` 可无副作用地产生 Android 采集方案，连接设备后再用
  `smp capture android` 抓取；Camera 等 preset 会声明所需证据类别。
- 可以复用相同的 Skill、策略、报告和 evidence-backed 输出机制。

## 14. 运行和分发方式

SmartPerfetto 支持多种运行方式：

| 方式 | 适合谁 | 说明 |
|---|---|---|
| Docker | 普通使用者、快速部署 | 使用已提交的预构建 Perfetto UI，不需要本地构建 submodule |
| 免安装包 | 不想安装 Docker 的用户 | Windows、macOS、Linux 包内带 Node runtime、后端、预构建 UI 和 trace_processor |
| 本地源码运行 | 开发者、调试者 | 使用 `./start.sh` 启动后端和预构建 UI |
| Dev 模式 | 修改 Perfetto UI 插件的人 | 使用 `./scripts/start-dev.sh` 调试 `perfetto/` submodule 前端 |

运行方式见 [快速开始](quick-start.md)，打包发布见 [免安装包打包](../reference/portable-packaging.md)。
宿主系统、实际 target 和“静态验证 / target-native smoke / 已发布验收”的区别见
[平台兼容与验证边界](../reference/platform-compatibility.md)。UI 与 CLI 的应用更新
检查只提示版本和对应动作，不会自动替换当前运行目录；见
[应用更新](application-updates.md)。

## 功能选择建议

| 你想做什么 | 推荐入口 |
|---|---|
| 快速问一个 trace 的事实 | AI Assistant + `fast` |
| 深入分析启动、滑动、ANR | AI Assistant + `full` 或 `auto` |
| 只看某一段时间或某个 slice | Perfetto 选区 + AI Assistant |
| 生成可分享的分析结论 | HTML report |
| 当前对话中临时对比 reference Trace | `compare_arrows` Trace 实时对比 |
| 跨窗口/跨用户对比已完成结果 | `fact_check` 多 Trace 分析结果对比 |
| 查询 Android Internals 背景 | 内置 Knowledge Pack；私有资料用显式 knowledge source |
| 把结论映射到本机源码文件和行号 | Code-Aware Analysis |
| 判断一次分析是否值得反馈、能贡献什么 | 结果下方“让 Agent 帮我判断是否应反馈” |
| 审阅并应用经过门控的分析改进 | 设置 → 自进化 / Evolution |
| 对多条本机 trace 跑同一个确定性分析 | `smp batch skill` |
| 先生成采集配置、再从 Android 设备抓 trace | `smp capture suggest/config/android` |
| 接入脚本或平台 | API / CLI / MCP 工具 |

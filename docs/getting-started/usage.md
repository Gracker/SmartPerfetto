# 基本使用

[English](usage.en.md) | [中文](usage.md)

如果你想先了解 SmartPerfetto 的完整功能边界、入口和输出效果，见 [功能总览](features.md)。
Windows 免安装包从下载到首次分析的连续流程见 [Windows 指南](windows.md)。

## 推荐 trace 内容

SmartPerfetto 最适合 Android 12+ trace，尤其是包含 FrameTimeline 数据的 trace。常用 atrace category：

| 场景 | 最低 category | 建议额外添加 |
|---|---|---|
| 滑动 | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| 启动 | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |
| GPU/渲染 | `gfx`, `view`, `sched` | `freq`, `gpu`, `binder_driver` |

## UI 分析流程

1. 打开运行入口给出的地址；Windows 免安装包使用启动器打印的实际 `Open:` URL，Docker 默认是 `http://localhost:10000`。
2. 加载 `.pftrace` 或 `.perfetto-trace`。
3. 打开 SmartPerfetto AI Assistant 面板。
4. 选择分析模式：对话、快速、完整或智能。
5. 输入自然语言问题。
6. 等待 SSE 流式输出、表格证据和最终结论。

结论正文一生成就会显示，并标注“结论已生成，正在核验”；核验（一次无工具语义复核）
仍在后台进行，完成后同一条消息补上核验结果，正文不会被改写。核验期间点“停止”只结束
核验：结论照常保存，核验状态记为“已按用户要求停止语义复核”（未核验）。再次点“停止”会强制
结束本轮，SmartPerfetto 仍会等待几秒让结论保存；若在这段时间内没能保存，你读到的结论会作为
未核验、不完整的回合保留（使用注册源码或知识库时不保留）。若运行在给出核验结果前出错或中断，
结论保留并标为“未完成核验”。

CLI（`smp run`、`smp ask`、`smp compare`、`smp capture --analyze` 与 REPL）的 Ctrl-C 按回合
同样处理：文本结论打印出来之后，第一次 Ctrl-C 只停止核验，本轮照常保存；结论出现之前或再按一次
Ctrl-C，会中止本轮且不保存（退出码 130，REPL 回到提示符）；继续按 Ctrl-C，或本轮约 2 秒内没有
停下，会立即以 130 退出。`--format json`/`ndjson` 不提前打印结论，第一次 Ctrl-C 即中止。本轮保存之后，
Ctrl-C 不再作用于它。

智能模式会先返回“场景盘点”，按时间顺序列出 trace 中识别到的启动、滑动、点击、导航、设备状态、ANR 等场景，并显示可深钻的范围按钮。选择“全部”或某一类场景后，才会进入对应的启动/滑动/点击等深钻分析。

## 场景还原

加载 Trace 后，选择要使用的 Provider，点击 **场景还原**。系统会调查整个 Trace 中的操作与状态变化，按时间展示每一段“用户在做什么、设备处于什么状态、应用如何响应”。智能模式的场景盘点仍用于选择深钻范围。

查看时间线时，请同时留意未知项、证据检查和覆盖不足的提示。没有记录到输入不代表设备空闲；调查结束也不代表每段操作都已证实。取消、失败或部分结果会保留对应状态，可据此决定是否继续调查或重新录制缺少数据的 Trace。

场景报告默认保留 7 天，只能在仍有权限访问原 Trace 时读取；删除 Trace 后相关报告不可再用。实现和证据边界见[场景还原架构合同](../architecture/scene-reconstruction.md)。

## 先对话，再决定是否分析

`对话` 是默认入口。没有打开 Trace 时，顶部 AI 入口会进入独立对话页；打开
Trace 后，同一个模式会在 AI Assistant 面板中附加当前 Trace。它适合先澄清目标、
讨论性能原理或查询已授权源码。信息不足时会返回一个明确问题；只有确实需要完整
Trace 因果分析时，才会给出可确认的完整分析交接，不会自行启动重型分析。

连续快速发送会复用同一会话并先停止旧 run。新对话、清空对话、切换 Provider、
输出语言、Workspace、源码授权或已附加 Trace 时都会建立新的安全边界。未附加 Trace
的会话没有 Trace 查询工具；注册的本地源码根目录即使尚无索引，也可在授权后按需
搜索和读取，索引只作为图谱/检索加速能力。

达到调查轮次上限时，会在剩余预算内关闭工具并总结已有发现、不足和下一步，结果仍标为
部分完成。后续追问会继承这些限制，并在需要核对细节时回查历史，不必重新描述整个问题。
同一会话支持重新打开和后端重启后的恢复；恢复先校验当前用户、Provider、Trace 与来源授权。
如果保存失败、旧运行被重启打断或部分来源历史不可读取，页面会明确提示。

## 使用分析结果操作

分析结论下方的操作只会在用户点击后执行：**跳到时间点**会把目标时间点居中并
明显缩放，**打开表格**会回到支撑结论的证据行，**收藏证据**会把证据或结果快照保存到
当前会话。输入 `/pins` 可以查看收藏结果；收藏不会固定 Perfetto 时间线泳道，
也不会自动把证据加入后续 AI 上下文。同一份 action 证据只收藏一次。

CLI 的未完成结果会显示原因和具体诊断：没有正文与已有正文但质量校验失败会分别
提示。调查触顶后的有限总结仍标为 `partial` / `max_turns`，请查看未完成项后再用
`smp ask` 继续核查。完整说明见 [CLI 参考](../reference/cli.md#全局选项)。

## Agent 辅助外部反馈

如果完成结果下方出现“可能值得反馈或贡献”的提示：

1. 点击 **让 Agent 帮我判断是否应反馈**。
2. 查看 Agent 的判断、影响面、贡献类型和缺失证据。
3. 回答必答问题，并人工检查待公开内容。
4. 勾选敏感信息复核后生成 GitHub 草稿。
5. 在草稿预览中再次检查，最后手动打开并提交 GitHub Issue。

系统不会自动提交，也不会把这次操作自动变成勾/叉 feedback 或 Self-Evolution
提案。private/code-aware 结果不开放公开反馈；安全问题只走 private advisory。
详见 [Agent 辅助 GitHub 反馈](agent-assisted-feedback.md)。

## Self-Evolution 管理流程

Self-Evolution 默认关闭，不影响上面的分析步骤。完成公开分析后，普通用户可以使用
勾/叉反馈；有权限的管理员可进入 **AI Assistant Settings → 自进化 / Evolution**
查看状态并显式启动策展。

控制台中的标准顺序是：

```text
策展 -> gate -> 检查 before/after 与证据 -> accept/reject
     -> 可选 export -> apply -> 新分析验证 -> revert
```

没有足够有效公开反馈时，“无提案”是正常结果。private feedback 不会进入策展；
apply/revert 还要求部署者启用专用开关和包外持久化目录。完整权限、故障与验收步骤见
[Self-Evolution 使用与验收](self-evolution.md)。

## 常见问题模板

```text
分析滑动卡顿
分析启动性能
帮我看看这个 ANR
这个 trace 的应用包名和主要进程是什么？
这段选区里主线程为什么卡住？
对比基线 trace 和对比 trace 的滑动差异
对比一下另外一份
对比 AR-1234abcd
```

## Raw Trace 实时对比

如果要在同一个对话里直接查询两条 raw trace，点击 AI Assistant 顶部的
`compare_arrows` 打开双窗。左/上是基线，右/下是对比；两个 selector 都可以从
当前 workspace 任意选择 Trace，也可以使用工具栏的“交换”反转比较方向。
之后可以说“对比基线和对比 Trace”或按当前布局说“左边/右边、上面/下面”。

如果当前还没有打开 Trace，也可以先进入 AI Assistant 的无 Trace 页面，点击
`双 Trace` 打开左右都为空的双窗。每一侧都能直接“上传 Trace”；上传成功后文件
保留在当前 workspace，并自动加载到对应 pane。已有 Trace 的 pane 可用“替换文件”。
两侧上传互相独立，分析运行期间会锁定上传和替换。

当前页面 Trace 只是首次打开双窗时的默认基线，不再强制留在 pair 中；两份历史
Trace 也可以直接互相对比。退出视觉双窗后可以保留双 Trace AI 上下文；
“退出对比”才会清空 pair。

最近一次 pair、布局和已完成分析会按 workspace 保存。刷新浏览器或正常重启后，
只要对应 Trace 仍在 workspace，就可以恢复双窗和已有分析/报告；未完成运行会标记为
中断，需要重新发起。
CLI 的等价入口是：

```bash
smp compare baseline.pftrace comparison.pftrace \
  --query "对比启动和滑动差异" --mode full
```

完整交互状态见 [双 Trace 工作区](../architecture/dual-trace-workspace.md)。

## 多 Trace 分析结果对比

如果你已经在两个或更多 Trace 上完成 AI 分析，可以直接在 AI 输入框里说 `对比一下另外一份`。当当前窗口有最新分析结果，并且同一 workspace 里只有一个明确的其他候选结果时，SmartPerfetto 会自动用当前结果作为基线并发起对比。

每份 AI 分析完成后，结果标题旁会显示 `Result ID`，例如 `AR-1234abcd`。如果候选不止一份，或者你想指定对象，可以说 `对比 AR-1234abcd`，也可以说 `对比 AR-11111111 和 AR-22222222`。多个 ID 同时出现时，第一个 ID 会作为基线，后面的 ID 会作为候选。

你也可以用 AI Assistant 顶部的 `fact_check` 入口打开“分析结果对比”。选择一个 `基线` 和一个或多个 `候选` 后，SmartPerfetto 会生成标准指标 delta、显著变化摘要和 HTML 对比报告。

这个功能对比的是已完成分析结果，不要求另一个 Perfetto UI 窗口继续打开。完整操作说明见 [多 Trace 分析结果对比](multi-trace-result-comparison.md)。

## 分析模式选择

| 模式 | 推荐问题 | 不适合的问题 |
|---|---|---|
| 对话 | 澄清需求、性能原理、已授权源码、决定是否需要 Trace 深钻 | 期望立即执行完整 Trace 因果分析 |
| 快速 | 包名、进程、trace 概览、简单数值 | `分析启动性能`、`分析滑动卡顿` 这类重查询 |
| 完整 | 启动、滑动、ANR、复杂渲染根因 | 只问一个简单事实时成本偏高 |
| 智能 | 混合脚本 trace、需要先看场景再决定深钻范围 | 明确只想直接分析单一场景时不如选择完整模式加具体问题 |

fast 模式默认 50 turns，可由 runtime-specific quick-turn 配置覆盖。重型 Skill
仍可能耗尽 turns；复杂性能分析建议直接使用 full。

## 选区与追问

前端会把 area selection 或 track event selection 作为 `selectionContext` 传给后端，其中只包含 Event/Track 身份与时间边界。卡片展示查询不会作为隐藏证据发送；后端会重新查询名称、线程、进程与异常状态。适合这样问：

```text
只看我选中的这段时间，为什么 UI thread 变慢？
这个 slice 前后有没有 Binder 或调度问题？
```

多轮追问会复用 session。切换 conversation/fast/full/auto 模式会开启新的 SDK session，避免轻量上下文和完整上下文混用。

`/anr` 和 `/jank` 使用与普通分析相同的后端证据、claim verification 和报告链路；AI 被策略禁用时，这两个命令也会被阻止。

## 源码与 Android Internals 背景

- 要把 trace 结论映射到本机源码，先在 UI `Codebases` 或 CLI
  `smp codebase preview/register` 注册，再在本次分析显式选择 codebase。注册的 live root 无索引也能有界搜索/读取；`reindex` 只是可选加速。
- 内置 Android Internals Knowledge Pack 随产品分发；用
  `smp knowledge-pack status` 查看版本，用 `update --check` 只检查更新。
- 私有 Android Internals checkout 与内置 Pack 不同，必须配置路径 allowlist、
  权利确认、provider 同意，并在请求中选择 source id。

源码和知识背景都不能替代当前 trace 的 SQL/Skill 证据。Code-Aware 默认只给模型
`CodeRef`；完整边界见 [Code-Aware](code-aware-analysis.md) 和
[Android Internals 知识](android-internals-knowledge.md)。

选中源码后，full 分析会先用 Trace/Skill/SQL 确认发生事实。如果存在可查询的符号、slice、Binder 描述符或 build-id 锚点，它必须进行有界源码 lookup；否则留下 `not_needed`、`disallowed`、`no_queryable_anchor` 等结构化原因。分析结果中的源码回执会区分已选、已查询和实际使用的 codebase，并标明 coverage 与 `corroborated|compatible|ambiguous|unverified` 机制状态。Trace 证明“发生了什么”，`CodeRef` 解释“实现上为什么可能发生”；只有 `CodeRef` 时不能把 trace 现象升级为已验证根因。

Web chat 只保留安全的折叠回执，不包含文件路径、源码片段、检索 query 或自由文本原因。HTML report、CLI artifact 和 snapshot/API 可保留安全的相对 `CodeRef` 与绑定，但同样不保留绝对 root 或源码正文。

## CLI Batch 与 Android Capture

确定性批处理不需要 LLM：

```bash
smp batch skill startup_analysis launch-a.pftrace launch-b.pftrace \
  --json-out batch.json --out batch.html
```

Android 采集先生成无副作用建议/配置，再连接设备抓取：

```bash
smp capture suggest "分析 Camera 打开到首帧预览延迟" \
  --app com.example.camera
smp capture config --preset camera --app com.example.camera \
  --duration 20 --out camera.pbtxt
smp capture android --config camera.pbtxt --out camera.perfetto-trace
```

`suggest` / `config` 不会访问设备；只有 `capture android` 会通过 adb/tracebox
实际采集。命令、平台和 `--analyze` 边界见 [CLI 参考](../reference/cli.md)。

## 输出怎么看

SmartPerfetto 的回答通常包含三类证据：

- SQL 结果：直接来自 `trace_processor_shell`。
- Skill 结果：来自 `backend/skills/` 的 YAML 分析流水线，按 L1-L4 分层展示。
- Agent 结论：LLM 基于 SQL、Skill、策略和 verifier 输出的中文解释。

结论应该能追溯到表格、时间段、线程、slice 或 Skill 结果。无法被 trace 数据支撑的建议，不应作为确定结论。

多项指标、阶段耗时、排行和双 Trace 差异适合在结论中用紧凑 Markdown 表格展示，
随后解释机制、影响和限制。结论表格是证据摘要，不是上方中间结果表的全量复制；
数值仍须有原始引用，单位、两侧身份、时间窗与变化方向应明确。缺失值不视为零，
不适合比较的数据不强行计算差值或比例。表格不替代重要发现与因果解释。

结论是主要交付内容：先概括，再完整说明重要发现、依据和不确定性。快速/完整预算不会切换成不同的结论合同，也不限定结论字数、表格行数或声明数。中间表格预览限制只影响展示。模型仍能获得全部证据条目的索引，按需读取后续结果；空结果与未采集状态也会保留。若模型输出或核验达到实际容量限制，结果会明确标记不完整，不会把前半段冒充完整、已核验的结论。

## 生成报告

agent 分析完成后，后端会生成 HTML report。UI 使用 `/api/agent/v1/:sessionId/report` 读取报告地址；通用报告接口位于 `/api/reports/:reportId`。

## 如何阅读系统调查结果

系统分析适用于相关性能场景。每轮先确定目标任务、时间窗口和依赖，再解释频率、系统占用、四象限、抢占及调度信息中与问题有关的部分。大小核比例与任务优先级是观测值；没有直接证据时，不能据此断言调度策略、抢占原因或瓶颈。

界面、HTML 报告和 CLI 分别显示“系统调查覆盖”和“系统证据覆盖”。前者说明回答是否解释了适用维度，后者说明是否具备对应的可信采集记录。已核验的解释可以明确指出证据不足。历史结果缺少这些字段时显示“尚未核验”；恢复或比较已保存结果不会自动重新读取 trace。限定问题与只使用已有证据的请求仍遵守原范围。

# 基本使用

[English](usage.en.md) | [中文](usage.md)

如果你想先了解 SmartPerfetto 的完整功能边界、入口和输出效果，见 [功能总览](features.md)。

## 推荐 trace 内容

SmartPerfetto 最适合 Android 12+ trace，尤其是包含 FrameTimeline 数据的 trace。常用 atrace category：

| 场景 | 最低 category | 建议额外添加 |
|---|---|---|
| 滑动 | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| 启动 | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |
| GPU/渲染 | `gfx`, `view`, `sched` | `freq`, `gpu`, `binder_driver` |

## UI 分析流程

1. 打开 `http://localhost:10000`。
2. 加载 `.pftrace` 或 `.perfetto-trace`。
3. 打开 SmartPerfetto AI Assistant 面板。
4. 选择分析模式：快速、完整或智能。
5. 输入自然语言问题。
6. 等待 SSE 流式输出、表格证据和最终结论。

智能模式会先返回“场景盘点”，按时间顺序列出 trace 中识别到的启动、滑动、点击、导航、设备状态、ANR 等场景，并显示可深钻的范围按钮。选择“全部”或某一类场景后，才会进入对应的启动/滑动/点击等深钻分析。

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
对比当前 trace 和参考 trace 的滑动差异
对比一下另外一份
对比 AR-1234abcd
```

## Raw Trace 实时对比

如果要在同一个对话里直接查询两条 raw trace，点击 AI Assistant 顶部的
`compare_arrows`，打开 current + reference 双窗并选择一条 workspace 历史 Trace。
之后可以说“对比当前 trace 和参考 trace”或按当前布局说“左边/右边、上面/下面”。

双窗只支持当前页面 current trace 加一条历史 reference，不支持任意两个历史 Trace。
退出视觉双窗后可以保留 current/reference AI 上下文；“退出对比”才会清空 reference。
CLI 的等价入口是：

```bash
smp compare current.pftrace reference.pftrace \
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
| 快速 | 包名、进程、trace 概览、简单数值 | `分析启动性能`、`分析滑动卡顿` 这类重查询 |
| 完整 | 启动、滑动、ANR、复杂渲染根因 | 只问一个简单事实时成本偏高 |
| 智能 | 混合脚本 trace、需要先看场景再决定深钻范围 | 明确只想直接分析单一场景时不如选择完整模式加具体问题 |

fast 模式默认 50 turns，可由 runtime-specific quick-turn 配置覆盖。重型 Skill
仍可能耗尽 turns；复杂性能分析建议直接使用 full。

## 选区与追问

前端会把 area selection 或 track event selection 作为 `selectionContext` 传给后端。适合这样问：

```text
只看我选中的这段时间，为什么 UI thread 变慢？
这个 slice 前后有没有 Binder 或调度问题？
```

多轮追问会复用 session。切换 fast/full/auto 模式会开启新的 SDK session，避免轻量上下文和完整上下文混用。

## 源码与 Android Internals 背景

- 要把 trace 结论映射到本机源码，先在 UI `Codebases` 或 CLI
  `smp codebase preview/register/reindex` 注册，再在本次分析显式选择 codebase。
- 内置 Android Internals Knowledge Pack 随产品分发；用
  `smp knowledge-pack status` 查看版本，用 `update --check` 只检查更新。
- 私有 Android Internals checkout 与内置 Pack 不同，必须配置路径 allowlist、
  权利确认、provider 同意，并在请求中选择 source id。

源码和知识背景都不能替代当前 trace 的 SQL/Skill 证据。Code-Aware 默认只给模型
`CodeRef`；完整边界见 [Code-Aware](code-aware-analysis.md) 和
[Android Internals 知识](android-internals-knowledge.md)。

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

## 生成报告

agent 分析完成后，后端会生成 HTML report。UI 使用 `/api/agent/v1/:sessionId/report` 读取报告地址；通用报告接口位于 `/api/reports/:reportId`。

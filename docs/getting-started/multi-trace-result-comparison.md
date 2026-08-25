# 多 Trace 分析结果对比

[English](multi-trace-result-comparison.en.md) | [中文](multi-trace-result-comparison.md)

这是 SmartPerfetto 的一个专项功能。完整功能地图见 [功能总览](features.md)。

多 Trace 分析结果对比用于比较已经完成的 AI 分析结果，而不是要求两个 Trace 同时在同一个 Perfetto UI 窗口里保持打开。它适合 A/B 测试、版本回归、启动耗时对比、滑动 FPS/Jank 对比，以及多人协作时复用同一 workspace 里的分析结论。

## 它解决什么问题

双 Trace 对比偏向实时分析：用户在同一 workspace 任意选择基线/对比两条 raw trace，AI 在一次对话里同时查询两侧。分析结果对比则偏向“结果复用”：每次 AI 分析完成后，SmartPerfetto 会把可对比的关键指标、证据引用、报告入口保存成 analysis result snapshot。之后你可以选择 2 个或更多 snapshot 做横向对比。

这意味着：

- 窗口 B 不需要一直打开。
- 两个 trace processor 不需要同时 active。
- 同一个 Trace 的多次分析结果也可以互相对比。
- 同一 workspace 中可见的其他用户分析结果也可以参与对比。

## 什么时候使用

适合使用分析结果对比的场景：

- 同一个 APK 两个版本的启动速度对比。
- 同一个页面两次滑动录制的 FPS、Jank、卡顿原因对比。
- A/B/C 三次测试结果横向比较。
- 同一个 Trace 先后用不同问题分析，想比较输出的标准指标和证据。
- 团队成员已经分析过一个 Trace，你想把当前结果和他的结果放在一起看。

如果你只是想在当前 AI 对话里临时选择两条 raw trace，让 AI 同时查两边数据，仍然可以使用工具栏里的 `compare_arrows` 实时对比入口。分析结果对比入口是 `fact_check` 图标。

## 前置条件

1. SmartPerfetto 后端已经启动，并且 AI provider 可以正常使用。
2. 至少完成过两次 AI 分析，或者同一 workspace 中已经有其他可读的分析结果。
3. 需要跨用户共享时，对方需要把结果设为 workspace 可见；默认结果是 private。

AI 分析完成后，AI Assistant 顶部会显示 `Ready result` 或 `Partial result`。这表示当前窗口最近一次分析已经生成 snapshot，可以作为后续对比输入。

## 操作流程

### 方式一：直接在 AI 输入框里说

每份 AI 分析完成后，结果标题旁会显示一个 `Result ID`，例如 `AR-1234abcd`。这个 ID 是当前 analysis result snapshot 的短引用，后续可以直接复制或输入到任意同 workspace 的 AI Assistant 窗口里。

常用说法：

```text
对比一下另外一份
对比 AR-1234abcd
对比 AR-11111111 和 AR-22222222
```

规则：

- `对比一下另外一份`：当前窗口有最新结果，并且同一 workspace 中只有一个明确的其他候选结果时，SmartPerfetto 会用当前结果作为基线，另一个结果作为候选。
- `对比 AR-1234abcd`：用当前窗口最新结果作为基线，指定的 `Result ID` 作为候选。
- `对比 AR-11111111 和 AR-22222222`：第一个 `Result ID` 作为基线，后面的 `Result ID` 作为候选。
- 如果有多个可能的“另外一份”，或者 ID 无法唯一匹配，SmartPerfetto 会要求你选择对比对象，而不是猜测。

这个入口仍然对比持久化的分析结果 snapshot。另一个 Perfetto UI 窗口不需要继续打开；如果窗口仍打开，SmartPerfetto 只会把它的最新结果作为更明确的候选线索。

### 方式二：用结果选择器

1. 打开第一个 Trace，完成一次 AI 分析，例如“分析启动性能”。
2. 打开第二个 Trace，完成另一次 AI 分析，例如“分析启动性能”或“分析滑动 FPS”。
3. 回到任意一个窗口，打开 AI Assistant 顶部的 `fact_check` 图标，标题是“分析结果对比...”。
4. 在右侧“选择分析结果”面板里选择一个 `基线`，再选择一个或多个 `候选`。
5. 如果候选结果是 private 且你希望 workspace 内其他人也能用，点击该结果上的 `共享`。
6. 可选：在 AI 输入框里先写关注点，例如“重点看启动速度和 FPS”，再点击 `开始对比`。
7. 等待 SmartPerfetto 返回对比结果。

结果选择器会展示每条结果的场景、原始问题、Trace 信息、创建时间、创建者、指标数量、证据引用数量和可见性。当前窗口最近的结果会标记为 `Current`，仍打开的窗口结果会标记为 `Open`。

如果你不确定该选哪份历史结果，可以先点结果行上的 `travel_explore`
相似结果按钮。SmartPerfetto 会显示相似 snapshot 或 case-library hint，
并标记为 `navigation_hint_only`。这些 hint 只用于帮助你决定下一步查看或对比
哪份结果，不会作为当前 trace 的诊断证据。

## 输出会包含什么

对比完成后，AI Assistant 会追加一条“分析结果对比已完成”消息，通常包含：

- Comparison ID。
- baseline 和 candidates。
- Significant changes 数量。
- 启动、FPS、Jank 等标准指标的 baseline 值、candidate 值和 delta。
- 指向完整 HTML 报告的导出链接。

完整 HTML 报告会展开更多指标、输入 snapshot、显著变化和 AI 结论。聊天消息只展示前几行重点指标，完整内容以报告为准。

## 支持的指标

当前版本会优先对比已经标准化的指标，重点覆盖：

- 启动相关指标，例如启动耗时。
- 滑动/帧率相关指标，例如 average FPS、Jank、慢帧。
- 其他可从分析结果中抽取或回填的标准 metric。

如果某个 snapshot 缺少对比所需的标准指标，后端可以尝试从原 Trace 回填。回填失败时，对比仍会完成，但结果会标注缺失原因，不会把没有证据的数值当成确定结论。

## 权限与共享

分析结果默认是 private，只对创建者可见。点击结果上的 `共享` 后，该 snapshot 会变成 workspace 可见，具备权限的同 workspace 用户可以读取并用于对比。

跨 workspace 的结果不会出现在结果选择器中。切换 workspace 后，当前窗口结果、候选结果和对比状态都会按 workspace 重新隔离。

## 常见问题

### 为什么结果选择器为空？

通常是因为当前 workspace 还没有完成过 AI 分析，或者已有结果仍是其他用户的 private 结果。先完成一次 AI 分析，等顶部出现 `Ready result` 或 `Partial result` 后再打开结果选择器。

### `Ready result` 和 `Partial result` 有什么区别？

`Ready result` 表示 snapshot 中已经有可对比的标准指标。`Partial result` 表示分析结果已经保存，但标准指标覆盖不完整。Partial 结果仍可以参与对比，只是部分指标可能显示缺失或需要回填。

### 它和旧的 Trace 对比有什么区别？

入口 `compare_arrows` 是 Trace 实时对比，适合从当前 workspace 任意选择基线/对比 Trace，让 AI 在一次对话里同时查询两条 raw trace。

新入口 `fact_check` 是分析结果对比，适合多个窗口、多用户、已经完成的分析结果。它依赖后端持久化 snapshot，不依赖另一个 Perfetto UI 窗口继续存活。

### 能不能对比三个以上 Trace？

可以。选择一个 baseline，再选择多个 candidates，就可以得到多结果横向矩阵。

### `Result ID` 找不到或匹配到多份怎么办？

确认 ID 是否来自同一个 workspace，并且你对该结果有读取权限。`AR-...` 是短引用，只要能唯一匹配即可；如果短引用不唯一，使用更长的 `Result ID` 或打开 `fact_check` 结果选择器手动选择。

### 能不能只看显著变化？

对比 API 支持 significant-only 视图。UI 默认消息会显示显著变化数量和前几行关键指标，完整筛选能力会继续在报告和后续 UI 中增强。

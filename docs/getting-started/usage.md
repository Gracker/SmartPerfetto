# 基本使用

[English](usage.en.md) | [中文](usage.md)

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

## 常见问题模板

```text
分析滑动卡顿
分析启动性能
帮我看看这个 ANR
这个 trace 的应用包名和主要进程是什么？
这段选区里主线程为什么卡住？
对比当前 trace 和参考 trace 的滑动差异
```

## 分析模式选择

| 模式 | 推荐问题 | 不适合的问题 |
|---|---|---|
| 快速 | 包名、进程、trace 概览、简单数值 | `分析启动性能`、`分析滑动卡顿` 这类重查询 |
| 完整 | 启动、滑动、ANR、复杂渲染根因 | 只问一个简单事实时成本偏高 |
| 智能 | 日常默认选择 | 对成本或深度有硬要求时不如显式选择 |

fast 模式默认 10 turns。重型 Skill 可能返回较大的 JSON，仍可能耗尽 turns；复杂性能分析建议直接使用 full。

## 选区与追问

前端会把 area selection 或 track event selection 作为 `selectionContext` 传给后端。适合这样问：

```text
只看我选中的这段时间，为什么 UI thread 变慢？
这个 slice 前后有没有 Binder 或调度问题？
```

多轮追问会复用 session。切换 fast/full/auto 模式会开启新的 SDK session，避免轻量上下文和完整上下文混用。

## 输出怎么看

SmartPerfetto 的回答通常包含三类证据：

- SQL 结果：直接来自 `trace_processor_shell`。
- Skill 结果：来自 `backend/skills/` 的 YAML 分析流水线，按 L1-L4 分层展示。
- Agent 结论：LLM 基于 SQL、Skill、策略和 verifier 输出的中文解释。

结论应该能追溯到表格、时间段、线程、slice 或 Skill 结果。无法被 trace 数据支撑的建议，不应作为确定结论。

## 生成报告

agent 分析完成后，后端会生成 HTML report。UI 使用 `/api/agent/v1/:sessionId/report` 读取报告地址；通用报告接口位于 `/api/reports/:reportId`。

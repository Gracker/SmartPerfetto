<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android 17 渲染锚点使用规则

锚点用于组织取证；当前路径以实际 Producer、资源去向与显示对象为准。
产品 catalog 提供精简教学，不以静态步骤表代替 Trace 身份关联。

## 先画实际对象树

先确认 Producer、最终可见 Surface/layer、宿主回流、独立 child layer、
BufferQueue/transaction 与 display。Flutter PlatformView、Camera、WebView、
多窗口和视频页面都可能同时存在多条节拍，不能把某个框架线程当成唯一帧。

## 再对齐四段时间

1. **触发与生产**：VSync/callback、main/UI、framework/engine、RenderThread 或
   自定义 producer；
2. **提交与可读**：dequeue、GPU/CPU work、queue/transaction、acquire fence；
3. **采纳与合成**：SF state/latch、layer snapshot、RenderEngine/HWC 分工；
4. **显示反馈**：present/release fence 与下一轮 buffer 复用。

每个结论都要引用实际 slice、thread/process、layer/buffer/token 和时间戳。
`queueBuffer` 完成不等于 SF 已采纳，SF 已采纳不等于 display 已 present，
present feedback 也不等于 panel 光学完成或用户感知。

## Android 12—17 边界

- Android 12 是现代 BLAST/FrameTimeline 分析基线，不是“Legacy 默认”。
- Android 13 的 latch-unsignaled 让部分 fence wait 后移；等待并未消失。
- Android 17 的 HWC 流程需按 `presentOrValidate` 实际分支解释；不要套用
  无条件 validate 序列。
- 框架/engine/provider 随 App 发布时，要同时记录 Android build 与对应版本。

## 归因纪律

- 先定位是哪一段晚，再找该段的 Running、Runnable、Blocked、GPU 或 fence
  证据；
- absence 只能写成缺失或未采集，不能写成“没有该机制”；
- feature 信号不能覆盖主类型证据；
- 类型特有的最小证据和误判边界需结合 catalog 卡片及实际采集覆盖确认。

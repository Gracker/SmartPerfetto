<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 渲染路径识别与教学

产品教学来自 `backend/skills/pipelines/index.yaml` 的精简卡片；检测信号和
分析建议由各 Pipeline Skill 维护。卡片解释机制，Trace SQL 建立本次事实。

## 分类与归属

先确定内容 Producer、资源去向、Window/layer 与 Display，不给整个 App 贴永久标签。
框架、内容场景和 Surface 承载不是互斥维度，同一页面可能经过多条生产和采样路径。
只有 catalog 中 `variant` 且 `primary_eligible` 的条目参与主类型排名。
PiP、多窗口、VRR、Video Overlay、ANGLE、ImageReader 等 feature 只能补充证据。
知识专题不自动成为检测项，版本号也不能替代启用状态和实际路径证据。

## 身份先于时间

- 保留进程实例 UPID、目标 Window/layer/queue 与 frame/buffer/token 身份。
- slot、GraphicBuffer ID、队列 frame number、surface/display token 不按数值相等连接。
- 仅时间相邻或重叠的 slice 不能证明内容交接；sched 唤醒和 critical path 也不等同 buffer 流。
- TextureView 输入与宿主窗口输出分别分析；SurfaceView 容器属性与承载 buffer 的 child 分开。

## Buffer 与完成

标准窗口的 BQ Consumer 是 App 内 BLAST；SF 接收含 buffer 的 transaction。
queueBuffer 返回、BLAST acquire、SF pending、latch、GPU 可读、present 和 release
分别回答不同问题。同步协调可能在 App 或协调者处持有 transaction。
BufferTX 上升只说明 server 收到 update；下降可能 latch 或 drop；不是 GPU-ready
库存、生产帧数或已显示帧数。FREE slot 仍可受旧读者的 release fence 约束。
Android 13+ latch-unsignaled 只移动等待位置，不取消安全依赖。
HWC `presentOrValidate` 成功时可能已经 present，不能再补一次必然的 present。

## 命名与可见性

新旧 WebView functor 名按 draw/sync/postDraw 分开；init/reparent 不计 draw。
RN `mqt_js` / `mqt_v_js` 只定位 JS 工作，Fabric/Paper 仍需阶段证据。
Chrome Viz 可在 `:privileged_process0`，线程名可截断为 `VizCompositorTh`。
用户构建缺 Vulkan tracing、App tracing 未启用或内部 category 未采集时，空结果
代表可见性缺口，不据此排除机制。缺 FrameTimeline 也不等于流畅。

## 量化边界

使用本次 expected timeline、实际刷新条件和内容 cadence，不能固定所有帧为16.67ms。
SF actual 包含显示栈时间，不全是 SF CPU；RenderThread duration 不是 GPU 执行时间。
媒体低 cadence、系统属性动画和前缓冲更新不要求每个刷新周期有新宿主 buffer。
present feedback 只是显示栈锚点，不证明 panel 光学完成或某个输入点已经可见。
输入到上屏需真实事件、内容与显示映射，不能用最近 doFrame/present 自行拼接。

双出口、录屏、前缓冲和系统转场按需调用 `lookup_knowledge(topic="rendering-outputs")`。
分别定义预览 present、虚拟输出可读和编码 sample/muxer 完成，不能共用 frame done。
输出时依次说明类型候选、实际路径证据、附加 feature、缺失信号、机制解释和后续取证。

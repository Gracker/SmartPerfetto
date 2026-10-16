<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android 17 出图类型知识路由

渲染教学的唯一文章真相是 `docs/rendering_pipelines/S01-S14`，固定到
`Gracker/rendering_pipelines@043074f775d03551b4f9d068b4296e70258b3571`。
平台锚点是 Android 17 / API 37 `android-17.0.0_r1`，kernel 锚点是
`android17-6.18-2026-06_r6`；文章同时说明 Android 12—17 差异。

## 两层分类契约

先报告用户可理解的出图类型，再报告机器检测子路径：

1. `S02_AOSP_STANDARD` 到 `S14_REACT_NATIVE` 是 13 个具体知识类型；
2. `backend/skills/pipelines/index.yaml` 将 31 个检测项标为 `variant` 或
   `feature`；
3. 只有 `variant` 能参与主出图类型排名；PiP、多窗口、VRR、Video
   Overlay、ANGLE、SurfaceControl、ImageReader、HardwareBufferRenderer 和
   SF software composition 等正交/实现证据不能单独成为主类型；
4. `S01_OVERVIEW` 是共同识别方法，不是可检测的具体类型。

不要从类型知识反推 trace 一定包含某条路径。没有 Producer、Surface 或
layer、BufferQueue/transaction 等最小证据时，必须写“证据缺失”，不能用
Android 版本、框架版本或常见默认值代替证据。

## 文章路由

| 类型 | 文章 | 典型检测子路径 |
|---|---|---|
| AOSP 标准 | S02 | Standard BLAST/Legacy、Compose |
| SurfaceView | S03 | `SURFACEVIEW_BLAST` |
| TextureView | S04 | `TEXTUREVIEW_STANDARD` |
| 混合出图 | S05 | `ANDROID_VIEW_MIXED` |
| 多窗口 | S06 | Multi-window、PiP/freeform feature |
| Software / 离屏 | S07 | Software、HBR、ImageReader、SurfaceControl evidence |
| Native Graphics | S08 | GLES、Vulkan、ANGLE evidence |
| WebView | S09 | Functor、SurfaceControl、SurfaceView/TextureView wrapper、Chrome Viz |
| Flutter | S10 | SurfaceView Impeller/Skia、TextureView |
| Camera | S11 | `CAMERA_PIPELINE` |
| Video Overlay / HWC | S12 | `VIDEO_OVERLAY_HWC` feature |
| Game | S13 | `GAME_ENGINE` |
| React Native | S14 | Old Arch、Fabric、Skia renderer |

具体边界、版本变化、源码入口、Mermaid、性能模式和最小证据集都从所选文章
读取，不在本模板复制维护。

## 辅助证据轴

`pipeline_4feature_scoring` 这个 ID 为兼容保留。Producer、layer 数、提交
路径、额外节奏源是辅助解释轴，不是最新版 S01 的规范分类法，也不能仅凭
四轴同时命中就确定类型。必须与目标文章的最小证据集交叉验证。

## Android 17 关键语义

- HWC 路径存在 `presentOrValidate` 分支；不要无条件叙述
  `validateDisplay → acceptDisplayChanges → presentDisplay`。
- Android 13 起 latch-unsignaled 改变等待发生的位置，不能把“latch 时没等”
  解释为 fence 不再需要。
- S01 当前列出六类瓶颈模式，包含安全/受保护内容的合成约束；不要沿用旧的
  五模式清单。
- present fence 是 Android 显示栈时间锚点。它不是 panel 光学响应、像素完全
  稳定或用户主观感知时刻的证明。

## 输入到上屏的测量边界

`android_input_events` 只把输入关联到接收该事件的 UI 线程上的
`Choreographer#doFrame`：与投递相交为精确关联；否则取之后的下一个 doFrame，
标为 `is_speculative_frame=1`。`end_to_end_latency_dur` 再取该帧之后同进程
第一个未丢弃的 app 层 FrameTimeline 帧的 present。

- 画面由其他线程或 producer 产出时（SurfaceView、Native Graphics、Flutter
  SurfaceView、Game），推测关联到的宿主 doFrame 不是出图帧。进程没有 app 层
  FrameTimeline 时 `end_to_end_latency_dur` 为 NULL：输入到上屏在该 trace 中
  不可测量，不是 0，也不是正常。
- 经宿主帧合成的 TextureView（含 Flutter TextureView）可能有 e2e 值；若来自推测
  关联，它只是候选值，不是该事件的实测上屏时间。
- 不要用 producer 帧节奏、宿主 doFrame 和 SF present 自行拼出端到端延迟来填补缺口。

## 输出顺序

1. 出图类型、置信度、文章路径；
2. 检测子路径及其 trace 证据；
3. 正交 feature，明确它们不参与主类型排名；
4. 缺失证据与仍不能确认的边界；
5. 从文章提取的线程、对象树、fence 和版本差异教学；
6. 建议的下一步 SQL/Skill。

<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: media
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: media_critical_path
      domain: critical_path
      description: "Identify audio, codec, camera, renderer and service tasks and their buffer deadlines. Bind producer/consumer roles across authorized processes; keep each task priority observation separate from actual scheduling policy."
    - id: media_dependencies
      domain: dependency_chain
      description: "Follow buffer queue, service/Binder, GPU and display dependencies for underrun or late-frame explanations. Missing scheduler policy is unknown and never proof that RT should be enabled."
classification_description: "Audio, video and camera pipelines, decoding, playback or capture behavior and performance."
priority: 6
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - frame_rendering
  - gpu
  - gpu_work_period
  - power_rails
keywords:
  - 视频
  - 音频
  - 解码
  - 编码
  - media
  - codec
  - video
  - audio
  - decoder
  - encoder
  - mediacodec
  - codec2
  - omx

---

#### media Core Strategy

**Route card**: 视频 / 音频 / 解码 / 编码 / media / codec / video / audio / decoder / encoder

**Capabilities**: required=[cpu_scheduling], optional=[frame_rendering, gpu, gpu_work_period, power_rails]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- codec_activity: 媒体场景必须检查 codec/buffer 活动或明确说明 trace 缺少媒体信号 (required: invoke_skill(media_codec_activity))
- render_or_power_context: 媒体卡顿/耗电问题需要补充渲染、GPU 或功耗上下文 (requires one of: invoke_skill(gl_standalone_swap_jank), invoke_skill(android_gpu_work_period_track), invoke_skill(power_consumption_overview))

**Phase reminders**
- codec_activity: 优先调用 media_codec_activity 检查 codec/buffer 事件。该 skill 基于 slice 信号；缺 codec trace 时必须标注数据不足。 工具: media_codec_activity
- media_rendering_power: 视频/媒体卡顿需要结合 frame/GL/GPU/power 证据：必要时调用 scrolling_analysis、gl_standalone_swap_jank、android_gpu_work_period_track、power_consumption_overview。 工具: media_codec_activity, gl_standalone_swap_jank, android_gpu_work_period_track, power_consumption_overview

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `media:full`: 媒体 / Codec 分析 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="media full strategy detail" keywords="media,视频,音频,解码,编码,media,codec,video,audio,decoder,encoder,mediacodec,codec2,媒体 / Codec 分析,detail,full" default="true" -->
#### 媒体 / Codec 分析

当前公开 stdlib index 没有稳定的 Android codec 专用表，因此媒体基础分析先基于 `slice` / `thread` 信号识别 MediaCodec、Codec2、OMX、CCodec 和 buffer API。

**Phase 1 — Codec 活动与慢事件：**

```
invoke_skill("media_codec_activity", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

重点看 `dequeueInputBuffer` / `queueInputBuffer` / `dequeueOutputBuffer` / `releaseOutputBuffer` 是否出现长耗时，以及 codec 线程是否集中在某个窗口。

**Phase 2 — 渲染/GPU/功耗上下文：**

| 问题 | 调用 |
|---|---|
| 视频掉帧但 codec 正常 | `invoke_skill("gl_standalone_swap_jank")` 或按场景切回 scrolling strategy |
| GPU active region 连续或异常 | `invoke_skill("android_gpu_work_period_track")` |
| 媒体播放耗电 | `invoke_skill("power_consumption_overview")` |

输出时必须标注媒体 trace 信号来源。如果 codec slices 不存在，只能说明当前 trace 不支持媒体归因，并给出采集建议。
<!-- /strategy-detail -->

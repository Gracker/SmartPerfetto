<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: pipeline
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: pipeline_critical_path
      domain: critical_path
      description: "Follow the selected producer, RenderThread, BufferQueue, SF/HWC and presentation stages. Bind task and frame/buffer identities before attributing CPU waits or work to a pipeline delay."
    - id: pipeline_dependencies
      domain: dependency_chain
      description: "Distinguish GPU work/fence, transaction, latch, present and visibility. CPU slice totals are not GPU execution time; missing fence/present events limit attribution."
classification_description: "Identifying the application rendering architecture and the path from frame production to composition and presentation."
priority: 4
effort: medium
required_capabilities:
  - frame_rendering
optional_capabilities:
  - surfaceflinger
  - gpu
keywords:
  - 管线识别
  - pipeline识别
  - 渲染路径
  - 渲染管线检测
  - 管线类型
  - pipeline detection
  - rendering pipeline
  - render path
  - architecture detection
  - 渲染架构检测
  - 帧渲染路径
  - frame path
  - BufferQueue
  - BLASTBufferQueue
  - BLAST
  - dequeueBuffer
  - queueBuffer
  - acquire fence
  - present fence
  - release fence
  - refresh rate policy
  - 刷新率策略
  - ARR
  - VRR
  - setFrameRate
  - HWC overlay

final_report_contract:
  required_sections:
    - id: rendering_stage_split
      label: 渲染/显示阶段拆分
      description: '把 Main/UI、RenderThread、BufferQueue、SurfaceFlinger、HWC/display 与 FrameTimeline/VSync 口径分开。'
      pattern_groups:
        - ['渲染/显示阶段拆分', '阶段拆分', 'stage\s+split', 'Main\s*/\s*UI', 'UI\s*/\s*Main', '主线程', 'RenderThread']
        - ['BufferQueue', 'SurfaceFlinger', '\bSF\b', '\bHWC\b', 'display', '显示']
        - ['FrameTimeline', 'VSync', 'queueBuffer', 'dequeueBuffer', 'commit', 'composite', 'present']
    - id: buffer_fence_boundary
      label: BufferQueue/Fence 边界
      description: '区分 producer queue/dequeue、SF acquire/latch、BLAST transaction、acquire/present/release fence，避免把 queueBuffer 等同上屏。'
      condition:
        kind: semantic
        description: '当问题要求分析图形缓冲区的生产、交接、消费、背压或同步 fence，或判断缓冲区提交与实际显示的关系时适用。'
      pattern_groups:
        - ['BufferQueue/Fence', 'BufferQueue', 'BLAST', 'queueBuffer', 'dequeueBuffer', 'latch']
        - ['acquire', 'present', 'release', 'fence', 'Fence', 'Transaction', 'backpressure', '背压', '槽位']
        - ['不等于', '不能', '不可', '区分', '边界', 'separate', 'not']
    - id: graphics_memory_policy_boundary
      label: 图形内存/刷新策略边界
      description: '当问题涉及 GraphicBuffer/dma-buf、图形内存、refresh-rate/ARR/VRR 或 HWC/SF policy 时，说明证据来源、缺口和版本/设备边界。'
      condition:
        kind: semantic
        description: '当问题涉及图形缓冲区或 GPU 内存、刷新率选择、自适应刷新，或系统显示合成策略及其设备差异时适用。'
      pattern_groups:
        - ['GraphicBuffer', 'dma[-_ ]?buf', 'graphics\s+memory', '图形内存', '刷新率', 'refresh[-\s]?rate', 'ARR', 'VRR', 'SurfaceFlinger', '\bSF\b', '\bHWC\b', 'overlay', 'composition', 'composite', '合成']
        - ['图形内存/刷新策略边界', 'graphics\s+memory\s+boundary', 'refresh\s+policy\s+boundary', 'policy', '策略', '缺失', 'missing', '边界', 'confidence', '置信度']

---

#### pipeline Core Strategy

**Route card**: 管线识别 / pipeline识别 / 渲染路径 / 渲染管线检测 / 管线类型 / pipeline detection / rendering pipeline / render path / architecture detection / 渲染架构检测

**Capabilities**: required=[frame_rendering], optional=[surfaceflinger, gpu]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- architecture_detection: 管线识别场景建议包含架构自动检测阶段 (detect_architecture) (required: detect_architecture)
- pipeline_skill_invocation: 管线识别场景建议包含管线教学内容展示阶段 (pipeline skill invocation) (requires one of: invoke_skill(rendering_pipeline_detection), invoke_skill(render_pipeline_latency), invoke_skill(scene_reconstruction))

**Phase reminders**
- buffer_fence_lifecycle: BufferQueue/Fence 问题必须拆 producer queue/dequeue、BLAST transaction、SF acquire/latch、HWC present、release fence。queueBuffer 只证明 producer submission；HWC 不是 BufferQueue consumer，SF 才消费 buffer 后再交给 HWC/RenderEngine。 工具: buffer_transaction_lifecycle, fence_wait_decomposition, surfaceflinger_analysis, present_fence_timing
- refresh_policy_boundary: 刷新率/ARR/VRR 是 policy/ranking 与设备能力问题。不要默认 16.6ms；先用 vsync_config / vsync_phase_alignment / FrameTimeline 识别实际 VSync 周期，再说明 setFrameRate/View.setRequestedFrameRate 只是 hint/vote。 工具: vsync_config, vsync_phase_alignment, surfaceflinger_analysis
- graphics_memory_boundary: GraphicBuffer/dma-buf 是图形物理内存证据面，不能和 BufferQueue 槽位、queue depth 或 fence backpressure 混用。只有 meminfo/dma-buf/SurfaceFlinger dumpsys/heap/counter 等证据存在时才能写图形内存占用；Perfetto slice 只能支持队列/同步/背压候选。 工具: memory_analysis

**Final report contract summary**
- 渲染/显示阶段拆分
- BufferQueue/Fence 边界
- 图形内存/刷新策略边界


**Detail ref**
- `pipeline:full`: 渲染管线识别与教学分析（用户提到 管线识别、pipeline 检测、渲染路径、渲染架构检测） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="pipeline full strategy detail" keywords="pipeline,管线识别,pipeline识别,渲染路径,渲染管线检测,管线类型,pipeline detection,rendering pipeline,render path,architecture detection,渲染架构检测,帧渲染路径,frame path,渲染管线识别与教学分析（用户提到 管线识别、pipeline 检测、渲染路径、渲染架构检测）,detail,full" default="true" -->
#### 渲染管线识别与教学分析（用户提到 管线识别、pipeline 检测、渲染路径、渲染架构检测）

**核心目标：** 先识别 S02-S14 出图类型，再报告细粒度检测子路径与正交
feature，展示上游 Android 17 文章中的实际对象树，并路由到对应分析策略。

**证据边界：**
1. 渲染链路要拆成 Main/UI、RenderThread、BufferQueue、SurfaceFlinger、HWC/display 和 GPU/fence；不要把某一个 slice 当成整条链路结论。
2. `queueBuffer()` 只说明 producer 提交 buffer；SurfaceFlinger 仍需 acquire/latch、commit/composite、交给 HWC/RenderEngine，并等待 present/release fence。
3. HWC 不是 BufferQueue consumer。SurfaceFlinger 才消费 buffer，HWC 参与后续 validate/accept/present。
4. GraphicBuffer/dma-buf 是图形物理内存证据，不能等同 BufferQueue 槽位、队列深度或 fence backpressure。
5. refresh rate / ARR / VRR 会改变帧预算；`setFrameRate()` / `View.setRequestedFrameRate()` 是 hint/vote，不是强制命令。报告必须用实际 VSync/FrameTimeline 证据说明预算。
6. 只有 catalog 中 `classification_role: variant` 的条目能成为主出图类型；
   VRR、PiP、多窗口、Video Overlay、ANGLE 等 feature 只能作为伴随证据。
7. Producer/layer/提交路径/节奏四轴仅是辅助证据，不能替代 S02-S14 的最小
   Producer、Surface/layer、BufferQueue 证据集。

**Phase 1 — 自动检测：**
```
detect_architecture()
```
- 返回：architectureType（Standard/Flutter/Compose/WebView/Game 等）、confidence、metadata（engine、surfaceType 等）
- 如果 confidence < 0.5：标注不确定性，进入 Phase 3 手动验证
- 如果 confidence >= 0.5：直接进入 Phase 2

**Phase 2 — 管线匹配与教学：**
```
list_skills(type="pipeline")
# 根据架构类型动态匹配并调用对应的 pipeline skill（如 android_view_standard_blast）
```

根据检测到的架构类型匹配对应的 Pipeline Skill：

| 架构类型 | Pipeline Skill | 说明 |
|---------|---------------|------|
| Standard BLAST | android_view_standard_blast | Android 12—17 现代基线，BLASTBufferQueue |
| Standard Legacy | android_view_standard_legacy | Android 12 之前的兼容路径，不能按版本默认推断 |
| Software Rendering | android_view_software | 软件渲染（无 RenderThread） |
| Compose | compose_standard | Jetpack Compose 渲染管线 |
| Flutter SurfaceView (Skia) | flutter_surfaceview_skia | Flutter Skia 引擎 + SurfaceView |
| Flutter SurfaceView (Impeller) | flutter_surfaceview_impeller | Flutter Impeller 引擎 + SurfaceView |
| Flutter TextureView | flutter_textureview | Flutter TextureView 模式 |
| WebView GL Functor | webview_gl_functor | WebView 默认渲染路径 |
| WebView SurfaceControl | webview_surface_control | WebView 独立 Surface 模式 |
| SurfaceView | surfaceview_blast | SurfaceView 独立渲染 |
| TextureView | textureview_standard | TextureView 渲染 |
| Game Engine | game_engine | 游戏引擎（Unity/Unreal 等） |
| OpenGL ES | opengl_es | 原生 OpenGL ES 渲染 |
| Vulkan | vulkan_native | 原生 Vulkan 渲染 |
| Camera | camera_pipeline | 相机预览管线 |
| Video Overlay | video_overlay_hwc | 视频 HWC Overlay |

Camera 管线判定可以在 Pixel/Google Camera trace 中优先探测
`pixel_camera_frames` 和 `pixel_camera_memory_span`，用于补充 camera graph
阶段、GoogleCamera / camera HAL / cameraserver RSS 与 DMA heap 证据。该 stdlib
是 Pixel-specific，可用前必须 `lookup_sql_schema`，不可替代通用 camera HAL /
SurfaceFlinger / HWC / app producer 证据链。

展示教学内容：
- **Mermaid 时序图**：帧从生产到消费的完整流程
- **线程角色表**：关键线程名、职责、对应的 trace 标签
- **关键 Slice 列表**：Slice 名称、说明、正常耗时范围

**Phase 3 — 管线验证（当 confidence < 0.5 时执行）：**

通过手动查询关键 Slice 模式来确认/修正管线类型：
```sql
-- 检查 HWUI 标准管线特征
SELECT s.name AS slice_name, COUNT(*) AS cnt
FROM slice s
WHERE s.name IN ('DrawFrame', 'syncFrameState', 'Choreographer#doFrame', 'dequeueBuffer', 'queueBuffer')
GROUP BY s.name
ORDER BY cnt DESC
```

```sql
-- 检查 Flutter 特征
SELECT thread_name, COUNT(*) AS slice_cnt
FROM thread_slice
WHERE thread_name IN ('1.ui', '1.raster', '1.io', 'io.flutter.1.ui', 'io.flutter.1.raster')
GROUP BY thread_name
```

```sql
-- 检查 WebView 特征
SELECT s.name AS slice_name, COUNT(*) AS cnt
FROM slice s
WHERE s.name GLOB '*CrRendererMain*'
   OR s.name GLOB '*WebViewChromium*'
   OR s.name GLOB '*GLFunctor*'
   OR s.name GLOB '*viz::*'
GROUP BY s.name
ORDER BY cnt DESC
LIMIT 10
```

```sql
-- 检查 Game Engine 特征
SELECT s.name AS slice_name, COUNT(*) AS cnt
FROM slice s
WHERE s.name GLOB '*UnityMain*'
   OR s.name GLOB '*UnityGfx*'
   OR s.name GLOB '*UE4*'
   OR s.name GLOB '*GameThread*'
   OR s.name GLOB '*RHIThread*'
GROUP BY s.name
ORDER BY cnt DESC
LIMIT 10
```

根据查询结果向用户展示证据：
"发现 DrawFrame 共 180 次、BLASTBufferQueue 相关 Slice 共 160 次 → 确认为 Standard BLAST 管线"

**Phase 4 — 管线特有分析路由：**

检测完管线后，引导用户进行对应的性能分析：

| 管线族 | 推荐分析 Skill | 注意事项 |
|-------|--------------|---------|
| **HWUI Standard** | scrolling_analysis, jank_frame_detail | FrameTimeline 可用，jank_type 直接可查 |
| **Flutter** | flutter_scrolling_analysis | 使用 1.ui/1.raster 线程，非标准 RenderThread |
| **Compose** | scrolling_analysis | 关注 Recomposition 开销，FrameTimeline 可用 |
| **WebView** | scrolling_analysis + 手动分析 CrRendererMain | Web 内容无直接 FrameTimeline |
| **Game Engine** | game_fps_analysis, gpu_analysis | 无 FrameTimeline，通常 GPU-bound |
| **Camera/Video** | gpu_analysis, surfaceflinger_analysis | HWC Overlay 分析，关注 layer 合成策略 |
| **SurfaceView** | surfaceflinger_analysis | 独立 Surface，需查看 SF 合成时序 |
| **TextureView** | scrolling_analysis | 共享 App Surface，可能有 GPU 纹理上传开销 |

若用户问题涉及 BufferQueue、BLAST、Fence、HWC/present 或刷新率策略，补充：

| 问题类型 | 推荐 Skill | 解释边界 |
|---|---|---|
| BufferQueue/BLAST transaction 生命周期 | `buffer_transaction_lifecycle` | 区分 App `queueBuffer` 与 SF transaction/apply/latch，到达时机不能混用 |
| acquire/present/release fence | `fence_wait_decomposition` + `present_fence_timing` | acquire 保护读取，release 影响复用；present 是 Android 显示栈锚点，不证明 panel 光学完成或用户感知 |
| SF/HWC 合成路径 | `surfaceflinger_analysis` | 区分 SF commit/composite、HWC present、RenderEngine/GPU fallback、layer 数和 transaction storm |
| refresh-rate / ARR / VRR | `vsync_config` + `vsync_phase_alignment` | 用实际 VSync 周期计算预算，不默认 16.6ms |
| GraphicBuffer/dma-buf 图形内存 | 先按内存策略补证 | 需要 meminfo/dma-buf/SurfaceFlinger dumpsys/heap/counter；BufferQueue slice 只能证明队列/同步候选 |

**Phase 5 — 多管线共存检测：**

某些应用同时使用多种渲染管线（如 WebView 嵌入 View、Flutter PlatformView、视频播放叠加 UI）：

```sql
-- 检测多 Surface 共存
SELECT
  layer_name,
  COUNT(*) as frame_cnt
FROM actual_frame_timeline_slice
GROUP BY layer_name
ORDER BY frame_cnt DESC
LIMIT 10
```

```sql
-- 检测多 RenderThread
SELECT thread_name, tid, COUNT(*) AS slice_cnt
FROM thread_slice
WHERE thread_name GLOB 'RenderThread*'
   OR thread_name GLOB '1.raster*'
   OR thread_name GLOB 'CrRendererMain*'
   OR thread_name GLOB 'GLThread*'
GROUP BY thread_name, tid
ORDER BY slice_cnt DESC
```

如果检测到多管线共存：
- 说明哪些管线共存以及各自的帧数占比
- 解释管线之间的交互方式（如 PlatformView 通过 TextureView 桥接）
- 指出可能的性能影响（如额外的 GPU 纹理拷贝、合成复杂度增加）

### 输出结构必须遵循：

1. **检测结果**：
   - S02-S14 出图类型 + 置信度
   - 检测子路径 + 独立列出的正交 feature
   - 如有多管线共存，分别列出

2. **管线架构图**（Mermaid 时序图，来自 Pipeline Skill 教学内容）

3. **关键线程角色表**：
   ```
   | 线程名 | 职责 | Trace 标签 |
   |-------|------|-----------|
   | main | UI 布局和事件处理 | Choreographer#doFrame, measure, layout |
   | RenderThread | GPU 命令提交 | DrawFrame, syncFrameState |
   | ... | ... | ... |
   ```

4. **管线特有性能注意事项**：
   - 该管线常见的性能瓶颈点
   - 需要特别关注的指标
   - 如果涉及 BufferQueue/Fence：列出 queue/dequeue/latch/acquire/present/release 的证据状态
   - 如果涉及 refresh-rate：列出实际 VSync 周期、预算和 policy/vote 证据
   - 如果涉及图形内存：把 GraphicBuffer/dma-buf 证据与 BufferQueue 状态分开

5. **推荐后续分析路径**：
   - 基于检测到的管线类型，建议用户可以进一步分析的方向
   - 例如："检测到 Flutter SurfaceView (Impeller) 管线，可以问'分析滑动卡顿'查看 Flutter 帧渲染性能"
<!-- /strategy-detail -->

<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: pipeline
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 2}
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
- buffer_fence_lifecycle: BufferQueue/Fence 问题必须拆 producer queue/dequeue、BLAST transaction、SF acquire/latch、HWC present、release fence。queueBuffer 只证明 producer submission；标准 BLAST 窗口的 BQ Consumer 在 App；SF 接收含 buffer 的 transaction，HWC/RenderEngine 读取其输入。 工具: buffer_transaction_lifecycle, fence_wait_decomposition, surfaceflinger_analysis, present_fence_timing
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

**核心目标：** 先按 catalog 识别有证据支持的出图类型，再报告细粒度检测子路径与正交
feature，展示产品教学卡片中的参考拓扑，并路由到对应分析策略。

**证据边界：**
1. 渲染链路要拆成 Main/UI、RenderThread、BufferQueue、SurfaceFlinger、HWC/display 和 GPU/fence；不要把某一个 slice 当成整条链路结论。
2. `queueBuffer()` 只说明 producer 提交 buffer；标准窗口先由 App 内 BLAST acquire 引用并提交 transaction；SF 接收、latch、合成后再关联 present。release 另约束被归还的 buffer。
3. 标准 BLAST 窗口的 BufferQueue Consumer 在 App；SF 消费 buffer transaction，并交给 RenderEngine/HWC。不能把 SF latch 当作对 App BQ 的 acquire。
4. GraphicBuffer/dma-buf 是图形物理内存证据，不能等同 BufferQueue 槽位、队列深度或 fence backpressure。
5. refresh rate / ARR / VRR 会改变帧预算；`setFrameRate()` / `View.setRequestedFrameRate()` 是 hint/vote，不是强制命令。报告必须用实际 VSync/FrameTimeline 证据说明预算。
6. 只有 catalog 中 `classification_role: variant` 的条目能成为主出图类型；
   VRR、PiP、多窗口、Video Overlay、ANGLE 等 feature 只能作为伴随证据。
7. Producer/layer/提交路径/节奏四轴仅是辅助证据，不能替代当前路径要求的最小
   Producer、Surface/layer、BufferQueue 证据集。

**Phase 1 — 自动检测：**
```
detect_architecture()
```
- 从目标 App 的出图路径解释检测结果。标准宿主只在有子路径证据时细分 BLAST 或 Legacy。
- 返回 UNKNOWN 时，说明缺少哪些出图证据；需要进一步核对时进入 Phase 3。候选分数只用于安排核查顺序。primary_confidence 表示当前采集可见的出图占比。

**Phase 2 — 管线匹配与教学：**

调用 `invoke_skill("rendering_pipeline_detection", {package: <target package>})`，读取本次 `pipeline_bundle` 的检测结果和教学卡。通用 AOSP 教学以已确认的宿主链路为限。只有在结果提供具体子路径时，才教学该变体。UNKNOWN 保留可直接观察的事件。

Camera 管线判定可以在 Pixel/Google Camera trace 中优先探测
`pixel_camera_frames` 和 `pixel_camera_memory_span`，用于补充 camera graph
阶段、GoogleCamera / camera HAL / cameraserver RSS 与 DMA heap 证据。该 stdlib
是 Pixel-specific，可用前必须 `lookup_sql_schema`，不可替代通用 camera HAL /
SurfaceFlinger / HWC / app producer 证据链。

展示教学内容：
- **Mermaid 时序图**：帧从生产到消费的完整流程
- **线程角色表**：关键线程名、职责、对应的 trace 标签
- **关键 Slice 列表**：Slice 名称、说明、正常耗时范围

**Phase 3 — 核对目标窗口的实际出图：**

1. 限定到目标包及其有归属的进程、观察窗口和输出 surface。沿生产线程上的 draw、提交 buffer、宿主采样或独立 layer，找出实际到达显示路径的帧。
2. 有 FrameTimeline 时，按目标 UPID、layer 和 surface/display frame token 核对 SurfaceFlinger 的消费与呈现。缺少可关联记录时说明断在哪一段，并保留可见的生产端证据。
3. 普通 RenderThread 向宿主窗口持续出图时，按标准 AOSP/HWUI 解读。线程名、SDK 初始化、单次 API 调用或别的进程在播放视频都只能提供搜索线索。主链路仍不清楚时保留 UNKNOWN。
4. 对 camera / video，分别确认预览帧或解码帧送入目标 surface 的证据。音频 codec、拍照处理和相机后台服务都不能证明屏幕上的画面；认定 HWC overlay 还需要该视频 layer 的合成方式。

**Phase 4 — 管线特有分析路由：**

检测完管线后，引导用户进行对应的性能分析：

| 管线族 | 推荐分析 Skill | 注意事项 |
|-------|--------------|---------|
| **HWUI Standard** | scrolling_analysis, jank_frame_detail | FrameTimeline 可用，jank_type 直接可查 |
| **Flutter** | flutter_scrolling_analysis | 使用 1.ui/1.raster 线程，非标准 RenderThread |
| **Compose** | scrolling_analysis | 关注 Recomposition 开销，FrameTimeline 可用 |
| **WebView** | scrolling_analysis + 手动分析 CrRendererMain | Web 内容无直接 FrameTimeline |
| **Game Engine** | game_fps_analysis, gpu_analysis | 无 FrameTimeline，通常 GPU-bound |
| **Camera/Video** | gpu_analysis, surfaceflinger_analysis | 核对预览或解码输出的 layer 及其实际合成方式 |
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

同一窗口有多个生产者时，仅展示分别有提交或消费证据的路径。按目标 layer 核对宿主与独立 surface 的帧；TextureView 等回到宿主的路径还需观察宿主采样。帧占比须明确分子、分母和观察窗口。只有能关联到同一 frame/buffer 时才描述两条路径的依赖。

### 输出结构必须遵循：

1. **检测结果**：
   - 已确认的出图类型、证据及对应教学卡；UNKNOWN 说明缺失的观测
   - 检测子路径 + 独立列出的正交 feature
   - 如有多管线共存，分别列出

2. **管线架构图**（确认路径且有对应教学卡时展示）

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

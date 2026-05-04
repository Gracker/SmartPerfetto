<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: scrolling
priority: 3
effort: medium
required_capabilities:
  - frame_rendering
  - cpu_scheduling
optional_capabilities:
  - binder_ipc
  - surfaceflinger
  - gpu
  - thermal_throttling
  - input_latency
  - lock_contention
  - gpu_work_period
  - cpu_freq_idle
  - battery_counters
keywords:
  - 滑动
  - 卡顿
  - 掉帧
  - 丢帧
  - jank
  - scroll
  - fps
  - 帧
  - frame
  - 列表
  - 流畅
  - fling
  - swipe
  - 刷新
  - 滚动
  - recycler
  - listview
  - lazy
  - 快滑
  - 慢滑
  - stuttering
  - dropped frame
  - janky
  - 不流畅
  - surfaceflinger
  - impeller

phase_hints:
  - id: overview
    keywords: ['概览', 'overview', '帧', 'frame', 'jank', '卡顿', 'scrolling_analysis', '统计']
    constraints: '必须调用 scrolling_analysis 获取全帧统计。注意区分 buffer_stuffing（非真实掉帧）和感知掉帧。'
    critical_tools: ['scrolling_analysis']
    critical: false
  - id: root_cause_drill
    keywords: ['根因', 'root cause', '诊断', 'diagnos', '深钻', 'deep', 'drill', '代表帧', 'representative', '逐帧']
    constraints: '对占比 >15% 且绝对帧数 >3 的 reason_code，必须选最严重帧执行 jank_frame_detail/frame_blocking_calls/blocking_chain_analysis 深钻。禁止仅靠 batch_frame_root_cause 统计分类直接出结论。workload_heavy 必须最后兜底。'
    critical_tools: ['jank_frame_detail', 'frame_blocking_calls', 'blocking_chain_analysis', 'lookup_knowledge']
    critical: true
  - id: frame_metrics_overlay
    keywords: ['overrun', 'per_frame', 'ui time', 'cpu time', 'work period', 'mali', '帧内', '帧阻塞', '阻塞调用', 'Binder', 'futex', 'GPU', '功耗', '频率']
    constraints: '需要帧内 CPU/UI/GPU/阻塞调用细分时，优先用 frame_overrun_summary、cpu_time_per_frame、frame_ui_time_breakdown、frame_blocking_calls、android_gpu_work_period_track、mali_gpu_power_state 作为补充证据。缺 gpu_work_period 时必须标注数据不足。'
    critical_tools: ['frame_overrun_summary', 'cpu_time_per_frame', 'frame_ui_time_breakdown', 'frame_blocking_calls', 'android_gpu_work_period_track', 'mali_gpu_power_state']
    critical: false
  - id: conclusion
    keywords: ['结论', 'conclusion', '输出', 'output', '报告', 'report', '总结']
    constraints: '输出必须包含：全帧根因分布表（按 reason_code 聚合）+ 代表帧分析（含四象限+频率+根因推理链）+ 按优先级排序的优化建议。每个 CRITICAL/HIGH 必须有量化证据+因果链。'
    critical_tools: []
    critical: false

plan_template:
  mandatory_aspects:
    - id: frame_jank_analysis
      match_keywords: ['frame', 'jank', 'scroll', '帧', '卡顿', '滑动', 'scrolling_analysis', 'consumer_jank']
      suggestion: '滑动场景建议包含帧渲染/卡顿分析阶段 (scrolling_analysis, consumer_jank_detection)'
    - id: root_cause_diagnosis
      match_keywords: ['root', 'cause', 'diagnos', '根因', '诊断', '深入', 'deep', 'jank_frame_detail', 'frame_blocking_calls']
      suggestion: '滑动场景建议包含卡顿帧根因分析阶段 (jank_frame_detail / frame_blocking_calls)'
---

**Android 版本注意**：
- FrameTimeline 数据需要 Android 12+ (API 31)
- blocked_functions 需要内核 CONFIG_SCHEDSTATS=y（高通量产内核常关闭）
- monitor_contention 需要 Android 13+ (API 33)
- input events 需要 Android 14+ (API 34)
- Android 14+ token 不再严格连续递增，token_gap 检测可能需调整

#### 滑动/卡顿分析（用户提到 滑动、卡顿、掉帧、jank、scroll、fps）

**⚠️ 核心原则：**
1. **逐帧根因诊断是最重要的**。概览统计（帧率、卡顿率）只是入口，真正有价值的是每一个掉帧帧的根因分析。
2. **掉帧检测以 present_ts 间隔为主**（> 1.5x VSync = 用户可感知卡顿），token_gap 为辅助信号。Buffer Stuffing 帧的 present_type 可以是 Late/Early/On-Time，需用 present_ts 间隔做二次验证。
   - **Per-Layer Buffer 枯竭检测（token-gap 辅助模型）**：当 App Layer 在连续 SF DisplayFrame 中出现 token 跳跃（gap > 1），说明 SF 在中间帧合成时该 Layer 没有新 Buffer = 缓冲区枯竭
   - `token_gap = 1` → 正常（每帧都有新 buffer），`token_gap = N` → 跳过 N-1 个 DisplayFrame
   - 这是 per-layer 检测，不受 SF 全局合成状态影响（SF 可能在消费其他 Layer 的 buffer）
   - **Prediction Error 帧处理**：Prediction Error 帧不应一律忽略。检查 prediction_type = 'Expired Prediction' 的比例：>5% 时标注"FrameTimeline 预测精度不足"。在管线 2-3 帧缓冲下用户可能感知延迟
3. **Guilty Frame 溯源**：
   - BlastBufferQueue 三缓冲下，可见卡顿通常出现在慢帧 2-3 帧之后（管线排空）
   - `guilty_frame_id` 字段指向导致管线枯竭的实际慢帧（向前回溯 ≤5 帧，取最慢的超预算帧）
   - 根因分析（四象限/CPU/Binder）应针对 guilty frame 而非枯竭帧本身
4. **get_app_jank_frames 结果中的 `jank_responsibility` 字段**：
   - `APP`：App 侧原因（App Deadline Missed / Self Jank）
   - `SF`：SurfaceFlinger 侧原因
   - `HIDDEN`：缓冲区枯竭但框架未标记（Perfetto 帧颜色为绿色）
   - `BUFFER_STUFFING`：Buffer Stuffing

**Phase 1 — 概览 + 掉帧列表 + 批量根因分类（1 次调用）：**
```
invoke_skill("scrolling_analysis", { start_ts: "<trace_start>", end_ts: "<trace_end>", process_name: "<包名>" })
```
- 建议传入 start_ts 和 end_ts 以获得更精确的结果
- 如果不知道 trace 时间范围，先用 SQL 查询：
  `SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice`
- 返回结果以 artifact 引用形式返回（紧凑摘要），包含：
  - `jank_type_stats`：掉帧类型分布，**注意 real_jank_count（真实掉帧）vs false_positive（假阳性）**
  - `scroll_sessions`：滑动区间列表
  - `batch_frame_root_cause`（主掉帧列表）：所有掉帧帧的**完整分析**（frame_id + start_ts + jank_type + jank_responsibility + vsync_missed + reason_code + 四象限 MainThread/RenderThread + CPU 频率 + Binder/GC 重叠 + 根因分类），覆盖所有掉帧帧
  - `get_app_jank_frames`（内部数据源，无独立显示）：掉帧帧列表，供 Agent 内部使用（焦点区间、帧实体捕获）
  - `scroll_sessions` 可展开：点击展开某个滑动区间，可查看该区间的**四象限分布、CPU 频率、关键线程大小核分布**（由 `session_stats_batch` 提供）
  - `session_quadrant_summary`（兼容数据源，不独立显示）：**滑动过程整体**四象限分布，Agent 可通过 save_as 引用
  - `session_cpu_freq`（兼容数据源，不独立显示）：CPU 频率分布
  - `session_thread_core_affinity`（兼容数据源，不独立显示）：关键线程大小核分布
- **获取详细数据**：对大型 artifact 使用分页获取：
  `fetch_artifact(artifactId, detail="rows", offset=0, limit=50)`
  响应包含 `totalRows` 和 `hasMore`，继续翻页获取所有数据。
  **必须获取完所有相关数据再出结论**，不可只看前 50 行就下结论

**Phase 1.3 — 全局上下文检查（基于 `global_context_flags` 结果，scrolling_analysis 自动输出）：**

检查 `global_context` 数据源中的标志。在**结论概述段**（帧率/掉帧率数据紧后）用粗体标注，格式如下：

| 标志 | 条件 | 在结论概述段标注 |
|------|------|----------------|
| `video_during_scroll = 1` | 滑动期间有视频解码活跃 | ⚠️ **视频播放并行**：滑动期间检测到视频解码活跃，workload_heavy 帧的负载归因不能全部归因于滑动渲染 |
| `interpolation_active = 1` | 大量 frame_id=-1 的插帧 | ⚠️ **OEM 插帧模式活跃**：统计指标（帧率/掉帧率）可能受插帧影响失真 |
| `thermal_trending = 1` | trace 尾部频率天花板明显低于峰值 | ⚠️ **温控持续降频**：thermal_throttling 帧的根因是系统级热管理，非 App 问题 |
| `background_cpu_heavy = 1` | 非 App 大核占比 >60% | ⚠️ **后台 CPU 干扰**：{non_app_big_core_pct}% 的大核 CPU 被非前台进程占用。需用 `execute_sql` 查询 top 占用进程 |

⚠️ 全局上下文标志**不改变 reason_code 分类**，仅在结论概述段增加修饰标注。多个标志同时为 1 时全部标注。

**Phase 1.5 — 架构感知分支（基于 detect_architecture 结果）：**

| 架构 | 调整动作 |
|------|---------|
| **Flutter** | 改用 `invoke_skill("flutter_scrolling_analysis")` 代替 `scrolling_analysis`。Flutter 的 1.ui/1.raster 线程模型与标准 RenderThread 不同，jank 帧的根因归属逻辑也不同 |
| **WebView** | 使用标准 `scrolling_analysis`，但注意 CrRendererMain 线程的 slice 可能是卡顿主因。WebView 场景下，CrRendererMain 线程的阻塞（V8 GC、CSS Layout Thrashing）可能导致帧延迟。可调用 webview_v8_analysis Skill 检查 V8 性能。**⚠️ WebView SurfaceTexture 单 buffer 问题**：如果 WebView 使用 SurfaceTexture 出图，单 buffer 模式下帧可能被覆盖（新帧写入未被消费的 buffer），表现为跳帧而非卡顿。可通过 `frame_production_gap` 检测 |
| **SurfaceTexture** | 使用标准 `scrolling_analysis`。SurfaceTexture 出图时注意**单 buffer 帧吞噬**：producer 写入新帧覆盖了 consumer 尚未读取的旧帧。表现为帧间 gap 但无 jank 标记。可通过 `invoke_skill("frame_production_gap")` 检测帧生产间隙 |
| **标准 HWUI** | 使用标准 `scrolling_analysis` |
| **Compose** | 使用标准 `scrolling_analysis`。如果检测到 Compose 架构，注意 Recomposition* slices 可能是卡顿主因。LazyColumn/LazyRow 的 prefetch 和 compose 阶段如果超时会导致掉帧。可调用 compose_recomposition_hotspot Skill 检测过度重组 |

**Phase 1.7 — 根因分支深钻（基于 batch_frame_root_cause 的 reason_code 和 jank_responsibility）：**

| 条件 | 深钻动作 | 目标 |
|------|---------|------|
| **多帧 `reason_code = sf_composition_slow`** | 调用 `invoke_skill("surfaceflinger_analysis")` | SF 合成延迟原因：HWC 回退 GPU 合成？Layer 过多？Fence 超时？ |
| **多帧 `reason_code = thermal_throttling` 或 `cpu_max_limited`** | 调用 `invoke_skill("thermal_throttling")`，或 `lookup_knowledge("thermal-throttling")` | 温度曲线？限频策略？是持续降频还是间歇性？thermal 还是 policy governor？ |
| **多帧 `reason_code = gc_pressure_cascade`** | 查询 `android_garbage_collection_events` 全程分布 | GC 频率趋势？是否有内存泄漏迹象？哪种 GC 类型为主？ |
| **多帧 `reason_code = render_thread_heavy`** | 对最严重帧调用 `invoke_skill("jank_frame_detail")` 查看 RT top slices | uploadBitmap？shader 初始化？syncFrameState？drawFrame 内部哪个阶段慢？ |
| **多帧 `reason_code = gpu_fence_wait` 或 `shader_compile`** | 调用 `invoke_skill("gpu_analysis")` 或 `execute_sql` 查询 GPU 频率/利用率 | GPU 频率被限？shader 复杂度？GPU 负载过高？ |
| **多帧 `reason_code = binder_sync_blocking` / `binder_timeout` / `lock_binder_wait` / `blocking_io` / `main_thread_file_io`** | 对最严重帧调用 `invoke_skill("frame_blocking_calls", {process_name, start_ts, end_ts})` | 帧窗口里真正重叠的是 Binder、GC、锁竞争、futex 还是文件 IO？重叠多久？ |
| **VRR 设备（VSync 周期 ≠ 16.67ms）** | 注意 1.5x VSync 阈值需基于实际 VSync 周期 | 如 120Hz = 8.33ms, 1.5x = 12.5ms |

**Phase 1.8 — 帧内指标 / GPU / CPU 利用率补充（按需执行）：**

当用户追问"每帧 CPU/UI 时间"、"GPU work period"、"Mali power state"、"是 CPU 还是 GPU 限制"时，优先调用已落地的 B-tier atomic skill：

| 问题 | 调用 | 说明 |
|---|---|---|
| 每帧 deadline overrun | `invoke_skill("frame_overrun_summary")` | 基于 `android.frames.per_frame_metrics`，列出 overrun 帧 |
| 每帧 CPU 时间 | `invoke_skill("cpu_time_per_frame")` | 区分帧窗口内 CPU 消耗 |
| UI thread 时间分解 | `invoke_skill("frame_ui_time_breakdown")` | 看 UI thread 在每帧的耗时分布 |
| 每帧阻塞调用 | `invoke_skill("frame_blocking_calls")` | 将掉帧帧与 Binder/GC/锁竞争/futex/文件 IO 阻塞区间做重叠匹配 |
| CPU process/thread 周期利用率 | `invoke_skill("cpu_process_utilization_period")` / `invoke_skill("cpu_thread_utilization_period")` | 用于 workload_heavy、后台抢占、线程归因 |
| CPU cluster 拓扑 | `invoke_skill("cpu_cluster_mapping_view")` | 解释大小核分布，辅助 small_core_placement |
| GPU work period | `invoke_skill("android_gpu_work_period_track")` | 只有 `gpu_work_period` capability 可用时才做 GPU active region 判断 |
| Mali power state | `invoke_skill("mali_gpu_power_state")` | Mali 设备专用；无数据时标注设备/trace 不支持 |

这些是补充证据，不替代 Phase 1.9 的根因深钻。若 Trace 数据完整度提示 `gpu_work_period` / `cpu_freq_idle` 缺失，结论中必须说明 GPU/CPU 供应侧判断的可信度下降。

**Phase 1.9 — 根因深钻（🔴 强制执行，不可跳过）：**

对 `batch_frame_root_cause` 中**占比 >15% 且绝对帧数 >3** 的每个 reason_code，**必须**选最严重的 1 帧执行深钻。
**⛔ 禁止**仅靠 batch_frame_root_cause 的统计分类直接出结论——reason_code（如 workload_heavy）只是分类标签，不是真正的根因。
**必须**通过至少一次工具调用（frame_blocking_calls / blocking_chain_analysis / binder_root_cause / lookup_knowledge / jank_frame_detail）获取机制级证据，回答"WHY 这帧慢"。跳过此步骤将触发验证错误。

**常见错误：** 看到 reason_code=workload_heavy 就结论"工作负载过重"，但没有回答：具体是哪段代码？为什么在这个时机执行？是否可异步/分帧？这不是根因分析，这只是分类。

| 条件 | 深钻动作 | 目标 |
|------|---------|------|
| **任何 reason_code + Q4>20%** | `invoke_skill("blocking_chain_analysis", {start_ts, end_ts, process_name})` | 阻塞链：谁阻塞了主线程？是锁？Binder？IO？唤醒者是谁？ |
| **帧内 Binder/IO/futex/锁信号**（`reason_code` 为 `binder_sync_blocking` / `binder_timeout` / `lock_binder_wait` / `blocking_io` / `main_thread_file_io`，或 `top_slice_name` 包含 `Binder` / `SharedPreferences` / `sqlite` / `fsync` / `futex` / `monitor` / `Lock`） | `invoke_skill("frame_blocking_calls", {start_ts, end_ts, process_name})` | 将掉帧帧和阻塞调用做时间重叠，确认真实影响帧窗口的调用类型、重叠时长和频次 |
| **binder_overlap >5ms** | `invoke_skill("binder_root_cause", {start_ts, end_ts, process_name})` | 服务端还是客户端慢？具体原因（GC？锁？IO？内存回收？）|
| **gc_overlap >3ms 或 gc_pressure_cascade** | 查询 `android_garbage_collection_events` WHERE gc_ts 在帧窗口内 | 哪种 GC？回收了多少？GC 运行耗时？是否有内存泄漏趋势？|
| **thermal_throttling / cpu_max_limited** | `lookup_knowledge("thermal-throttling")` | 温度驱动 vs policy 驱动？限频比例？是否持续恶化？|
| **render_thread_heavy** | `invoke_skill("jank_frame_detail", {start_ts, end_ts})` 查看 render_slices_json | RT 内部瓶颈：uploadBitmap？syncFrameState？drawFrame？eglSwapBuffers？|
| **sf_composition_slow** | `invoke_skill("surfaceflinger_analysis")` | SF 合成瓶颈：HWC delay？GPU 回退合成？Layer 过多？|
| **freq_ramp_slow** | `lookup_knowledge("cpu-scheduler")` | 是 governor 升频延迟还是 thermal 限频？|
| **small_core_placement** | `lookup_knowledge("cpu-scheduler")` | 为什么被调度到小核？大核被谁占用？|
| **gpu_fence_wait / shader_compile** | `lookup_knowledge("rendering-pipeline")` | GPU 频率是否被限？SF 合成是否是瓶颈？|

**workload_heavy 子分类指导：** 当 reason_code = `workload_heavy` 时，检查 `top_slice_name` 字段是否**包含**以下关键字，进一步归类（这是字符串包含匹配，不是 SQL 查询）：

| top_slice_name 包含 | 子分类 | 优化方向 |
|--------------------|--------|---------|
| `Choreographer` / `doFrame` / `doCallbacks` | doFrame 回调总时间过长 | [App层] 检查 measure/layout/draw 各阶段，减少过度绘制 |
| `layout` / `measure` / `onLayout` / `onMeasure` | 布局计算密集 | [App层] 减少嵌套层级，使用 ConstraintLayout，避免 requestLayout 连锁 |
| `obtainView` / `inflate` / `createViewFromTag` / `RecyclerView` / `prefetch` | View 创建/Inflate/预取过长 | [App层] 启用 RecyclerView 预创建、异步 inflate、ViewStub 延迟加载 |
| `animation` / `Animator` / `ValueAnimator` | 动画回调过长 | [App层] 检查是否有多个动画叠加，或动画回调中执行了耗时操作 |
| `input` / `dispatchTouchEvent` / `onTouch` / `onScrollChanged` | 输入处理阻塞 | [App层] 避免在 onTouchEvent/onScrollChanged 中执行耗时操作 |
| `decodeBitmap` / `BitmapFactory` / `decodeResource` / `decode` | 主线程图片解码 | [App层] 使用 Glide/Coil 异步加载，避免主线程 decode |
| `SharedPreferences` / `sqlite` / `QueuedWork` / `waitToFinish` | 主线程 IO | [App层] 迁移到 DataStore/Room 异步 API，避免 apply() 后 waitToFinish |
| `traversal` / `performTraversal` / `relayoutWindow` | ViewRootImpl traversal 过长 | [App层] 减少 View 树深度，检查是否有不必要的 invalidate |
| `Recomposition` / `compose:` | Compose 重组过长 | [App层] 使用 derivedStateOf/remember 减少不必要的重组 |
| 其他 / 无法匹配 | 通用负载过重 | 需要 jank_frame_detail 查看 main_slices_json 获取更多上下文 |

**workload_heavy 频率复核：** 对 batch_frame_root_cause 中每个 workload_heavy 帧，直接读取已有的 `big_avg_freq_mhz` 和 `device_peak_freq_mhz` 字段（无需额外工具调用），计算频率占比：
- 如果 `big_avg_freq_mhz < device_peak_freq_mhz * 0.70`：根因应标注为 **"负载过重 + 频率不足"**（trigger=workload, supply=frequency_insufficient）。在满频下相同操作可能不超时，优化建议应同时包含 [App层] 降低负载 + [系统层] 提升调度频率
- 如果 `big_avg_freq_mhz >= device_peak_freq_mhz * 0.70`：确认为纯负载问题，优化方向纯 [App层]
- 计算公式：实际运行频率占比 = `big_avg_freq_mhz / device_peak_freq_mhz`，低于 70% 需标注
- **在结论的代表帧分析中必须报告频率数据**：`大核均频 XXMHz / 设备峰值 YYMHz (ZZ%)`

**WHY 链深度要求：** 每个 [CRITICAL]/[HIGH] 发现的根因推理链必须至少 2 级：
- ✅ Level 1: "帧超时" → Level 2: "Binder 阻塞" → Level 3: "服务端 system_server monitor_contention"
- ❌ 仅 Level 1: "帧超时 45ms，workload_heavy"（缺少机制解释）

**Phase 1.95 — 缺帧检测（满足以下任一条件时执行）：**

| 触发条件 | 说明 |
|----------|------|
| `real_jank_count < 5` 但 `scroll_sessions` 存在 ≥2 个滑动区间 | 滑动区间存在但几乎无肥帧 → 可能是缺帧导致的感知卡顿 |
| `jank_type_stats` 中 `false_positive` 占比 > 50% | 大量 Buffer Stuffing 假阳性 → 管线问题可能伴随缺帧 |
| 检测到 WebView / SurfaceTexture 架构（Phase 1.5） | 单 buffer 模式天然容易产生缺帧 |

缺帧在 Perfetto 时间线上表现为帧间 gap 而非红/黄帧，`batch_frame_root_cause` 无法检出。

```
invoke_skill("frame_production_gap", { process_name: "<包名>", start_ts: "<滑动起始>", end_ts: "<滑动结束>" })
```

返回结果包含：
- `gap_overview`：Gap 总数、分类统计（ui_no_frame / rt_no_drawframe / sf_backpressure）、最长 Gap
- `gap_list`：每个 Gap 的详细信息（时间、VSync 数、类型、doFrame/DrawFrame 计数）

**缺帧类型解读：**

| Gap 类型 | 含义 | 常见原因 | 优化方向 |
|----------|------|---------|---------|
| `ui_no_frame` | UI Thread 未触发 doFrame | 按压/松手时无触摸事件驱动、滑动到顶/底部内容已耗尽、App 主动调用 `setFrameRate()` 限帧 | [App层] 检查 Input 事件流、滑动边界处理 |
| `rt_no_drawframe` | 有 doFrame 但 RenderThread 未执行 DrawFrame | doFrame 中 measure/layout 判定无 dirty 区域（View 未 invalidate）、syncFrameState 超时被跳过 | [App层] 检查是否有冗余 requestLayout 但无实际绘制 |
| `sf_backpressure` | 有 DrawFrame 但帧未被 SF 消费 | SurfaceTexture 单 buffer 覆盖（WebView/Camera）、BlastBufferQueue 背压、SF 端 dequeue 延迟 | [系统层] 检查 BufferQueue 状态、SF 合成延迟 |
| `production_gap` | 其他原因的帧中断 | 进程被冻结（后台化）、ANR 状态、系统低内存 killing | 检查进程状态和系统级事件 |

⚠️ 缺帧和肥帧可以同时存在。**先分析 batch_frame_root_cause（肥帧），再用 frame_production_gap（缺帧）补充**。

**Phase 2 — 补充深钻（可选，仅在 Phase 1.9 深钻后仍需更多细节时执行）：**
Phase 1 的 `batch_frame_root_cause` 已包含每帧的**完整统计数据**（但统计数据 ≠ 根因，Phase 1.9 的工具调用深钻不可省略）：
- MainThread 四象限（Q1 大核运行 / Q2 小核运行 / Q3 调度等待 / Q4 休眠）
- RenderThread 四象限（render_q1 大核 / render_q3 调度 / render_q4 休眠）
- CPU 大核频率（big_avg_freq_mhz / big_max_freq_mhz）+ 升频延迟（ramp_ms）
- Binder 同步重叠（binder_overlap_ms）+ GC 重叠（gc_overlap_ms）
- 根因分类（reason_code）+ 关键操作（top_slice_name / top_slice_ms）

此外，每个滑动区间的**整体运行特征**（四象限分布、CPU 频率、关键线程大小核分布）已内嵌在 `scroll_sessions` 的展开行中（由 `session_stats_batch` 提供），无需调用 jank_frame_detail 或 blocking_chain_analysis 来获取全局指标。兼容数据源 `session_quadrant_summary`、`session_cpu_freq`、`session_thread_core_affinity` 仍可通过 save_as 引用。

**batch_frame_root_cause 的统计数据可用于分类和概览，但 Phase 1.9 的深钻工具调用不可省略**。jank_frame_detail 仅在以下特殊情况需要调用：
仅在以下情况才调用 jank_frame_detail（**最多 2 帧**）：
- 需要查看 CPU 频率**时间线**（帧内频率变化过程）
- 需要查看 RenderThread 或主线程的 top N slices 详情
- **reason_code 为 unknown 且帧数 >5%**：必须对至少 1 帧调用 jank_frame_detail 获取更多线索，不能在分布表中仅标记"未分类"就跳过
- reason_code 与实际数据矛盾时（如 `lock_binder_wait` 但 Binder 耗时 0ms）：应在结论中标注可能的误分类原因

`frame_blocking_calls` 是 Phase 1.9 的帧内阻塞证据补充，不占 `jank_frame_detail` 的 2 帧上限。遇到 Binder/IO/futex/锁相关根因时，优先用它确认阻塞调用是否真的与掉帧帧重叠。

```
invoke_skill("jank_frame_detail", {
  start_ts: "<帧的start_ts>",
  end_ts: "<帧的end_ts>",
  jank_type: "<帧的jank_type>",
  jank_responsibility: "<帧的jank_responsibility>",
  process_name: "<包名>"
})
```

**Phase 3 — 综合结论（基于全量帧数据）：**

**输出结构必须遵循：**

1. **概览**（必须包含以下数据）：
   - 总帧数、**总真实掉帧数 = SUM(所有 jank_type 行的 real_jank_count)**
   - 分类明细：App 侧掉帧 N 帧 + 隐形掉帧 N 帧 + 假阳性 N 帧
   - **峰值体验指标**（仅看掉帧率会掩盖极端长帧对用户感知的影响）：
     - 最长帧耗时：XXms（超预算 N 倍）
     - 最长连续丢帧 VSync 数：N 个 VSync（= XXms 无响应）
     - 如有 >3 帧超过 3× VSync 预算，标注"存在用户强感知卡顿峰值"
   - **综合评级标准**（不能只看掉帧率，必须同时考虑峰值）：
     - 优秀：掉帧率 <1% 且最长帧 <2× VSync
     - 良好：掉帧率 <3% 且最长帧 <4× VSync
     - 一般：掉帧率 <5% 或最长帧 <8× VSync
     - 差：掉帧率 ≥5% 或最长帧 ≥8× VSync
     - 例：掉帧率 2% 但最长帧 62ms（7.5× VSync）→ 评级应为"一般"而非"良好"
   - **指标口径说明**：FPS 基于滑动时间窗口（非分析耗时），时间范围需标注来源
   - 如果存在隐形掉帧（`jank_type=None` 但 `real_jank_count > 0`），**必须在概览中明确标注**：
     "其中 N 帧为隐形掉帧（框架未标记但消费端检测到真实掉帧），可能与 SurfaceFlinger 合成延迟、管线积压或跨进程 Binder 阻塞有关"
   - ⚠️ **`App Deadline Missed` 不等于全部真实掉帧**。例如 135 帧 App Deadline Missed + 165 帧隐形掉帧 = 300 总真实掉帧

2. **各滑动区间运行特征**（from scroll_sessions 展开行，或兼容数据源 session_quadrant_summary / session_cpu_freq / session_thread_core_affinity）：
   - 对每个滑动区间分别报告（如有多个区间，逐区间列出）：
   - 主线程四象限：Q1=XX% Q2=XX% Q3=XX% Q4a=XX% Q4b=XX%
   - RenderThread 四象限：Q1=XX% Q3=XX% Q4a=XX% Q4b=XX%
   - CPU 频率：prime 均频 XXMHz / big 均频 XXMHz / little 均频 XXMHz
   - 关键线程大小核分布：MainThread prime XX%+big XX% / RenderThread prime XX%+big XX%

3. **全帧根因分布**（基于 batch_frame_root_cause，覆盖所有掉帧帧）：
   按 reason_code 聚合，附带四象限分布和频率特征：
   ```
   | 根因类型 | 帧数 | 占比 | 四象限特征 | 频率特征 |
   |---------|------|------|-----------|---------|
   | workload_heavy | 80 | 59% | Q1=45% Q3=8% | 大核均频 2200MHz |
   | freq_ramp_slow | 30 | 22% | Q1=30% Q3=12% | 大核均频 1100MHz, ramp>10ms |
   | small_core_placement | 15 | 11% | Q2=55% | 大核均频 900MHz |
   | ... | ... | ... | ... | ... |
   ```

4. **代表帧分析**（每个根因类别选最严重的 1 帧，从 batch 数据中直接引用）：
   ```
   ### [reason_code] 代表帧: [start_ts] — [jank_responsibility]
   - 帧耗时：XXms（帧预算 XXms）
   - 主线程：Q1=XX% Q2=XX% Q3=XX% Q4=XX%
   - RenderThread：Q1=XX% Q3=XX% Q4=XX%
   - 关键操作：[top_slice_name] 耗时 XXms
   - CPU 频率：均频 XXMHz / 峰频 XXMHz，升频延迟 XXms
   - Binder: XXms / GC: XXms
   ```
   如有额外深钻帧（来自 jank_frame_detail），标注其 CPU freq timeline 和 slices 详情。

5. **优化建议**：按根因类别给出可操作建议，优先级按帧数占比排序。**必须分层标注**：
   - **[App 层]**：App 开发者可直接实施的优化（异步化、分帧、预加载、减少主线程阻塞等）— 建议要具体到代码模式
   - **[系统/ROM 层]**：需要厂商协同或系统级权限的优化（governor 调优、thermal 策略、SCHED_UTIL_CLAMP 等）— 标注"需系统级能力"
   - 优先给出 App 层建议；系统层建议仅作为补充参考

**当报告隐形掉帧时，必须提醒用户：**
- 隐形掉帧在 Perfetto 时间线上帧颜色为**绿色**（框架标记 jank_type=None）
- 真实卡顿证据是 **VSYNC-sf 计数器轨道**上的呈现间隔异常（> 1.5x VSync 周期）
- 可参考帧列表中的"呈现间隔"列确认

⚠️ **结论必须覆盖所有掉帧帧的根因分布**，不能只报告少数几帧。
   batch_frame_root_cause 提供了全量分类和详细指标，结论中的"全帧根因分布"和"代表帧分析"都应基于它。

---

#### 滑动场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_frame_stats`、`android_frames_overrun`、`android_surfaceflinger_workloads`、`android_gpu_frequency`、`cpu_thread_utilization_in_interval(ts, dur)`、`cpu_frequency_counters`、`slice_self_dur`、`android_screen_state`

---

#### 滑动分析的 SQL 回退方案

**当 scrolling_analysis Skill 返回 success=false 或 get_app_jank_frames 为空时**，按以下步骤走：

**回退 Step 1 — 消费端真实掉帧检测（含隐形掉帧）：**

```sql
WITH vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
vsync_cfg AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER)
     FROM vsync_intervals
     WHERE interval_ns BETWEEN 4000000 AND 50000000),
    16666667
  ) as period_ns
),
frames AS (
  SELECT a.ts, a.dur, a.jank_type,
    a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END as present_ts,
    LAG(a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END)
      OVER (PARTITION BY a.layer_name ORDER BY a.ts) as prev_present_ts
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '{process_name}*' OR '{process_name}' = '')
    AND p.name NOT LIKE '/system/%'
)
SELECT printf('%d', ts) AS start_ts, printf('%d', ts + dur) AS end_ts,
  ROUND(dur/1e6, 2) AS dur_ms, jank_type,
  CASE WHEN jank_type = 'None' OR jank_type IS NULL THEN '隐形掉帧' ELSE jank_type END as display_type,
  CASE
    WHEN jank_type = 'None' OR jank_type IS NULL THEN 'HIDDEN'
    WHEN jank_type GLOB '*SurfaceFlinger*' THEN 'SF'
    ELSE 'APP'
  END as responsibility,
  MAX(CAST(ROUND((present_ts - prev_present_ts) * 1.0 / (SELECT period_ns FROM vsync_cfg) - 1, 0) AS INTEGER), 0) as vsync_missed
FROM frames
WHERE prev_present_ts IS NOT NULL
  AND (present_ts - prev_present_ts) <= (SELECT period_ns FROM vsync_cfg) * 6
  AND (present_ts - prev_present_ts) > (SELECT period_ns FROM vsync_cfg) * 1.5
ORDER BY vsync_missed DESC, dur DESC
LIMIT 20
```

⚠️ 注意：此 SQL 同时返回框架标记的掉帧和隐形掉帧。`display_type='隐形掉帧'` 的帧是框架未标记但消费端检测到的真实掉帧。

**回退 Step 2 — 对 top 5 卡顿帧调用 jank_frame_detail（必须执行）：**
- 混合选取 APP 和 HIDDEN 帧
```
invoke_skill("jank_frame_detail", { start_ts: "<帧的start_ts>", end_ts: "<帧的end_ts>", process_name: "<包名>" })
```

**不执行逐帧分析就直接出结论是不允许的。**

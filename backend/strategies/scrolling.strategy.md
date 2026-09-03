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
  - gpu
  - thermal_throttling
  - input_latency
  - lock_contention
  - gpu_work_period
  - cpu_freq_idle
  - battery_counters
  - chrome_scroll_jank
keywords:
  - 滑动
  - 卡顿
  - 掉帧
  - 丢帧
  - jank
  - scroll
  - fps
  - 列表
  - 流畅
  - fling
  - swipe
  - 滚动
  - recycler
  - recyclerview
  - scrollview
  - scrollstate
  - lazycolumn
  - lazyrow
  - listview
  - lazy
  - 快滑
  - 慢滑
  - stuttering
  - frame drop
  - frame drops
  - dropped frame
  - dropped frames
  - resync
  - resynced
  - App Resynced Jitter
  - janky
  - 不流畅
  - impeller
  - textureview
  - react native
  - glsurfaceview
  - nativeactivity
  - drawfunctor

final_report_contract:
  required_sections:
    - id: root_cause_distribution
      label: 掉帧与根因分布
      description: '用 jank_type_stats 报告全量掉帧类型/责任；用 batch_frame_root_cause 报告已分析帧的 reason_code，并在采样截断时明确 X/Y、coverage 和 scope，禁止外推样本百分比。'
      pattern_groups:
        - ['掉帧与根因分布', '根因样本分布', '全帧根因分布', '根因分布', 'root[-\s]?cause distribution', 'reason_code']
        - ['帧数', '占比', 'frame count', 'percentage', '\|\s*根因\s*\|', '\|\s*reason']
    - id: representative_frames
      label: 代表帧分析
      description: '每个 CRITICAL/HIGH 根因至少给出 1 个代表样本，包含帧耗时、超预算倍数、vsync_missed、关键 slice/阻塞点和因果链。'
      pattern_groups:
        - ['代表帧', 'representative\s+frame']
        - ['frame_id', 'guilty[_ ]?frame', '帧耗时', '耗时\s*/\s*预算', '帧\s*\d+', 'frame duration']
        - ['vsync_missed', 'VSync\s*丢失', '丢失\s*\d+\s*VSync', '超预算', '预算', 'budget overrun', 'missed[-\s]?vsync']
    - id: peak_and_semantic_metrics
      label: 峰值/口径指标
      description: '说明总帧数、真实掉帧、假阳性/Buffer Stuffing、最长帧和最长连续丢帧等口径。'
      recovery_text:
        zh:
          - '真实掉帧口径：以以下已完成阶段中确认的用户可感知卡顿为准；仅在阶段证据明确区分时排除假阳性/Buffer Stuffing，否则保留为口径限制。'
          - '最长帧/峰值口径：以下阶段证据中的最长单帧与最长连续丢帧代表当前采集窗口峰值；缺失项保持为数据缺口。'
        en:
          - 'Real jank semantics: use user-visible jank confirmed by the completed phases below; exclude false positives or Buffer Stuffing only when the phase evidence distinguishes them, otherwise keep that boundary as a limitation.'
          - 'Longest frame / peak semantics: the longest single frame and longest consecutive missed-frame interval in the phase evidence below represent the current capture-window peak; keep missing fields as data gaps.'
      pattern_groups:
        - ['真实掉帧', 'real[_\s-]?jank']
        - ['最长帧', 'longest frame', '峰值']
    - id: case_recommendations
      label: 相似案例引用
      description: '当 typed caseRecommendations 中存在 strong 匹配时，报告需引用对应 case_id，并说明它是证据验证后的相似案例。'
      trigger_patterns:
        - 'case recommendation|caseRecommendations|相似案例|案例引用'
      pattern_groups:
        - ['case_id', '相似案例', '案例引用', 'case recommendation', 'case[-\s]?based']

phase_hints:
  - id: overview
    keywords: ['概览', 'overview', '帧', 'frame', 'jank', '卡顿', 'scrolling_analysis', '统计']
    constraints: '必须调用 scrolling_analysis 获取 jank_type_stats 全量统计和 batch 根因分析覆盖信息。注意区分 buffer_stuffing（非真实掉帧）和感知掉帧；root_cause_analysis_scope=capped_frame_sample 时不得把 reason_code 样本写成全量分布。'
    critical_tools: ['scrolling_analysis']
    critical: false
  - id: root_cause_drill
    keywords: ['根因', 'root cause', '诊断', 'diagnos', '深钻', 'deep', 'drill', '代表帧', 'representative', '逐帧']
    constraints: '对占比 >15% 且绝对帧数 >3 的 reason_code，先读已有 direct evidence，再只选择能补齐当前证据缺口的深钻工具：RT/slice/unknown 用 jank_frame_detail，Binder/锁/IO 用 frame_blocking_calls，未解释的 Q4/wakeup 链才用 blocking_chain_analysis。无信息增益的工具必须跳过并说明，禁止机械执行三件套。workload_heavy 必须最后兜底。只有能命名一个尚缺字段时才允许最多一次定向 SQL；失败后标注证据边界并收口。'
    critical_tools: []
    max_tool_calls:
      execute_sql: 1
    critical: true
  - id: frame_metrics_overlay
    keywords: ['overrun', 'per_frame', 'ui time', 'cpu time', 'work period', 'mali', '帧内', '帧阻塞', '阻塞调用', 'Binder', 'futex', 'GPU', '功耗', '频率']
    constraints: '需要帧内 CPU/UI/GPU/阻塞调用细分时，优先用 frame_overrun_summary、cpu_time_per_frame、frame_ui_time_breakdown、frame_blocking_calls、android_gpu_work_period_track、mali_gpu_power_state 作为补充证据。缺 gpu_work_period 时必须标注数据不足。'
    critical_tools: ['frame_overrun_summary', 'cpu_time_per_frame', 'frame_ui_time_breakdown', 'frame_blocking_calls', 'android_gpu_work_period_track', 'mali_gpu_power_state']
    critical: false
  - id: missing_frame_gap
    keywords: ['缺帧', 'gap', 'frame_production_gap', '帧间', 'production gap', '隐形缺帧']
    constraints: '只有满足缺帧触发条件时才调用 frame_production_gap；如果 real_jank_count 足够、Buffer Stuffing 假阳性低且非 WebView/SurfaceTexture，要记录触发条件并跳过，不要重复要求 scrolling_analysis。'
    critical_tools: ['frame_production_gap']
    critical: false
  - id: chrome_scroll_jank
    keywords: ['Chrome', 'Chromium', 'WebView', 'scroll jank v4', 'preferred frame timeline', 'ChromeScrollJank']
    constraints: '当 trace 明确来自 Chrome/Chromium/WebView 或用户提到 Chrome scroll jank 时，调用 chrome_scroll_jank_frame_timeline。若返回 no_chrome_scroll_data，只能说明缺少 Chrome scroll instrumentation，不要把 Android app FrameTimeline 当作 Chrome scroll jank 证据。'
    critical_tools: ['chrome_scroll_jank_frame_timeline']
    critical: false
  - id: architecture_specific_jank
    keywords: ['TextureView', 'SurfaceTexture', 'WebView', 'DrawFunctor', 'React Native', 'RN', 'Fabric', 'JSI', 'GLSurfaceView', 'NativeActivity', 'OpenGL', 'Compose', 'Flutter', 'mixed', '混合', '架构', '生产端']
    constraints: '只执行当前 plan/gate 已激活的架构专属 Skill；runner-up 和静态工具列表不触发调用。aggregate/direct evidence 与已声明架构 Skill 已回答阶段目标时，立即 completed。只有能命名一个尚缺字段时才允许最多一次定向 SQL；失败后标注证据边界并收口，禁止 schema lookup + SQL 探索循环。用户显式要求额外 SQL/源码，或新 direct evidence 激活第二链路时，再用 revise_plan 最小补充。'
    critical_tools: []
    max_tool_calls:
      execute_sql: 1
    critical: false
  - id: display_pipeline_boundary
    keywords: ['BufferQueue', 'BLAST', 'dequeueBuffer', 'queueBuffer', 'SurfaceFlinger', 'HWC', 'acquire fence', 'present fence', 'release fence', 'refresh rate', '刷新率', 'ARR', 'VRR', 'FrameTimeline', 'sf_backpressure', 'gpu_fence_wait', 'resync', 'resynced', 'App Resynced Jitter']
    constraints: '当掉帧证据涉及 BufferQueue、Fence、SF/HWC、Buffer Stuffing、隐形掉帧或刷新率变化时，必须把 App/RenderThread、BufferQueue queue/dequeue/latch、SF commit/composite/present、HWC/display 与 acquire/present/release fence 拆开。queueBuffer 快不等于已上屏；dequeueBuffer 等待更接近 release fence/backpressure；刷新率/ARR/VRR 要用实际 VSync 周期，不默认 16.6ms。已有 scrolling_analysis:vsync_config artifact 时直接复用；只有该证据缺失时才调用 standalone vsync_config，不要把可选补充工具预先写成无条件 expectedCalls。'
    critical_tools: ['surfaceflinger_analysis', 'buffer_transaction_lifecycle', 'fence_wait_decomposition']
    critical: false
  - id: resync_sf_backlog
    keywords: ['resync', 'resynced', 'App Resynced Jitter', 'Choreographer#doFrame - resynced', 'SF没合成', '没有合成', '后面针堆积', '帧堆积', 'backlog']
    constraints: '命中 Choreographer#doFrame - resynced 或 App Resynced Jitter 时，先把它当作 Choreographer 因回调迟到/相位漂移而切到后续 VSync 的 marker，不要当作独立 doFrame 或普通业务耗时重复计数。必须继续核对 FrameTimeline 的 jank_type、present_type、vsync_resynced_jitter_millis、同 layer display/surface frame token 连续性、present_ts 间隔和 SF actual/display frame；只有存在 SF actual frame 缺失/late、SF jank_type、present gap 或 dropped display frame 证据时，才能说 SF 未合成对应帧。否则按 App resync/jitter、BufferQueue 背压或 App 未按时产帧描述，并说明 SF 结论证据不足。'
    critical_tools: ['scrolling_analysis', 'jank_frame_detail', 'consumer_jank_detection', 'frame_production_gap', 'surfaceflinger_analysis']
    critical: true
  - id: conclusion
    keywords: ['结论', 'conclusion', '输出', 'output', '报告', 'report', '总结']
    constraints: '输出必须包含：掉帧与根因分布（jank_type_stats 全量类型/责任 + batch 已分析帧 reason_code，并报告 root-cause X/Y coverage）+ 代表帧分析（含四象限+频率+根因推理链）+ 按优先级排序的优化建议。截断时禁止外推样本百分比。每个 CRITICAL/HIGH 必须有量化证据+因果链。lock_contention / binder_sync_blocking / render_sync_wait 必须分别引用对应 direct overlap；Q4b 可中断睡眠本身不能命名根因。'
    critical_tools: []
    critical: false

plan_template:
  mandatory_aspects:
    - id: frame_jank_analysis
      match_keywords: ['frame', 'jank', 'scroll', '帧', '卡顿', '滑动', 'scrolling_analysis', 'consumer_jank']
      suggestion: '滑动场景建议包含帧渲染/卡顿分析阶段 (scrolling_analysis, consumer_jank_detection)'
      required_expected_calls:
        - tool: invoke_skill
          skill_id: scrolling_analysis
    - id: frame_artifact_fetch
      match_keywords: ['fetch_artifact', 'batch_frame_root_cause', 'artifact', '掉帧与根因分布', '根因样本分布', '代表帧', 'reason_code']
      suggestion: '滑动场景先用 detail=summary 读取 scrolling_analysis 返回的 batch/root-cause artifact 聚合，并检查 root_cause_analysis_scope、已分析/eligible 帧数和 coverage。aggregate.complete 只证明 artifact 行聚合完整，不证明覆盖全部 eligible jank。只有聚合不完整、缺少结论所需字段或需要代表帧证据时，才读取解决该证据缺口所需的最少 rows。缺失或无掉帧时执行阶段标记 skipped 并说明。'
      required_expected_calls:
        - tool: fetch_artifact
    - id: root_cause_diagnosis
      match_keywords: ['root', 'cause', 'diagnos', '根因', '诊断', '深入', 'deep', 'jank_frame_detail', 'frame_blocking_calls']
      suggestion: '滑动场景必须包含证据驱动的根因判读阶段；先读取 batch direct evidence，再仅为可行动且尚未解释的证据缺口 revise_plan 添加一个最小深钻工具。terminal code 不预占调用。'
    - id: architecture_specific_jank
      waivable: false
      trigger_keywords: ['TextureView', 'SurfaceTexture', 'WebView', 'DrawFunctor', 'React Native', 'RN', 'Fabric', 'JSI', 'GLSurfaceView', 'NativeActivity', 'OpenGL', 'Compose', 'Flutter', 'mixed', '混合']
      match_keywords: ['TextureView', 'SurfaceTexture', 'WebView', 'DrawFunctor', 'React Native', 'RN', 'Fabric', 'JSI', 'GLSurfaceView', 'NativeActivity', 'OpenGL', 'Compose', 'Flutter', 'mixed', '混合', '架构']
      suggestion: '非标准/混合渲染架构必须在 plan.expectedCalls 声明门禁返回的 requiredExpectedCalls。只声明当前 detect_architecture/triggerContext 已命中的架构 Skill；未命中的条件分支不得加入 plan。执行时拆 HWUI host 链路 + 当前 producer 链路，再按证据合并因果。'
      conditional_required_expected_calls:
        - trigger_keywords: ['Flutter', 'FLUTTER']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: flutter_scrolling_analysis
        - trigger_keywords: ['TextureView', 'SurfaceTexture', 'TEXTUREVIEW_STANDARD']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: textureview_producer_frame_timing
        - trigger_keywords: ['WebView', 'DrawFunctor']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: webview_drawfunctor_jank_chain
        - trigger_keywords: ['RN_OLD_ARCH', 'React Native Bridge']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: rn_bridge_to_frame_jank
        - trigger_keywords: ['RN_NEW_ARCH', 'Fabric', 'JSI']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: rn_fabric_render_jank
        - trigger_keywords: ['GLSurfaceView', 'NativeActivity', 'OPENGL', 'GL_STANDALONE']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: gl_standalone_swap_jank
        - trigger_keywords: ['Compose', 'COMPOSE']
          required_expected_calls:
            - tool: invoke_skill
              skill_id: compose_recomposition_hotspot
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: flutter_scrolling_analysis
        - tool: invoke_skill
          skill_id: textureview_producer_frame_timing
        - tool: invoke_skill
          skill_id: webview_drawfunctor_jank_chain
        - tool: invoke_skill
          skill_id: rn_bridge_to_frame_jank
        - tool: invoke_skill
          skill_id: rn_fabric_render_jank
        - tool: invoke_skill
          skill_id: gl_standalone_swap_jank
        - tool: invoke_skill
          skill_id: compose_recomposition_hotspot
        - tool: invoke_skill
          skill_id: surfaceflinger_analysis
---

#### Scrolling Core Strategy

**Route card**: 滑动 / 卡顿 / 掉帧 / jank / scroll / fps / list / fling

**Execution contract**
- `submit_plan` 必须覆盖 frontmatter mandatory aspects；detail 仅 informational，不能替代 Skill/SQL/artifact 证据。
- 条件项只在用户问题、plan 或 trace 证据命中 trigger 时强制；无数据用 `skipped` + reason/waiver。
- 核心链路：`scrolling_analysis` → `fetch_artifact` 读 root-cause/frame artifact → 代表帧深钻。
- TextureView 的 `signal_inventory.event_count` 是信号次数，不是帧数；`consumer_notification` cadence gap 只是时序候选。未与 FrameTimeline / present 证据明确关联前，不得称为 hidden jank、producer stall 或根因。

**Required phases**
1. Overview: 调用 `scrolling_analysis`，区分 real jank、buffer stuffing 假阳性、隐形缺帧和 scroll session 边界。
2. Artifact read: 先用 `fetch_artifact(detail="summary")` 读取 batch/root-cause artifact。`aggregate.complete=true` 只表示当前 artifact 行已完整聚合；必须另读 `root_cause_analysis_scope`、`root_cause_analyzed_frame_count`、`root_cause_eligible_frame_count`、`root_cause_coverage_ratio`。只有 `full_frame_set + coverage=1` 才能把 reason_code 当全量分布；截断时只能报告已分析帧样本，禁止外推样本百分比。只有聚合不完整、缺字段或需要代表帧逐项证据时，才读取解决该缺口所需的最少 rows。
3. Root-cause drill: 对主要 reason_code 选最严重代表帧，先复用 batch direct evidence，再从 `jank_frame_detail` / `frame_blocking_calls` / `blocking_chain_analysis` 中选择最小适用集合；未命中相应证据边界的工具不调用。workload_heavy 只能最后兜底。
4. Conditional branches: TextureView/WebView/RN/GL/Compose/Flutter/mixed 命中时，`submit_plan` 必须在 `expectedCalls` 写入对应 producer/embedded/SF skill（Flutter 用 `invoke_skill(flutter_scrolling_analysis)`）；缺信号时执行阶段再 `skipped + reason`，不能在 plan 阶段 waiver 掉。
5. Display boundary: BufferQueue/Fence/SF/HWC/刷新率/resync 相关时拆 App/RT、queue/dequeue/latch、SF commit/composite/present、fence；不要默认 16.6ms。
   - 已有 `scrolling_analysis:vsync_config` artifact 时直接复用；只有 overview 缺少 VSync 证据时才调用 standalone `vsync_config`。不要在 `expectedCalls` 中无条件预占 standalone `vsync_config` 或其他仅用于补缺的工具。

**Final report must include**
- 必须显式出现 `### 掉帧与根因分布`：先给 jank_type_stats 全量类型/责任，再给 batch 已分析帧 reason_code；同时写根因分析 X/Y、coverage 和 scope。截断时禁止外推样本百分比。
- 必须显式出现 `### 代表帧分析`：耗时、超预算、vsync_missed、四象限/频率、关键 slice/阻塞点、因果链。
- 必须显式出现 `### 峰值/口径指标`：真实掉帧、假阳性、最长帧、最长连续丢帧；缺数据时写缺失来源和降级口径。
- 必须显式分层给出 App/系统建议。

**Detail refs**
- `scrolling:overview_artifacts`: scrolling_analysis、artifact 字段、全局上下文和身份确认。
- `scrolling:architecture_branches`: Flutter/TextureView/WebView/RN/GL/Compose/mixed 分支。
- `scrolling:root_cause_drill`: reason_code 深钻、frame_blocking_calls、blocking_chain_analysis、display pipeline 边界。
- `scrolling:missing_frame_gap`: frame_production_gap 触发和缺帧解释。
- `scrolling:final_report_and_sql_fallback`: 结论结构和 SQL fallback。


<!-- strategy-detail id="overview_artifacts" title="滑动概览、artifact、全局上下文和身份确认" keywords="overview,scrolling_analysis,fetch_artifact,batch_frame_root_cause,scroll_sessions,process_identity_resolver" default="true" -->
**Android 版本注意**：
- FrameTimeline 数据需要 Android 12+ (API 31)
- blocked_functions 需要 trace 包含 `sched/sched_blocked_reason`，并且设备 tracepoint / 符号化可用；缺失时不要只归因 CONFIG_SCHEDSTATS
- monitor_contention 需要 Android 13+ (API 33)
- input events 需要 Android 14+ (API 34)
- Android 14+ token 不再严格连续递增，token_gap 检测可能需调整
- Chrome/Chromium trace 与普通 Android app trace 不共用同一套 jank 语义；Chrome scroll jank 需要 `chrome_scroll_jank_frame_timeline` 中的 `chrome_scrolls`、`chrome_scroll_jank_v4_results` 或 preferred frame timeline 证据。

#### 滑动/卡顿分析（用户提到 滑动、卡顿、掉帧、jank、scroll、fps）

**⚠️ 核心原则：**
1. **逐帧根因诊断是最重要的**。概览统计（帧率、卡顿率）只是入口，真正有价值的是每一个掉帧帧的根因分析。
2. **掉帧检测使用混合证据口径**：非 Buffer Stuffing 帧以 `present_type in (Late Present, Dropped Frame)` 为权威消费状态；Buffer Stuffing 才用同 layer `present_ts` 间隔 `>1.5x && <=6x VSync` 二次验证。`On-time Present` 仅有长间隔时只能记为 cadence candidate，不能升级为 hidden jank。
   - **Per-Layer Buffer 枯竭检测（token-gap 辅助模型）**：当 App Layer 在连续 SF DisplayFrame 中出现 token 跳跃（gap > 1），说明 SF 在中间帧合成时该 Layer 没有新 Buffer = 缓冲区枯竭
   - `token_gap = 1` → 正常（每帧都有新 buffer），`token_gap = N` → 跳过 N-1 个 DisplayFrame
   - 这是 per-layer 检测，不受 SF 全局合成状态影响（SF 可能在消费其他 Layer 的 buffer）
   - **Prediction Error 帧处理**：Prediction Error 帧不应一律忽略。检查 prediction_type = 'Expired Prediction' 的比例：>5% 时标注"FrameTimeline 预测精度不足"。在管线 2-3 帧缓冲下用户可能感知延迟。孤立 Prediction Error 通常不代表用户可感知的 App 卡顿，但不能把密集或连续 Prediction Error 一概称为“统计噪声/统计假象”；present gap、Dropped Frame 或成簇异常必须单独报告。即使 App Deadline Missed 是唯一可直接归因到 App 的类别，也不能写成“唯一真实/唯一用户可感知掉帧”，不能用“仅 N 帧真实/可感知”排除其余呈现间隔异常。
3. **Guilty Frame 溯源**：
   - BlastBufferQueue 三缓冲下，可见卡顿通常出现在慢帧 2-3 帧之后（管线排空）
   - `guilty_frame_id` 字段指向导致管线枯竭的实际慢帧（向前回溯 ≤5 帧，取最慢的超预算帧）
   - 根因分析（四象限/CPU/Binder）应针对 guilty frame 而非枯竭帧本身
4. **get_app_jank_frames 结果中的 `jank_responsibility` 字段**：
   - `APP`：App 侧原因（App Deadline Missed / Self Jank）
   - `SF`：SurfaceFlinger 侧原因
   - `HIDDEN`：缓冲区枯竭但框架未标记（Perfetto 帧颜色为绿色）
   - `BUFFER_STUFFING`：Buffer Stuffing
5. **Resync 判读边界**：
   - `Choreographer#doFrame - resynced to <vsync> in <x>ms` 是 doFrame 内部 child marker，表示回调已经晚到至少一个 VSync，Choreographer 重新绑定到后续 frame timeline；它不是一帧新的 doFrame，也不是可直接归因给 SF 的合成 slice。
   - `App Resynced Jitter` 属于 App 侧 FrameTimeline jank 类型；报告中应把它作为 App 相位重同步/回调迟到信号，并继续寻找导致迟到的主线程/RT/GPU/BufferQueue 证据。
   - 用户怀疑“resync 后 SF 没合成对应帧、后面帧堆积”时，必须用同 layer token、present_ts 间隔、SF actual/display frame、present_type/dropped frame 或 SF jank_type 证明；不能仅凭 resync marker 下结论。

**Phase 1 — 概览 + 掉帧列表 + 批量根因分类（1 次调用）：**

如果 `process_name` 来自自动焦点检测、或用户/trace 证据提示进程名与包名/线程名/layer 不一致，先执行 **Phase 1.6 进程身份交叉确认**，再调用本阶段的 `scrolling_analysis`。

```
invoke_skill("scrolling_analysis", { start_ts: "<trace_start>", end_ts: "<trace_end>", process_name: "<resolver.recommended_process_name_param 或用户明确指定的包名>" })
```
- 建议传入 start_ts 和 end_ts 以获得更精确的结果
- 如果不知道 trace 时间范围，先用 SQL 查询：
  `SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice`
- 返回结果以 artifact 引用形式返回（紧凑摘要），包含：
  - `jank_type_stats`：掉帧类型分布，**注意 real_jank_count（真实掉帧）vs false_positive（假阳性）**
  - `scroll_sessions`：滑动区间列表
  - `input_data_check` / `input_latency_summary`：可选的 android.input 证据源检测和输入分发/处理/ACK/跟手度概览。缺数据时只能说明 trace 未包含完整 input event 链路，不可据此否定输入延迟问题
  - `batch_frame_root_cause`（主掉帧列表）：已选择掉帧帧的**完整逐帧分析**（frame_id + start_ts + jank_type + jank_responsibility + vsync_missed + reason_code + 四象限 MainThread/RenderThread + CPU 频率 + Binder/GC 重叠 + Input 处理证据 + 根因分类）。先读 `root_cause_analysis_scope` 和 X/Y coverage；默认每 Session 最多 200 帧，截断时它是代表性严重帧样本，不是全量 reason_code 分布
    - 特别注意 `App Resynced Jitter` / `Choreographer#doFrame - resynced...`：它们只能说明 App doFrame 相位重同步；如果要声称 SF 未合成，必须补充 consumer/SF 侧证据
  - `get_app_jank_frames`（内部数据源，无独立显示）：掉帧帧列表，供 Agent 内部使用（焦点区间、帧实体捕获）
  - `scroll_sessions` 可展开：点击展开某个滑动区间，可查看该区间的**四象限分布、CPU 频率、关键线程大小核分布**（由 `session_stats_batch` 提供）
  - `session_quadrant_summary`（兼容数据源，不独立显示）：**滑动过程整体**四象限分布，Agent 可通过 save_as 引用
  - `session_cpu_freq`（兼容数据源，不独立显示）：CPU 频率分布
  - `session_thread_core_affinity`（兼容数据源，不独立显示）：关键线程大小核分布
- **读取 artifact**：默认先取 `fetch_artifact(artifactId, detail="summary")`。summary 的 `aggregate` 会说明 `analyzedRowCount`、`totalRowCount` 和 `complete`，并提供有界的分类计数与数值范围：
  - `complete=true` 时可直接用 aggregate 回答全表分布，不再为了流程完整性分页读取原始行。
  - `complete=false`、缺少结论字段或需要核对代表帧时，才用 `detail="rows"` 读取解决该证据缺口所需的最少行；说明样本口径，不把样本占比写成全量占比。
  - 不得仅因 `hasMore=true` 自动翻完所有页；原始 rows 用于验证具体帧，不替代已有的完整聚合。
  - 用户明确要求“不要 rows / 不读原始 rows / no raw rows”时，该约束适用于本轮所有 artifact，包括小表；只能使用 summary aggregate，缺字段就报告证据边界，不能以行数少为理由绕过。
  - “不分页”单独出现时只禁止机械翻页或读完整表；“不逐帧”单独出现时只禁止 per-frame 深钻，不自动禁止小型非逐帧 artifact rows。用户显式要求查看某个 row/table 时优先满足，除非同时明确禁止 row access。
- 如果 `buffer_tx_coverage.coverage_status = target_process_not_found`，或 `fallback_no_frame_timeline` 只有数据不可用提示而没有可用替代源，立即停止自动追加帧/架构 Skill 与探索 SQL。目标进程缺失时说明当前 trace 未包含目标包并建议核对包名或重新采集；目标进程存在但无帧源时说明 FrameTimeline/BufferTX 证据不可用。两种情况都不得写成性能正常，也不得为了完成流程改查无关进程。
- `vsync_source = default_60hz_no_trace_timing` 只是内部默认预算，不是 trace 实测刷新率；当帧数据源不可用时，不得把 60Hz 当作设备或本次场景事实交付。

**Phase 1.3 — 全局上下文检查（基于 `global_context_flags` 结果，scrolling_analysis 自动输出）：**

检查 `global_context` 数据源中的标志。在**结论概述段**（帧率/掉帧率数据紧后）用粗体标注，格式如下：

| 标志 | 条件 | 在结论概述段标注 |
|------|------|----------------|
| `video_during_scroll = 1` | 滑动期间有视频解码活跃 | ⚠️ **视频播放并行**：滑动期间检测到视频解码活跃，workload_heavy 帧的负载归因不能全部归因于滑动渲染 |
| `interpolation_active = 1` | 大量 frame_id=-1 的插帧 | ⚠️ **OEM 插帧模式活跃**：统计指标（帧率/掉帧率）可能受插帧影响失真 |
| `thermal_trending = 1` | trace 尾部频率天花板明显低于峰值 | ⚠️ **温控持续降频**：thermal_throttling 帧的根因是系统级热管理，非 App 问题 |
| `background_cpu_heavy = 1` | 非 App 大核占比 >60% | ⚠️ **后台 CPU 干扰**：{non_app_big_core_pct}% 的大核 CPU 被非前台进程占用。需用 `execute_sql` 查询 top 占用进程 |

⚠️ 全局上下文标志**不改变 reason_code 分类**，仅在结论概述段增加修饰标注。多个标志同时为 1 时全部标注。
<!-- /strategy-detail -->

<!-- strategy-detail id="architecture_branches" title="滑动混合架构和 producer 分支" keywords="Flutter,TextureView,WebView,React Native,GLSurfaceView,Compose,mixed,architecture" -->
**Phase 1.5 — 架构感知分支（基于 detect_architecture 结果）：**

`detect_architecture` 的 `primary_pipeline_id` 是当前选中的主 pipeline，也是初始 plan hard gate 的架构事实。`candidates_list` 是排序候选和检测审计证据：runner-up 单独出现不等于该链路已激活，不得因此自动加入对应专属 Skill。只有 selected pipeline 明确为 mixed、结构化架构字段或用户问题明确要求该链路，或执行阶段新增 direct evidence 确认第二 producer 时，才按 **multi-pipeline** 处理；后者通过 `revise_plan` 最小补充，不在初始 plan 预占所有候选。

**混合出图规则：**
1. **先分开看 HWUI host 链路**：始终调用 `scrolling_analysis` 获取宿主 App FrameTimeline、MainThread/RenderThread、SF 责任分布。
2. **再分开看 producer/embedded 链路**：只按 selected/明确激活的 pipeline 调用对应 skill（Flutter、WebView、TextureView、RN、GL、游戏/媒体）；runner-up 仅说明检测不确定性。
3. **最后合并看链路依赖**：判断 producer 是否阻塞/拖慢 host RT、host 是否吞掉 producer 帧、SF 是否在多 layer 中沿用旧 buffer，或两条链路只是并行同屏但无依赖。

架构 aggregate 和已激活专属 Skill 已能回答上述依赖时应直接闭合阶段。只有一个可命名的结论字段仍缺失时，才补一次定向 SQL；查询失败或字段不可用后记录边界并收口，不得转入 schema lookup + 多轮探索 SQL。

**输出必须分三段**：`HWUI host 证据`、`嵌入/独立 producer 证据`、`合并因果判断`。不能只说“这是 Flutter/WebView/RN 架构所以改用某一个 skill”，也不能只说“FrameTimeline 正常所以无卡顿”。

| 架构 | 调整动作 |
|------|---------|
| **selected ANDROID_VIEW_MIXED / direct evidence 已确认多链路** | 先 `scrolling_analysis` 分析 HWUI host，再只对已确认激活的链路补 skill：Flutter → `flutter_scrolling_analysis`，WebView → `webview_drawfunctor_jank_chain`，TextureView → `textureview_producer_frame_timing`，RN → RN 专属 skill，GL/Game → GL/Game 专属 skill。最后检查 host/producer/SF 三者是否有依赖；不得把所有 runner-up 逐个执行一遍 |
| **Flutter** | 不替代 host 分析。先用 `scrolling_analysis` 看宿主 HWUI/SF，再用 `invoke_skill("flutter_scrolling_analysis")` 看 1.ui/1.raster。Flutter TextureView 还要补 `textureview_producer_frame_timing` 或 `frame_production_gap` 看宿主 RT updateTexImage/帧吞噬 |
| **WebView GL Functor / TextureView** | 先用 `scrolling_analysis` 获取宿主帧概览，再调用 `invoke_skill("webview_drawfunctor_jank_chain", {process_name, start_ts, end_ts})` 关联 V8/Chromium/Functor 与宿主帧。若是 WebView SurfaceTexture/X5/UC 内核，补 `textureview_producer_frame_timing` 或 `frame_production_gap` 检查生产端帧吞噬 |
| **SurfaceTexture / TextureView** | 先用 `scrolling_analysis` 看宿主 HWUI。SurfaceTexture 出图时注意**单 buffer 帧吞噬**：producer 写入新帧覆盖了 consumer 尚未读取的旧帧。表现为帧间 gap 但无 jank 标记。可调用 `invoke_skill("textureview_producer_frame_timing", {process_name, start_ts, end_ts})` 和 `invoke_skill("frame_production_gap")` 检测生产端帧间隔与宿主消费 gap |
| **React Native Old Architecture** | 先用 `scrolling_analysis` 看 HWUI host，再调用 `invoke_skill("rn_bridge_to_frame_jank", {process_name, start_ts, end_ts})` 检查 JS/BatchedBridge/UIManager 工作是否与掉帧帧重叠 |
| **React Native Fabric / JSI** | 先用 `scrolling_analysis` 看 HWUI host，再调用 `invoke_skill("rn_fabric_render_jank", {process_name, start_ts, end_ts})` 检查 Fabric commit、Mounting、JSI/TurboModule 同步工作是否拖慢帧 |
| **GLSurfaceView / NativeActivity / OpenGL ES** | 先用 `scrolling_analysis` 看宿主/SF 消费端；再调用 `invoke_skill("gl_standalone_swap_jank", {process_name, start_ts, end_ts})` 检查应用自管 swap/present 间隔 |
| **标准 HWUI** | 使用标准 `scrolling_analysis`。当 `type=STANDARD`、selected `primary_pipeline_id` 为 `ANDROID_VIEW_STANDARD_*`，且没有结构化字段、用户意图或 direct evidence 激活 producer/嵌入链路时，不要把 Flutter、TextureView、SurfaceView、WebView、RN、GL/Game 等架构专属 Skill 预先写入 `expectedCalls`；runner-up candidate 不改变这一点 |
| **Compose** | 使用标准 `scrolling_analysis`。如果检测到 Compose 架构，注意 Recomposition* slices 可能是卡顿主因。LazyColumn/LazyRow 的 prefetch 和 compose 阶段如果超时会导致掉帧。可调用 `compose_recomposition_hotspot` 检测过度重组；新版会在 FrameTimeline 可用时输出 recomposition→frame 重叠证据 |

**滑动场景计划契约（submit_plan 时提前声明）：**
- 概览/数据收集阶段通常应声明 `expectedCalls: [{ tool: "invoke_skill", skillId: "scrolling_analysis" }]`，并在 `expectedTools` 中同时包含可能用到的 `execute_sql`、`fetch_artifact`、`lookup_sql_schema`。
- 根因诊断阶段先声明“读取 batch direct evidence 并决定是否需要深钻”，不要在初始计划里预占 `jank_frame_detail` / `frame_blocking_calls` / `blocking_chain_analysis`。执行中确认存在可行动证据缺口后，再 `revise_plan` 添加一个匹配的最小调用；terminal code 不加调用。
- Flutter、TextureView、SurfaceView、WebView、RN、GL/Game 等混合管线阶段，应把对应架构 Skill 写进 `expectedCalls`；如果要用 FrameTimeline、`thread_slice`、BufferQueue、VSYNC 或 SF 表做兜底 SQL 交叉验证，`expectedTools` 必须包含 `execute_sql`，并先包含/调用 `lookup_sql_schema`。
- 缺帧/producer gap 阶段若会检查 Flutter TextureView、SurfaceTexture 或多 layer 生产端，`expectedCalls` 至少包含 `frame_production_gap`，按架构再追加 `textureview_producer_frame_timing`、`flutter_scrolling_analysis` 或其他 producer Skill。
- **架构专属 expectedCalls 必须由证据触发，不能为“可能存在”的分支预占坑位。** 在初始计划中，若自动检测为标准 HWUI（`STANDARD` + `ANDROID_VIEW_STANDARD_*`）且没有非标准候选/特征，只声明标准链路和已知根因的调用；不得把 `textureview_producer_frame_timing`、`flutter_scrolling_analysis`、WebView、RN、GL/Game 等 producer Skill 写入 `expectedCalls`。执行中只有 `detect_architecture`、FrameTimeline、layer/线程或 Skill 结果出现相应证据后，才 `revise_plan` 加入**匹配的那个**架构 Skill，再执行它。`surfaceflinger_analysis` 仅在 SF 合成责任、BufferQueue/Fence 或 reason_code 证据出现时作为独立根因分支加入，不能作为猜测 producer 的理由。
- 进程身份来自自动焦点检测、Skill 返回空但线程/layer 有目标信号、或身份准入提示 ambiguous/blocked 时，单独设置身份确认阶段，并声明 `expectedCalls: [{ tool: "invoke_skill", skillId: "process_identity_resolver" }]`；执行中才发现时先 `revise_plan` 再调用。

**Phase 1.6 — 进程身份交叉确认（当 process_name 可能不可靠时）：**

系统会在进程级 Skill 执行前自动做身份准入。满足任一条件时，若准入返回 ambiguous/blocked，调用 `invoke_skill("process_identity_resolver", { process_name, start_ts, end_ts })` 查看候选进程，再继续深钻：
- `process_name` 来自自动焦点检测，而不是用户明确指定
- 用户反馈 Perfetto UI 里进程名不对、线程名/layer 看起来对
- `scrolling_analysis`、架构专属 Skill 或自定义 SQL 返回空结果，但 FrameTimeline/layer/线程名明显有目标应用信号

处理规则：
- 使用 resolver 第一名候选的 `recommended_process_name_param` 作为后续 `scrolling_analysis` / `jank_frame_detail` / `frame_blocking_calls` 的 `process_name`
- 在结论中把 `canonical_package_name` 当作用户可读的目标应用身份；不要把它和旧 Skill 的 `process_name` 参数混为一谈
- 如果 resolver 只有 `weak_match` 或提示 shared UID，多抓取候选行并说明身份不确定性；必要时先不传 `process_name` 跑全量概览，再按 `upid`/线程/layer 过滤
<!-- /strategy-detail -->

<!-- strategy-detail id="root_cause_drill" title="滑动根因分支深钻和 display pipeline 边界" keywords="root cause,reason_code,jank_frame_detail,frame_blocking_calls,blocking_chain_analysis,SurfaceFlinger,Fence,BufferQueue" -->
**Phase 1.7 — 根因分支深钻（基于 batch_frame_root_cause 的 reason_code 和 jank_responsibility）：**

| 条件 | 深钻动作 | 目标 |
|------|---------|------|
| **多帧 `reason_code = sf_composition_slow`** | 调用 `invoke_skill("surfaceflinger_analysis")` | SF 合成延迟原因：HWC 回退 GPU 合成？Layer 过多？Fence 超时？ |
| **`reason_code = prediction_error`** | 默认不追加逐帧 App 深钻；聚合占比并说明 SurfaceFlinger scheduler prediction drift | 孤立预测误差通常不可感知；不能改写成 App、GPU 或 SF CPU 变慢。只有用户追问或误差持续集中时才补显示时序证据。 |
| **`reason_code = display_hal`** | 默认复用 FrameTimeline 直接证据；持续高占比且用户要求系统侧定位时，才补 `surfaceflinger_analysis` / display pipeline 证据 | 边界是 SF 已按时下发、HAL 未在目标 VSync 呈现，不调用 App 帧内工具。 |
| **`reason_code = app_jank_unattributed`** | 明确写“App 责任已确认、底层原因证据不足”；仅在 trace capability 和用户目标表明会增加信息时，选择一个最小深钻工具 | 不把未归因标签改写成 Binder、GC、锁、调度或工作负载根因。 |
| **`reason_code = frame_timeline_unattributed`** | 明确写“FrameTimeline 标记了 Unknown Jank，但当前 trace 无法归因到 App、SF 或帧内直接机制”；默认停止自动深钻 | 仍须报告观测到的异常与不确定性，不能写成噪声、假帧或不可感知。只有用户追问，或新 capability/证据能增加信息时，才选择一个最小工具。 |
| **多帧 `reason_code = thermal_throttling` 或 `cpu_max_limited`** | 调用 `invoke_skill("thermal_throttling")`，或 `lookup_knowledge("thermal-throttling")` | 温度曲线？限频策略？是持续降频还是间歇性？thermal 还是 policy governor？ |
| **多帧 `reason_code = gc_pressure_cascade`** | 查询 `android_garbage_collection_events` 全程分布 | GC 频率趋势？是否有内存泄漏迹象？哪种 GC 类型为主？ |
| **多帧 `reason_code = render_thread_heavy`** | 对最严重帧调用 `invoke_skill("jank_frame_detail")` 查看 RT top slices | uploadBitmap？shader 初始化？syncFrameState？drawFrame 内部哪个阶段慢？ |
| **多帧 `reason_code = gpu_fence_wait` 或 `shader_compile`** | 调用 `invoke_skill("gpu_analysis")`；若证据指向 BufferQueue/Fence，再补 `fence_wait_decomposition` / `present_fence_timing` / `vsync_config` | GPU 频率被限？shader 复杂度？GPU 负载过高？还是 acquire/present/release fence 或刷新率预算导致？ |
| **多帧 `reason_code = binder_sync_blocking` / `binder_timeout` / `lock_contention` / `io_page_cache_wait` / `uninterruptible_wait` / `main_thread_file_io`** | 对最严重帧调用 `invoke_skill("frame_blocking_calls", {process_name, start_ts, end_ts})` | 帧窗口里真正重叠的是 Binder、monitor 锁竞争、futex、文件 IO，还是仅有 D/DK 不可中断等待候选？重叠多久？ |
| **多帧 `reason_code = render_sync_wait`** | 读取 `render_sync_wait_ms` 和主/RT slices；需要定位 RT 内部工作时，对最严重帧调用 `jank_frame_detail({frame_id})` | 区分主线程自产 UI 工作、postAndWait/syncFrameState 同步边界与 RenderThread 回放/提交压力。不要改写成锁/Binder。 |
| **多帧 `reason_code = input_handling_slow`** | 先读取 `input_events_json` / `input_slices_json`，再对最严重帧调用 `frame_blocking_calls` 或 `jank_frame_detail` | 是 `deliverInputEvent` / `dispatchTouchEvent` / `onTouchEvent` 本身慢，还是 input 回调里同步 Binder/IO/锁/RecyclerView inflate/bind？ |
| **VRR 设备（VSync 周期 ≠ 16.67ms）** | 注意 1.5x VSync 阈值需基于实际 VSync 周期 | 如 120Hz = 8.33ms, 1.5x = 12.5ms |

**Display pipeline 边界（当证据命中 SF/BufferQueue/Fence/刷新率时必须写清）：**
- `queueBuffer()` 只证明 producer 已提交 buffer；它不证明 SurfaceFlinger 已 acquire/latch，也不证明 HWC/panel 已 present。
- `dequeueBuffer` 长等通常更接近 release fence / BufferQueue backpressure / triple-buffer 槽位复用问题；不要把它直接写成 App 主线程代码慢。
- Fence 要拆成 acquire / present / release：acquire 影响 SF latch，present 影响用户可见上屏，release 影响 producer 复用上一帧 buffer。
- HWC 不是 BufferQueue consumer；SurfaceFlinger 消费 buffer 后，再通过 HWC validate/accept/present 或 RenderEngine 合成。
- 刷新率/ARR/VRR 会改变帧预算。报告必须基于 `vsync_config`、VSYNC-sf、FrameTimeline 或等价证据，不默认 16.6ms。
- 当 `performance_summary.fps_source = buffer_tx_rising_edge_fallback` 时，必须引用 `coverage_status`、`frame_timeline_to_buffer_tx_ratio`、`frame_source_track` 和 effective span，并按覆盖模式分层：
  - `no_frame_timeline_coverage`：只能交付目标包 BufferTX 正向 delta 支持的帧产出数和 FPS；不支持 App/SF 责任、掉帧率、峰值长帧或根因结论。相应小节标记“当前 trace 证据不可用”，不得填 0 或根据 FPS 推断无卡顿。
  - `partial_frame_timeline_coverage`：overview 帧数/FPS 以 BufferTX 为准；`jank_type_stats` / `batch_frame_root_cause` 仅是 FrameTimeline 覆盖到的 sparse sample。只能表述“已观测样本中的根因”，必须引用 `evidence_scope=partial_sample` 和 coverage ratio，不得写成全量根因分布或用样本比例估算全量帧数。
  - `frame_timeline_to_buffer_tx_ratio` = FrameTimeline 帧数 / BufferTX 产出帧数，是两个独立来源的比值，**不是有界覆盖率**（字段与标签都已按"帧数比"命名，不要再当成百分比覆盖率读）：`> 1 说明 BufferTX 少计`（track 选择或 rising-edge 判定漏帧），不代表覆盖超过 100%。此时以 FrameTimeline 为准并写明 BufferTX 少计，不要表述成“覆盖率 100.x%”。
- GraphicBuffer/dma-buf 是图形物理内存证据面；BufferQueue/Fence slice 只能证明队列、同步和背压候选，不能单独证明图形内存泄漏或占用峰值。

**Phase 1.8 — 帧内指标 / GPU / CPU 利用率补充（按需执行）：**

当用户追问"每帧 CPU/UI 时间"、"GPU work period"、"Mali power state"、"是 CPU 还是 GPU 限制"时，优先调用已落地的 B-tier atomic skill：

| 问题 | 调用 | 说明 |
|---|---|---|
| 每帧 deadline overrun | `invoke_skill("frame_overrun_summary")` | 基于 `android.frames.per_frame_metrics`，列出 overrun 帧 |
| 每帧 CPU 时间 | `invoke_skill("cpu_time_per_frame")` | 区分帧窗口内 CPU 消耗 |
| UI thread 时间分解 | `invoke_skill("frame_ui_time_breakdown")` | 看 UI thread 在每帧的耗时分布 |
| 每帧阻塞调用 | `invoke_skill("frame_blocking_calls")` | 将掉帧帧与 Binder/GC/锁竞争/futex/文件 IO 阻塞区间做重叠匹配 |
| CPU process/thread 周期利用率 | `invoke_skill("cpu_process_utilization_period")` / `invoke_skill("cpu_thread_utilization_period")` | 用于 workload_heavy、后台抢占、线程归因 |
| 进程 slice CPU 热点 | `invoke_skill("process_slice_cpu_hotspots", { process_name, start_ts, end_ts })` | 用 `thread_state=Running` 求交，确认掉帧窗口内真正消耗 CPU 的 named slice |
| CPU cluster 拓扑 | `invoke_skill("cpu_cluster_mapping_view")` | 解释大小核分布，辅助 small_core_placement |
| GPU work period | `invoke_skill("android_gpu_work_period_track")` | 只有 `gpu_work_period` capability 可用时才做 GPU active region 判断 |
| Mali power state | `invoke_skill("mali_gpu_power_state")` | Mali 设备专用；无数据时标注设备/trace 不支持 |

这些是补充证据，不替代 Phase 1.9 对可行动根因的按需深钻。`prediction_error`、`display_hal`、`app_jank_unattributed`、`frame_timeline_unattributed` 按下述 terminal-code 例外处理。若 Trace 数据完整度提示 `gpu_work_period` / `cpu_freq_idle` 缺失，结论中必须说明 GPU/CPU 供应侧判断的可信度下降。

**Phase 1.9 — 可行动根因深钻（有信息增益时强制）：**

对 `batch_frame_root_cause` 中**占比 >15% 且绝对帧数 >3** 的可行动 reason_code，先读 batch 已有 direct evidence；仍有明确证据缺口时，**必须**选最严重的 1 帧并调用一个能补齐该缺口的最小工具。不得为了满足流程重复查询已有字段。
`prediction_error`、`display_hal`、`app_jank_unattributed`、`frame_timeline_unattributed` 是 evidence-bound terminal codes：前两者已有 FrameTimeline 系统边界，`app_jank_unattributed` 表示 App 责任已确认但底层机制证据不足，`frame_timeline_unattributed` 表示原始 Unknown Jank 在当前 trace 中没有 App、SF 或帧内直接机制证据。仅因占比超过阈值，不得强制调用逐帧 App 深钻工具。若同一报告还包含 workload/freq/lock/GC/render/SF composition 等可行动 reason，仍须对那些 reason 执行本阶段。
**⛔ 禁止**仅靠 workload_heavy 等统计分类直接出结论，也禁止把 terminal code 扩写成其证据不支持的具体原因。

**常见错误：** 看到 reason_code=workload_heavy 就结论"工作负载过重"，但没有回答：具体是哪段代码？为什么在这个时机执行？是否可异步/分帧？这不是根因分析，这只是分类。

| 条件 | 深钻动作 | 目标 |
|------|---------|------|
| **Q4>20% 且 batch/direct overlap 仍不能解释等待来源** | `invoke_skill("blocking_chain_analysis", {start_ts, end_ts, process_name})` | 补齐未解释的阻塞/唤醒链；已有 Binder、锁、IO 或 RT-sync direct evidence 时不要重复调用。 |
| **帧内 Binder/IO/futex/锁信号**（`reason_code` 为 `binder_sync_blocking` / `binder_timeout` / `lock_contention` / `io_page_cache_wait` / `uninterruptible_wait` / `main_thread_file_io`，或 `top_slice_name` 包含 `Binder` / `SharedPreferences` / `sqlite` / `fsync` / `futex` / `monitor` / `Lock`） | `invoke_skill("frame_blocking_calls", {start_ts, end_ts, process_name})` | 将掉帧帧和阻塞调用做时间重叠，确认真实影响帧窗口的调用类型、重叠时长和频次；`uninterruptible_wait` 需要 io_wait/blocked_function 或 app-level IO 证据才能升格为 IO |
| **render_sync_wait** | 先复用 batch 的 `render_sync_wait_ms`；只有需要定位 RenderThread 内部 slice 时再调用 `jank_frame_detail({frame_id})` | 解释 UI→RT 同步边界和实际 RT 工作，不重复调用 Binder/锁工具。 |
| **input_handling_slow** | 读取 `input_stage`、`input_slice_ms`、`input_handling_ms`、`input_events_json`；若 input slice 内有 Binder/IO/锁，再调用 `frame_blocking_calls` | 确认 input-bound 的直接机制：App input callback 慢、事件批处理过多、还是 input 内同步阻塞 |
| **binder_overlap >5ms** | `invoke_skill("binder_root_cause", {start_ts, end_ts, process_name})` | 服务端还是客户端慢？具体原因（GC？锁？IO？内存回收？）|
| **gc_overlap >3ms 或 gc_pressure_cascade** | 查询 `android_garbage_collection_events` WHERE gc_ts 在帧窗口内 | 哪种 GC？回收了多少？GC 运行耗时？是否有内存泄漏趋势？|
| **thermal_throttling / cpu_max_limited** | `lookup_knowledge("thermal-throttling")` | 温度驱动 vs policy 驱动？限频比例？是否持续恶化？|
| **render_thread_heavy** | `invoke_skill("jank_frame_detail", {start_ts, end_ts})` 查看 render_slices_json | RT 内部瓶颈：uploadBitmap？syncFrameState？drawFrame？eglSwapBuffers？|
| **sf_composition_slow** | `invoke_skill("surfaceflinger_analysis")`，必要时补 `buffer_transaction_lifecycle` / `fence_wait_decomposition` | SF 合成瓶颈：commit/composite/present 哪段慢？HWC delay？GPU 回退合成？Layer 过多？Fence/BufferQueue 背压？|
| **freq_ramp_slow** | `lookup_knowledge("cpu-scheduler")` | 是 governor 升频延迟还是 thermal 限频？|
| **small_core_placement** | `lookup_knowledge("cpu-scheduler")` | 为什么被调度到小核？大核被谁占用？|
| **gpu_fence_wait / shader_compile** | `lookup_knowledge("rendering-pipeline")`；fence/backpressure 命中时补 `fence_wait_decomposition` / `present_fence_timing` / `vsync_config` | GPU 频率是否被限？SF 合成是否是瓶颈？acquire/present/release fence 哪类等待主导？|
| **prediction_error / display_hal / app_jank_unattributed / frame_timeline_unattributed** | 默认不调用帧内深钻；按上面的 terminal-code 证据边界收口 | 避免把 scheduler drift、HAL present 边界或明确未归因状态变成机械工具链；Prediction Error 只能写成带范围限定的预测偏差；FrameTimeline 未归因帧不能写成噪声、假帧或不可感知。|

**workload_heavy 子分类指导：** 当 reason_code = `workload_heavy` 时，检查 `top_slice_name` 字段是否**包含**以下关键字，进一步归类（这是字符串包含匹配，不是 SQL 查询）：

| top_slice_name 包含 | 子分类 | 优化方向 |
|--------------------|--------|---------|
| `Choreographer` / `doFrame` / `doCallbacks` | doFrame 回调总时间过长 | [App层] 检查 measure/layout/draw 各阶段，减少过度绘制 |
| `layout` / `measure` / `onLayout` / `onMeasure` | 布局计算密集 | [App层] 减少嵌套层级，使用 ConstraintLayout，避免 requestLayout 连锁 |
| `obtainView` / `inflate` / `createViewFromTag` / `RecyclerView` / `prefetch` | View 创建/Inflate/预取过长 | [App层] 启用 RecyclerView 预创建、异步 inflate、ViewStub 延迟加载 |
| `animation` / `Animator` / `ValueAnimator` | 动画回调过长 | [App层] 检查是否有多个动画叠加，或动画回调中执行了耗时操作 |
| `input` / `dispatchTouchEvent` / `onTouch` / `onScrollChanged` | 输入处理阻塞 | [App层] 优先查看 `input_stage`、`input_slice_ms`、`input_events_json`，避免在 onTouchEvent/onScrollChanged 中执行耗时同步逻辑 |
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
- 不要用 `execute_sql` 从 `actual_frame_timeline_slice` 查询 `big_avg_freq_mhz`、`device_peak_freq_mhz` 或 `cpu_freq_clusters_json`；这些是 `batch_frame_root_cause` 的派生结果，不是 FrameTimeline 原生列。
- 不要把 `batch_frame_root_cause`、`__intrinsic_batch_frame_root_cause` 或任何 skill step/save_as 名称当作 SQL 表查询；它们是 Skill Artifact。先用 `fetch_artifact(detail="summary")` 读取聚合，只在聚合缺口或代表帧验证需要时读取最少 rows。

**WHY 链深度要求：** 每个 [CRITICAL]/[HIGH] 发现的根因推理链必须至少 2 级：
- ✅ Level 1: "帧超时" → Level 2: "Binder 阻塞" → Level 3: "服务端 system_server monitor_contention"
- ❌ 仅 Level 1: "帧超时 45ms，workload_heavy"（缺少机制解释）
<!-- /strategy-detail -->

<!-- strategy-detail id="missing_frame_gap" title="缺帧检测和 production gap" keywords="frame_production_gap,missing frame,缺帧,production gap,Buffer Stuffing" -->
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
<!-- /strategy-detail -->

<!-- strategy-detail id="final_report_and_sql_fallback" title="滑动最终报告结构和 SQL 回退方案" keywords="conclusion,final report,SQL,fallback,掉帧与根因分布,根因样本分布,代表帧" -->
**Phase 2 — 补充深钻（可选，仅在 Phase 1.9 深钻后仍需更多细节时执行）：**
Phase 1 的 `batch_frame_root_cause` 已包含每个**已分析帧**的完整统计数据。先检查 root-cause X/Y coverage；可行动分类仍需按 Phase 1.9 补齐机制证据，terminal codes 按其证据边界直接收口：
- MainThread 四象限（Q1 大核运行 / Q2 小核运行 / Q3 调度等待 / Q4 休眠）
- RenderThread 四象限（render_q1 大核 / render_q3 调度 / render_q4 休眠）
- CPU 大核频率（big_avg_freq_mhz / big_max_freq_mhz）+ 升频延迟（ramp_ms）
- Binder 同步重叠（binder_overlap_ms）+ GC 重叠（gc_overlap_ms）
- Input 管线证据（input_stage / input_slice_ms / input_handling_ms / input_event_count / input_events_json）
- 根因分类（reason_code）+ 关键操作（top_slice_name / top_slice_ms）

此外，每个滑动区间的**整体运行特征**（四象限分布、CPU 频率、关键线程大小核分布）已内嵌在 `scroll_sessions` 的展开行中（由 `session_stats_batch` 提供），无需调用 jank_frame_detail 或 blocking_chain_analysis 来获取全局指标。兼容数据源 `session_quadrant_summary`、`session_cpu_freq`、`session_thread_core_affinity` 仍可通过 save_as 引用。

**batch_frame_root_cause 的统计数据可用于分类和概览；只有存在可补齐的机制证据缺口时才执行 Phase 1.9 工具调用。** jank_frame_detail 仅在以下特殊情况需要调用：
仅在以下情况才调用 jank_frame_detail（**最多 2 帧**）：
- 需要查看 CPU 频率**时间线**（帧内频率变化过程）
- 需要查看 RenderThread 或主线程的 top N slices 详情
- **reason_code 为 unknown 且帧数 >5%**：必须对至少 1 帧调用 jank_frame_detail 获取更多线索，不能在分布表中仅标记"未分类"就跳过
- legacy artifact 的 reason_code 与 direct overlap 矛盾时，应明确标注旧分类不成立；当前 runtime 的 lock/Binder/RT-sync 结论必须分别由 numeric direct evidence 支撑。

如果深钻结果已给出更具体的根因，不要在最终报告继续把原始 `reason_code` 当作根因名称。典型例子：
- `render_sync_wait` 且 `render_slices_json` 出现 `cache_miss: makePipeline` / shader 编译 / Vulkan finish frame，应写成 **具体 RT 工作 + UI→RT sync wait**；不要把 Q4b 睡眠改写成锁或 Binder。
- `render_sync_wait` 只在主线程 Q4b>30%、去重后的同步等待同时达到帧预算 20% 与帧耗时 25% 的较大者，并且同窗有 RT active 或 `syncFrameState`/`DrawFrame` 直接证据时成立。更短的 `postAndWait` 只作为依赖放大证据；有 RT-heavy/workload/shader/GPU 等强 trigger 时，主 reason 保持 trigger。
- `workload_heavy` 但 `main_slices_json` 明确指向应用自定义方法，最终根因应写具体方法名和所处阶段，例如 `CustomScroll_longFrameLoad` 在 ANIMATION 回调同步执行，而不是只写 "workload_heavy"。

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

**Phase 3 — 综合结论（全量掉帧类型统计 + 明示覆盖率的根因分析）：**

**输出结构必须遵循。以下三个小节标题必须显式出现在最终报告中：`### 掉帧与根因分布`、`### 代表帧分析`、`### 峰值/口径指标`。**

1. **概览**（必须包含以下数据）：
   - 先检查 `fps_source` 和 `coverage_status`。如果是 `buffer_tx_rising_edge_fallback + no_frame_timeline_coverage`，本节只交付 BufferTX 帧数/FPS/effective span/证据轨道，下述掉帧、峰值、责任与评级要求改为显式“当前 trace 证据不可用”，不能从 NULL 填 0。如果是 `partial_frame_timeline_coverage`，同样不能输出全量掉帧/峰值/评级；可以附上 sparse root rows，但必须以 coverage ratio 标记为部分样本。
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

   最终报告中必须把上述峰值体验和指标口径整理到 `### 峰值/口径指标` 小节，不能只散落在概览或建议里。

2. **各滑动区间运行特征**（from scroll_sessions 展开行，或兼容数据源 session_quadrant_summary / session_cpu_freq / session_thread_core_affinity）：
   - 对每个滑动区间分别报告（如有多个区间，逐区间列出）：
   - 主线程四象限：Q1=XX% Q2=XX% Q3=XX% Q4a=XX% Q4b=XX%
   - RenderThread 四象限：Q1=XX% Q3=XX% Q4a=XX% Q4b=XX%
   - CPU 频率：prime 均频 XXMHz / big 均频 XXMHz / little 均频 XXMHz
   - 关键线程大小核分布：MainThread prime XX%+big XX% / RenderThread prime XX%+big XX%

3. **掉帧与根因分布**：
   - 先用 `jank_type_stats` 给出全量 jank_type / 责任方帧数与占比。
   - 再用 `batch_frame_root_cause` 按 reason_code 聚合已分析帧，附带四象限和频率特征；必须写 `root_cause_analyzed_frame_count / root_cause_eligible_frame_count`、`root_cause_coverage_ratio`、`root_cause_analysis_scope`。
   - 当 scope=`capped_frame_sample` 时，表头和正文都标记“已分析严重帧样本”；截断时禁止外推样本百分比到全部 eligible jank，也不能按样本占比排序全局优化优先级。
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
   - Input: 阶段 [input_stage] / 重叠 XXms / 最慢处理 XXms（如有 input 证据）
   ```
   如有额外深钻帧（来自 jank_frame_detail），标注其 CPU freq timeline 和 slices 详情。

   如果代表帧涉及 SF/BufferQueue/Fence/刷新率，必须追加一行 display pipeline 拆分：
   `App/RT -> BufferQueue -> SF commit/composite -> HWC/display -> fence`，并说明缺的是
   acquire、present 还是 release fence 证据。不要把 `queueBuffer` 快写成“已上屏”，也不要把
   GraphicBuffer/dma-buf 内存证据写成 BufferQueue 槽位证据。

5. **优化建议**：按根因类别给出可操作建议，优先级按帧数占比排序。**必须分层标注**：
   - **[App 层]**：App 开发者可直接实施的优化（异步化、分帧、预加载、减少主线程阻塞等）— 建议要具体到代码模式
   - **[系统/ROM 层]**：需要厂商协同或系统级权限的优化（governor 调优、thermal 策略、SCHED_UTIL_CLAMP 等）— 标注"需系统级能力"
   - 优先给出 App 层建议；系统层建议仅作为补充参考

**当报告隐形掉帧时，必须提醒用户：**
- 隐形掉帧在 Perfetto 时间线上帧颜色为**绿色**（框架标记 jank_type=None）
- 真实卡顿证据是 **VSYNC-sf 计数器轨道**上的呈现间隔异常（> 1.5x VSync 周期）
- 可参考帧列表中的"呈现间隔"列确认

⚠️ **结论必须覆盖全量掉帧类型/责任，并诚实披露根因分析覆盖率。**
   `jank_type_stats` 提供全量类型/责任统计；`batch_frame_root_cause` 提供已分析帧的详细机制分类和代表帧。只有 `root_cause_analysis_scope=full_frame_set` 时才能称为全量 reason_code 分布。

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
    (SELECT CAST(PERCENTILE(interval_ns, 50) AS INTEGER)
     FROM vsync_intervals
     WHERE interval_ns BETWEEN 4000000 AND 50000000),
    16666667
  ) as period_ns
),
frames AS (
  SELECT a.ts, a.dur, a.jank_type, COALESCE(a.present_type, 'Unknown Present') as present_type,
    a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END as present_ts,
    LAG(a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END)
      OVER (PARTITION BY a.layer_name ORDER BY a.ts) as prev_present_ts,
    CASE
      WHEN a.jank_type GLOB '*Self Jank*'
        OR a.jank_type GLOB '*App Deadline Missed*'
        OR a.jank_type GLOB '*App Resynced Jitter*' THEN 'APP'
      WHEN a.jank_type GLOB '*SurfaceFlinger*' THEN 'SF'
      WHEN a.jank_type GLOB '*Buffer Stuffing*' THEN 'BUFFER_STUFFING'
      WHEN a.jank_type GLOB '*Prediction Error*'
        OR a.jank_type GLOB '*Display HAL*' THEN 'SF'
      WHEN a.jank_type = 'None' OR a.jank_type IS NULL THEN 'HIDDEN'
      ELSE 'UNKNOWN'
    END as responsibility
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (
    '{process_name}' = ''
    OR p.name = '{process_name}'
    OR p.name GLOB '{process_name}:*'
  )
    AND p.name NOT LIKE '/system/%'
)
SELECT printf('%d', ts) AS start_ts, printf('%d', ts + dur) AS end_ts,
  ROUND(dur/1e6, 2) AS dur_ms, jank_type,
  CASE WHEN jank_type = 'None' OR jank_type IS NULL THEN '隐形掉帧' ELSE jank_type END as display_type,
  responsibility,
  MAX(CAST(ROUND((present_ts - prev_present_ts) * 1.0 / (SELECT period_ns FROM vsync_cfg) - 1, 0) AS INTEGER), 0) as vsync_missed
FROM frames
WHERE prev_present_ts IS NOT NULL
  AND (present_ts - prev_present_ts) <= (SELECT period_ns FROM vsync_cfg) * 6
  AND (
    (present_type IN ('Late Present', 'Dropped Frame')
      AND (responsibility != 'BUFFER_STUFFING'
        OR jank_type GLOB '*App Deadline Missed*'
        OR jank_type GLOB '*App Resynced Jitter*'
        OR jank_type GLOB '*SurfaceFlinger*'
        OR jank_type GLOB '*Prediction Error*'
        OR jank_type GLOB '*Display HAL*'))
    OR (responsibility = 'BUFFER_STUFFING'
      AND (present_ts - prev_present_ts) > (SELECT period_ns FROM vsync_cfg) * 1.5)
  )
ORDER BY vsync_missed DESC, dur DESC
LIMIT 20
```

⚠️ 注意：此 SQL 同时返回框架标记的掉帧和隐形掉帧。`display_type='隐形掉帧'` 的帧是框架未标记但消费端检测到的真实掉帧。

**回退 Step 2 — 只在有信息增益时选择代表帧深钻：**
- `prediction_error` / `Display HAL` 直接按 SF scheduler / HAL 呈现边界解释，不调用 App 帧内工具。Prediction Error 只允许带范围限定地说明“孤立错误通常不代表用户可感知 App 卡顿”；密集/连续样本、present gap 和 Dropped Frame 仍需分别报告，不能称为统计噪声。
- `frame_timeline_unattributed` 直接报告 FrameTimeline 的 Unknown Jank 与当前证据边界；不能写成噪声、假帧或不可感知，也不因占比高自动追加逐帧工具。
- `APP` / `HIDDEN` / `UNKNOWN` 只有在用户要求底层原因、trace 具备相应线程证据且当前 SQL 未能解释时，才选 1 个最严重代表帧调用：
```
invoke_skill("jank_frame_detail", { start_ts: "<帧的start_ts>", end_ts: "<帧的end_ts>", process_name: "<包名>" })
```
- 没有可补齐证据时直接说明边界，不得固定跑 top 5，也不得为了完成流程调用工具。
<!-- /strategy-detail -->

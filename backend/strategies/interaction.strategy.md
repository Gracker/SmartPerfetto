<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: interaction
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: interaction_critical_path
      domain: critical_path
      description: "Bind input event, receiving window, dispatch, app callback, state update and visible result. Select input/Main/render/SF tasks on that response path and distinguish ACK, focus and actual presentation."
    - id: interaction_dependencies
      domain: dependency_chain
      description: "Use Binder, lock, queue, input dispatch and display dependencies only where they explain response latency; preserve missing endpoint or causal-link limitations. Speculative frame matches are unproven candidates and NULL end-to-end latency is unmeasured, not zero."
classification_description: "Discrete input or tap response, from input dispatch through application handling to presentation."
priority: 4
effort: medium
required_capabilities:
  - input_latency
  - frame_rendering
optional_capabilities:
  - cpu_scheduling
  - binder_ipc
  - surfaceflinger
keywords:
  - 点击
  - 触摸
  - 输入延迟
  - 响应延迟
  - 点击慢
  - 响应慢
  - 点击卡顿
  - click
  - tap
  - touch
  - input latency
  - response time
  - click delay
  - input delay
  - InputDispatcher
  - InputChannel
  - FINISHED
  - ACK
  - wait queue
  - wq
  - stale event
  - focused window

final_report_contract:
  required_sections:
    - id: input_stage_breakdown
      label: 输入阶段拆分
      description: '把 dispatch、handling、ACK，以及 display/present 证据或缺口拆开，避免把 completed input event 总耗时写成上屏延迟；推测关联的 frame_id 不算上屏链接，NULL 延迟写未测量。'
      pattern_groups:
        - ['输入阶段拆分', '阶段拆分', 'latency breakdown', 'dispatch', 'handling', 'ACK']
        - ['dispatch', '分发', 'handling', '处理', 'ACK', 'FINISHED']
        - ['present', 'FrameTimeline', '上屏', 'display', '首帧', '缺失', '不适用']
    - id: ack_focus_window_boundary
      label: ACK/焦点/窗口边界
      description: '区分 iq/oq/wq、FINISHED ACK、stale drop、InputChannel、target/focused window；不能把这些直接等同 App 业务处理。'
      pattern_groups:
        - ['ACK/焦点/窗口', 'ACK', 'FINISHED', 'wait queue', '\bwq\b', 'stale', 'focused window', 'target window', 'InputChannel']
        - ['区分', '边界', '不是', '不能', '不可', '缺失', 'separate', 'not', 'missing']
        - ['iq', 'oq', '\bwq\b', 'FINISHED', 'ACK', 'stale', 'InputChannel', 'focused window', 'target window', '焦点', '窗口']
    - id: input_confidence_boundary
      label: 置信度与缺失证据
      description: '说明 android.input completed-event、dumpsys/logcat/WMS/InputDispatcher 和 FrameTimeline 哪些存在，哪些只能作为补证方向。'
      pattern_groups:
        - ['置信', 'confidence', '证据不足', '缺失', '限制', '补证', '下一步', '采集']
        - ['android\.input', 'completed', 'dumpsys', 'logcat', 'WindowManager', 'InputDispatcher', 'FrameTimeline', 'present', 'stale', 'focus']
        - ['不能', '不可', '不等于', '候选', '需要', 'missing', 'not']

phase_hints:
  - id: input_ack_queue_boundary
    keywords: ['InputDispatcher', 'InputChannel', 'FINISHED', 'ACK', 'wait queue', 'wq', 'iq', 'oq', 'input latency', '输入延迟']
    constraints: '先区分 completed android.input 事件的 dispatch/handling/ACK 总耗时与未完成 FINISHED 的队列背压。wq 增长只能说明目标连接尚未 ACK；必须结合 App 主线程、InputDispatcher、dumpsys/logcat 或窗口证据，不能直接命名 Binder、App 代码或 InputDispatcher 根因。'
    critical_tools: ['click_response_analysis', 'click_response_detail', 'input_events_in_range']
    critical: true
  - id: focus_window_stale_boundary
    keywords: ['stale', 'focused window', 'target window', 'InputChannel', 'WindowInfosListener', 'no focused window', '焦点', '窗口', '陈旧事件']
    constraints: 'stale drop、no-focused-window、InputChannel 创建/断连和 target-window 选择是不同对象。trace 只含 completed input events 时要写成证据缺口；需要 WindowManager/InputDispatcher logcat、dumpsys input 或窗口拓扑证据才能定因。'
    critical_tools: ['input_events_in_range']
    critical: false
  - id: display_present_boundary
    keywords: ['present', 'FrameTimeline', 'end_to_end_latency', 'frame_id', 'first frame', '首帧', '上屏', '端到端']
    constraints: 'total_latency_dur 是 dispatch-to-ACK，不是 input-to-present。只有 end_to_end_latency_dur、frame_id/FrameTimeline、RenderThread/SF present 证据可用时，才能写上屏或可见反馈延迟；否则只报告 dispatch/ACK 或首帧候选。'
    critical_tools: ['click_response_analysis', 'input_to_frame_latency', 'scroll_response_latency']
    critical: false

plan_template:
  mandatory_aspects:
    - id: input_latency_stage_breakdown
      match_keywords: ['dispatch', 'handling', 'ACK', 'FINISHED', 'click_response_analysis', 'input_events_in_range', '输入延迟', '阶段拆分']
      suggestion: '交互输入场景必须拆分 dispatch、handling、ACK，并说明 total_latency_dur 是否只覆盖 dispatch-to-ACK'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: click_response_analysis
        - tool: invoke_skill
          skill_id: input_events_in_range
    - id: focus_stale_channel_boundary
      match_keywords: ['stale', 'focused window', 'target window', 'InputChannel', 'WindowInfosListener', 'wait queue', 'wq', 'dumpsys', 'logcat', '焦点', '窗口']
      suggestion: '交互输入场景需要覆盖或明确缺失 stale、focus/window、InputChannel、iq/oq/wq 和 FINISHED ACK 证据边界'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: click_response_detail
        - tool: invoke_skill
          skill_id: input_events_in_range
---

#### interaction Core Strategy

**Route card**: 点击 / 触摸 / 输入延迟 / 响应延迟 / 点击慢 / 响应慢 / 点击卡顿 / click / tap / touch

**Capabilities**: required=[input_latency, frame_rendering], optional=[cpu_scheduling, binder_ipc, surfaceflinger]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- input_latency_stage_breakdown: 交互输入场景必须拆分 dispatch、handling、ACK，并说明 total_latency_dur 是否只覆盖 dispatch-to-ACK (requires one of: invoke_skill(click_response_analysis), invoke_skill(input_events_in_range))
- focus_stale_channel_boundary: 交互输入场景需要覆盖或明确缺失 stale、focus/window、InputChannel、iq/oq/wq 和 FINISHED ACK 证据边界 (requires one of: invoke_skill(click_response_detail), invoke_skill(input_events_in_range))

**Phase reminders**
- input_ack_queue_boundary: 先区分 completed android.input 事件的 dispatch/handling/ACK 总耗时与未完成 FINISHED 的队列背压。wq 增长只能说明目标连接尚未 ACK；必须结合 App 主线程、InputDispatcher、dumpsys/logcat 或窗口证据，不能直接命名 Binder、App 代码或 InputDispatcher 根因。 工具: click_response_analysis, click_response_detail, input_events_in_range
- focus_window_stale_boundary: stale drop、no-focused-window、InputChannel 创建/断连和 target-window 选择是不同对象。trace 只含 completed input events 时要写成证据缺口；需要 WindowManager/InputDispatcher logcat、dumpsys input 或窗口拓扑证据才能定因。 工具: input_events_in_range
- display_present_boundary: total_latency_dur 是 dispatch-to-ACK，不是 input-to-present。只有 end_to_end_latency_dur、frame_id/FrameTimeline、RenderThread/SF present 证据可用时，才能写上屏或可见反馈延迟；否则只报告 dispatch/ACK 或首帧候选。 工具: click_response_analysis, input_to_frame_latency, scroll_response_latency

**Final report contract summary**
- 输入阶段拆分
- ACK/焦点/窗口边界
- 置信度与缺失证据


**Detail ref**
- `interaction:full`: 点击/触摸响应分析（用户提到 点击、触摸、tap、click、input latency） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="interaction full strategy detail" keywords="interaction,点击,触摸,输入延迟,响应延迟,点击慢,响应慢,点击卡顿,click,tap,touch,input latency,response time,点击/触摸响应分析（用户提到 点击、触摸、tap、click、input latency）,detail,full" default="true" -->
#### 点击/触摸响应分析（用户提到 点击、触摸、tap、click、input latency）

**Phase 1 — 概览 + 慢事件列表（1 次调用）：**
```
invoke_skill("click_response_analysis", { enable_per_event_detail: false })
```
- 如果知道包名，传入 `package` 参数以精确过滤
- 如果知道时间范围，传入 `start_ts` / `end_ts`
- 返回结果包含以下 artifact：
  - `latency_overview`：延迟概览（总事件数、平均延迟、P50/P90/P99）
  - `slow_events`：慢输入事件列表（event_ts, event_end_ts, total_ms, dispatch_ms, handling_ms, event_type, event_action, process_name）
  - `latency_by_type`：按事件类型分组的延迟统计
  - `input_thread_state`：输入处理期间的主线程状态分布
  - `input_binder`：输入处理期间的 Binder 调用
  - `latency_distribution`：延迟分布直方图
- **获取慢事件详细数据**：
  `fetch_artifact(artifactId, detail="rows", offset=0, limit=20)` 获取 `slow_events` 的完整列表
- **如果没有慢事件**（slow_events 为空或总平均延迟 < 100ms）：只能说明已完成 ACK 的 `android.input` 事件响应良好。若用户问的是 `wq`、stale、focus/window、InputChannel 或 no-focused-window，必须继续说明这些未完成/窗口类证据不在 completed-event 结果内，不能直接停止。

**Phase 2 — 逐事件深钻（最多 5 个慢事件）：**

从 `slow_events` 中选取延迟最大的 5 个事件，对每个事件调用：
```
invoke_skill("click_response_detail", {
  event_ts: "<事件的 event_ts>",
  event_end_ts: "<事件的 event_end_ts>",
  total_ms: <总延迟ms>,
  dispatch_ms: <分发延迟ms>,
  handling_ms: <处理延迟ms>,
  event_type: "<事件类型>",
  event_action: "<事件动作>",
  process_name: "<进程名>"
})
```
返回每个事件的：
- `quadrant`：四象限分析（Q1 大核运行 / Q2 小核运行 / Q3 Runnable / Q4 Sleeping）
- `cpu_core`：CPU 大小核占比
- `blocking`：主线程阻塞原因分析（thread_states + blocked_functions）
- `binder_calls`：Binder 调用详情
- `main_sync_binder`：主线程同步 Binder 阻塞
- `sched_delay`：调度延迟
- `main_file_io`：主线程文件 IO

对大型 artifact 使用 `fetch_artifact` 获取完整行数据。

**Phase 3 — 综合结论（基于根因决策树）：**

### 第一步：瓶颈定位 — dispatch vs handling vs ACK / display

| 延迟阶段 | 含义 | 高占比（>50% 总延迟）时的根因方向 |
|---------|------|-------------------------------|
| dispatch_ms | 系统分发延迟（InputDispatcher 到目标 App receive 之前） | 系统侧或目标唤醒问题：system_server/InputDispatcher 调度、InputChannel/socket、目标窗口选择或进程唤醒；需要 system_server/窗口/logcat/dumpsys 交叉验证 |
| handling_ms | 应用处理延迟（应用收到事件到处理完成） | 应用侧问题：主线程阻塞、计算量大 → 用四象限分析定位 |
| ack_ms | FINISHED/ACK 延迟（处理回调完成到 finish/ack 写回及调度） | 可能是回调尾部、调度或 writeback 延迟；不是帧上屏证据 |
| display/present | 输入到可见反馈（需要 `end_to_end_latency_dur`、非推测的 `frame_id`/FrameTimeline、RenderThread/SF present） | 只有帧/上屏链路可用时才归因渲染或 SurfaceFlinger；缺失时写成数据缺口 |

**帧关联与缺失值的读法：**
- `is_speculative_frame=1` 的 `frame_id` 是同一 UI 线程上事件之后的下一个 `Choreographer#doFrame`，未经证实消费了该事件：该线程就是出图线程且间隔很短时可作候选帧，但不能单独证明帧链接、同帧堆积或上屏；由它推出的 `end_to_end_latency_dur` 只是候选值。DOWN/UP 常见推测关联，这不影响同一事件 dispatch/handling/ACK 的精确性。
- `end_to_end_latency_dur` 为 NULL 表示未测量，不是 0ms 或“响应良好”；目标进程没有 app 层 FrameTimeline（Flutter SurfaceView、GL/游戏等）时，输入到上屏延迟在本 trace 中不可测量。
- `event_action` 为 NULL 的行常是同一批物理触摸投递给 system_server/systemui 监听通道的副本，不是额外手势（可按共享的 `input_event_id` 核对），不计入目标应用的手势数或慢事件。未传 `package` 时，按事件数自动选出的目标进程可能是 systemui；先确认 `target_process` 是用户关心的应用。

### 输入队列、焦点和窗口边界（只在有证据时定因）

- `iq` / `oq:{window}` / `wq:{window}` 分别代表 inbound、outbound 和 wait queue。`wq` 持续增长只说明该连接还没有收到 `FINISHED`，不能单独证明 Binder、App 业务代码或 InputDispatcher 是根因。
- stale event 是保护性丢弃旧事件，不是 App 已消费，也不等同 Input ANR。必须结合 stale/drop 日志、队列状态和前序窗口/线程时间线。
- Touch 目标来自 touched-window hit testing，Key 目标来自 focused-window resolution。WindowInfosListener / WMS 窗口拓扑证据影响 target/focus 判断，但不说明 App handling 耗时。
- InputChannel 创建失败、fd/内存耗尽或 dead channel 是窗口/通道生命周期问题，可能表现为窗口添加失败、缺焦点或 no-focused-window ANR；不要把它写成普通慢事件处理。
- 短 `deliverInputEvent` 只说明 App-side receive/process slice 短，不能排除事件在主线程 MessageQueue 中等待或更早的 dispatcher/channel/focus 延迟。

### 第二步：当 handling 是瓶颈时 — 用四象限分析定位

| 四象限 | 占比 | 含义 | 下一步 |
|--------|------|------|--------|
| Q1 大核运行 高 | >50% | CPU-bound，处理逻辑重 | 分析主线程热点 slice，检查是否有不必要的同步计算 |
| Q2 小核运行 高 | >15% | 被调度到性能不足的小核 | 检查进程优先级、EAS/uclamp 配置 |
| Q3 Runnable 高 | >5% | CPU 资源争抢 | 看调度延迟、后台负载 |
| Q4 Sleeping 高 | >25% | 主线程被阻塞 | **必须看 blocked_functions** → 第三步 |

### 第三步：当 Q4 占比高时 — 用线程状态 + blocked_functions 定位

| 线程状态 | blocked_functions 特征 | 根因类型 |
|---------|----------------------|---------|
| S (Sleeping) | `futex_wait_queue` / `futex_wait` | 锁等待（synchronized/ReentrantLock） |
| S (Sleeping) | `binder_wait_for_work` / `binder_ioctl` | 同步 Binder 阻塞 |
| S (Sleeping) | `SyS_nanosleep` / `hrtimer_nanosleep` | 主动 sleep() 调用 |
| D (Uninterruptible sleep) + `io_wait=1` | `io_schedule` / `blkdev_issue_flush` | IO wait 直接证据 |
| D (Uninterruptible sleep) | `SyS_fsync` / `do_fsync` | fsync 候选（SQLite/SharedPreferences 需 slice 补证） |
| D (Uninterruptible sleep) | `filemap_read` / `filemap_fault` / `do_page_fault` | 页缓存/页缺失候选 |

遇到 D-state、`io_wait` 或 blocked_function 时调用 `lookup_knowledge("thread-state-blocked-reason")`，说明 blocked_function 是 kernel wchan 单帧而不是完整调用栈。

### 第四步：多手势类型识别（次要 — 仅在用户明确提及时分析）

以下手势类型属于进阶分析，仅在用户明确提到"长按"、"双击"等手势关键词时才进行分析：

| 手势类型 | 识别方式 | 分析要点 |
|---------|---------|---------|
| **长按 (Long Press)** | ACTION_DOWN 到 ACTION_UP 之间持续时间 > 500ms，且无 MOVE 事件（或 MOVE < 3 次） | 长按响应由 ViewConfiguration.getLongPressTimeout() 控制（默认 500ms）。如果用户反馈长按响应慢，检查：① 主线程在 DOWN 后 500ms 内是否有阻塞导致 Looper 延迟处理 LongPress Runnable；② onLongClick 回调本身的执行耗时 |
| **双击 (Double Tap)** | 两次 ACTION_DOWN 之间间隔 < 300ms（ViewConfiguration.getDoubleTapTimeout()） | 双击检测由 GestureDetector 处理。如果用户反馈双击不灵敏，检查：① 两次 tap 间隔是否接近 300ms 阈值；② 首次 tap 的 ACTION_UP 处理是否过慢导致第二次 DOWN 被错过 |

手写 SQL 直接读 `android_input_events` 时，`event_action` 可能带 `ACTION_` 前缀（新版 trace processor 输出 `ACTION_MOVE`，旧版输出 `MOVE`）。Skill 已统一为不带前缀的大写动作；raw SQL 先用 `CASE WHEN event_action GLOB 'ACTION_*' THEN SUBSTR(event_action, 8) ELSE event_action END` 归一化，再与 `DOWN`/`MOVE`/`UP` 比较。

**长按事件检测 SQL（仅在用户提及时使用）：**
```
execute_sql("WITH input AS (SELECT read_time AS ts, CASE WHEN event_action GLOB 'ACTION_*' THEN SUBSTR(event_action, 8) ELSE event_action END AS event_action FROM android_input_events WHERE event_type='MOTION'), motion AS (SELECT ts, event_action, SUM(CASE WHEN event_action='DOWN' THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS gid FROM input), gestures AS (SELECT gid, MIN(ts) AS down_ts, MAX(CASE WHEN event_action='UP' THEN ts END) AS up_ts, COUNT(CASE WHEN event_action='MOVE' THEN 1 END) AS move_cnt FROM motion WHERE gid>0 GROUP BY gid) SELECT printf('%d', down_ts) AS ts, ROUND((up_ts - down_ts)/1e6, 1) AS hold_ms FROM gestures WHERE up_ts IS NOT NULL AND (up_ts - down_ts) > 500000000 AND move_cnt <= 2 ORDER BY down_ts LIMIT 20")
```

**双击事件检测 SQL（仅在用户提及时使用）：**
```
execute_sql("WITH downs AS (SELECT read_time AS ts, LAG(read_time) OVER (ORDER BY read_time) AS prev_ts FROM android_input_events WHERE event_type='MOTION' AND event_action IN ('DOWN', 'ACTION_DOWN')) SELECT printf('%d', ts) AS ts, ROUND((ts - prev_ts)/1e6, 1) AS gap_ms FROM downs WHERE prev_ts IS NOT NULL AND (ts - prev_ts) < 300000000 ORDER BY ts LIMIT 20")
```

### 输出结构必须遵循：

1. **概览**：总事件数、慢事件数、平均/P90/P99 延迟、总体评级
   - 如果无慢事件：报告"已完成 ACK 的输入事件响应良好"并说明它不覆盖未完成 ACK、stale drop、focus/window 或 InputChannel 证据

2. **瓶颈分布**：
   - dispatch-heavy 事件 N 个（系统侧）
   - handling-heavy 事件 N 个（应用侧）
   - ack-heavy 事件 N 个（FINISHED/ACK 回写或调度）
   - input-to-present / FrameTimeline 是否可用；不可用或只有推测帧关联时不要写上屏延迟

3. **逐事件根因**（每个慢事件）：
   ```
   ### 事件 #N: [event_type] [event_action] — 总延迟 XXms
   - 瓶颈阶段：handling (XXms, YY%)
   - 四象限：Q1=XX% Q2=XX% Q3=XX% Q4=XX%
   - 根因：[具体根因 + blocked_functions 证据]
   - 建议：[可操作的优化建议]
   ```

4. **优化建议**：按影响面排序，区分系统侧 vs 应用侧建议

5. **证据边界**：列出 `android.input` completed-event、InputDispatcher/dumpsys/logcat、WindowManager/focus、FrameTimeline/present 哪些可用，哪些缺失；对 `wq`、stale、focus/window、InputChannel 只在证据闭环时定因。
<!-- /strategy-detail -->

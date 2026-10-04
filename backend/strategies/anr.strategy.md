<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: anr
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: anr_critical_path
      domain: critical_path
      description: "Check recorded ANR type, target UPID and timeout window when available. If no ANR is recorded but the user asks about unresponsiveness, discover long main-thread waits with anr_main_thread_blocking without process_name/anr_ts, then correlate candidate UPID and exact wait window with target input dispatch and FINISHED acknowledgements; absence of an ANR anchor must not stop this investigation. Identify blocked task, main-thread work and relevant owner/peer tasks rather than equating the longest wait with the full timeout."
    - id: anr_dependencies
      domain: dependency_chain
      description: "Trace Binder transactions, lock ownership, IO and wakeup dependencies where available; distinguish observed waiting from an established blocking chain and from ANR trigger attribution."
classification_description: "Application unresponsiveness, ANR triggers, deadlocks and timeout-related blocking."
priority: 1
effort: medium
required_capabilities:
  - anr
  - cpu_scheduling
optional_capabilities:
  - binder_ipc
  - lock_contention
  - gc_memory
keywords:
  - anr
  - 无响应
  - 应用无响应
  - 主线程无响应
  - deadlock
  - not responding
  - 死锁
  - watchdog
  - broadcast timeout
  - input dispatching
  - 冻屏
  - freeze
  - 卡死

final_report_contract:
  required_sections:
    - id: anr_diagnostic_api_boundary
      label: ANR 诊断 API/外部聚合边界
      description: '当用户主动提到 ApplicationExitInfo、ProfilingTrigger、Play/Android Vitals 或客户端 watchdog 时，区分系统确认 ANR、客户端预警、Profiling artifact、Play 聚合和当前 trace 根因证据。'
      condition:
        kind: semantic
        description: '当问题要求解释、比较或使用系统 ANR 诊断记录、剖析产物、外部聚合指标或客户端 watchdog 告警时适用。'
      pattern_groups:
        - ['ANR 诊断 API/外部聚合边界', 'ANR diagnostic API', 'system-confirmed', 'client watchdog', 'Play Vitals', 'ProfilingTrigger', 'ApplicationExitInfo']
        - ['diagnostic_api', 'profiling_artifact', 'external_aggregate', 'ApplicationExitInfo', 'getAnrInfo', 'REASON_ANR', 'ProfilingManager', 'ProfilingTrigger', 'TRIGGER_TYPE_ANR', 'Play Vitals', 'Android Vitals', 'watchdog']
        - ['API\s*3[067]', 'Android\s*1[167]', 'version', '版本', 'reason', 'trigger type', 'timeout', 'ANR window', 'event window', 'timestamp', 'artifact']
        - ['current trace', 'Perfetto', 'direct_blocker', 'logcat', 'Binder', 'lock', 'align', '对齐', 'missing', '缺失', 'confidence', '不能', '不可', 'not replace']

---

#### anr Core Strategy

**Route card**: anr / 无响应 / 应用无响应 / 主线程无响应 / deadlock / not responding / 死锁 / watchdog / broadcast timeout / input dispatching

**Capabilities**: required=[anr, cpu_scheduling], optional=[binder_ipc, lock_contention, gc_memory]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- anr_root_cause: ANR 场景建议包含 ANR 原因定位阶段 (anr_analysis) (required: invoke_skill(anr_analysis))

**Phase reminders**
- freeze_verdict: 有 ANR 窗口时先读 freeze_verdict：system freeze → 系统原因排查；app_specific → App 根因决策树；undetermined（system_server 主线程不可评估且无停滞证据）或 verdict 不可得时继续 App 决策树与无锚点主线程调查，保留系统健康证据缺口，既不排除也不断言系统冻结。 工具: anr_analysis
- anr_diagnostic_api_boundary: ApplicationExitInfo、ProfilingTrigger 产物、Play/Android Vitals、客户端 watchdog 都只能补充 ANR 证据。必须说明 API/Android 版本、reason/trigger type、record/artifact 时间、事件窗口对齐；根因仍需 Perfetto ANR window、direct_blocker、logcat、Binder/lock/IO/GC/scheduler 证据闭环。 工具: anr_analysis, lookup_knowledge

**无 ANR 锚点仍须调查无响应**
- 用户询问主线程无响应而未记录 ANR 时，调用 `anr_main_thread_blocking`，省略 `process_name` / `anr_ts`，读取 `wakeup_chain` 的应用主线程最长 S/D 等待候选（默认 ≥3s，每进程分别保留最长已结束/未结束等待，支持 `top_n` / `offset` 分页）。无结果只代表该阈值/UID 覆盖内未命中，不能证明没有无响应。
- 用输入目标/前台活动核对候选 UPID，再以观测到的 `process_name` 和窗口调用该 Skill。同名多实例或重启时改用带明确 UPID/UTID 等值条件的 SQL 核查，不能依赖旧详情中的首个同名进程。按原始 ns 对齐目标 channel 的 DOWN/UP、receive 与 FINISHED，窗口应覆盖等待结束后的响应；只描述实际重叠，不把派发自动等同超时。
- 保留“未记录系统 ANR 声明”。长 S 可能正常 Looper 空闲；及时 FINISHED 是反证。没有 blocked_function/锁/Binder/输入处理证据时，报告等待及原因未知，不断言冻结、静默 kill 或 ANR。

**Final report contract summary**
- ANR 诊断 API/外部聚合边界


**Detail ref**
- `anr:full`: ANR 分析（用户提到 ANR、无响应、not responding、死锁、冻屏） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="anr full strategy detail" keywords="anr,anr,无响应,应用无响应,主线程无响应,deadlock,not responding,死锁,watchdog,broadcast timeout,input dispatching,冻屏,freeze,ANR 分析（用户提到 ANR、无响应、not responding、死锁、冻屏）,detail,full" default="true" -->
#### ANR 分析（用户提到 ANR、无响应、not responding、死锁、冻屏）

**⚠️ 核心原则：**
1. **有 ANR 窗口时先判系统还是应用**：读取 `system_freeze_check` step 保存的 `freeze_check.freeze_verdict`。没有 ANR 窗口则走 Core 的无锚点长等待发现与输入时间线调查，不以缺少 freeze_verdict 为停止条件。
2. **分清四层语义**：`trigger_type` 是触发机制，`direct_blocker` 是 ANR 窗口内的直接阻塞形态，`root_cause_pattern_hints` 只是候选提示，最终根因必须由多源证据闭环
3. **按 ANR 类型差异化分析**：INPUT_DISPATCHING / NO_FOCUS / BROADCAST / SERVICE / JOB / WATCHDOG / CONTENT_PROVIDER 的分析路径不同
4. **四象限 + blocked_functions 交叉定位根因**：与启动分析相同的诊断方法论
5. **量化证据链**：每个根因判断必须有窗口裁剪后的时长、线程状态占比、Binder 对端、锁 owner 或系统上下文等具体证据

### ANR 类型与超时阈值

| ANR 类型 | 超时阈值 | 触发条件 |
|----------|---------|---------|
| INPUT_DISPATCHING_TIMEOUT | 5s | 输入事件分发无响应 |
| INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW | 5s | 没有可接收输入的焦点窗口 |
| BROADCAST_OF_INTENT | 10s (前台) / 60s (后台) | BroadcastReceiver.onReceive() 超时 |
| START_FOREGROUND_SERVICE | Perfetto 默认 30s | 前台服务启动链路未及时完成 |
| EXECUTING_SERVICE | Perfetto 默认 20s（OEM/前后台策略可能不同） | Service.onCreate()/onStartCommand() 超时 |
| FOREGROUND_SERVICE_TIMEOUT / FOREGROUND_SHORT_SERVICE_TIMEOUT | Perfetto 默认 30s / 180s | 前台服务生命周期超时 |
| CONTENT_PROVIDER_NOT_RESPONDING | 可能无 Perfetto 默认值 | ContentProvider 发布或访问链路超时 |
| JOB_SERVICE_START / JOB_SERVICE_STOP / JOB_SERVICE_BIND | 8s 级别 | JobService 回调或绑定链路超时 |
| SYSTEM_SERVER_WATCHDOG_TIMEOUT | 系统 Watchdog | system_server Handler/锁/Binder 线程卡死 |
| GPU_HANG | 可能无 Perfetto 默认值 | GPU/fence/buffer 链路无响应 |
| APP_TRIGGERED | 可能无 Perfetto 默认值 | App 主动触发或厂商扩展 ANR |
| UNKNOWN_ANR_TYPE | 兜底 | 类型未知，先保留 baseline evidence |

#### 证据边界和裁剪规则

- `anr_dur_ms` 是 Perfetto 从 timer event 或 subject 抽取的实际 ANR duration，优先级高于 AOSP/Pixels 默认值。分析窗口必须使用 `timeout_ms = COALESCE(NULLIF(anr_dur_ms, 0), default_anr_dur_ms, heuristic_fallback)`。
- `heuristic_fallback` 只是低置信度 lookback，不是 Perfetto default。`CONTENT_PROVIDER_NOT_RESPONDING`、`GPU_HANG`、`APP_TRIGGERED`、`UNKNOWN_ANR_TYPE` 在 Perfetto 默认表中没有固定 timeout，使用 heuristic 时必须明确标为证据缺口/低置信度。
- 多个 ANR 必须按 `error_id` / `upid` / 单个 ANR 窗口隔离证据。`upid` 是 Perfetto 进程唯一身份，逐事件线程证据优先用 `upid` 定位，`pid`/进程名只能作为降级匹配。不要把第一条 ANR 附近的 CPU、logcat、Binder 或锁竞争套到后续事件上；overview 中首个 ANR 窗口系统健康只可作为 baseline context。
- 所有 duration 证据必须裁剪到 `[anr_ts - timeout_ns, anr_ts]`；跨窗口 slice 只能计入重叠部分。
- `nativePollOnce`、`epoll_wait`、Looper 空闲只说明主线程等待事件或缺少更细证据。它可以作为排除性证据，不能单独作为最终根因。
- `blocking`、`binder_calls`、`main_sync_binder`、`sched_delay` 这类包名级 artifact 只能作辅助上下文；逐 ANR 定因必须优先使用 `direct_blocker_candidates`、同窗口线程/slice 证据和事件级锚点。
- Binder wait 需要对端/服务端证据；锁等待需要 owner/monitor chain；CPU/IO/内存压力需要与同一窗口的主线程、系统负载或日志闭环。
- AnrManager/ActivityManager 的 “ANR in ...” 往往是 dump 或报告时刻，不必然等于真实触发起点；用它校验上下文，不替代 Perfetto ANR 时间窗。
- 输入类 ANR 必须区分 `wq`/FINISHED timeout、stale drop、InputChannel 创建/断连、target/focused window 缺失和 App main-thread blocking。`wq`/queue age 是未 ACK 症状和计时基础，不是 Binder、App 业务代码或 InputDispatcher 根因本身；stale drop 也不是系统确认 ANR。
- ApplicationExitInfo、ProfilingManager/ProfilingTrigger 产物、Play/Android Vitals 和客户端 watchdog 是不同证据层。它们可以帮助确认历史退出、预警、采样窗口或线上影响面，但不能替代当前 Perfetto ANR window、direct blocker、事件级 logcat、Binder/lock/IO/GC/scheduler 证据链。需要机制背景时调用 `lookup_knowledge("observability-diagnostics")`。

#### ANR 场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_oom_adj_intervals`、`android_monitor_contention_chain`、`android_screen_state`、`sched_latency_for_running_interval`、`cpu_utilization_in_interval(ts, dur)`、`android_garbage_collection_events`

**Phase 1 — ANR 检测 + 系统健康评估（1 次调用）：**
```
invoke_skill("anr_analysis")
```
- 如果知道包名，传入 `process_name` 或 `package` 参数
- 返回结果包含以下关键 artifact：
  - `detection`：ANR 检测（总数、受影响进程数、时间跨度）
  - `trigger_classification`：Perfetto ANR 类型到 SmartPerfetto `trigger_type` 的规范化映射，并输出候选根因提示（非最终结论）
  - `cpu_health`：系统 CPU 负载（大核/小核利用率、是否过载）
  - `memory_pressure`：ANR 窗口内的 LMK 事件
  - `io_load`：各进程的 D-state 不可中断等待基线，只是系统背景；不能单独作为 IO 根因
  - `anr_io_wait`：ANR 进程自己的 D/DK 等待（主线程、进程合计、最长线程、IO 等待点、冻结等待、blocked_function 覆盖率）；缺少 ANR 进程 upid 时不运行，不能读成「没有 D 态」
  - `lock_waits`：futex/mutex 锁等待分布（P95/max）
  - **`freeze_check`**（from `system_freeze_check`）：**系统冻结判定（最关键）**
  - `overview` / `anr_events`：ANR 分类统计、逐事件窗口、`timeout_source` 与跳转范围
  - 逐 ANR 的 `anr_detail` 迭代结果（四象限、`direct_blocker_classification` 保存为 `direct_blocker_candidates`、`direct_blocker_slice_classification` 保存为 `direct_blocker_slice_candidates`、`anr_logcat_context` 保存为 `logcat_event_context`、Binder、锁竞争、唤醒链等）

**必须获取关键 artifact 的完整数据**：
```
fetch_artifact(artifactId, detail="rows", offset=0, limit=50)
```
优先获取：`freeze_check`、`trigger_classification`、`anr_events`、逐 ANR 的 `quadrant`（四象限）、`direct_blocker_candidates`（from `direct_blocker_classification`）、`direct_blocker_slice_candidates`（from `direct_blocker_slice_classification`，若 slice 可用）和 `logcat_event_context`（from `anr_logcat_context`）；若缺 `android_logs`，读取 `logcat_context_gap`（from `anr_logcat_evidence_gap`）。`blocking`/Binder/sched artifact 只作为包名级辅助上下文

**Phase 2 — 冻结判定分流（基于 freeze_verdict，第一优先级）：**

### ⚠️ 必须首先检查 `freeze_check.freeze_verdict` 字段：

| freeze_verdict | 含义 | 后续分析方向 |
|---------------|------|-------------|
| `system_server_freeze` | system_server 主线程过半存活时间处于可运行等待或不可中断等待（R/R+/D/DK） | **系统级问题**：system_server watchdog、kernel panic、硬件故障。报告为系统问题，不是 App Bug |
| `system_freeze` | ≥3 个有运行需求的应用主线程（不含 ANR 进程）中过半停滞（stalled_pct > 50%） | **系统级问题**：可能是 CPU 饥饿（后台负载；频率上限只是候选，是否限频以 `cpu_throttling_in_range` 的限频证据为准）、内存压力（大量 LMK）、IO 风暴。交叉检查 `cpu_health` 和 `memory_pressure` |
| `app_specific` | system_server 可评估且未停滞，未见系统级停滞证据（主线程处于 S 睡眠不算停滞证据；`demanding_apps` < 3 时应用侧系统停滞未评估） | **应用级排查**：进入 Phase 3 详细分析主线程阻塞原因；它不证明系统无问题，S 态死锁要靠逐 ANR 阻塞证据 |
| `undetermined` | system_server 主线程在 ANR 窗口内不可评估（缺失或存活不足 90% 窗口），且没有停滞证据 | **系统/应用未判定**：不能仅凭 freeze_check 判定为 App 问题或系统冻结；进入 Phase 3，由逐 ANR 证据闭环定因，结论中保留系统健康证据缺口 |

**当 `freeze_verdict = system_server_freeze` 或 `system_freeze` 时：**
- 如果 `detection.total_anr_count === 1`：可报告为系统级问题，不要深入推测 App 代码；交叉检查 `cpu_health`、`memory_pressure`、`io_load` 和系统侧日志后到 Phase 4 输出
- 如果 `detection.total_anr_count > 1`：`freeze_check` 只代表首个 ANR 窗口 baseline context，不能直接推广到全部 ANR。必须继续读取逐 ANR `direct_blocker_candidates`、`direct_blocker_slice_candidates`、`logcat_event_context` 和 `app_freeze_check`，逐事件确认是否同属系统冻结链路
- 多 ANR 只有在每个关键事件窗口都有系统侧线程/日志/资源压力证据闭环时，才能升级为整体系统根因；否则按事件分别输出系统背景 + App/对端候选

**Phase 3 — App 级根因诊断决策树（当 freeze_verdict = app_specific；为 undetermined 或缺少 freeze_check 时也进入，但不排除系统冻结）：**

### 第一步：看四象限分布（来自 anr_detail 的 `quadrant`）

| 四象限 | 占比 | 含义 | 下一步 |
|--------|------|------|--------|
| Q4 Sleeping 极高 | >80% | 等待占比高，可能正常空闲；单独不能证明阻塞或无响应 | → 第二步：结合 blocked_functions、输入处理/ACK 与调用链判断 |
| Q3 Runnable 高 | >30% | CPU 饥饿——可运行但得不到 CPU | → 检查 `sched_latency`、`cpu_health`、后台进程抢占 |
| Q1+Q2 Running 高 | >70% | CPU-bound——主线程在执行重计算 | → 检查 `main_slices`（from `main_thread_slices`），并调用 `invoke_skill("process_slice_cpu_hotspots", { process_name, start_ts, end_ts, thread_scope: "main" })` 定位主线程热点函数/slice 的 Running CPU time |
| 混合 | 无明显主导 | 多因素共同导致 | → 依次排查 Q4→Q3→Q1 |

### 第二步：当 Q4 占比高时 — 以 direct_blocker + 线程状态定位

先读取逐事件 `direct_blocker_candidates`（from `direct_blocker_classification`）。`blocking`（主线程状态分布）里的 `blocked_function` 可帮助理解状态，但它是包名级上下文，不能单独作为最终根因：

| 线程状态 | blocked_functions 特征 | 根因类型 | 典型场景 |
|---------|----------------------|---------|---------|
| S (Sleeping) | `futex_wait_queue` / `futex_wait` | **锁等待** | art_lock_contention、monitor 竞争、synchronized 块 |
| S (Sleeping) | `binder_wait_for_work` / `binder_ioctl` | **同步 Binder 阻塞** | 跨进程 IPC 等待 system_server/对端进程响应 |
| S (Sleeping) | `do_epoll_wait` / `ep_poll` | **Looper 空闲/等待事件** | 正常空闲等待（非阻塞，排除性证据） |
| S (Sleeping) | `pipe_wait` / `pipe_read` | **管道等待** | 等待子线程/进程通信 |
| S (Sleeping) | `SyS_nanosleep` / `hrtimer_nanosleep` | **主动 sleep** | Thread.sleep() 在主线程 |
| D (Uninterruptible sleep) + `io_wait=1` | `io_schedule` / `blkdev_issue_flush` | **IO wait 直接证据** | 大文件读写、SQLite 操作、存储队列等待 |
| D (Uninterruptible sleep) | `SyS_fsync` / `do_fsync` | **fsync 候选** | SQLite WAL checkpoint、SharedPreferences commit；需结合 DB/SP/file slice |
| D (Uninterruptible sleep) | `filemap_read` / `filemap_fault` / `do_page_fault` | **页缓存/页缺失候选** | 内存映射文件首次访问；需结合 page fault、block I/O 或内存压力 |
| D (Uninterruptible sleep) | 无明确 IO/page-fault blocked_function | **不可中断等待候选** | 低置信系统/内核等待信号，必须继续找 slice、blocked_function 或 block IO 证据 |

同时读取 `direct_blocker_candidates`（from `direct_blocker_classification`）：

| direct_blocker_type | 可直接说明什么 | 还缺什么才能定最终根因 |
|---------------------|---------------|------------------------|
| `binder_wait` | 主线程同步 Binder 等待 | 对端进程/服务端线程是否忙、死锁或系统卡顿 |
| `lock_or_futex_wait` | 主线程锁/monitor/futex 等待 | 锁 owner、monitor contention chain、持锁代码路径 |
| `disk_or_page_fault_io` / `db_or_file_io_slice` | 主线程或关键线程处于 IO/DB 路径 | IO 系统上下文、文件/SQLite 调用栈或 slice 名称 |
| `render_or_fence_wait` | RenderThread/SF/fence 候选 | SurfaceFlinger、buffer/fence 和 draw/focus 链证据 |
| `gc_or_stw_wait` | GC/STW 候选 | GC pause、内存压力、LMK 或 heap 变化 |
| `scheduler_pressure` | runnable 但调度不足 | sched_latency、CPU topology、后台进程抢占 |
| `native_poll_idle_or_ambiguous` | Looper/epoll 等待 | 只能说明空闲或证据不足，不能单独定因 |

### 第三步：按 ANR 类型差异化分析

当 blocked_functions 不足以确定根因时，结合 ANR 类型缩小范围：

| ANR 类型 | 重点检查 | 关键 artifact |
|----------|---------|-------------|
| INPUT_DISPATCHING_TIMEOUT | 主线程在做什么？是否有长 Binder 调用或锁等待阻塞了 input 处理 | `direct_blocker_candidates`、`lock_contention`、事件级 Logcat/InputDispatcher |
| INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW | Activity/window 焦点链：resume 是否返回、relayout/draw 是否完成、WindowManager 是否给焦点；与 stale drop、InputChannel 失败和普通 `wq` FINISHED timeout 分开 | `trigger_classification`、`logcat_event_context`、`render_thread`、WindowManager/InputDispatcher 日志、dumpsys input/window |
| BROADCAST_OF_INTENT | `onReceive()` 内是否有网络/IO/数据库操作在主线程执行 | `direct_blocker_candidates`、`main_slices`（查找 onReceive 相关 slice）、事件级 ActivityManager/Broadcast 日志 |
| START_FOREGROUND_SERVICE / EXECUTING_SERVICE / FOREGROUND_SERVICE_TIMEOUT | Service 生命周期、前台服务启动和冷启动链路 | `direct_blocker_candidates`、`main_slices`、Service/ActivityManager 日志 |
| JOB_SERVICE_START / STOP / BIND | JobService 回调或绑定链路，不要简化成普通 Service | `direct_blocker_candidates`、`logcat_event_context`、事件级 JobScheduler 日志 |
| CONTENT_PROVIDER_NOT_RESPONDING | provider publish、query/CRUD 或跨进程 Provider 访问阻塞 | `direct_blocker_candidates`、`main_slices`、`anr_io_wait` |
| SYSTEM_SERVER_WATCHDOG_TIMEOUT | system_server Handler/锁/Binder 线程，默认不是 App Bug | `freeze_check`、system_server 线程状态、monitor contention |
| GPU_HANG | GPU/fence/buffer 或 RenderThread/SF 链路 | `render_thread`、SurfaceFlinger 日志、frame/fence slice |

### 第四步：进阶诊断工具（按需）

| 工具 | 何时使用 | artifact |
|------|---------|---------|
| **唤醒链（wakeup_chain）** | Q4 高但 blocked_function 为空时 — 谁唤醒了主线程？ | `wakeup` |
| **锁竞争（lock_contention）** | blocked_function 含 futex/monitor 时 — 谁持有锁？ | `lock_contention`（from `android_monitor_contention`） |
| **App 冻结检测（app_freeze_check）** | 判断应用是否完全无活动（MainThread+RenderThread+Binder 全部无活动） | 逐 ANR `app_freeze_check` |
| **RenderThread 分析** | INPUT_DISPATCHING_TIMEOUT 中，检查是否 nSyncDraw/dequeueBuffer 阻塞 | `render_thread` |
| **Binder 调用详情** | direct_blocker 为 binder_wait 时补查对端进程是谁；包名级 Binder artifact 只能补证 | `binder_calls`、`main_sync_binder` |
| **调度延迟** | Q3 Runnable 高且 direct_blocker 为 scheduler_pressure 时补查具体延迟分布 | `sched` |

### 第五步：交叉验证系统上下文

- **CPU 负载** (`cpu_health`)：大核 avg_util_pct > 90% → CPU 饥饿参与因素
- **内存压力** (`memory_pressure`)：ANR 窗口内有 LMK → 可能是 GC 压力或进程被回收重启
- **不可中断等待基线** (`io_load`)：多进程 D-state 高只能说明系统/内核等待压力；只有结合 block IO、blocked_function 或文件/SQLite slice 证据，才能升级为系统级 IO 瓶颈
- **ANR 进程不可中断等待** (`anr_io_wait`)：这个 ANR 的 D 态证据只看 ANR 进程本身，主线程优先；`blocked_function_coverage_pct` 为空或低时等待点未记录，不能据此说「不是 IO」；`frozen_ms` 是 cgroup 冻结，不是 IO
- **锁等待** (`lock_waits`)：futex/mutex P95 偏高只作为包名级候选信号；最终定因必须结合逐 ANR `direct_blocker_candidates`、当前进程主线程 `lock_contention` 或锁链证据
- **blocked_function 机制解释**：报告 D-state、`io_wait` 或 kernel blocked_function 时，调用 `lookup_knowledge("thread-state-blocked-reason")`；说明它是 kernel wchan 单帧，不是完整调用栈。

**Phase 4 — 综合输出：**

### 输出结构必须遵循：

1. **ANR 概览**：
   - ANR 事件数、受影响进程数、时间跨度
   - 系统冻结判定结果（`freeze_verdict`）+ system_server 状态
   - 如果是系统级问题，明确标注 **"⚠️ 系统级问题，非应用 Bug"**

2. **系统健康摘要**：
   - CPU 负载状态（正常/繁忙/过载）
   - 内存压力（LMK 事件数）
   - D-state 不可中断等待基线（Top 进程；不能单独写成 IO 根因）

3. **逐 ANR 根因分析**（每个 ANR 事件）：
   ```
   ### ANR #N: [进程名] — [ANR 类型] ([超时阈值])
  - **触发类型**：trigger_type=[input/no_focus/broadcast/service/job/watchdog/...]，timeout_source=[actual_anr_duration/perfetto_default/heuristic_fallback]
   - **四象限**：Q1=XX% Q2=XX% Q3=XX% Q4=XX% → 状态判断: [blocked/cpu_starved/busy_running]
   - **直接阻塞点**：direct_blocker=[binder_wait/lock_or_futex_wait/native_poll_idle_or_ambiguous/...]，证据时长=XXms，root_cause_boundary=[needs_peer_evidence/...]
   - **候选根因提示**：root_cause_pattern_hints=[deadlock/high_load_anr/memory_leak_oom_pressure/none]（明确标注为 not final）
   - **逐事件日志上下文**：logcat_event_context=[AnrManager/InputDispatcher/WindowManager/JobScheduler...]；如果 android_logs 不存在，列出 logcat_context_gap 证据缺口
   - **根因推理链**：
     ① 四象限显示 Q4=NN%（主线程大量时间被阻塞）
     ② 线程状态：S(Sleeping) = XXms，blocked_function = `futex_wait_queue` → 锁等待
     ③ 锁持有者：[线程名] 在执行 [操作]（来自 lock_contention）
     ④ 结论：[具体根因 + 证据]
   - **App 冻结状态**：[正常/部分冻结/完全冻结]
   - **Binder 影响**：[主线程同步 Binder 总时长、关键对端]
   ```

4. **优化建议**：
   - 按影响面排序
   - 区分系统侧 vs 应用侧建议
   - 系统冻屏：建议检查 system_server watchdog、CPU 限频证据、内存压力
   - 应用锁等待：建议减少 synchronized 范围、使用异步 Binder
   - 应用 IO/page-cache 候选：先补齐 io_wait/blocked_function 与文件/数据库/Provider 证据，再建议将同步 IO 移到后台线程
   - CPU 饥饿：建议检查后台进程、调整线程优先级

⚠️ **禁止的做法：**
- 不检查 `freeze_verdict` 就开始分析 App 代码（可能把系统冻屏误判为 App Bug）
- 只说"主线程被阻塞"而不提供 blocked_function 和具体阻塞对象
- 忽略 `wakeup_chain` 数据（这是定位间接依赖链的关键）
- 把所有 ANR 统一用同一个决策路径分析，不区分 ANR 类型
- 忽略逐 ANR `app_freeze_check`（应用完全冻结 vs 部分响应是重要区分）
- 不交叉检查 CPU/内存/IO 系统上下文就下结论
- 把 `root_cause_pattern_hints`、AnrManager 文本或 `nativePollOnce` 当成最终根因
- 把 stale drop、no-focused-window、InputChannel 失败、`wq`/FINISHED timeout 混成同一种 input ANR 根因
- 多 ANR 场景中混用不同 `error_id` 的日志、Binder、锁竞争和调度证据
- 对 Binder/锁/CPU/IO/内存压力只给单点证据，不说明还缺的 peer/owner/system/context 证据
<!-- /strategy-detail -->

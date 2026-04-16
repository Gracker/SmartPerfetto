<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: anr
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

phase_hints:
  - id: freeze_verdict
    keywords: ['verdict', '判定', 'freeze', 'diagnosis', '诊断', '原因', 'anr_analysis', '系统', 'system']
    constraints: 'freeze_verdict 是第一优先级门控。system freeze → 系统原因排查；app_specific → 进入 App 根因决策树（5 步子流程）。禁止在未确认 freeze_verdict 前直接分析 App 代码。'
    critical_tools: ['anr_analysis']
    critical: true
---

#### ANR 分析（用户提到 ANR、无响应、not responding、死锁、冻屏）

**⚠️ 核心原则：**
1. **先判系统还是应用**：`system_freeze_check` 的 `freeze_verdict` 是第一优先级判定。系统冻屏导致的 ANR 不是 App Bug
2. **按 ANR 类型差异化分析**：INPUT_DISPATCHING / BROADCAST / SERVICE / CONTENT_PROVIDER 的分析路径不同
3. **四象限 + blocked_functions 交叉定位根因**：与启动分析相同的诊断方法论
4. **量化证据链**：每个根因判断必须有 blocked_function、线程状态占比、Binder 对端等具体证据

### ANR 类型与超时阈值

| ANR 类型 | 超时阈值 | 触发条件 |
|----------|---------|---------|
| INPUT_DISPATCHING_TIMEOUT | 5s | 输入事件分发无响应 |
| BROADCAST_OF_INTENT | 10s (前台) / 60s (后台) | BroadcastReceiver.onReceive() 超时 |
| EXECUTING_SERVICE | 20s (前台) / 200s (后台) | Service.onCreate()/onStartCommand() 超时 |
| CONTENT_PROVIDER_NOT_RESPONDING | 10s | ContentProvider 发布超时 |
| NO_FOCUSED_WINDOW | 5s | 无焦点窗口（通常是 Activity 启动异常） |

#### ANR 场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_oom_adj_intervals`、`android_monitor_contention_chain`、`android_screen_state`、`sched_latency_for_running_interval`、`cpu_utilization_in_interval(ts, dur)`、`android_garbage_collection_events`

**Phase 1 — ANR 检测 + 系统健康评估（1 次调用）：**
```
invoke_skill("anr_analysis")
```
- 如果知道包名，传入 `process_name` 或 `package` 参数
- 返回结果包含以下关键 artifact：
  - `detection`：ANR 检测（总数、受影响进程数、时间跨度）
  - `cpu_health`：系统 CPU 负载（大核/小核利用率、是否过载）
  - `memory_pressure`：ANR 窗口内的 LMK 事件
  - `io_load`：各进程的 D-state（IO 阻塞）时长
  - `lock_waits`：futex/mutex 锁等待分布（P95/max）
  - **`system_freeze_check`**：**系统冻结判定（最关键）**
  - `anr_overview`：ANR 分类统计
  - 逐 ANR 的 `anr_detail` 迭代结果（四象限、阻塞原因、Binder、锁竞争、唤醒链等）

**必须获取关键 artifact 的完整数据**：
```
fetch_artifact(artifactId, detail="rows", offset=0, limit=50)
```
优先获取：`system_freeze_check`、`anr_overview`、逐 ANR 的 `quadrant`（四象限）和 `blocking`（阻塞原因）

**Phase 2 — 冻结判定分流（基于 freeze_verdict，第一优先级）：**

### ⚠️ 必须首先检查 `system_freeze_check` 的 `freeze_verdict` 字段：

| freeze_verdict | 含义 | 后续分析方向 |
|---------------|------|-------------|
| `system_server_freeze` | system_server 冻结（running_pct < 5%） | **系统级问题**：system_server watchdog、kernel panic、硬件故障。报告为系统问题，不是 App Bug |
| `system_freeze` | 多数应用冻结（frozen_pct > 70%）但 system_server 未冻结 | **系统级问题**：可能是 CPU 饥饿（thermal throttling、后台负载）、内存压力（大量 LMK）、IO 风暴。交叉检查 `cpu_health` 和 `memory_pressure` |
| `app_specific` | 仅目标应用受影响 | **应用级问题**：进入 Phase 3 详细分析主线程阻塞原因 |

**当 `freeze_verdict = system_server_freeze` 或 `system_freeze` 时：**
- 直接报告为系统级问题，不要深入分析 App 代码
- 交叉检查：`cpu_health` 显示 `overloaded` → CPU 饥饿；`memory_pressure` 有大量 LMK → 内存压力；`io_load` 有高 IO wait → IO 风暴
- 建议用户检查系统侧日志（logcat system_server、kernel dmesg）
- **跳过 Phase 3，直接到 Phase 4 输出**

**Phase 3 — App 级根因诊断决策树（当 freeze_verdict = app_specific）：**

### 第一步：看四象限分布（来自 anr_detail 的 `quadrant`）

| 四象限 | 占比 | 含义 | 下一步 |
|--------|------|------|--------|
| Q4 Sleeping 极高 | >80% | **主线程被阻塞**（ANR 最常见原因） | → 第二步：用 blocked_functions 定位 |
| Q3 Runnable 高 | >30% | CPU 饥饿——可运行但得不到 CPU | → 检查 `sched_latency`、`cpu_health`、后台进程抢占 |
| Q1+Q2 Running 高 | >70% | CPU-bound——主线程在执行重计算 | → 检查 `main_thread_slices`、热点函数 |
| 混合 | 无明显主导 | 多因素共同导致 | → 依次排查 Q4→Q3→Q1 |

### 第二步：当 Q4 占比高时 — 用 blocked_functions + 线程状态定位

从 `blocking`（主线程状态分布）artifact 中读取 `blocked_function` 字段：

| 线程状态 | blocked_functions 特征 | 根因类型 | 典型场景 |
|---------|----------------------|---------|---------|
| S (Sleeping) | `futex_wait_queue` / `futex_wait` | **锁等待** | art_lock_contention、monitor 竞争、synchronized 块 |
| S (Sleeping) | `binder_wait_for_work` / `binder_ioctl` | **同步 Binder 阻塞** | 跨进程 IPC 等待 system_server/对端进程响应 |
| S (Sleeping) | `do_epoll_wait` / `ep_poll` | **Looper 空闲/等待事件** | 正常空闲等待（非阻塞，排除性证据） |
| S (Sleeping) | `pipe_wait` / `pipe_read` | **管道等待** | 等待子线程/进程通信 |
| S (Sleeping) | `SyS_nanosleep` / `hrtimer_nanosleep` | **主动 sleep** | Thread.sleep() 在主线程 |
| D (Disk Sleep) | `io_schedule` / `blkdev_issue_flush` | **磁盘 IO** | 大文件读写、SQLite 操作 |
| D (Disk Sleep) | `SyS_fsync` / `do_fsync` | **fsync 刷盘** | SQLite WAL checkpoint、SharedPreferences commit |
| D (Disk Sleep) | `filemap_fault` / `do_page_fault` | **页缺失** | 内存映射文件首次访问 |

### 第三步：按 ANR 类型差异化分析

当 blocked_functions 不足以确定根因时，结合 ANR 类型缩小范围：

| ANR 类型 | 重点检查 | 关键 artifact |
|----------|---------|-------------|
| INPUT_DISPATCHING_TIMEOUT | 主线程在做什么？是否有长 Binder 调用或锁等待阻塞了 input 处理 | `blocking`、`binder_calls`、`main_sync_binder`、`lock_contention` |
| BROADCAST_OF_INTENT | `onReceive()` 内是否有网络/IO/数据库操作在主线程执行 | `blocking`、`main_thread_slices`（查找 onReceive 相关 slice）、`io_load` |
| EXECUTING_SERVICE | `onCreate()`/`onStartCommand()` 是否有耗时初始化 | `main_thread_slices`、`blocking` |
| CONTENT_PROVIDER_NOT_RESPONDING | ContentProvider 发布阻塞 | `blocking`、`binder_calls` |
| NO_FOCUSED_WINDOW | Activity 启动异常，可能是 ANR 前 Activity 未完成创建 | 检查是否有关联的启动事件 |

### 第四步：进阶诊断工具（按需）

| 工具 | 何时使用 | artifact |
|------|---------|---------|
| **唤醒链（wakeup_chain）** | Q4 高但 blocked_function 为空时 — 谁唤醒了主线程？ | `wakeup` |
| **锁竞争（lock_contention）** | blocked_function 含 futex/monitor 时 — 谁持有锁？ | `lock_contention`（from `android_monitor_contention`） |
| **App 冻结检测（app_freeze_check）** | 判断应用是否完全无活动（MainThread+RenderThread+Binder 全部无活动） | `freeze` |
| **RenderThread 分析** | INPUT_DISPATCHING_TIMEOUT 中，检查是否 nSyncDraw/dequeueBuffer 阻塞 | `render_thread` |
| **Binder 调用详情** | blocked_function 含 binder 时 — 对端进程是谁？ | `binder_calls`、`main_sync_binder` |
| **调度延迟** | Q3 Runnable 高时 — 具体延迟分布 | `sched` |

### 第五步：交叉验证系统上下文

- **CPU 负载** (`cpu_health`)：大核 avg_util_pct > 90% → CPU 饥饿参与因素
- **内存压力** (`memory_pressure`)：ANR 窗口内有 LMK → 可能是 GC 压力或进程被回收重启
- **IO 负载** (`io_load`)：多进程 D-state 高 → 系统级 IO 瓶颈
- **锁等待** (`lock_waits`)：futex P95 > 20ms → 严重锁竞争系统级问题

**Phase 4 — 综合输出：**

### 输出结构必须遵循：

1. **ANR 概览**：
   - ANR 事件数、受影响进程数、时间跨度
   - 系统冻结判定结果（`freeze_verdict`）+ system_server 状态
   - 如果是系统级问题，明确标注 **"⚠️ 系统级问题，非应用 Bug"**

2. **系统健康摘要**：
   - CPU 负载状态（正常/繁忙/过载）
   - 内存压力（LMK 事件数）
   - IO 负载（Top 进程 D-state）

3. **逐 ANR 根因分析**（每个 ANR 事件）：
   ```
   ### ANR #N: [进程名] — [ANR 类型] ([超时阈值])
   - **四象限**：Q1=XX% Q2=XX% Q3=XX% Q4=XX% → 状态判断: [blocked/cpu_starved/busy_running]
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
   - 系统冻屏：建议检查 system_server watchdog、thermal、内存压力
   - 应用锁等待：建议减少 synchronized 范围、使用异步 Binder
   - 应用 IO 阻塞：建议将 IO 移到后台线程
   - CPU 饥饿：建议检查后台进程、调整线程优先级

⚠️ **禁止的做法：**
- 不检查 `freeze_verdict` 就开始分析 App 代码（可能把系统冻屏误判为 App Bug）
- 只说"主线程被阻塞"而不提供 blocked_function 和具体阻塞对象
- 忽略 `wakeup_chain` 数据（这是定位间接依赖链的关键）
- 把所有 ANR 统一用同一个决策路径分析，不区分 ANR 类型
- 忽略 `app_freeze_check`（应用完全冻结 vs 部分响应是重要区分）
- 不交叉检查 CPU/内存/IO 系统上下文就下结论
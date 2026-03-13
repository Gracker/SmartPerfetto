---
scene: interaction
priority: 4
effort: medium
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
compound_patterns:
  - "点击.*响应"
  - "响应.*时间"
  - "输入.*慢"
---

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
- **如果没有慢事件**（slow_events 为空或总平均延迟 < 100ms）：报告响应良好并停止，无需深钻

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

### 第一步：瓶颈定位 — dispatch vs handling vs ack

| 延迟阶段 | 含义 | 高占比（>50% 总延迟）时的根因方向 |
|---------|------|-------------------------------|
| dispatch_ms | 系统分发延迟（从内核到应用） | 系统侧问题：SurfaceFlinger 忙、system_server 负载高、输入管线积压 |
| handling_ms | 应用处理延迟（应用收到事件到处理完成） | 应用侧问题：主线程阻塞、计算量大 → 用四象限分析定位 |
| ack_ms | ACK 延迟（处理完成到帧上屏） | 渲染管线问题：帧绘制慢、SurfaceFlinger 合成延迟 |

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
| D (Disk Sleep) | `io_schedule` / `blkdev_issue_flush` | 磁盘 IO 阻塞 |
| D (Disk Sleep) | `SyS_fsync` / `do_fsync` | fsync 刷盘（SQLite/SharedPreferences） |
| D (Disk Sleep) | `filemap_fault` / `do_page_fault` | 页缺失 |

### 第四步：多手势类型识别（次要 — 仅在用户明确提及时分析）

以下手势类型属于进阶分析，仅在用户明确提到"长按"、"双击"等手势关键词时才进行分析：

| 手势类型 | 识别方式 | 分析要点 |
|---------|---------|---------|
| **长按 (Long Press)** | ACTION_DOWN 到 ACTION_UP 之间持续时间 > 500ms，且无 MOVE 事件（或 MOVE < 3 次） | 长按响应由 ViewConfiguration.getLongPressTimeout() 控制（默认 500ms）。如果用户反馈长按响应慢，检查：① 主线程在 DOWN 后 500ms 内是否有阻塞导致 Looper 延迟处理 LongPress Runnable；② onLongClick 回调本身的执行耗时 |
| **双击 (Double Tap)** | 两次 ACTION_DOWN 之间间隔 < 300ms（ViewConfiguration.getDoubleTapTimeout()） | 双击检测由 GestureDetector 处理。如果用户反馈双击不灵敏，检查：① 两次 tap 间隔是否接近 300ms 阈值；② 首次 tap 的 ACTION_UP 处理是否过慢导致第二次 DOWN 被错过 |

**长按事件检测 SQL（仅在用户提及时使用）：**
```
execute_sql("WITH motion AS (SELECT read_time AS ts, event_action, process_name, SUM(CASE WHEN event_action='DOWN' THEN 1 ELSE 0 END) OVER (ORDER BY read_time) AS gid FROM android_input_events WHERE event_type='MOTION'), gestures AS (SELECT gid, MIN(ts) AS down_ts, MAX(CASE WHEN event_action='UP' THEN ts END) AS up_ts, COUNT(CASE WHEN event_action='MOVE' THEN 1 END) AS move_cnt FROM motion WHERE gid>0 GROUP BY gid) SELECT printf('%d', down_ts) AS ts, ROUND((up_ts - down_ts)/1e6, 1) AS hold_ms FROM gestures WHERE up_ts IS NOT NULL AND (up_ts - down_ts) > 500000000 AND move_cnt <= 2 ORDER BY down_ts LIMIT 20")
```

**双击事件检测 SQL（仅在用户提及时使用）：**
```
execute_sql("WITH downs AS (SELECT read_time AS ts, LAG(read_time) OVER (ORDER BY read_time) AS prev_ts FROM android_input_events WHERE event_type='MOTION' AND event_action='DOWN') SELECT printf('%d', ts) AS ts, ROUND((ts - prev_ts)/1e6, 1) AS gap_ms FROM downs WHERE prev_ts IS NOT NULL AND (ts - prev_ts) < 300000000 ORDER BY ts LIMIT 20")
```

### 输出结构必须遵循：

1. **概览**：总事件数、慢事件数、平均/P90/P99 延迟、总体评级
   - 如果无慢事件：报告"输入响应良好"并给出关键指标

2. **瓶颈分布**：
   - dispatch-heavy 事件 N 个（系统侧）
   - handling-heavy 事件 N 个（应用侧）
   - ack-heavy 事件 N 个（渲染管线）

3. **逐事件根因**（每个慢事件）：
   ```
   ### 事件 #N: [event_type] [event_action] — 总延迟 XXms
   - 瓶颈阶段：handling (XXms, YY%)
   - 四象限：Q1=XX% Q2=XX% Q3=XX% Q4=XX%
   - 根因：[具体根因 + blocked_functions 证据]
   - 建议：[可操作的优化建议]
   ```

4. **优化建议**：按影响面排序，区分系统侧 vs 应用侧建议

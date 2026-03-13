---
scene: scroll_response
priority: 3
effort: medium
keywords:
  - 滑动响应
  - 滑动延迟
  - 响应速度
  - 首帧延迟
  - 首帧响应
  - scroll response
  - scroll latency
  - first frame
  - response latency
  - 滑动开始
  - scroll start
  - initial response
  - 触摸响应
compound_patterns:
  - "滑动.*响应"
  - "滑动.*延迟"
  - "scroll.*response"
  - "scroll.*latency"
  - "首帧.*延迟"
  - "首帧.*响应"
  - "滑动.*首帧"
---

#### 滑动响应速度分析（用户提到 滑动响应、滑动延迟、首帧延迟、scroll response、scroll latency）

**核心区分：滑动响应速度 ≠ 滑动流畅性**
- **响应速度**（本策略）：ACTION_MOVE → 第一帧画面变化的端到端延迟（target: <100ms）
- **流畅性**（scrolling 策略）：持续滑动中的帧间稳定性 → 应使用 scrolling 策略

如果用户问的是持续滑动中的卡顿/掉帧，应引导到 scrolling 策略，而非本策略。

**Phase 1 — 输入事件定位：**

首先定位滑动手势的起始输入事件：
```
invoke_skill("input_events_in_range", { event_type: "motion", event_action: "move" })
```

如果该 Skill 不可用，使用 SQL 回退：
```sql
SELECT
  printf('%d', ts) AS ts,
  printf('%d', dur) AS dur,
  ROUND(dur / 1e6, 2) AS dur_ms,
  arg_set_id,
  EXTRACT_ARG(arg_set_id, 'event_action') AS action,
  EXTRACT_ARG(arg_set_id, 'event_type') AS type
FROM slice
WHERE name = 'aq:pending:deliver'
  OR name GLOB 'deliverInputEvent*'
  OR name GLOB '*InputEvent*'
ORDER BY ts
LIMIT 50
```

- 找到滑动手势中 **ACTION_DOWN 之后的第一个 ACTION_MOVE** 事件
- 记录其时间戳作为 `gesture_start_ts`
- 如果有多个滑动手势，分别分析每个手势的首帧响应

**Phase 2 — 首帧关联：**

找到手势启动后的第一帧：
```
invoke_skill("scroll_response_latency", { ... })
```

如果该 Skill 不可用，使用 SQL 回退：
```sql
-- 查找 gesture_start_ts 之后的第一帧
SELECT
  printf('%d', a.ts) AS frame_ts,
  printf('%d', a.dur) AS frame_dur,
  ROUND(a.dur / 1e6, 2) AS frame_dur_ms,
  printf('%d', a.ts + a.dur) AS present_ts,
  a.jank_type,
  a.on_time_finish
FROM actual_frame_timeline_slice a
LEFT JOIN process p ON a.upid = p.upid
WHERE p.name GLOB '{process_name}*'
  AND a.ts >= {gesture_start_ts}
ORDER BY a.ts
LIMIT 1
```

计算端到端响应延迟：
```
response_latency = frame_present_ts - gesture_start_ts
```

**评级标准：**

| 响应延迟 | 评级 | 说明 |
|---------|------|------|
| <50ms | 极佳 | 用户几乎无感知延迟 |
| 50-100ms | 良好 | 在可接受范围内 |
| 100-200ms | 一般 | 用户可感知到轻微延迟 |
| 200-500ms | 差 | 明显卡顿感 |
| >500ms | 极差 | 严重影响用户体验 |

**Phase 3 — 延迟分解：**

将端到端延迟分解为以下各段，逐段定位瓶颈：

**段 1：Input dispatch latency（内核 → App 进程）**
```sql
-- 查找输入事件分发耗时
SELECT
  printf('%d', ts) AS ts,
  ROUND(dur / 1e6, 2) AS dispatch_ms
FROM slice
WHERE name = 'aq:pending:deliver'
  AND ts <= {gesture_start_ts} + 50000000  -- 50ms window
  AND ts >= {gesture_start_ts} - 10000000
ORDER BY ts
LIMIT 5
```

**段 2：Choreographer wait（收到输入 → 下一个 VSync doFrame）**
- 输入事件到达 App 后，需要等待下一个 VSync 信号触发 Choreographer#doFrame
- 正常等待 0-16ms（一个 VSync 周期）

**段 3：App frame build（measure + layout + draw）**
```sql
SELECT
  printf('%d', ts) AS ts,
  ROUND(dur / 1e6, 2) AS dur_ms,
  name
FROM slice
WHERE name IN ('Choreographer#doFrame', 'measure', 'layout', 'draw', 'Record View#draw()')
  AND ts >= {gesture_start_ts}
  AND ts <= {gesture_start_ts} + 200000000  -- 200ms window
ORDER BY ts
LIMIT 20
```

**段 4：Render thread（sync + draw commands + swap buffers）**
```sql
SELECT
  printf('%d', ts) AS ts,
  ROUND(dur / 1e6, 2) AS dur_ms,
  name
FROM slice
WHERE name IN ('DrawFrame', 'syncFrameState', 'flush commands', 'eglSwapBuffersWithDamageKHR')
  AND ts >= {gesture_start_ts}
  AND ts <= {gesture_start_ts} + 200000000
ORDER BY ts
LIMIT 20
```

**段 5：SurfaceFlinger composition（合成 + present）**
```sql
SELECT
  printf('%d', ts) AS ts,
  ROUND(dur / 1e6, 2) AS dur_ms,
  name
FROM slice s
JOIN thread t ON s.track_id = t.utid
WHERE t.name = 'surfaceflinger'
  AND s.name IN ('onMessageReceived', 'INVALIDATE', 'REFRESH')
  AND s.ts >= {gesture_start_ts}
  AND s.ts <= {gesture_start_ts} + 200000000
ORDER BY s.ts
LIMIT 20
```

对每一段，判断耗时是否超出正常范围，定位瓶颈段。

**Phase 4 — 根因与建议：**

| 延迟段 | 正常范围 | 异常时根因方向 |
|--------|---------|-------------|
| Input dispatch | <10ms | system_server 负载高、input 线程被阻塞、输入管线积压 |
| Choreographer wait | 0-16ms（1 VSync） | 错过当前 VSync、要等下一个周期，可能主线程正忙 |
| App frame build | <8ms | 主线程忙（layout 复杂、数据加载、同步 Binder 阻塞） |
| Render thread | <4ms | GPU 负载高、draw commands 多、纹理上传 |
| SF composition | <4ms | GPU composition 慢、layer 数多、HWC 回退 |

**深钻决策（基于瓶颈段）：**

| 瓶颈段 | 深钻动作 |
|-------|---------|
| App frame build 超时 | `invoke_skill("jank_frame_detail", { start_ts, end_ts, process_name })` 查看主线程热点 |
| Render thread 超时 | 检查 GPU 频率：`invoke_skill("gpu_analysis")` |
| SF composition 超时 | `invoke_skill("surfaceflinger_analysis")` 查看合成策略和 layer 数 |
| Input dispatch 超时 | 检查 system_server CPU 占用和 InputDispatcher 线程状态 |

### 输出结构必须遵循：

1. **端到端响应延迟**：总延迟（ms）+ 评级
   - 如有多个滑动手势，分别报告每个手势的首帧响应

2. **延迟分解瀑布图**：
   ```
   | 延迟段 | 耗时 | 占比 | 是否瓶颈 |
   |-------|------|------|---------|
   | Input dispatch | 5ms | 5% | |
   | Choreographer wait | 12ms | 12% | |
   | App frame build | 65ms | 65% | ★ 瓶颈 |
   | Render thread | 8ms | 8% | |
   | SF composition | 10ms | 10% | |
   | **总计** | **100ms** | **100%** | |
   ```

3. **瓶颈段根因分析**：
   - 具体到导致延迟的 Slice/函数/线程状态
   - 如果是主线程阻塞，给出 blocked_function 和 thread_state

4. **与滑动流畅性的关联**：
   - 如果首帧慢且后续帧也有卡顿 → 说明是系统性问题（如 CPU 频率不足、主线程持续被阻塞）
   - 如果仅首帧慢 → 可能是冷启动代价（首次布局/数据加载）

5. **优化建议**：按瓶颈段给出可操作的建议

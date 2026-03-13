---
scene: touch_tracking
priority: 3
effort: medium
keywords:
  - 跟手度
  - 跟手
  - 跟随
  - follow finger
  - touch tracking
  - 触控延迟
  - 持续延迟
  - 滑动跟随
  - input to display
  - 管线延迟
  - pipeline latency
  - 触摸跟踪
  - touch latency
  - 输入延迟持续
compound_patterns:
  - "跟手.*度"
  - "跟手.*延迟"
  - "滑动.*跟手"
  - "滑动.*跟随"
  - "touch.*tracking"
  - "follow.*finger"
  - "input.*display.*latency"
  - "持续.*延迟"
  - "每帧.*延迟"
  - "per.*frame.*latency"
---

#### 跟手度分析（用户提到 跟手度、跟手延迟、follow finger、touch tracking）

**⚠️ 核心区分：跟手度 ≠ 首帧响应速度 ≠ 滑动流畅性**

| 指标 | 定义 | 对应策略 |
|------|------|---------|
| **跟手度**（本策略） | 整个滑动过程中，每一个 MotionEvent 到它对应的帧 present 的**持续延迟** | touch_tracking |
| **首帧响应速度** | ACTION_MOVE → 第一帧画面变化的**单次延迟** | scroll_response |
| **滑动流畅性** | 帧间时间稳定性、掉帧率 | scrolling |

跟手度差的典型表现：手指已经滑到位置 A，但屏幕内容还停留在 2-3 帧之前的位置。
用户不会感到"卡顿"（帧率可能60fps），但会感到"不跟手"、"有黏滞感"。

**Phase 1 — 逐帧 Input-to-Display 延迟测量：**

```
invoke_skill("input_to_frame_latency", { process_name: "<包名>" })
```
返回：每个 ACTION_MOVE 事件的 input_ts → frame_present_ts 延迟，以及统计指标（均值、P50、P90、P99、抖动）。

如果该 Skill 不可用（trace 缺少 `android_input_event_dispatch` 表），使用 SQL 回退：
```sql
-- 查找 MOVE 事件与消费帧的关联
WITH input_events AS (
  SELECT
    ied.ts as input_ts,
    ied.event_action,
    ied.upid,
    p.name as process_name
  FROM android_input_event_dispatch ied
  LEFT JOIN process p ON p.upid = ied.upid
  WHERE (p.name GLOB '{process_name}*' OR '{process_name}' = '')
    AND (ied.event_action = 'ACTION_MOVE' OR ied.event_action = '2')
),
frame_match AS (
  SELECT
    ie.input_ts,
    ie.process_name,
    (SELECT MIN(f.ts) FROM actual_frame_timeline_slice f
     WHERE f.upid = ie.upid AND f.ts >= ie.input_ts) as frame_ts,
    (SELECT MIN(f.ts + f.dur) FROM actual_frame_timeline_slice f
     WHERE f.upid = ie.upid AND f.ts >= ie.input_ts) as frame_present_ts
  FROM input_events ie
)
SELECT
  printf('%d', input_ts) as input_ts,
  process_name,
  printf('%d', frame_ts) as frame_ts,
  printf('%d', frame_present_ts) as frame_present_ts,
  ROUND((frame_present_ts - input_ts) / 1e6, 2) as input_to_display_ms,
  ROUND((frame_ts - input_ts) / 1e6, 2) as input_to_frame_start_ms
FROM frame_match
WHERE frame_present_ts IS NOT NULL
ORDER BY input_ts
```

**评级标准（基于 P90 input-to-display 延迟）：**

| P90 延迟 | 评级 | 说明 |
|---------|------|------|
| <32ms | 极佳 | 约 2 帧延迟（60Hz），用户感知完美跟手 |
| 32-48ms | 良好 | 约 2-3 帧延迟（60Hz），轻微不跟手但可接受 |
| 48-64ms | 一般 | 约 3-4 帧延迟，明显不跟手感 |
| 64-96ms | 差 | 4-6 帧延迟，强烈黏滞感 |
| >96ms | 极差 | 严重不跟手 |

注意：120Hz 设备的评级标准更严格（×0.5），240Hz 更甚。需先检测 VSync 周期进行评级校准。

**Phase 2 — VSync 相位分析：**

跟手延迟的一个关键因素是 **input sampling 与 VSync 的相位关系**。

```
invoke_skill("vsync_phase_alignment", { process_name: "<包名>" })
```

该 Skill 测量：
- Input event timestamp 与最近 VSync 信号的相位差
- 相位差的统计分布
- 是否存在系统性的相位偏移（worst case: input 刚好在 VSync 后到达，需要多等一帧）

**Phase 3 — 延迟分解（根因定位）：**

将每帧 input-to-display 延迟分解为 4 段：

| 段 | 计算方法 | 正常范围 (60Hz) | 含义 |
|----|---------|---------------|------|
| **Input→VSync** | frame_ts - input_ts | 0-16ms | 输入事件等待下一个 VSync（取决于相位） |
| **VSync→FrameEnd** | frame_dur | 8-16ms | App 处理帧（measure+layout+draw+RenderThread） |
| **FrameEnd→Present** | present_ts - (frame_ts + frame_dur) | 0-16ms | SurfaceFlinger 合成+呈现 |
| **总计** | present_ts - input_ts | 16-48ms | 端到端 |

对于延迟偏高的帧，深钻瓶颈段：
```sql
-- 检查 Choreographer wait 是否过长
SELECT
  printf('%d', s.ts) AS ts,
  ROUND(s.dur / 1e6, 2) AS dur_ms,
  s.name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
WHERE t.name = 'main' AND s.name = 'Choreographer#doFrame'
  AND s.ts >= {frame_ts} - 20000000
  AND s.ts <= {frame_ts} + 20000000
ORDER BY s.ts
LIMIT 5
```

**Phase 4 — 跟手度优化诊断树：**

| 根因 | 判断条件 | 优化方向 |
|------|---------|---------|
| **VSync 相位不利** | Input→VSync 段持续 >12ms | 调整 input dispatch timing 或启用 input prediction |
| **帧处理过慢** | VSync→FrameEnd 段 >16ms | 同滑动卡顿分析（四象限诊断） |
| **SF 合成延迟** | FrameEnd→Present 段 >16ms | GPU composition 慢 / layer 数多 |
| **管线深度过深** | 持续 3+ 帧延迟 | 检查 BufferQueue 模式（triple buffering → 固有 3 帧延迟） |
| **低刷新率** | VSync 周期 >16ms | 设备未处于高刷模式（VRR 未激活） |
| **输入采样率低** | input event 间隔 >12ms | 触控 IC 采样率低（120Hz touch sampling = 8.3ms interval） |

**深钻决策：**

| 条件 | 深钻动作 |
|------|---------|
| **VSync→FrameEnd 过长** | `invoke_skill("jank_frame_detail", ...)` 查看帧内瓶颈 |
| **管线深度 ≥3** | 检查 BufferQueue 深度和 BLAST/Legacy 模式 |
| **持续高延迟 + 低频率** | `invoke_skill("thermal_throttling")` 检查是否热降频 |
| **VSync 周期异常** | `invoke_skill("vrr_detection")` 检查 VRR 状态 |

### 输出结构必须遵循：

1. **跟手度评级**：P50/P90/P99 input-to-display 延迟 + 评级（需标注设备刷新率）
   ```
   | 统计指标 | 值 | 说明 |
   |---------|-----|------|
   | 设备刷新率 | 120Hz (8.33ms/帧) | VSync 周期 |
   | 触控采样率 | ~240Hz (~4.2ms) | Input event 间隔中位数 |
   | P50 延迟 | 24ms | 约 3 帧延迟 |
   | P90 延迟 | 38ms | 约 4.5 帧延迟 |
   | P99 延迟 | 65ms | 约 8 帧延迟 |
   | 抖动 (StdDev) | 8ms | 延迟稳定性 |
   ```

2. **延迟分布图**：按时间顺序展示每帧的 input-to-display 延迟
   - 标注延迟飙升点（spike）
   - 关联可能的系统事件（GC、Binder、频率变化）

3. **延迟分段分解**：
   ```
   | 延迟段 | 均值 | P90 | 是否瓶颈 |
   |-------|------|-----|---------|
   | Input→VSync | 6ms | 12ms | |
   | VSync→FrameEnd | 10ms | 22ms | ★ 瓶颈 |
   | FrameEnd→Present | 8ms | 14ms | |
   | **总计** | **24ms** | **38ms** | |
   ```

4. **根因分析**：基于延迟分段定位主要瓶颈
   - 如果是 VSync 相位问题：说明 input sampling 与 VSync 的对齐情况
   - 如果是帧处理慢：给出主线程/RenderThread 的热点
   - 如果是管线深度：说明 BufferQueue 配置

5. **优化建议**：
   - 按根因类别给出可操作建议
   - 标注预期收益（例如"优化后预计 P90 从 38ms 降至 24ms"）

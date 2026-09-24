<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: touch_tracking
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: touch_tracking_critical_path
      domain: critical_path
      description: "Correlate continuous input samples with corresponding app updates and presentation windows. Select input/Main/render/SF critical tasks across that sequence; summarize tracking delay distributions with actual coverage."
    - id: touch_tracking_dependencies
      domain: dependency_chain
      description: "Distinguish input sampling, queueing, task service and presentation lag. Matching FPS alone does not prove good tracking or locate its cause. Speculative input-frame matches are unproven candidates and NULL end-to-end latency is unmeasured, not zero; if the app has no FrameTimeline/present linkage (e.g. Flutter SurfaceView), state tracking latency is unmeasurable."
classification_description: "Continuous input-to-display tracking during a gesture, including how closely visual motion follows touch input."
priority: 3
effort: medium
required_capabilities:
  - input_latency
  - frame_rendering
  - surfaceflinger
optional_capabilities:
  - cpu_scheduling
  - gpu
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

plan_template:
  mandatory_aspects:
    - id: per_frame_latency_measurement
      match_keywords: ['input', 'touch', '跟手', '延迟', 'latency', 'per_frame', 'tracking']
      suggestion: '跟手度场景建议包含逐帧 Input-to-Display 延迟测量阶段'
      required_expected_calls:
        - tool: invoke_skill
          skill_id: touch_to_display_latency
---

#### touch_tracking Core Strategy

**Route card**: 跟手度 / 跟手 / 跟随 / follow finger / touch tracking / 触控延迟 / 持续延迟 / 滑动跟随 / input to display / 管线延迟

**Capabilities**: required=[input_latency, frame_rendering, surfaceflinger], optional=[cpu_scheduling, gpu]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- per_frame_latency_measurement: 跟手度场景建议包含逐帧 Input-to-Display 延迟测量阶段 (required: invoke_skill(touch_to_display_latency))

**Phase reminders**
- 无额外 phase hint。

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `touch_tracking:full`: 跟手度分析（用户提到 跟手度、跟手延迟、follow finger、touch tracking） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="touch_tracking full strategy detail" keywords="touch_tracking,跟手度,跟手,跟随,follow finger,touch tracking,触控延迟,持续延迟,滑动跟随,input to display,管线延迟,pipeline latency,触摸跟踪,跟手度分析（用户提到 跟手度、跟手延迟、follow finger、touch tracking）,detail,full" default="true" -->
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
invoke_skill("input_to_frame_latency", { package: "<包名>" })
```
返回：每个 MOVE 事件的 5 维延迟分解（dispatch/handling/ack/e2e）+ 帧内分解（frame_dur/frame_to_present），以及统计指标（均值、P50、P90、P99、抖动）和 is_speculative 帧关联置信度。

**写任何跟手度数值前，先判读证据可用性：**
- `is_speculative=1`（stdlib `is_speculative_frame`）表示没有 doFrame 与该事件的投递相交，stdlib 只取了同一 UI 线程上之后的下一个 `Choreographer#doFrame`（不限间隔）。该帧未经证实消费了事件，只是候选：不能据此确认逐帧跟手延迟、帧关联、同帧输入堆积或上屏时间，由它推出的 input-to-display 也只是候选值。只有该线程就是出图线程且间隔很短时它才是可信的候选帧；许多事件落到同一个推测帧时，画面由其他线程产出则只说明该 UI 线程在手势期间没有出帧，标准 HWUI 上要结合主线程当时是否被占用判断。
- `end_to_end_latency_dur`、`input_to_display_ms` 或统计值为 NULL、表为空，含义是“未测量”，不是 0ms，也不是“极佳/正常”；此时不给 P50/P90/P99 或评级。
- dispatch/handling/ACK 按事件精确测量，不受帧关联是否推测影响，可以照常报告，但它们不是上屏延迟。
- 画面不在接收输入的 UI 线程上产出的管线（Flutter SurfaceView 的 1.raster、GLSurfaceView/游戏引擎、独立 SurfaceView producer）：目标进程没有 app 层 FrameTimeline/present 链接时，跟手度在本 trace 中**不可测量**。分别报告 dispatch/handling/ACK、producer 帧节奏（如 `flutter_scrolling_analysis`）和 SF present 等已有证据，不把它们拼成端到端延迟。

如果该 Skill 不可用（trace 缺少 `sendMessage(*)`/`receiveMessage(*)` slices），使用 SQL 回退：
```sql
-- 查找 MOVE 事件与目标进程帧的关联。无 slice 时读 proto 输入表 android_motion_events：
-- 它不记录接收进程，只能按目标进程的帧关联；action & 255 = 2 即 MOVE。
WITH target_process AS (
  SELECT upid, name AS process_name
  FROM process
  WHERE name = '{process_name}' OR name GLOB '{process_name}:*'
),
input_events AS (
  SELECT
    m.ts as input_ts,
    'MOVE' as event_action,
    tp.upid,
    tp.process_name
  FROM android_motion_events m
  CROSS JOIN target_process tp
  WHERE (m.action & 255) = 2
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
该回退把输入配到目标进程之后的第一个 FrameTimeline 帧，与推测匹配同性质，结果只能写成候选；返回空按上面的“未测量”规则处理。

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
invoke_skill("vsync_phase_alignment", { package: "<包名>" })
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
| **持续高延迟 + 低频率** | `invoke_skill("thermal_throttling")` 检查温度/频率；确认是否真被限频以及谁触发，用 `invoke_skill("cpu_frequency_limit_attribution")` |
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
   - 不可测量时直接写“本 trace 中跟手度（input-to-display）不可测量”，列出缺失的链接（app 层 FrameTimeline/present、精确帧关联），只给出可测的 dispatch/handling/ACK 与帧节奏；上表和第 2、3 项都不输出。
   - 仅有推测帧关联时，数值标为候选值（不是上界也不是下界）并注明推测关联的事件占比。

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
<!-- /strategy-detail -->

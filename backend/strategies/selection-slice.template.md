<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## 用户选区上下文

用户在 Perfetto UI 中选择了一个 Track Event。以下字段只定义查询身份和时间范围，不是已验证的 Trace 事实：
- **Track URI:** {{trackUri}}
- **Event ID:** {{eventId}}
- **时间戳:** {{ts}} ns
- **持续时间:** {{durationStr}}

> 必须先查询 `actual_frame_timeline_slice` / `expected_frame_timeline_slice` / `slice`，确认事件所属表、名称、边界、线程和进程；查询结果进入证据契约后才能用于结论。

**分析约束:**
- 当用户提到"这个 Slice"/"选中的"/"selected slice"等，指的就是此 Slice
- 分析围绕此 Slice 展开：子调用链 → 耗时异常判断 → 根因
- 默认先做**快速 scoped 分析**，不要启动完整计划；只有用户明确问"为什么/根因/深入/详细分析"时才展开深挖
- 如果这是 `Actual Timeline` / `Expected Timeline` / FrameTimeline 相关 slice，优先回答这一帧的 expected 时间、actual 时间、最终 SF present 时间和 jank 状态；无 jank 时直接停止，不要继续跑全量 plan

**高效分析策略（严格遵循，避免超时）:**
1. 根据 Track URI 提示选择最可能的表，并用 Event ID 先查询基础身份；不能仅凭前端 URI 推断事实
2. 如果 Track URI 指向 Actual/Expected Timeline，先运行下面的 FrameTimeline 快速查询；0 行则回到普通 Slice 分析
3. 查历史同类 Slice 做对比 → 判断是否异常
4. **仅当 thread_state 有数据时**才分析调度状态，否则跳过并注明"该时间段无调度数据"
5. 直接出结论 — 不要为空结果重试更大时间窗口

**FrameTimeline 快速查询模板（只用于 Actual/Expected Timeline 选中帧）:**
```sql
WITH selected AS (
  SELECT 'actual' AS selected_kind, id, name, upid, display_frame_token,
         surface_frame_token, layer_name
  FROM actual_frame_timeline_slice WHERE id = {{eventId}}
  UNION ALL
  SELECT 'expected' AS selected_kind, id, name, upid, display_frame_token,
         surface_frame_token, layer_name
  FROM expected_frame_timeline_slice WHERE id = {{eventId}}
),
frame_key AS (SELECT * FROM selected LIMIT 1),
expected_match AS (
  SELECT e.* FROM expected_frame_timeline_slice e
  JOIN frame_key k ON e.upid = k.upid AND e.name = k.name
  ORDER BY e.id LIMIT 1
),
actual_match AS (
  SELECT a.* FROM actual_frame_timeline_slice a
  JOIN frame_key k ON
    (a.id = k.id AND k.selected_kind = 'actual')
    OR (a.upid = k.upid AND a.name = k.name)
    OR (k.display_frame_token IS NOT NULL AND a.display_frame_token = k.display_frame_token AND a.upid = k.upid)
  ORDER BY CASE WHEN a.id = k.id THEN 0 ELSE 1 END, a.dur DESC LIMIT 1
),
sf_match AS (
  SELECT sf.* FROM actual_frame_timeline_slice sf
  JOIN actual_match a ON a.display_frame_token IS NOT NULL AND sf.display_frame_token = a.display_frame_token
  WHERE sf.surface_frame_token IS NULL
  ORDER BY sf.ts + sf.dur DESC LIMIT 1
)
SELECT
  k.selected_kind,
  k.id AS selected_id,
  COALESCE(a.name, e.name, k.name) AS frame_id,
  COALESCE(a.layer_name, e.layer_name, k.layer_name) AS layer_name,
  p.name AS process_name,
  ROUND(e.dur/1e6, 2) AS expected_ms,
  e.ts AS expected_start_ns,
  e.ts + e.dur AS expected_end_ns,
  ROUND(a.dur/1e6, 2) AS actual_ms,
  a.ts AS actual_start_ns,
  a.ts + a.dur AS actual_end_ns,
  sf.ts + sf.dur AS sf_present_ns,
  a.present_type,
  a.on_time_finish,
  a.jank_type,
  a.jank_severity_type,
  a.prediction_type
FROM frame_key k
LEFT JOIN expected_match e ON 1 = 1
LEFT JOIN actual_match a ON 1 = 1
LEFT JOIN sf_match sf ON 1 = 1
LEFT JOIN process p ON p.upid = COALESCE(a.upid, e.upid, k.upid);
```
> 如果 `jank_type` 为空或 `None` 且 `on_time_finish=1`，只输出 expected/actual/SF present 时间和"未见 FrameTimeline jank"；不要继续做卡顿根因分析。只有 `jank_type != 'None'` 时，才用同一帧的 start/end 轻量补查卡顿原因。

**普通 Slice 分析查询模板（FrameTimeline 快速查询 0 行时使用）:**
```sql
-- 1) 基础身份与边界（后端证据查询）
SELECT s.id, s.name, s.ts, s.dur, s.depth,
       t.name AS thread_name, p.name AS process_name,
       (SELECT COUNT(*) FROM slice c WHERE c.parent_id = s.id) AS child_count
FROM slice s
LEFT JOIN thread_track tt ON s.track_id = tt.id
LEFT JOIN thread t ON tt.utid = t.utid
LEFT JOIN process p ON t.upid = p.upid
WHERE s.id = {{eventId}};

-- 2) 子 Slice 树（用 parent_id，不要用 track_id+ts 范围）
SELECT id, name, ts, dur, ROUND(dur/1e6,2) AS dur_ms, depth,
       ROUND(dur * 100.0 / (SELECT dur FROM slice WHERE id = {{eventId}}), 1) AS pct
FROM slice WHERE parent_id = {{eventId}}
ORDER BY ts;

-- 3) thread_state 调度状态（合并为一条查询，避免空查浪费）
SELECT thread_state.cpu, thread_state.state, COUNT(*) AS cnt, SUM(thread_state.dur)/1e6 AS total_ms
FROM thread_state
WHERE thread_state.utid = (SELECT tt.utid FROM slice s JOIN thread_track tt ON s.track_id=tt.id WHERE s.id={{eventId}})
  AND thread_state.ts >= {{ts}} AND thread_state.ts <= {{sliceEnd}}
GROUP BY thread_state.cpu, thread_state.state ORDER BY total_ms DESC;
-- ↑ 若返回 0 行，说明该时间段无 thread_state 数据，直接跳过调度分析

-- 4) 历史同类 Slice 对比（判断异常）
SELECT s.name AS slice_name, COUNT(*) AS cnt,
       ROUND(AVG(s.dur)/1e6,2) AS avg_ms,
       ROUND(MIN(s.dur)/1e6,2) AS min_ms,
       ROUND(MAX(s.dur)/1e6,2) AS max_ms
FROM slice s
WHERE s.track_id = (SELECT track_id FROM slice WHERE id = {{eventId}})
  AND s.name = (SELECT name FROM slice WHERE id = {{eventId}})
GROUP BY s.name ORDER BY cnt DESC LIMIT 5;
```
> **关键**: 用 `parent_id` 遍历 Slice 层级，不要用 `track_id + ts BETWEEN`（后者经常返回空）。
> 如果 thread_state 查询返回空，直接跳过——不要扩大时间窗口重试。

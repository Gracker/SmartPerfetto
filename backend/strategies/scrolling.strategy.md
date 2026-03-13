---
scene: scrolling
priority: 3
effort: medium
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
---

#### 滑动/卡顿分析（用户提到 滑动、卡顿、掉帧、jank、scroll、fps）

**⚠️ 核心原则：**
1. **逐帧根因诊断是最重要的**。概览统计（帧率、卡顿率）只是入口，真正有价值的是每一个掉帧帧的根因分析。
2. **区分真实掉帧 vs 框架标记**：
   - **真实掉帧（real_jank）**：消费端帧呈现间隔 > 1.5x VSync 周期，用户肉眼可见的卡顿
   - **App 超时（App Deadline Missed）**：App 生产帧超过帧预算，是真实掉帧的子集
   - **隐形掉帧**：框架标记为 `jank_type=None`，但消费端检测到真实掉帧。这类帧往往是 SurfaceFlinger 合成延迟或管线积压导致的，**不可忽略**
   - **Buffer Stuffing 假阳性**：框架标记为 Buffer Stuffing，但消费端间隔正常（false_positive=9 表示 9 帧是假阳性）
3. **如何计算真实掉帧总数**：
   - scrolling_analysis 的 `jank_type_stats` step 返回每种 `jank_type` 的 `real_jank_count` 字段
   - **总真实掉帧 = 所有行的 `real_jank_count` 之和**（不是只看 `jank_type != 'None'` 的行！）
   - 例如：`None` 行 `real_jank_count=165` + `App Deadline Missed` 行 `real_jank_count=135` = 总真实掉帧 300
   - `jank_type=None` 但 `real_jank_count > 0` 表示 **隐形掉帧**，必须在报告中明确指出
4. **get_app_jank_frames 结果中的 `jank_responsibility` 字段**：
   - `APP`：App 侧原因（App Deadline Missed / Self Jank）
   - `SF`：SurfaceFlinger 侧原因
   - `HIDDEN`：隐形掉帧（框架未标记，消费端检测到）
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
  - `get_app_jank_frames`：所有掉帧帧列表（含 start_ts, end_ts, jank_type, jank_responsibility）
  - `batch_frame_root_cause`：**每帧完整分析**（reason_code + 四象限 MainThread/RenderThread + CPU 频率 + Binder/GC 重叠 + 根因分类），覆盖所有掉帧帧
- **获取详细数据**：对大型 artifact 使用分页获取：
  `fetch_artifact(artifactId, detail="rows", offset=0, limit=50)`
  响应包含 `totalRows` 和 `hasMore`，继续翻页获取所有数据。
  **必须获取完所有相关数据再出结论**，不可只看前 50 行就下结论

**Phase 1.5 — 架构感知分支（基于 detect_architecture 结果）：**

| 架构 | 调整动作 |
|------|---------|
| **Flutter** | 改用 `invoke_skill("flutter_scrolling_analysis")` 代替 `scrolling_analysis`。Flutter 的 1.ui/1.raster 线程模型与标准 RenderThread 不同，jank 帧的根因归属逻辑也不同 |
| **WebView** | 使用标准 `scrolling_analysis`，但注意 CrRendererMain 线程的 slice 可能是卡顿主因。WebView 场景下，CrRendererMain 线程的阻塞（V8 GC、CSS Layout Thrashing）可能导致帧延迟。可调用 webview_v8_analysis Skill 检查 V8 性能 |
| **标准 HWUI** | 使用标准 `scrolling_analysis` |
| **Compose** | 使用标准 `scrolling_analysis`。如果检测到 Compose 架构，注意 Recomposition* slices 可能是卡顿主因。LazyColumn/LazyRow 的 prefetch 和 compose 阶段如果超时会导致掉帧。可调用 compose_recomposition_hotspot Skill 检测过度重组 |

**Phase 1.7 — 根因分支深钻（基于 batch_frame_root_cause 的 reason_code 和 jank_responsibility）：**

| 条件 | 深钻动作 |
|------|---------|
| **多帧 `reason_code = gpu_bound`** | 调用 `invoke_skill("gpu_analysis")` 或 `execute_sql` 查询 GPU 频率/利用率。GPU 瓶颈通常与 GPU 频率受限或 shader 复杂度有关 |
| **多帧 `jank_responsibility = SF`** | 调用 `invoke_skill("surfaceflinger_analysis")` 分析 SF 合成延迟、GPU/HWC 合成比例、Fence 超时 |
| **多帧 `big_avg_freq_mhz` 显著低于设备峰值** | 调用 `invoke_skill("thermal_throttling")` 检查是否存在热节流。CPU 频率被 thermal 限制是常见的跨帧系统级根因 |
| **VRR 设备（通过 `vrr_detection` 或 VSync 周期 ≠ 16.67ms 判断）** | 注意 1.5x VSync 阈值需基于检测到的实际 VSync 周期（如 120Hz = 8.33ms, 1.5x = 12.5ms），而非固定 16.67ms |

**Phase 2 — 补充深钻（可选，仅在需要时执行）：**
Phase 1 的 `batch_frame_root_cause` 已包含每帧的**完整详细分析数据**：
- MainThread 四象限（Q1 大核运行 / Q2 小核运行 / Q3 调度等待 / Q4 休眠）
- RenderThread 四象限（render_q1 大核 / render_q3 调度 / render_q4 休眠）
- CPU 大核频率（big_avg_freq_mhz / big_max_freq_mhz）+ 升频延迟（ramp_ms）
- Binder 同步重叠（binder_overlap_ms）+ GC 重叠（gc_overlap_ms）
- 根因分类（reason_code）+ 关键操作（top_slice_name / top_slice_ms）

**大多数情况下 batch_frame_root_cause 数据已足够出结论**，无需调用 jank_frame_detail。
仅在以下情况才调用 jank_frame_detail（**最多 2 帧**）：
- 需要查看 CPU 频率**时间线**（帧内频率变化过程）
- 需要查看 RenderThread 或主线程的 top N slices 详情
- reason_code 为 unknown 且需要更多线索

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
   - 如果存在隐形掉帧（`jank_type=None` 但 `real_jank_count > 0`），**必须在概览中明确标注**：
     "其中 N 帧为隐形掉帧（框架未标记但消费端检测到真实掉帧），可能与 SurfaceFlinger 合成延迟、管线积压或跨进程 Binder 阻塞有关"
   - ⚠️ **`App Deadline Missed` 不等于全部真实掉帧**。例如 135 帧 App Deadline Missed + 165 帧隐形掉帧 = 300 总真实掉帧

2. **全帧根因分布**（基于 batch_frame_root_cause，覆盖所有掉帧帧）：
   按 reason_code 聚合，附带四象限分布和频率特征：
   ```
   | 根因类型 | 帧数 | 占比 | 四象限特征 | 频率特征 |
   |---------|------|------|-----------|---------|
   | workload_heavy | 80 | 59% | Q1=45% Q3=8% | 大核均频 2200MHz |
   | freq_ramp_slow | 30 | 22% | Q1=30% Q3=12% | 大核均频 1100MHz, ramp>10ms |
   | small_core_placement | 15 | 11% | Q2=55% | 大核均频 900MHz |
   | ... | ... | ... | ... | ... |
   ```

3. **代表帧分析**（每个根因类别选最严重的 1 帧，从 batch 数据中直接引用）：
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

4. **优化建议**：按根因类别给出可操作建议，优先级按帧数占比排序

⚠️ **结论必须覆盖所有掉帧帧的根因分布**，不能只报告少数几帧。
   batch_frame_root_cause 提供了全量分类和详细指标，结论中的"全帧根因分布"和"代表帧分析"都应基于它。

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

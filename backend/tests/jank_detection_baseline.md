# Jank Detection Regression Test Baseline

本文档记录滑动掉帧检测的基准测试数据。任何对掉帧检测逻辑的修改都应该通过这些测试，确保结果一致。

## 测试原理

掉帧检测基于 **VSYNC-sf 间隔** + **BufferTX 状态**：

1. **用户可见掉帧** = VSYNC-sf 间隔 > 1.5x 正常周期（SF 跳过了 VSync）
2. **责任归属**：
   - BufferTX = 0 → App 侧掉帧（App 没有及时提交 Buffer）
   - BufferTX > 0 → SF 侧掉帧（有 Buffer 但 SF 没消费）
3. **总掉帧** = App 侧 + SF 侧

---

## 基准测试数据

### 1. Heavy Jank Trace

**Trace 文件**: `test-traces/app_aosp_scrolling_heavy_jank.pftrace`

| 指标 | 期望值 |
|------|--------|
| VSync 周期 | ~8.03ms (125Hz) |
| **SF 跳帧事件总数** | **39** |
| App 侧掉帧事件 (BufferTX=0) | 6 |
| SF 侧掉帧事件 (BufferTX>0) | 33 |
| 最大 VSync 跳帧数 | 56 |
| 累计 VSync 跳帧数 | 150 |

**帧匹配数据**（一个 SF 跳帧事件可匹配多个 App 帧）：

| 指标 | 期望值 |
|------|--------|
| 匹配到的 App 帧数 | 140 |
| App 责任帧 | 0 |
| SF 责任帧 | 140 |
| 累计跳帧 VSync | 217 |
| 最大单帧跳帧 | 56 |

---

### 2. Light Jank Trace

**Trace 文件**: `test-traces/app_aosp_scrolling_light.pftrace`

| 指标 | 期望值 |
|------|--------|
| VSync 周期 | ~7.87ms (127Hz) |
| **SF 跳帧事件总数** | **8** |
| App 侧掉帧事件 (BufferTX=0) | 6 |
| SF 侧掉帧事件 (BufferTX>0) | 2 |
| 最大 VSync 跳帧数 | 143 |
| 累计 VSync 跳帧数 | 204 |

**帧匹配数据**：

| 指标 | 期望值 |
|------|--------|
| 匹配到的 App 帧数 | 3 |
| App 责任帧 | 0 |
| SF 责任帧 | 3 |
| 累计跳帧 VSync | 147 |
| 最大单帧跳帧 | 143 |

---

## 验证 SQL

使用以下 SQL 验证掉帧事件统计：

```sql
WITH
vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
vsync_config AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER)
     FROM vsync_intervals WHERE interval_ns > 5000000 AND interval_ns < 15000000),
    8333333
  ) as vsync_period_ns
),
vsync_events AS (
  SELECT c.ts as vsync_ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
buffer_events AS (
  SELECT c.ts, c.value as buffer_count
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name LIKE '%BufferTX%'
),
vsync_with_buffer AS (
  SELECT v.vsync_ts, v.interval_ns,
    (SELECT b.buffer_count FROM buffer_events b WHERE b.ts <= v.vsync_ts ORDER BY b.ts DESC LIMIT 1) as buffer_at_vsync
  FROM vsync_events v
  WHERE v.interval_ns IS NOT NULL
),
jank_analysis AS (
  SELECT
    COUNT(*) as total_vsync,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 THEN 1 ELSE 0 END) as total_jank_count,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 AND buffer_at_vsync = 0 THEN 1 ELSE 0 END) as app_jank_count,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 AND COALESCE(buffer_at_vsync, 1) > 0 THEN 1 ELSE 0 END) as sf_jank_count,
    MAX(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
        THEN ROUND(interval_ns * 1.0 / (SELECT vsync_period_ns FROM vsync_config) - 1) ELSE 0 END) as max_vsync_missed,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
        THEN ROUND(interval_ns * 1.0 / (SELECT vsync_period_ns FROM vsync_config) - 1) ELSE 0 END) as total_vsync_missed
  FROM vsync_with_buffer
  WHERE buffer_at_vsync IS NOT NULL
)
SELECT * FROM jank_analysis;
```

---

## 相关文件

- **Skill 文件**: `backend/skills/composite/scrolling_analysis.skill.yaml`
- **帧详情 Skill**: `backend/skills/composite/jank_frame_detail.skill.yaml`
- **Atomic Skill**: `backend/skills/atomic/consumer_jank_detection.skill.yaml`

---

## 更新日志

| 日期 | 更新内容 |
|------|----------|
| 2026-01-10 | 创建基准测试文档。修正掉帧检测逻辑，统计所有 SF 跳帧事件（不仅限 BufferTX=0） |

---

## 运行验证命令

```bash
# Heavy jank trace
./perfetto/out/ui/trace_processor_shell test-traces/app_aosp_scrolling_heavy_jank.pftrace --query-file /path/to/verify_jank.sql

# Light jank trace
./perfetto/out/ui/trace_processor_shell test-traces/app_aosp_scrolling_light.pftrace --query-file /path/to/verify_jank.sql
```

预期输出应与上述基准数据匹配。

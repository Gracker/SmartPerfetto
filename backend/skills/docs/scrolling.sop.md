# 滑动卡顿分析 SOP

> 维护边界：runtime-read SOP。优先使用 FrameTimeline、动态刷新率和当前 Skill
> 证据；固定 60Hz 数值只用于明确标注的 fallback 示例。

## 1. 概述

### 1.1 目标
分析应用滑动时的流畅度，识别卡顿原因，提供优化建议。

### 1.2 核心指标

| 指标 | 说明 | 理想值 |
|------|------|--------|
| 帧率 (FPS) | 每秒渲染帧数 | 60fps / 90fps / 120fps |
| 帧时间 | 单帧渲染时间 | 小于当前 frame deadline / 刷新周期 |
| Jank 率 | 丢帧占比 | < 5% |
| 严重 Jank | 丢 2 帧以上 | < 1% |

### 1.3 渲染流水线

```
┌──────────────────────────────────────────────────────────────────┐
│                      Android 渲染流水线                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  VSYNC    UI Thread          RenderThread        SurfaceFlinger │
│    │          │                   │                    │        │
│    ├─────────►│ Input/Animation   │                    │        │
│    │          │ Traversal         │                    │        │
│    │          │ (measure/layout)  │                    │        │
│    │          │ Draw              │                    │        │
│    │          │────────────────────►                   │        │
│    │          │                   │ syncFrameState    │        │
│    │          │                   │ DrawFrame         │        │
│    │          │                   │ GPU Commands      │        │
│    │          │                   │──────────────────►│        │
│    │          │                   │                   │ Compose │
│    │          │                   │                   │ Display │
│    │                                                            │
│  ◀──────────────── 16.67ms (60Hz) ─────────────────────────────▶ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 分析步骤

### Step 1: 确定分析方法

根据 Android 版本选择分析方法：

| Android 版本 | 推荐方法 | 数据来源 |
|-------------|---------|---------|
| 12+ (S+) | Frame Timeline | `expected/actual_frame_timeline_slice` |
| 11 及以下 | Choreographer | `slice` 表的 `Choreographer#doFrame` |

**检查 Frame Timeline 支持：**
```sql
SELECT COUNT(*) FROM sqlite_master
WHERE type='table' AND name='expected_frame_timeline_slice'
```

---

### Step 2: Frame Timeline 分析 (Android 12+)

**核心概念：**
- `expected_frame_timeline_slice`: 预期的帧时间（VSYNC 间隔）
- `actual_frame_timeline_slice`: 实际的帧时间
- `jank_type`: 系统识别的 Jank 类型

**Jank 类型说明：**

| jank_type | 说明 | 常见原因 |
|-----------|------|---------|
| `App Deadline Missed` | 应用未在 deadline 前完成 | 主线程阻塞 |
| `SurfaceFlinger Deadline Missed` | SF 未及时合成 | GPU 繁忙 |
| `Buffer Stuffing` | Buffer 队列满 | 渲染积压 |
| `Display HAL` | 显示硬件问题 | 硬件层问题 |
| `Prediction Error` | 预测错误 | 系统调度 |

**SQL 查询：**
```sql
SELECT
  afs.dur / 1e6 as actual_dur_ms,
  efs.dur / 1e6 as expected_dur_ms,
  afs.jank_type,
  afs.on_time_finish
FROM expected_frame_timeline_slice efs
JOIN actual_frame_timeline_slice afs
  ON efs.upid = afs.upid
  AND efs.display_frame_token = afs.display_frame_token
WHERE efs.upid IN (SELECT upid FROM process WHERE ('${package}' = '' OR name = '${package}' OR name GLOB '${package}:*'))
```

---

### Step 3: Choreographer 分析 (传统方法)

**查找 doFrame：**
```sql
SELECT
  s.ts / 1e6 as ts_ms,
  s.dur / 1e6 as dur_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE ('${package}' = '' OR p.name = '${package}' OR p.name GLOB '${package}:*')
  AND t.tid = p.pid
  AND s.name GLOB '*Choreographer#doFrame*'
ORDER BY s.ts ASC
```

**判断标准：**
| 帧时间 | 状态 | 说明 |
|--------|------|------|
| ≤ 1 × 当前周期 | deadline 内 | 不能仅凭时长判断用户可见结果 |
| 1–2 × 当前周期 | 候选 Jank | 用 FrameTimeline / present 证据确认 |
| 2–3 × 当前周期 | 候选严重 Jank | 核对 App、SF、GPU 和 display 阶段 |
| > 3 × 当前周期 | 长帧候选 | 同时检查空闲、低帧率内容、VRR/ARR 与采集缺口 |

---

### Step 4: UI 线程阻塞分析

**目的：** 找出主线程上的耗时操作

```sql
SELECT
  s.name as blocking_operation,
  s.dur / 1e6 as dur_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE ('${package}' = '' OR p.name = '${package}' OR p.name GLOB '${package}:*')
  AND t.tid = p.pid
  AND s.dur > ${vsync_period_ns}
  AND s.name NOT GLOB '*Choreographer*'
ORDER BY s.dur DESC
```

**常见阻塞原因：**
1. **IO 操作** - 文件读写、数据库查询
2. **网络请求** - 同步 HTTP 请求
3. **锁等待** - synchronized、ReentrantLock
4. **Binder 调用** - 系统服务调用
5. **GC** - 垃圾回收暂停

---

### Step 5: RenderThread 分析

```sql
SELECT
  s.name as operation,
  AVG(s.dur) / 1e6 as avg_dur_ms,
  MAX(s.dur) / 1e6 as max_dur_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE ('${package}' = '' OR p.name = '${package}' OR p.name GLOB '${package}:*')
  AND t.name = 'RenderThread'
GROUP BY s.name
ORDER BY avg_dur_ms DESC
```

**关键操作：**
| 操作 | 说明 | 优化方向 |
|------|------|---------|
| `DrawFrame` | 执行绘制命令 | 减少过度绘制 |
| `syncFrameState` | 同步帧状态 | 减少 View 数量 |
| `dequeueBuffer` | 获取缓冲区 | GPU 资源竞争 |
| `queueBuffer` | 提交缓冲区 | 渲染管线效率 |

---

### Step 6: RecyclerView 分析

```sql
SELECT
  s.name as operation,
  COUNT(*) as count,
  AVG(s.dur) / 1e6 as avg_dur_ms
FROM slice s
WHERE s.name GLOB '*RecyclerView*'
   OR s.name GLOB '*onCreateViewHolder*'
   OR s.name GLOB '*onBindViewHolder*'
GROUP BY s.name
```

**优化建议：**

| 问题 | 阈值 | 建议 |
|------|------|------|
| onCreateViewHolder 慢 | > 10ms | 简化布局 |
| onBindViewHolder 慢 | > 5ms | 避免耗时计算 |
| 频繁创建 ViewHolder | - | 增加缓存池 |

---

## 3. 判断标准

### 3.1 帧率标准

| 屏幕刷新率 | 帧时间预算 | 优秀 | 良好 | 需优化 |
|-----------|-----------|------|------|--------|
| 60Hz | 16.67ms | < 12ms | 12-16ms | > 16ms |
| 90Hz | 11.11ms | < 8ms | 8-11ms | > 11ms |
| 120Hz | 8.33ms | < 6ms | 6-8ms | > 8ms |

### 3.2 Jank 率标准

| Jank 率 | 评价 | 用户感知 |
|---------|------|---------|
| < 1% | 优秀 | 非常流畅 |
| 1-5% | 良好 | 偶尔卡顿 |
| 5-10% | 需优化 | 明显卡顿 |
| > 10% | 严重 | 频繁卡顿 |

---

## 4. 常见问题及优化

### 4.1 主线程阻塞

**症状：** doFrame 耗时 > 16ms，大部分时间在主线程
**排查：**
1. 检查是否有 IO 操作
2. 检查 Binder 调用
3. 检查 GC 频率

**优化：**
```kotlin
// 将耗时操作移到后台
lifecycleScope.launch(Dispatchers.IO) {
    val data = loadData()
    withContext(Dispatchers.Main) {
        updateUI(data)
    }
}
```

### 4.2 过度绘制

**症状：** RenderThread DrawFrame 耗时长
**排查：** 开启 GPU 过度绘制调试
**优化：**
1. 移除不必要的背景
2. 使用 `clipRect()` 裁剪
3. 减少透明度使用

### 4.3 RecyclerView 卡顿

**症状：** onBindViewHolder 或 onCreateViewHolder 耗时
**优化：**
```kotlin
// 使用 DiffUtil
val diffCallback = object : DiffUtil.Callback() { ... }
val diffResult = DiffUtil.calculateDiff(diffCallback)
diffResult.dispatchUpdatesTo(adapter)

// 预计算
adapter.setHasStableIds(true)
recyclerView.setItemViewCacheSize(20)
```

### 4.4 布局性能差

**症状：** measure/layout 耗时 > 5ms
**优化：**
1. 减少嵌套层级
2. 使用 `ConstraintLayout`
3. 避免 `WRAP_CONTENT` 在 RecyclerView 中

---

## 5. 厂商特殊处理

### 5.1 高刷屏设备
- 120Hz 设备帧时间预算仅 8.33ms
- 需要更严格的阈值

### 5.2 可变刷新率 (VRR)
- 部分设备支持动态刷新率
- 需要关注 VSYNC 间隔变化

---

## 6. 检查清单

### 分析检查项
- [ ] 确定屏幕刷新率
- [ ] 计算总帧数和 Jank 帧数
- [ ] 分析 Jank 类型分布
- [ ] 检查 UI 线程阻塞
- [ ] 分析 RenderThread 性能
- [ ] 检查 RecyclerView (如适用)

### 优化检查项
- [ ] 主线程无 IO 操作
- [ ] Binder 调用已优化
- [ ] 布局层级 < 5 层
- [ ] 无过度绘制
- [ ] RecyclerView 使用正确

---

## 7. 参考资料

1. [Android 渲染性能](https://developer.android.com/topic/performance/rendering)
2. [Perfetto Frame Timeline](https://perfetto.dev/docs/data-sources/frametimeline)
3. [RecyclerView 优化](https://developer.android.com/topic/performance/vitals/render)

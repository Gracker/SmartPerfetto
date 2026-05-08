# 应用启动分析 SOP (Standard Operating Procedure)

> 版本: 1.0.0 | 最后更新: 2024-12 | 作者: SmartPerfetto Team

## 1. 概述

### 1.1 目标
分析 Android 应用的启动性能，识别性能瓶颈，提供优化建议。

### 1.2 适用场景
- 冷启动 (Cold Start): 应用进程不存在，需要完整启动
- 温启动 (Warm Start): 进程存在但 Activity 被销毁
- 热启动 (Hot Start): 进程和 Activity 都存在，只需恢复

### 1.4 启动类型判定规则 (Perfetto 信号)

Perfetto `android_startups` 表的 `startup_type` 可能不准确，需基于 trace slice 信号重分类：

| 类型 | 判定信号 | Android 框架路径 |
|------|---------|-----------------|
| 冷启动 (cold) | `bindApplication` slice 存在 | Zygote fork → handleBindApplication() |
| 温启动 (warm) | `performCreate:*` 存在且**无** `bindApplication` | Activity.onCreate()（跳过 App 初始化）|
| 热启动 (hot) | 两者均不存在 → 保留 Perfetto 原始分类 | Activity.onRestart() → onResume() |

**⚠️ LMK 误分类：** 进程被 LMK 回收后重启，Perfetto 可能报 warm（ActivityManager 仍持有 Activity 记录），但 `bindApplication` 存在说明进程经历了完整初始化，实为 cold start。`startup_events_in_range` skill 的 SQL 层已实现此重分类逻辑。

### 1.3 启动阶段概览

```
┌──────────────────────────────────────────────────────────────────┐
│                        应用冷启动时间线                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  fork     bind        Application   Activity    First           │
│  进程  → Application → onCreate  →  onCreate → Frame           │
│                                                                  │
│  ◀─────────────────── 冷启动总时间 ─────────────────────────────▶ │
│                                                                  │
│  │←────────→│←────────→│←─────────→│←─────────→│                 │
│   进程创建    绑定应用    App 初始化   Activity    首帧渲染       │
│   ~50ms      ~20ms      变化较大     ~100ms     ~16ms            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 分析步骤

### Step 1: 获取启动事件

**目的**: 从 Trace 中识别所有启动事件及其时间范围

**SQL 查询**:
```sql
SELECT
  startup_id,
  ts,
  ts + dur as ts_end,
  dur / 1e6 as dur_ms,
  package,
  startup_type
FROM android_startups
WHERE package GLOB '${package}*'
ORDER BY ts ASC
```

**关键字段**:
| 字段 | 说明 |
|------|------|
| `ts` | 启动开始时间 (纳秒) |
| `ts_end` | 启动结束时间 (纳秒) |
| `dur_ms` | 启动耗时 (毫秒) |
| `startup_type` | 启动类型 (cold/warm/hot) |

**注意事项**:
- 一个 Trace 可能包含多个启动事件
- 每个启动事件需要独立分析
- 后续所有查询都需限制在 `ts` 到 `ts_end` 范围内

---

### Step 2: 分析关键启动阶段

**目的**: 分解启动过程中的关键阶段耗时

**关键阶段**:
| 阶段 | Slice 名称 | 说明 |
|------|-----------|------|
| 进程创建 | N/A (系统层) | fork 进程的时间 |
| bindApplication | `*bindApplication*` | 绑定 Application |
| Application.onCreate | `*Application.onCreate*` | Application 初始化 |
| ContentProvider | `*contentProviderCreate*` | ContentProvider 初始化 |
| Activity.onCreate | `*performCreate*`, `*onCreate*` | Activity 创建 |
| Activity.onResume | `*performResume*`, `*onResume*` | Activity 恢复 |
| 首帧渲染 | `*Choreographer#doFrame*` | 第一帧渲染 |
| 完全绘制 | `*reportFullyDrawn*` | 应用报告完全绘制 |

**SQL 查询**:
```sql
SELECT
  s.name as phase_name,
  s.dur / 1e6 as dur_ms,
  (s.ts - ${startup.ts}) / 1e6 as relative_start_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '${package}*'
  AND t.name = 'main'
  AND s.ts >= ${startup.ts} AND s.ts <= ${startup.ts_end}
  AND (s.name GLOB '*bindApplication*'
       OR s.name GLOB '*Application.onCreate*'
       OR s.name GLOB '*contentProviderCreate*'
       OR s.name GLOB '*performCreate*'
       OR s.name GLOB '*performResume*'
       OR s.name GLOB '*Choreographer#doFrame*')
ORDER BY s.ts ASC
```

---

### Step 3: 分析主线程状态分布

**目的**: 了解主线程在启动期间的状态分布

**线程状态说明**:
| 状态 | 含义 | 正常占比 |
|------|------|---------|
| Running | CPU 上执行 | 越高越好 |
| Runnable (R/R+) | 等待 CPU 调度 | <10% |
| Sleeping (S) | 主动睡眠 | 越低越好 |
| Disk Sleep (D) | 等待 IO | 应该 <5% |

**理想分布**:
- Running: >80%
- Runnable: <10%
- Sleeping: <10%
- Disk Sleep: <5%

**SQL 查询**:
```sql
SELECT
  state,
  SUM(dur) / 1e6 as total_dur_ms,
  (SUM(dur) * 100.0) / ${startup.dur} as percent
FROM thread_state
WHERE utid = ${main_thread.utid}
  AND ts >= ${startup.ts} AND ts <= ${startup.ts_end}
GROUP BY state
ORDER BY total_dur_ms DESC
```

---

### Step 4: 分析 CPU 大小核分布

**目的**: 检查主线程是否在大核上运行

**核心类型**:
- **大核 (Big Core)**: 通常是 CPU 4-7，性能更强
- **小核 (Little Core)**: 通常是 CPU 0-3，功耗更低

**为什么重要**:
- 启动期间应尽量在大核运行，提升启动速度
- 如果主要在小核运行，可能是系统调度问题

**判断标准**:
| 大核占比 | 评价 | 可能原因 |
|----------|------|---------|
| >70% | 优秀 | 系统调度正常 |
| 50-70% | 良好 | 可接受 |
| 30-50% | 需关注 | 可能有调度问题 |
| <30% | 严重 | 功耗策略或调度异常 |

**SQL 查询**:
```sql
SELECT
  ss.cpu,
  COALESCE(ct.core_type, 'unknown') as core_type,
  SUM(dur) / 1e6 as total_dur_ms
FROM sched_slice ss
LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
WHERE ss.utid = ${main_thread.utid}
  AND ss.ts >= ${startup.ts} AND ss.ts <= ${startup.ts_end}
GROUP BY ss.cpu, core_type
ORDER BY total_dur_ms DESC
```

---

### Step 5: 分析主线程阻塞

**目的**: 找出主线程被阻塞的原因

**阻塞类型**:
| 类型 | 特征函数 | 说明 |
|------|---------|------|
| Binder | `*binder*` | 跨进程调用等待 |
| Lock | `*futex*`, `*mutex*` | 锁竞争 |
| IO | `*epoll*`, `*poll*` | 网络/文件 IO |
| Sleep | `*sleep*` | 主动睡眠 |
| SurfaceFlinger | `*SurfaceFlinger*`, `*dequeue*` | 等待 SF |
| GC | `*GC*`, `*art::gc*` | 垃圾回收 |

**SQL 查询**:
```sql
SELECT
  blocked_function,
  dur / 1e6 as dur_ms,
  CASE
    WHEN blocked_function GLOB '*binder*' THEN 'binder'
    WHEN blocked_function GLOB '*futex*' THEN 'lock'
    -- ... 其他类型
  END as block_type
FROM thread_state
WHERE utid = ${main_thread.utid}
  AND state IN ('S', 'D')
  AND dur > 1000000  -- > 1ms
  AND ts >= ${startup.ts} AND ts <= ${startup.ts_end}
ORDER BY dur DESC
LIMIT 20
```

---

### Step 6: 分析 Binder 调用

**目的**: 识别耗时的跨进程调用

**为什么重要**:
- Binder 调用会阻塞主线程
- 启动期间应减少不必要的 Binder 调用

**SQL 查询**:
```sql
SELECT
  client_process,
  server_process,
  client_dur / 1e6 as dur_ms
FROM android_binder_txns
WHERE (client_process GLOB '${package}*' OR server_process GLOB '${package}*')
  AND client_ts >= ${startup.ts} AND client_ts <= ${startup.ts_end}
  AND client_dur > 1000000  -- > 1ms
ORDER BY client_dur DESC
LIMIT 10
```

---

### Step 7: 分析 GC 事件

**目的**: 检查 GC 对启动的影响

**判断标准**:
| GC 占比 | 评价 |
|---------|------|
| <2% | 优秀 |
| 2-5% | 良好 |
| 5-10% | 需优化 |
| >10% | 严重 |

---

## 3. 判断标准

### 3.1 启动时间标准

| 启动类型 | 优秀 | 良好 | 需优化 | 严重 |
|----------|------|------|--------|------|
| 冷启动 | <500ms | 500-1000ms | 1-2s | >2s |
| 温启动 | <200ms | 200-500ms | 500-1000ms | >1s |
| 热启动 | <100ms | 100-200ms | 200-500ms | >500ms |

### 3.2 各阶段参考耗时

| 阶段 | 理想值 | 警告值 |
|------|--------|--------|
| bindApplication | <100ms | >200ms |
| Application.onCreate | <200ms | >500ms |
| Activity.onCreate | <100ms | >200ms |
| 首帧渲染 | <16ms | >32ms |

---

## 4. 常见问题及优化建议

### 4.1 Application.onCreate 耗时过长

**可能原因**:
1. 初始化了太多第三方 SDK
2. 同步执行了网络请求
3. 数据库初始化

**优化建议**:
1. 使用 App Startup 库延迟初始化
2. 将非必要初始化移到后台线程
3. 使用懒加载模式

### 4.2 ContentProvider 初始化慢

**可能原因**:
1. ContentProvider 过多
2. ContentProvider 中有耗时操作

**优化建议**:
1. 减少 ContentProvider 数量
2. 延迟 ContentProvider 中的耗时操作

### 4.3 大核占比过低

**可能原因**:
1. 系统功耗策略限制
2. 调度器配置问题
3. 前台应用识别问题

**优化建议**:
1. 检查系统调度配置
2. 联系系统工程师调整策略

### 4.4 Binder 调用过多

**可能原因**:
1. 启动时查询过多系统服务
2. 没有缓存 Binder 调用结果

**优化建议**:
1. 合并多次 Binder 调用
2. 缓存不变的 Binder 结果
3. 延迟非必要的 Binder 调用

---

## 5. 厂商特殊处理

### 5.1 OPPO (ColorOS)
- 检查 `ColorOS*`, `HyperBoost*` 相关 Slice
- 注意 ColorOS 加速引擎的影响

### 5.2 vivo (OriginOS)
- 检查 `OriginOS*`, `Jovi*` 相关 Slice
- 注意智能冻结机制

### 5.3 小米 (MIUI)
- 检查 `MIUI*`, `Boost*` 相关 Slice
- 注意 MIUI 优化的影响

### 5.4 Honor (MagicOS)
- 检查 `MagicOS*`, `TurboX*` 相关 Slice
- 注意 GPU Turbo 的影响

---

## 6. 检查清单

### 启动分析检查项

- [ ] 获取启动事件的精确时间范围
- [ ] 分析关键阶段耗时
- [ ] 检查主线程状态分布
- [ ] 检查 CPU 大小核分布
- [ ] 分析主线程阻塞原因
- [ ] 检查 Binder 调用
- [ ] 检查 GC 影响
- [ ] 检查厂商特殊 Slice

### 优化检查项

- [ ] Application.onCreate 是否有优化空间
- [ ] ContentProvider 是否可以延迟初始化
- [ ] Binder 调用是否可以减少/合并
- [ ] 是否有不必要的同步操作
- [ ] 内存分配是否可以优化

---

## 7. 参考资料

1. [Android 官方启动优化文档](https://developer.android.com/topic/performance/vitals/launch-time)
2. [Perfetto 启动指标](https://perfetto.dev/docs/analysis/metrics#android-startup)
3. [App Startup 库](https://developer.android.com/topic/libraries/app-startup)
4. [响应性分析实战](https://www.androidperformance.com/2021/09/13/android-systrace-Responsiveness-in-action-1/)

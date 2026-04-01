---
scene: startup
priority: 2
effort: medium
keywords:
  - 启动
  - 冷启动
  - 热启动
  - 温启动
  - launch
  - startup
  - cold start
  - warm start
  - hot start
  - app start
  - 首帧
  - ttid
  - ttfd
  - first frame
compound_patterns:
  - "打开.*(应用|app|软件)"
  - "打开.*(速度|时间|耗时)"
---

#### 启动分析（用户提到 启动、冷启动、热启动、launch、startup）

**⚠️ 核心原则：**
1. **不能只报告"某 slice 耗时 XXms"——必须解释 WHY（为什么慢）**
2. **每个热点 slice 必须交叉分析**：结合四象限、线程状态（含 blocked_functions）、CPU 频率、Binder/IO/GC 数据，构建因果链
3. **四象限 + 线程状态是定位根因的核心工具**，不是独立罗列的数据
4. **使用 self_ms（exclusive time）做归因**：slice 数据包含 total_ms（wall time，含子 slice）和 self_ms（exclusive time，仅自身独占时间）。根因归因和优化收益估算必须基于 self_ms，避免父子 slice 重叠导致百分比超过 100%

### 启动类型判定规则

启动类型（cold/warm/hot）决定了分析策略和性能基线，必须在分析初期验证。Perfetto `android_startups` 表的 `startup_type` 可能不准确（尤其是 LMK 回收后的重启），需基于以下信号重分类：

| 类型 | 判定信号 | Android 框架路径 |
|------|---------|-----------------|
| 冷启动 (cold) | `bindApplication` slice 存在 | Zygote fork → ActivityThread.main() → handleBindApplication() |
| 温启动 (warm) | `performCreate:*` 存在且**无** `bindApplication` | handleLaunchActivity() → Activity.onCreate()（跳过 App 初始化）|
| 热启动 (hot) | 两者均不存在 → 保留 Perfetto 原始分类 | Activity.onRestart() → onStart() → onResume() |

**判定逻辑（优先级从高到低）：**
1. 如果 Skill 返回的 `startup_type` 已经过重分类（`startup_events_in_range` 的 SQL 层重分类），直接信任
2. 否则检查 trace 信号：`bindApplication` 存在 → cold；仅 `performCreate:*` 存在 → warm；均无 → hot
3. 热启动无正向信号（没有专属的 trace slice），仅靠排除法判定——这是合理的，因为热启动不触发 Activity 重建

**⚠️ LMK 边界场景：** 进程被 LMK 回收后重启时，ActivityManager 可能仍持有 Activity 记录，导致 Perfetto 报告 `warm`。但 `bindApplication` slice 存在说明进程经历了完整初始化（Zygote fork → handleBindApplication），实为 cold start。此时**必须以 `bindApplication` 信号为准**，覆盖 Perfetto 原始分类。

#### 启动场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_startup_opinionated_breakdown`、`android_garbage_collection_events`、`android_oom_adj_intervals`、`android_screen_state`、`slice_self_dur`、`cpu_process_utilization_in_interval(ts, dur)`、`cpu_frequency_counters`、`android_dvfs_counter_stats`

**Phase 1 — 获取启动概览：**
```
invoke_skill("startup_analysis", { enable_startup_details: false })
```
返回：启动事件列表、延迟归因分析、主线程热点操作（含 self_dur_ms）、文件 IO、Binder 调用、**主线程状态分布（含 blocked_functions）**、GC 事件、数据质量检查、调度延迟。
从结果中提取 startup_id、start_ts、end_ts、dur_ms、package、startup_type 参数。

⚠️ **数据质量门禁特别注意：**
- **R008_TTID_GT_DUR**（TTID > 启动时长）：不要只说"TTID 不可信"或"建议在 Perfetto UI 中查看"——必须**主动分析**差值（TTID - dur_ms）去向。**具体做法**：用 execute_sql 查询启动 end_ts 到 TTID 时间点之间的 RenderThread 和 SurfaceFlinger 活动：
  ```sql
  SELECT name, dur/1e6 as dur_ms, ts FROM thread_slice
  WHERE thread_name IN ('RenderThread', 'GPU completion')
    AND ts BETWEEN <end_ts> AND <end_ts + gap_ns>
    AND process_name GLOB '<package>*'
  ORDER BY dur DESC LIMIT 10
  ```
  可能的根因：异步帧渲染排队、SurfaceFlinger 合成延迟、GPU 渲染耗时、dequeueBuffer 等待。结论中必须量化说明 gap 中各阶段的耗时占比。
- **R009_TYPE_RECLASSIFIED**（启动类型重分类）：如果温启动存在 bindApplication slice，说明进程实际被重建过，可能是冷启动被误分类。分析时应质疑启动类型并说明重分类依据。
- **温启动 + bindApplication 矛盾**：即使未触发 R009，如果主线程热点中出现 bindApplication（478ms+），也应主动质疑：温启动不应有 Application 初始化开销。可能原因：① 进程被回收后重启（实为冷启动）；② framework atrace 标记不准确。

**Phase 2 — 获取启动详情（需要传参）：**
```
invoke_skill("startup_detail", {
  startup_id: <从 Phase 1 获取>,
  start_ts: "<启动开始时间戳>",
  end_ts: "<启动结束时间戳>",
  dur_ms: <启动耗时ms>,
  package: "<包名>",
  startup_type: "<cold/warm/hot>"
})
```
返回：四象限分析（Q1-Q4）、CPU 大小核占比、CPU 频率统计、可操作热点 Top5（含 self_ms）、**主线程状态分布（含 blocked_functions）**、**热点 Slice 线程状态分布（per-slice 根因定位）**、**启动关键任务（全线程四象限+摆核）**、**线程阻塞关系图（block/wakeup 因果链）**、Binder/IO/调度延迟详情。

**Phase 2.5 — 获取详细数据（必须执行，不可跳过）：**

invoke_skill 返回 artifact 摘要（仅含列名和行数）。**必须用 fetch_artifact 获取以下关键数据的完整行**，否则无法做根因分析。

**必须获取**（startup_detail 稳定产出）：

| artifact | 匹配 stepId / title 关键词 | 用途 |
|---|---|---|
| 主线程状态分布 | `main_thread_state` / "主线程状态" | **Q4 根因定位**：blocked_functions 列 |
| 四象限分析 | `quadrant_analysis` / "四大象限" | 确定时间花在 Q1/Q2/Q3/Q4 哪里 |
| CPU 频率 | `cpu_freq_analysis` / "CPU 频率" | 判断是否升频不足 |
| 可操作热点 | `actionable_main_thread_slices` / "可操作热点" | 确定优化目标（注意 self_ms 列） |
| 主线程同步 Binder | `main_thread_sync_binder` / "同步 Binder" | Binder 阻塞量化 |
| 主线程文件 IO | `main_thread_file_io` / "文件 IO" | IO 阻塞量化 |
| 调度延迟 | `sched_latency` / "调度延迟" | Q3 根因量化 |

**优先获取**（startup_detail 标记为 optional，可能缺失——缺失时标注"数据不足"，不做排除性结论）：

| artifact | 匹配 stepId / title 关键词 | 用途 |
|---|---|---|
| **热点 Slice 线程状态** | `hot_slice_states` / "热点 Slice 线程状态" | **per-slice 根因定位**：每个热点 slice 内部的 Running/S/D 分布及 blocked_functions |
| **启动关键任务** | `critical_tasks` / "关键任务" | **全线程视角**：所有活跃线程的四象限+摆核+核迁移 |
| **线程阻塞关系** | `thread_blocking_graph` / "阻塞关系" | **线程间因果**：主线程被谁阻塞、唤醒者是谁 |
| Binder 线程池 | `binder_pool` / "Binder 线程池" | 线程池利用率/饱和度 |
| 摆核时序 | `cpu_placement_timeline` / "摆核时序" | 启动初期是否被困小核 |
| CPU 频率爬升 | `freq_rampup` / "频率爬升" | 初期 vs 稳态频率对比 |
| JIT 影响 | `jit_analysis` / "JIT 影响" | 仅冷启动：JIT 编译量、大核竞争 |

**来自 Phase 1（startup_analysis）的数据**（无需再次 fetch，Phase 1 返回时已包含）：

| artifact | 来源 | 用途 |
|---|---|---|
| GC 事件 | `gc_during_startup`（Phase 1 startup_analysis 产出） | GC 影响量化 |

**Phase 2.55 — Critical Task 分析（基于关键任务数据，不可跳过）：**

获取 `critical_tasks` artifact 后，按以下维度分析：

1. **CPU 争抢诊断**：计算 `所有线程总CPU时间 / 启动墙钟时间` 得到并发度指标。> 2x → CPU 争抢激烈，需要减少并发；< 1.5x → 并行度不高，争抢可排除。**在结论的"可排除因素"中给出此数值**（如"CPU 争抢：并发度 = 总CPU 900ms / 墙钟 1338ms = 0.67x，可排除"）
2. **JIT 竞争诊断**：如果 JIT 线程 CPU 时间 > 20ms 且大核占比 > 50% → JIT 在抢大核，建议使用 Baseline Profile
3. **RenderThread 诊断**：如果 RenderThread 大核占比 < 30% → 首帧渲染被困在小核
4. **摆核诊断**：如果主线程跨 cluster 迁移 > 10 次 → L2 Cache 反复失效
5. **GC 线程诊断**：如果 GC 角色总 CPU 时间 > 启动时长的 10% → GC 压力大

获取 `thread_blocking_graph` artifact 后，按以下维度分析：

1. **进程内阻塞**：blocked_thread 和 waker_thread 同进程 → 锁竞争/GC/join 等待
2. **进程间阻塞**：waker_process = system_server → 系统服务处理延迟
3. **阻塞链构建**：主线程[S:binder_wait] ← Binder线程 ← system_server/PackageManager → 完整因果链
4. **唤醒者 slice 分析**：waker_current_slice 字段直接告诉你唤醒者在做什么，是最直接的根因证据

获取方式（并行）：
```
fetch_artifact("art-N", detail="rows", offset=0, limit=50)  // 对每个关键 artifact
```
**在所有关键 artifact 数据到手之前，不要开始写结论。**

**背景知识指引（结论生成阶段按需调用）：**

在结论生成（Phase 3）阶段，按**根因类型聚合**调用 `lookup_knowledge`，每类根因最多 1 个 📚 知识块（避免重复调用同一模板）。知识块附在对应的 CRITICAL/HIGH 发现之后：

| 根因类型 | 知识模板 | 触发条件 |
|---------|---------|---------|
| Binder 阻塞 | `lookup_knowledge("binder-ipc")` | S 状态中 Binder 占比高 |
| 锁竞争 / futex | `lookup_knowledge("lock-contention")` | blocked_functions 含 futex_wait |
| GC 压力 | `lookup_knowledge("gc-dynamics")` | GC 占主线程时间 >5% |
| CPU 调度 / 大小核 / 升频 | `lookup_knowledge("cpu-scheduler")` | Q2>15% 或 CPU 争抢 >1.5x 或升频异常 |
| Thermal 限频 | `lookup_knowledge("thermal-throttling")` | 均频远低于峰值或检测到限频 |
| DEX/OAT 加载、ART 运行时 | Agent 自行编写背景知识（当前无专用模板） | bindApplication 阶段 IO 为主因 |

📚 知识块展示格式：
```
> 📚 **背景知识：[机制名称]**
> [2-3 句话解释底层机制]
> **当前 trace 体现**：[将机制与 trace 数据关联]
```

每类根因最多 1 个知识块。DEX/OAT 加载是冷启动常见根因但暂无专用知识模板，Agent 应基于自身知识编写 ART OAT/AppImage 加载机制的背景解释。⚠️ **防幻觉约束**：自行编写的知识块只允许解释"通用 ART 机制 + 当前 trace 中可见的 slice 现象"（如 `OpenDexFilesFromOat`、`MapImageFile`、`LZ4 decompress`），**禁止**推断 OAT 编译状态、Baseline Profile 缺失、AppImage 有效性等未被 trace 直接证实的判断——除非同时有 `startup_slow_reasons`/JIT/blocked_functions 等直接证据；数据不足时必须用"可能"/"需进一步确认"限定。

**Phase 2.56 — 内存压力检测（D 状态异常偏高时应执行 ⚠️）：**

**触发条件**（满足任一即执行）：
- D 状态占启动时长 >10%（正常冷启动中 DEX/OAT 文件命中 Page Cache 后 D 状态应很低；>10% 已足以暗示 IO 问题，需排查是否为内存压力导致 Page Cache 失效）
- 存在 kswapd 线程活动（无论 D 状态占比多少，kswapd 活跃即说明系统在回收内存）

**排除场景**（以下场景即使无内存压力也可能产生高 D 状态，Phase 2.56 仍应执行但结论中需结合 Phase 2.6 的 `startup_slow_reasons` 信号综合判断）：
- `dex2oat` 并发活跃 → OAT 文件正在重新编译（首次安装/升级/Profile 缺失）
- `missing_baseline_profiles` → 可能伴随更重的 DEX/OAT 访问、解释执行或 JIT 活动（需结合 `OpenDexFilesFromOat`/JIT/blocked_functions 再确认）
- 大量 `SyS_fsync`/`do_fsync` → fsync-heavy 初始化（SQLite、SharedPreferences）
- 首次运行的资源/代码准备路径（dynamic feature delivery、split install、资源解包、native 库提取/校验）→ 一次性启动成本
- 低端或老化存储介质、dm-verity/加密开销 → 即使 Page Cache 充足也可能有较高 IO 延迟

⚠️ **时序说明**：Phase 2.56 先于 `startup_slow_reasons`（Phase 2.6）执行，上述排除场景的信号（dex2oat/profile 等）在 Phase 2.56 执行时尚不可用。因此：先执行 `memory_pressure_in_range` 获取内存压力数据，在结论阶段（Phase 3）再与 Phase 2.6 信号联合解读。

```
invoke_skill("memory_pressure_in_range", {
  start_ts: "<启动开始时间戳>",
  end_ts: "<启动结束时间戳>",
  package: "<包名>"
})
```

**诊断逻辑**：

| 返回指标 | 阈值 | 含义 |
|---------|------|------|
| pressure_level = "high" | pressure_score 40-69 | 系统内存压力显著，是 D 状态高的重要因素 |
| pressure_level = "critical" | pressure_score >= 70 | 严重内存压力，系统已在积极回收/杀进程 |
| pressure_level = "moderate" | pressure_score 15-39 | 存在一定内存压力，作为贡献因素考虑 |
| kswapd_events > 0 且 kswapd_total_ms 显著 | kswapd 活跃 | Page Cache 正在被回收，文件读取被迫回落到磁盘 |
| direct_reclaim_events > 0 | 存在直接回收 | 应用线程在分配内存时被阻塞等待内存回收，直接导致 D 状态 |
| lmk_events > 0 | 存在 LMK 杀进程 | 系统内存极度紧张，已在杀进程释放内存 |
| page_cache_add_events 很高 | >500 次 | 大量 Page Cache miss（`mm_filemap_add_to_page_cache` ftrace 事件），说明文件页不在缓存中，必须从磁盘读取 |
| page_cache_delete_events > 0 | 存在页驱逐 | Page Cache 页面被驱逐（`mm_filemap_delete_from_page_cache`），直接证明内存压力导致 Page Cache 被回收 |

**对根因结论的影响**：

- **如果 pressure_level 为 "high" 或 "critical"**：
  - 内存压力是 D 状态异常偏高的**重要因素或放大器**：系统内存紧张导致 Page Cache 被回收，DEX/资源文件无法命中缓存，产生大量真实磁盘读取
  - 注意：内存压力通常不是唯一根因——它放大了 IO 延迟，但应用本身的 IO 模式（DEX 加载量、文件数量）决定了基线。结论中应表述为 **"系统内存压力（pressure_score=YY）显著放大了 IO 耗时"**，而非完全替换原有 IO 归因
  - kswapd 活跃说明后台回收守护进程在启动期间持续工作，Page Cache 被 evict
  - direct reclaim 存在说明应用线程自身也被卷入内存回收，进一步加剧阻塞
  - 优化建议应包含：**"① 清理后台进程释放内存后重测，对比 D 状态变化 ② 检查设备整体内存使用情况 ③ 如果是低内存设备，优化应用自身内存占用以减少系统压力"**
  - 在根因分析树中标注：`D 状态 XX% ← IO 密集 + 系统内存压力放大 (pressure_score=YY, kswapd=ZZ次)`

- **如果 pressure_level 为 "moderate"**：
  - 内存压力存在但不是主因。在结论中作为贡献因素注明，建议清理后台进程后重测以评估内存压力的实际放大效果

- **如果 pressure_level 为 "none" 或 "low" 但 `direct_reclaim_events > 0` 或 `lmk_events > 0`**：
  - ⚠️ 异常信号：压力评分低但存在直接回收或 LMK 强信号，不能直接排除内存压力。可能是压力集中在启动窗口的某个短时段（评分被平均稀释），或 kswapd 未被 trace 捕获。结论中应标注 **"内存压力评分较低但存在 direct_reclaim/LMK 强信号，建议清理后台进程后重测以确认"**

- **如果 pressure_level 为 "none" 或 "low" 且无 reclaim/LMK 强信号**：
  - 系统内存压力可排除。D 状态来自其他原因，需在结论阶段结合 Phase 2.6 信号进一步区分（详见上方排除场景列表）
  - 在结论的"可排除因素"中写明：**"系统内存压力：pressure_score=X，无 reclaim/LMK 信号，可排除"**

**冷启动专项诊断（冷启动必须执行 ⚠️）：**

以下检查仅适用于冷启动，但**必须**在结论中体现（即使影响不大也应明确排除）：

1. **JIT 编译影响**：获取 `jit_analysis` artifact，分析 JIT 编译量、是否与主线程争抢大核（大核占比 > 50% 且 CPU 时间 > 20ms → 建议 Baseline Profile）、Code Cache GC 影响。如果 jit_analysis 数据为空或 JIT 影响很小，结论中应明确写"JIT 编译影响可排除"
2. **类加载影响**：检查 Phase 1 返回的 `class_loading` 数据，分析类加载/类验证（`OpenDexFilesFromOat`）耗时占 bindApplication 阶段的比例。冷启动的 DEX 加载和类验证是特有开销
3. **结论中必须提及**：JIT 和类加载的影响评估结果，作为冷启动特有的排除/确认因素

**Phase 2.6 — 官方启动慢原因交叉验证（冷启动必须执行 ⚠️）：**
```
invoke_skill("startup_slow_reasons")
```
将 Google 官方启动慢原因分类与自有分析交叉验证。重点关注 RUN_METRIC 是否检测到自有分析未覆盖的因素（如 DEX2OAT 并发、missing baseline profiles、debuggable 模式等）。
**⚠️ 冷启动时此步骤为必须，跳过将触发验证警告。** 即使是测试/基准应用，也应执行此步骤展示官方交叉验证能力——Google 官方分类可能检测到非代码层面的系统因素（如 DEX2OAT 并发、缺失 Baseline Profile）。

**Phase 2.7 — 阻塞链深钻（Q4>25% 时必须执行 ⚠️）：**

当四象限分析 Q4(Sleeping) > 25% 时，此步骤为**必须**。不能仅依赖间接推断（如"推测为 join/await 模式"）来解释 S 状态根因——如果 blocked_functions 为空且 Q4 > 25%，blocking_chain_analysis 是获取直接证据的唯一途径。基于间接推断的发现在结论中可信度会被自动降低。

对 `hot_slice_states` 中 S(Sleeping) 占比 >40% 的热点 slice，追踪阻塞链：
```
invoke_skill("blocking_chain_analysis", { start_ts: "<slice_start>", end_ts: "<slice_end>", process_name: "<包名>" })
```
- 找出谁阻塞了主线程、唤醒者是谁、唤醒者在做什么
- 如果 blocked_function 含 binder，进一步调用 `binder_root_cause` 定位服务端原因
- 用 `lookup_knowledge` 获取相关机制解释（如锁竞争、Binder IPC）

**Phase 2.8 — Compose 启动特有分析（当架构检测为 Compose 时）：**

注意：Compose 应用的启动 hotspot 分布与传统 View 应用不同：
- 传统 View: `inflate` → XML 解析 + 反射创建 View → 主要瓶颈在 LayoutInflater
- Compose: 没有 inflate，改为 `Recomposition` + `Compose:` 系列 slice → 主要瓶颈在 composition 函数执行
- Compose + View 混合: 同时存在 inflate 和 Recomposition slice

**Compose 启动 hotspot 检查：**
```
execute_sql("SELECT name, dur/1e6 as dur_ms FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid JOIN process p ON t.upid = p.upid WHERE (t.is_main_thread = 1) AND s.ts >= <startup_ts> AND s.ts < <startup_end_ts> AND (s.name GLOB 'Compose:*' OR s.name GLOB 'Recompos*' OR s.name GLOB '*CompositionLocal*' OR s.name GLOB '*LazyList*') ORDER BY dur DESC LIMIT 20")
```

- 如果存在大量 `Recomposition` slice → 检查是否有不必要的重组（state reads 过多）
- 如果 `Compose:*` slice 总耗时 > 启动总时长的 30% → Compose composition 是瓶颈
- 如果同时存在 `inflate` 和 `Compose:*` → 混合应用，分别分析两部分的耗时占比

**Phase 2.9 — Flutter 启动特殊处理（当架构检测为 Flutter 时）：**

Flutter 冷启动包含独特的双线程初始化模型：
- **主线程 (Android)**：正常的 Application/Activity 生命周期 + Flutter 引擎初始化（`FlutterEngine.create`、native library 加载）
- **1.ui 线程 (Dart)**：Dart VM 初始化 + Framework warm-up + 首次 `Framework::BeginFrame`

**关键 Slice：**
- `flutter::Shell::OnPlatformViewCreated` — Flutter 引擎与平台视图绑定完成
- `Framework::BeginFrame`（首次出现）— Dart 框架开始渲染第一帧，是 Flutter 层面的 TTID
- `DartIsolate::CreateRunningRootIsolate` — Dart VM isolate 创建
- `Engine::Run` — Dart 代码开始执行

**分析要点：**
1. Flutter 冷启动 = Android 启动耗时 + Flutter 引擎初始化 + Dart 首帧渲染
2. 如果 `bindApplication` 到第一个 `Framework::BeginFrame` 之间有较大 gap，检查 native library 加载耗时
3. 主线程阻塞分析仍适用于 Android 层面；Dart 层面的瓶颈需检查 1.ui 线程的 slice

```
execute_sql("SELECT name, dur/1e6 as dur_ms, track_id FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid JOIN process p ON t.upid = p.upid WHERE t.name IN ('1.ui', '1.raster') AND s.ts >= <startup_ts> AND s.ts < <startup_end_ts> AND (s.name GLOB '*Framework*BeginFrame*' OR s.name GLOB '*Shell*' OR s.name GLOB '*Engine*Run*' OR s.name GLOB '*DartIsolate*') ORDER BY s.ts LIMIT 20")
```

**Phase 2.10 — WebView 启动特殊处理（当架构检测为 WebView 时）：**

WebView 冷启动包含 Chromium 渲染引擎的初始化：
- **主线程 (Android)**：Activity 生命周期 + WebView 初始化（`WebViewChromium.init`）
- **CrRendererMain 线程**：V8 引擎初始化、DOM 解析、CSS 布局、JavaScript 执行

**关键 Slice：**
- `WebViewChromium.init` — WebView 组件初始化入口
- `v8.compile` / `v8.run` — V8 引擎编译和执行 JavaScript
- `CrRendererMain` 线程首个 slice — Chromium 渲染进程开始工作
- `ParseHTML` / `Layout` — DOM 解析和 CSS 布局

**分析要点：**
1. WebView 冷启动 = Android Activity 启动 + WebView/Chromium 初始化 + 页面加载渲染
2. `WebViewChromium.init` 在 Android 主线程执行，可能占据数百毫秒（首次加载 Chromium 库）
3. 页面渲染瓶颈在 CrRendererMain 线程：V8 GC、大量 DOM 节点、CSS Layout Thrashing
4. 网络请求耗时通常不在 trace 中体现，需结合 TTFD 分析

```
execute_sql("SELECT name, dur/1e6 as dur_ms FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid JOIN process p ON t.upid = p.upid WHERE s.ts >= <startup_ts> AND s.ts < <startup_end_ts> AND (s.name GLOB '*WebViewChromium*' OR s.name GLOB '*v8.*' OR t.name = 'CrRendererMain' OR s.name GLOB '*ParseHTML*' OR s.name GLOB '*Layout*') ORDER BY dur DESC LIMIT 20")
```

**Phase 3 — 综合结论（基于根因诊断决策树）：**

### 预检查：识别测试/基准应用

在开始根因分析前，检查热点 slice 名称是否包含测试/基准特征模式：
- 常见关键词：`Benchmark`、`StressTest`、`TestRunner`、`Mock`、`Synthetic`、`Dummy`
- 特征：slice 名称中含有 `Simulator`、`Fake`、`Test` 前缀/后缀，或非标准 AOSP 框架 slice 占据大量启动时间

如果检测到这些特征：
- 在**概览**中明确标注：**"⚠️ 此应用为性能测试/基准应用，slice 名称含有模拟负载标记"**
- 不要给出通用的"检查 synchronized 块"/"使用 AsyncLayoutInflater"等优化建议（对测试 App 无意义）
- 改为描述模拟负载的性能特征，帮助用户理解测试 App 的行为
- 如果用户的目标是验证测试框架本身，可以分析模拟负载是否符合预期

### Slice 嵌套感知（⚠️ 关键）

主线程热点 slice 数据包含两组指标：
- **total_ms / percent_of_startup**（wall time）：包含所有子 slice 的时间，**父子会重叠**
- **self_ms / self_percent**（exclusive time）：仅自身独占时间，**不含子 slice，不会重叠**

**必须遵循的规则：**
1. **根因归因用 self_ms**，不要用 total_ms。例如 `activityStart` 的 total_ms=832ms 但 self_ms 可能只有 5ms（其余全是子 slice 贡献），这意味着 activityStart 本身不是问题
2. **根因分析树中，嵌套 slice 必须体现父子关系**：
   - ✅ 正确：`activityStart (832ms wall) → performCreate (827ms) → inflate (710ms)`
   - ❌ 错误：将 activityStart (62%)、performCreate (61%)、inflate (53%) 作为独立根因并列
3. **优化建议的收益估算必须基于 self_ms**，不能把父子 slice 的 wall time 简单相加（会导致预期节省超过总时长）
4. **识别叶子 slice**：self_ms ≈ total_ms 的 slice 是叶子（无子 slice），是真正的耗时归因点；self_ms << total_ms 的 slice 是容器（框架包裹），优化价值低

### 启动阶段划分（必须覆盖）

Android 启动有两个串行大阶段，**分析结论必须覆盖两个阶段**，不能遗漏：

1. **bindApplication 阶段**（Application.onCreate / ContentProvider.onCreate）
   - 典型 slice：`bindApplication`、`app.onCreate`、`contentProviderCreate`、`OpenDexFilesFromOat`
   - 冷启动特有；温启动出现 bindApplication 说明启动类型可能被误判

2. **activityStart 阶段**（Activity.onCreate / onStart / onResume → 首帧）
   - 典型 slice：`activityStart`、`performCreate:*`、`inflate`、`Choreographer#doFrame`

如果两个阶段的 self_ms 总和接近启动总时长，说明关键路径是串行的；如果远小于，说明有非主线程因素（如 Binder 阻塞、调度延迟）。

### 根因诊断决策树

**第一步：看四象限分布，确定主线程时间花在哪里**

| 四象限 | 占比 | 含义 | 下一步 |
|--------|------|------|--------|
| Q1 大核运行 高 | >50% | CPU-bound，主线程在大核执行计算 | → 分析热点 slice 的计算密集度 |
| Q2 小核运行 高 | >15% | 被调度到性能不足的小核 | → 检查进程优先级、是否有大核抢占、EAS/uclamp 配置 |
| Q3 Runnable 高 | >5% | CPU 资源争抢，可运行但得不到 CPU | → 看调度延迟数据、核迁移次数、后台负载 |
| Q4 Sleeping 高 | >25% | **主线程被阻塞**（最常见的根因来源） | → **必须看 blocked_functions 定位阻塞原因**（见第二步） |

**第二步：当 Q4 占比高时，用线程状态 + blocked_functions 定位阻塞根因**

主线程状态分布数据包含 state（Running/S/D/R）和 **blocked_functions** 列。这是最关键的诊断数据：

| 线程状态 | blocked_functions 特征 | 根因类型 | 典型场景 |
|---------|----------------------|---------|---------|
| S (Sleeping) | `futex_wait_queue` / `futex_wait` | **锁等待** | art_lock_contention、monitor 竞争、ReentrantLock、synchronized 块 |
| S (Sleeping) | `binder_wait_for_work` / `binder_ioctl` | **同步 Binder 阻塞** | 跨进程 IPC 等待 system_server 响应 |
| S (Sleeping) | `do_epoll_wait` / `ep_poll` | **Looper 空闲/等待事件** | 正常空闲（非问题）或等待异步回调 |
| S (Sleeping) | `pipe_wait` / `pipe_read` | **管道等待** | 等待子线程/进程通信 |
| S (Sleeping) | `SyS_nanosleep` / `hrtimer_nanosleep` | **主动 sleep** | 代码中的 Thread.sleep()/SystemClock.sleep() |
| S (Sleeping) | `do_wait` / `wait_consider_task` | **等待子进程** | fork 后等待 |
| D (Disk Sleep) | `io_schedule` / `blkdev_issue_flush` | **磁盘 IO** | 文件读写、数据库操作 |
| D (Disk Sleep) | `SyS_fsync` / `do_fsync` | **fsync 刷盘** | SQLite WAL checkpoint、SharedPreferences commit |
| D (Disk Sleep) | `filemap_fault` / `do_page_fault` | **页缺失** | 内存映射文件首次访问、dex 文件加载 |

⚠️ **D 状态高占比时应排查系统内存压力** → 满足触发条件时执行 **Phase 2.56（内存压力检测）**，触发条件和排除场景详见 Phase 2.56 定义。

**第 2.5 步：当主线程状态分布的 blocked_functions 为空或 "-" 时**

某些 trace 的 `blocked_functions` 列为空（内核未开启 CONFIG_SCHEDSTATS）。此时：

1. **优先使用 hot_slice_states 数据**（已包含在 startup_detail 的返回结果中，Phase 2.5 fetch_artifact 时获取）。
   即使全局 blocked_functions 为空，per-slice 的线程状态分布（Running/S/D 各自占比）仍然有效，可以判断 slice 慢在"计算"还是"阻塞"。

2. **从已有数据交叉推断**（hot_slice_states 的 blocked_functions 也为空时）：
   - S 状态时长高 + 主线程同步 Binder >50ms → **Binder 阻塞**是主因
   - S 状态时长高 + GC 在主线程 >20ms → **GC 阻塞**参与
   - D 状态时长高 + 文件 IO Top15 有大量 open/read → **磁盘 IO** 是主因
   - S 状态时长高 + 无明显 Binder/GC → 可能是 **锁等待** 或 **sleep()** 调用
   - **结论中必须标注"基于间接证据推断，blocked_functions 不可用"**

3. **在优化建议中**：建议用户后续抓 trace 时开启内核 `CONFIG_SCHEDSTATS` 选项（或使用 `echo 1 > /proc/sys/kernel/sched_schedstats`），以获取完整的 `blocked_functions` 数据。这将大幅提升阻塞根因定位的精度——从"间接推断"升级为"直接证据"

**第三步：用热点 Slice 线程状态（hot_slice_states）做 per-slice 根因定位**

`hot_slice_states` 返回每个热点 slice 内部的线程状态分解（Running/S/D/R 各自的耗时和 blocked_functions）。
**这是判断某个 slice 为什么慢的最直接证据**，优先于间接推理。

使用方式：
- 如果 `app.onCreate` 的 hot_slice_states 显示 S=400ms + blocked_functions=`futex_wait_queue`
  → **确证**：此 slice 被锁等待阻塞了 400ms
- 如果 `inflate` 的 hot_slice_states 显示 Running=300ms + S=150ms + blocked_functions 为空
  → 结论：部分 CPU-bound + 部分阻塞，blocked_functions 为空则需结合上下文推断阻塞原因
- 如果 `contentProviderCreate` 的 hot_slice_states 显示 D=30ms + blocked_functions=`io_schedule`
  → **确证**：ContentProvider 初始化中执行了数据库操作产生磁盘 IO 阻塞

⚠️ **重要：slice 的 wall time ≠ 线程状态时间的直接对比**
slice 的 wall time（如 inflate 479ms）包含 Running + S + D + R 所有状态。
不能直接用 slice wall time 与全区间的 S 状态总量做数值对比来推断因果关系。
必须用 `hot_slice_states` 的 per-slice 线程状态数据来确认具体比例。

如果 hot_slice_states 为空或不可用，才退回到间接推理（见第 2.5 步的补救措施），但**结论中必须标注"基于间接证据推断"**。

**第四步：检查 CPU 频率是否是瓶颈**
- 大核均频 vs 最高频率：如果均频远低于最高频 → 存在升频延迟或频率受限
- 冷启动初期 CPU 可能还在低频，影响前几百毫秒的性能
- 如果应用完全跑大核 (Q1≈100%) 且大核频率已达峰值 → 频率不是瓶颈，是纯计算量问题

⚠️ **CPU 频率估算**：参见"通用分析规则"中的 CPU 频率估算章节。启动场景特有注意：冷启动初期 CPU 可能还在低频，影响前几百毫秒的性能；thermal 限频可通过 thermal_zone 计数器确认。

**第五步：排除/确认其他影响因素**
- **Binder 阻塞**：看主线程同步 Binder 总时长。<10ms 基本可排除；>50ms 需关注具体接口
- **Binder 线程池**：如果 `binder_pool` 显示利用率 >90%（⚠️），即使 Binder 总耗时短，也应在结论中说明——线程池过小（如仅 1 个 Binder 线程）在高并发 Binder 调用时会成为瓶颈。标注为"当前非瓶颈但线程池过小存在潜在风险"
- **GC 影响**：看 GC 是否在主线程执行。Background GC 不直接阻塞主线程，但争抢 CPU。`GC: Wait For Completion` 在主线程上才真正阻塞
- **类加载**：冷启动时 `OpenDexFilesFromOat` 和类验证可能占显著时间
- **布局 Inflation**：`inflate` 和自定义 View 构造函数是 CPU-bound，看 Q1 而非 Q4
- **调度延迟**：>8ms 的严重延迟次数和最大值。频繁的调度延迟指向系统负载问题

**第六步：TTID / TTFD 分析与分析边界确认**

TTID 和 TTFD 是两个不同的指标，必须区分：
- **TTID（Time To Initial Display）**：首帧显示时间，由框架自动计算（RenderThread 完成第一次 DrawFrame）。对应 `android_startup_time_to_display` 的 `time_to_initial_display` 字段。**不依赖** `reportFullyDrawn()`
- **TTFD（Time To Full Display）**：完全显示时间，**需要**应用主动调用 `reportFullyDrawn()` 才有数据。对应 `time_to_full_display` 字段

**分析边界（analysis window）说明**：
- `android_startups` 表的 `dur`（= `end_ts - start_ts`）是框架层启动时长，通常表示框架认定的 startup completion，可近似首帧显示边界
- 注意：`dur` 与 TTID 在部分 trace 上并不严格等价（文档前面的 `R008_TTID_GT_DUR` 数据质量检查即为此设计）。当数据质量检查触发 R008 时，需单独核验 `dur` 与 TTID 的偏差原因
- 即使 `ttid_ms` 字段为 NULL，`dur_ms` 仍然定义了有效的分析窗口，分析的全部内容（Phase 1 到 Phase 3）都基于 `start_ts` 到 `end_ts` 范围

**诊断逻辑**：
- `ttid_ms` 存在 → 报告中显示 TTID 值
- `ttid_ms` 为 NULL → 报告中说明："TTID 数据点不可用（可能原因：DrawFrame slice 未被独立捕获、trace 配置缺失、Perfetto 版本差异等），分析窗口基于 android_startups.dur = XXms"。**不要**说"TTID 不可用因为未调用 reportFullyDrawn"——这是错误的，TTID 与 reportFullyDrawn 无关
- `ttfd_ms` 存在且 > `ttid_ms`（或 > `dur_ms`）→ 应用在首帧后仍有异步内容加载。注意：前面所有 Phase 的查询边界固定在 `start_ts ~ end_ts`，不覆盖首帧之后的时间段。分析 TTID→TTFD 的耗时去向需追加查询：
  ```sql
  -- 查询首帧后到 TTFD 之间的主线程活动
  SELECT name, dur/1e6 as dur_ms FROM thread_slice
  WHERE thread_name IN ('main', 'RenderThread')
    AND ts BETWEEN <end_ts> AND <start_ts + ttfd_ns>
    AND process_name GLOB '<package>*'
  ORDER BY dur DESC LIMIT 15
  ```
  常见原因：网络请求、数据库查询、图片异步加载、WebView 初始化。如果无法追加查询，结论中应降级为"确认存在首帧后延迟（TTFD - dur = XXms），但该时段不在当前分析窗口内"
- `ttfd_ms` 为 NULL → 报告中说明："应用未调用 `reportFullyDrawn()`，TTFD 不可用"（分析范围已在 TTID 分支中说明，此处无需重复）

**第七步：特定阶段补充检查**
- **ContentProvider**：冷启动时 `contentProviderCreate` slice 可能占显著时间（尤其多 ContentProvider 应用）。检查 `startup_main_thread_slices_in_range` 中是否有此 slice
- **厂商特定 Slice**：部分 OEM 有专有 trace 标记（如 OPPO `HyperBoost*`、vivo `TurboX*`、Xiaomi `MiBoost*`），可作为辅助分析信号
- **Zygote fork 阶段**：冷启动的 pre-`bindApplication` 阶段（进程 fork ~50ms）通常不是瓶颈，但极端情况下（系统负载高）可能贡献显著延迟

**输出结构必须遵循：**

1. **概览**：应用名、启动类型、总耗时、**TTID**、**TTFD**（如有）、**分析边界**、评级、数据质量提示
   - **分析边界**必须明确写出，格式示例：
     - TTID 有值且与 dur 一致时："分析范围：启动开始 → 首帧显示（TTID = XXms）"
     - TTID 无值但 dur 有值时："分析范围：启动开始 → 框架启动完成（dur = XXms，基于 android_startups），近似首帧显示"
     - R008_TTID_GT_DUR 触发时（TTID > dur）："分析范围：启动开始 → 框架启动完成（dur = XXms）。注意 TTID = YYms > dur，差值 ZZms 需单独分析（见数据质量提示）"
     - TTFD 有值时追加："TTFD = XXms（应用调用了 reportFullyDrawn）"
     - TTFD 无值时追加："TTFD 不可用（应用未调用 reportFullyDrawn()）"
   - 如果检测到模拟器/测试应用特征，必须在此标注
   - 如果启动类型与 bindApplication 存在矛盾，必须在此说明

2. **关键发现**（每个发现必须包含**根因推理链**，不能只报数字）：
   ```
   **[CRITICAL] 标题**
   - 描述：XX slice 自身耗时 YY ms（self_percent ZZ%）[wall time AA ms]
   - 根因推理链：
     ① 四象限显示 Q4=NN%（主线程大量时间被阻塞）
     ② 线程状态：S(Sleeping) = XX ms >> D(IO) = YY ms → 阻塞主因是 S 状态
     ③ blocked_functions 含 futex_wait_queue → 锁等待
     ④ 结合热点 slice：该 slice 内部存在 [锁竞争/sleep/同步Binder/IO阻塞]
   - 结论：此 slice 慢的根因是 [具体根因]，不是 [排除的因素]
   - 建议：[可操作的优化建议]
   ```

3. **根因分析树**：层级式展示启动耗时分解，**必须体现嵌套关系和使用 self_ms**
   ```
   启动总耗时 XXms
   ├── [Phase 1] bindApplication = XXms wall
   │     └── app.onCreate = XXms wall (self=YYms)
   │           ├── contentProviderCreate = XXms (self=YYms) ← 根因: [IO/锁等待/...]
   │           └── OpenDexFilesFromOat = XXms (self=YYms) ← DEX 加载
   ├── [Phase 2] activityStart = XXms wall
   │     └── performCreate = XXms wall (self=YYms)
   │           ├── inflate = XXms (self=YYms) ← CPU-bound (布局复杂度)
   │           └── Choreographer#doFrame = XXms (self=YYms) ← 首帧渲染
   └── [可排除因素]
         ├── Binder 阻塞 < Xms ✓
         ├── GC [主线程/后台线程] ✓
         └── 调度延迟 < Xms ✓
   ```
   ⚠️ 树中百分比用 self_percent，不要用 wall percent（否则总和超过 100%）

4. **优化建议**（双视角，按预期收益排列）：

   **[App 层]**（应用开发者可直接实施）：
   - 收益估算基于 self_ms（不是 wall time）
   - 嵌套 slice 的收益不能简单相加

   **[系统/平台层]**（系统工程师 / ROM 开发者参考）：

   **核心优先检查**（Phase 1/2 通常已包含数据，优先输出结论；若对应 artifact 缺失则标注"数据不足"）：

   | 维度 | 检查项 | 数据来源 |
   |------|--------|---------|
   | CPU 调度 | 主线程大小核摆放（Q2 占比）、核迁移频率 | 四象限分析、摆核时序（如 critical_tasks 缺失则标注） |
   | CPU 频率 | 启动初期升频延迟、频率是否达峰 | CPU 频率分析（如 freq_rampup 缺失则仅看均频） |
   | Binder 阻塞 | 主线程同步 Binder 中 system_server 响应延迟 | 主线程同步 Binder、Binder 阻塞分析 |
   | 调度延迟 | >8ms 严重延迟次数、整体调度质量 | sched_latency |

   **条件触发**（仅当有对应数据或满足触发条件时分析，数据不足时输出"当前数据不足以判断"）：

   | 维度 | 触发条件 | 数据来源 |
   |------|---------|---------|
   | 内存压力 | Phase 2.56 被执行（D 状态 >10% 或 kswapd 活跃）| memory_pressure_in_range |
   | Binder 线程池 | binder_pool artifact 存在 | Binder 线程池利用率（optional artifact） |
   | Thermal | 均频远低于峰值（>10% 差距）| thermal_zone counters（需 execute_sql 查询） |
   | IO 子系统 | D 状态 >30% 且 memory_pressure 排除 | 文件 IO 类型、blocked_functions |
   | 进程管理 | LMK 事件 > 0 或 Binder 中有 freezer 相关调用 | oom_adj_intervals（需 execute_sql 查询） |
   | OEM 差异 | 检测到厂商特定 Slice（HyperBoost/TurboX/MiBoost 等）| slice 名称匹配 |

   格式示例：
   ```
   **[系统/平台层] P1 — CPU 调度优化**
   - 发现：主线程启动前 200ms 被调度到小核（Q2=15%），核迁移 12 次
   - 建议：配置 uclamp.min=512 确保启动关键路径获得大核调度；检查 EAS 是否正确识别前台启动场景

   **[系统/平台层] P2 — 系统内存治理**
   - 发现：内存压力 moderate，2 次 LMK，Page Cache 被回收导致 D 状态放大
   - 建议：检查后台进程 oom_adj 策略；考虑在启动场景下临时提升 Page Cache 优先级

   **[系统/平台层] 可排除项**
   - Thermal：prime 核均频 2499/2500MHz，无限频 ✓
   - CPU 调度：主线程 100% 大核运行，无小核调度问题 ✓
   - 调度延迟：max 0.67ms，0 次严重延迟 ✓
   ```

⚠️ **禁止的做法：**
- 只说"XX 耗时 YYms"但不解释为什么慢
- 把四象限、线程状态、Binder、GC 当独立章节罗列，而不进行交叉引用
- 忽略 blocked_functions 数据（这是定位 Q4 根因的关键）
- 在证据中只复制 slice 列表，不做根因推理链
- 把所有 Q4 时间统称为"休眠/阻塞"而不区分 S（锁/Binder/sleep）vs D（IO/页缺失）
- 不区分 GC 在主线程还是后台线程
- 把延迟归因（opinionated_breakdown）的 category 字段（IO/Layout/Other 等）当作真实的阻塞原因。这些 category 是 Perfetto 基于 slice 名称的**启发式分类**，不代表实际线程状态。例如 bind_application 被标记为 IO 类别，但实际阻塞原因可能是锁等待。**必须用线程状态数据（特别是 hot_slice_states）来验证真实根因**
- 用 slice wall time 与全区间线程状态总量做直接数值对比来推断因果（如"inflate 479ms ≈ S状态 468ms 所以它是 S 状态的根因"）。wall time 包含所有线程状态，正确做法是使用 hot_slice_states 的 per-slice 状态分解
- **将嵌套 slice 的 wall time 作为独立根因并列报告**，导致百分比总和超过 100%。必须用 self_ms 归因
- **只分析 activityStart 阶段而遗漏 bindApplication 阶段**（反之亦然）。两个阶段都必须覆盖
- **给出过于精确的 CPU 频率收益估算**（如"升频可降低 28%"），除非有多频率对比的实测数据

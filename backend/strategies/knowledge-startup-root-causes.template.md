<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android 启动慢根因分类体系

> 本文档是 Agent 在启动分析 Phase 3（结论生成）阶段的参考手册。
> 根据已发现的现象（四象限、blocked_functions、SR codes）查找对应根因，构建完整的根因推理链。

## 使用说明

1. **不要全部阅读** —— 根据分析中发现的异常指标，查阅对应的根因条目
2. 每个根因条目包含：**机制（WHY）→ 现象特征 → Perfetto 检测 → 阈值 → 建议**
3. 关注 **交叉因素（C 节）**：多个根因同时出现时，解释它们的放大/掩盖关系
4. 结论中使用根因编号（如 A9、B3）以便交叉引用；编号仅用于分类，不自动代表因果已证实。
5. 下表 Good/Warning/Critical 是调查优先级，不是确认或排除条件。小总量只能描述该口径的观测成本，不能推出“不在关键路径”“系统正常”或排除其他机制。
6. 源码函数名、调用参数、注释和模拟标记不等于实现行为；先读实际被调用函数定义。Running 占比只证明线程在执行，不能证明指令效率、供给充足或所有实例行为相同。
7. 启动事件 `trampoline_ms > 0` 时，启动区间前段是另一个入口 Activity/包的 trampoline 跳转。按占比或时长套用本手册阈值、归入 A 类根因时，以目标包的 `dur_without_trampoline_ms` 为分母；trampoline 段的耗时只能归到发起跳转的入口，不属于目标 App。

---

## A. App 层根因

---

### A1. Application/ContentProvider 初始化过重

**机制**：Cold start 时 `handleBindApplication()` 按优先级逐一加载每个 ContentProvider 并调用 `ContentProvider.onCreate()`，最后调用 `Application.onCreate()`。Firebase/Crashlytics/WorkManager 等三方库通过 ContentProvider 自动初始化，每个增加数毫秒到数十毫秒。累积后可达数百毫秒。

**现象特征**：
- `bindApplication` slice 耗时异常（>200ms）
- 多个 `contentProviderCreate` 子 slice
- Application.onCreate 阶段占启动总时长 >50%

**Perfetto 检测**：
- Slice: `bindApplication`, `contentProviderCreate`, `Application.onCreate`
- Table: `slice` JOIN `thread_track` JOIN `thread` JOIN `process`
- 统计 `contentProviderCreate` 子 slice 的数量和各自耗时

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| bindApplication 总耗时 | <100ms | 100-200ms | >200ms |
| 单个 ContentProvider | <5ms | 5-20ms | >20ms |
| ContentProvider 总数 | <3 | 3-8 | >8 |

**典型影响**: 50-500ms

**关联**: 是 A2(磁盘IO)、A8(数据库)、A9(SP)、A11(三方SDK) 的容器阶段——这些根因的耗时都会叠加到 bindApplication 中。

**建议 [App层]**: 使用 Jetpack App Startup 合并 ContentProvider；延迟非关键 SDK 初始化；审计每个 ContentProvider 的必要性。

---

### A2. 主线程磁盘 I/O

**机制**：主线程执行 `read()/write()/fsync()` 等系统调用时可能进入 D 状态（Uninterruptible Sleep），等待 page-cache、文件系统或块设备路径完成。是否属于 I/O wait 要看 `io_wait=1` 或 IO/page-cache `blocked_function`；低内存时 page cache 不命中会把延迟从微秒级放大到毫秒级。

**现象特征**：
- 四象限 Q4 中 D 状态占比高，且 `io_wait=1` 或 `blocked_function` 命中 IO/page-cache 函数族
- `blocked_function` 含 `io_schedule`、`do_page_fault`、`filemap_fault`、`filemap_read`、`wait_on_page_bit`、`ext4_*`、`f2fs_*`
- `startup_main_thread_file_io_in_range` 结果中有大量文件操作

**Perfetto 检测**：
- Table: `thread_state` WHERE state IN ('D','DK') AND (`io_wait=1` OR IO/page-cache `blocked_function`)
- blocked_function 模式: `do_page_fault`, `filemap_fault`, `filemap_read`, `io_schedule`, `wait_on_page_bit`, `folio_wait_bit`, `ext4_*`, `f2fs_*`, `__blockdev_direct_IO`
- Counter: `mem.mm.maj_flt`(major page fault)

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 主线程 D 状态总占比 | <5% | 5-15% | >15% |
| 单次 IO 阻塞 | <5ms | 5-20ms | >20ms |
| Major page faults | <10 | 10-50 | >50 |

**典型影响**: 10-500ms

**关联**: 与 B3(内存压力) 高度相关——page cache 被回收后所有文件读取退化为真实磁盘 IO。与 B5(IO竞争) 叠加。是 A8(数据库)、A9(SP) 的底层实现。

**建议 [App层]**: 将文件/数据库操作移至后台线程；使用 memory-mapped 访问减少 syscall 开销。

---

### A3. 主线程网络调用

**机制**：主线程发起同步 HTTP/Socket 请求时阻塞等待服务器响应。DNS 解析、TCP 握手、TLS 协商、数据传输每步都可能引入延迟。

**现象特征**：
- 主线程 S 状态，blocked_function 为 `inet_*`、`tcp_*`
- 启动期间有网络数据包活动

**Perfetto 检测**：
- Table: `thread_state` WHERE state='S' AND blocked_function GLOB '*tcp*' or '*inet*'
- Stdlib: `android.network_packets`

**阈值**: 主线程任何同步网络调用 >0ms 都是问题（应 100% 异步化）

**典型影响**: 100-3000ms

**关联**: 可能被 A1(ContentProvider) 或 A11(SDK初始化) 间接触发。

**建议 [App层]**: 所有网络调用必须异步化；启动期间禁止同步网络请求。

---

### A4. Layout Inflation 复杂度

**机制**：`LayoutInflater.inflate()` 解析 XML → 反射创建 View 对象 → measure/layout/draw。嵌套布局、大量 View、自定义 View 构造函数中的重操作都导致首帧渲染时间过长。

**现象特征**：
- `inflate` slice 耗时长（>100ms）
- `activityStart` 阶段 Q1(Running) 占比高（CPU-bound）
- `Choreographer#doFrame` 首帧耗时 >32ms

**Perfetto 检测**：
- Slice: `inflate`, `setContentView`, `Choreographer#doFrame`, `performTraversals`
- 官方阈值(android_startup.sql): inflate > 450ms

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| inflate 总时间 | <100ms | 100-450ms | >450ms |
| ResourcesManager#getResources | <50ms | 50-130ms | >130ms |
| 首帧 Choreographer#doFrame | <16ms | 16-32ms | >32ms |

**典型影响**: 50-500ms

**关联**: 与 A15(大资源加载) 相关——Bitmap decode 在 inflate 阶段发生。与 A18(自定义View) 互为因果。

**解释边界**：只有确认执行了真实 inflate/View 构造路径，才使用上述机制。自定义或模拟切片即使名字含 inflation，也可能只是反射枚举、计算或等待；调用参数不是 View 数量。必须读取该函数定义并关联实际事件，不能根据命名套用布局机制。

**建议 [App层]**: 使用 ViewStub 延迟非首屏 View；减少布局嵌套层级；考虑 AsyncLayoutInflater。

---

### A5. 类加载 / DEX 优化 / Baseline Profile

**机制**：ART Runtime 加载类时需要：① `OpenDexFilesFromOat` 打开 DEX/OAT 文件 ② `VerifyClass` 验证字节码合法性 ③ 类静态初始化。无 Baseline Profile 时，启动路径代码需要解释执行或 JIT 编译，比 AOT 慢 ~30%。Startup Profile 将启动类集中到 DEX 连续区域减少 page fault。

**现象特征**：
- `OpenDexFilesFromOat*` slice 占启动 >20%
- 大量 `VerifyClass*` slice
- 冷启动 D 状态高（DEX 文件 page fault）

**Perfetto 检测**：
- Slice: `OpenDexFilesFromOat*`, `VerifyClass*`, `JIT compiling*`
- 官方阈值: OpenDexFilesFromOat >20% duration, VerifyClass >15% duration, JIT >100ms

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| OpenDexFilesFromOat 占比 | <20% | 20-40% | >40% |
| VerifyClass 占比 | <15% | 15-30% | >30% |
| JIT 编译时间 | <100ms | 100-300ms | >300ms |
| JIT 编译方法数 | <30 | 30-65 | >65 |

**典型影响**: 无 Baseline Profile 时额外 100-500ms

**关联**: Baseline Profile 效果受安装时 dex2oat 编译影响。DEX 布局优化与 A2(磁盘IO)、B3(内存压力) 交叉。

**建议 [App层]**: 集成 Baseline Profile + Startup Profile；使用 `speed-profile` 编译模式。

---

### A6. GC 压力

**机制**：Android 8+ 使用 Concurrent Copying (CC) GC。启动期间大量对象创建（String 操作、序列化、集合初始化）触发 young GC。CC GC 的 pause 很短（<1ms），但 GC 线程与应用线程竞争 CPU，间接减慢启动。大量 GC 是内存分配模式不健康的信号。

**现象特征**：
- 启动期间 GC 事件 >3 次
- GC 总时间占启动 >5%
- `critical_tasks` 中 GC 线程 CPU 占用显著

**Perfetto 检测**：
- Stdlib: `android.garbage_collection` → `android_garbage_collection_events`
- Slice: `concurrent copying GC`, `young concurrent copying GC`
- blocked_function: `art::gc::*`, `SuspendAll`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| GC 总时间/启动时间 | <2% | 2-5% | >5% |
| GC 事件数 | <3 | 3-8 | >8 |
| 主线程 GC pause | <1ms | 1-5ms | >5ms |

**典型影响**: 10-100ms

**关联**: 与 A11(SDK初始化) 交叉——SDK 初始化常有大量对象分配。GC 线程与 B1(CPU调度) 交叉——GC 线程在小核上运行时更慢。

**建议 [App层]**: 减少启动期间的对象分配；避免大集合一次性创建；注意 String 拼接。

---

### A7. 锁竞争

**机制**：启动期间多线程并行初始化时，`synchronized` / `ReentrantLock` / `futex` 导致主线程阻塞等待锁释放。ART 的 monitor contention 跟踪可精确记录哪个线程在等锁、谁持有锁、等了多久。

**现象特征**：
- Q4(Sleeping) 高 + blocked_function 含 `futex_wait_queue`
- `Lock contention on*` slice 存在
- `android_monitor_contention` 有记录

**Perfetto 检测**：
- Stdlib: `android.monitor_contention` → `android_monitor_contention` 表
- Slice: `Lock contention on*`, `Lock contention on a monitor*`
- blocked_function: `futex_wait_queue`, `futex_wait`, `__mutex_lock`, `pthread_mutex_lock`
- 关键列: `blocked_thread_name`, `blocking_thread_name`, `short_blocked_method`, `short_blocking_method`, `waiter_count`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 锁竞争总时间/启动 | <5% | 5-20% | >20% |
| Monitor 竞争/启动 | <5% | 5-15% | >15% |
| 单次锁等待 | <5ms | 5-20ms | >20ms |

**典型影响**: 5-200ms

**关联**: Lock holder 在小核运行(B1)会放大竞争时间(见C2)。system_server 层锁(B7)通过 Binder 传递到应用层。是 A8(数据库) 和 A9(SP) 的底层阻塞机制之一。

**建议 [App层]**: 减小 synchronized 临界区；用 concurrent 集合替代同步集合；审查 singleton 懒加载模式。

---

### A8. 数据库初始化

**机制**：Room/SQLite 首次访问时创建数据库文件、执行 schema creation（CREATE TABLE + INDEX）、执行 pending migration。即使在后台线程，如果 `Application.onCreate` 中同步等待数据库就绪，仍会阻塞启动。

**现象特征**：
- D/DK 状态 + `io_wait=1` 或 IO/page-cache `blocked_function`，并有 SQLite/Room/Provider/SharedPreferences 业务证据
- bindApplication 阶段有文件系统操作
- 可能伴随锁竞争（多线程竞争同一数据库连接）

**Perfetto 检测**：
- Thread state: D/DK 状态，`io_wait=1` 或 blocked_function 含 `do_page_fault`、`filemap_read`、`io_schedule`（只能支持数据库文件 IO 候选）
- Slice: 自定义 atrace（Room 不自动插桩）
- 结合 A2(磁盘IO) 的 blocked_function 分析，关注 `SyS_fsync`/`do_fsync`（WAL checkpoint 候选）；命名为数据库根因前必须补 SQLite/Room/Provider stack 或 slice

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 主线程数据库操作 | 0ms | 任何 | 任何(bug) |
| Schema migration | <50ms | 50-200ms | >200ms |

**典型影响**: 20-500ms

**关联**: 本质是 A2(磁盘IO) 的特化。B3(低内存)时 WAL/journal IO 开销更大。

**建议 [App层]**: 数据库初始化必须异步；Room migration 预检查在后台完成；考虑延迟打开数据库。

---

### A9. SharedPreferences 同步读取

**机制**：两个独立的阻塞路径：
1. **`awaitLoadedLocked()`**: 首次调用 `getXxx()` 时，如果 SP 文件尚未加载完成，当前线程阻塞等待。大 SP 文件(>100KB)或 IO 慢时可达数百毫秒。
2. **`QueuedWork.waitToFinish()`**: Activity pause/stop 时框架强制等待所有 pending 的 `apply()` 写操作完成 fsync。`apply()` 看似异步但在生命周期切换时同步等待。

**现象特征**：
- 主线程 S 状态 + blocked_function = `futex_wait_queue`（等待 SP 加载线程）
- bindApplication 早期阶段出现 S/D 状态交替
- 无明显的 Binder 或 Lock contention slice，但有 futex 等待

**Perfetto 检测**：
- Thread state: S + `futex_wait_queue`（awaitLoadedLocked）
- Thread state: D + `SyS_fsync`/`do_fsync`（QueuedWork 的 fsync 等待）
- 结合 A2 和 A7 的查询模式
- ⚠️ SP 没有原生 atrace 标记，需要从 blocked_function 模式间接推断

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| awaitLoadedLocked 阻塞 | <5ms | 5-50ms | >50ms |
| QueuedWork.waitToFinish | <10ms | 10-50ms | >50ms |

**典型影响**: 5-200ms

**关联**: 本质是 A2(磁盘IO) + A7(锁竞争) 的组合。B3(低内存) 和 B5(IO竞争) 放大影响。

**建议 [App层]**: 迁移到 Jetpack DataStore；拆分大 SP 文件；避免在 Application.onCreate 中读取 SP。

---

### A10. WebView 初始化

**机制**：WebView 初始化包含多个重量级阶段：① Context acquisition ② Java 代码加载（反射 WebViewChromiumFactoryProvider）③ Native 库加载（地址空间保留 + RELRO 预加载 + System.loadLibrary + JNI_OnLoad）④ Assets/Resources 注册。首次创建 WebView 实例时全部执行。

**现象特征**：
- `WebViewFactory.getProvider()` 或 `dlopen: *webview*.so` slice
- 首屏 Activity 包含 WebView 组件
- Native 库加载导致 D 状态（page fault）

**Perfetto 检测**：
- Slice: `WebViewFactory.getProvider()`, `dlopen: *webview*.so`, `JNI_OnLoad`
- Thread state: D(加载.so的page fault) + S(等待RELRO准备)

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| WebView 首次初始化 | <100ms | 100-300ms | >300ms |
| Native lib loading | <50ms | 50-150ms | >150ms |

**典型影响**: 100-500ms

**关联**: 是 A14(Native库加载) 的特化。RELRO 共享可跨进程减少开销。

**建议 [App层]**: 延迟 WebView 初始化到首次使用时；预创建 WebView 放在后台线程；使用 WebView 预热(Android 12+)。

---

### A11. 三方 SDK 初始化

**机制**：Firebase/Crashlytics/Analytics/广告/推送等 SDK 通过 ContentProvider 自动初始化或在 Application.onCreate 中显式初始化。每个 SDK 可能包含：配置文件读取(A2)、网络检查(A3)、Native库加载(A14)、线程池创建、数据库/SP初始化(A8,A9)。

**现象特征**：
- bindApplication 阶段大量非框架 slice
- 多个 `contentProviderCreate` 子 slice 关联三方包名
- bindApplication 耗时远超简单应用基线(>300ms)

**Perfetto 检测**：
- Slice: `contentProviderCreate`（按包名/类名识别三方 SDK）
- bindApplication 阶段的 slice 分解：过滤掉框架标准 slice 后剩余即为 SDK 贡献
- 线程创建：启动期间新线程的 upid/name 匹配 SDK 特征

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| SDK 初始化总时间 | <100ms | 100-300ms | >300ms |
| 启动路径中 SDK 数量 | <5 | 5-10 | >10 |
| 单个 SDK | <30ms | 30-100ms | >100ms |

**典型影响**: 50-800ms

**关联**: 是 A1(ContentProvider) 的主要贡献者。A1 中大部分耗时来自 SDK 初始化。

**建议 [App层]**: 使用 App Startup 合并 ContentProvider；延迟非关键 SDK（如 Analytics 延迟到首帧后）；评估每个 SDK 的启动必要性。

---

### A12. JIT 编译开销

**机制**：无 Baseline Profile 时，所有启动路径代码需要解释执行或 JIT 编译。JIT 线程在 CPU 最紧张的时候竞争资源，尤其抢占大核。JIT 编译方法数 >65 是 Google 官方警告阈值。

**现象特征**：
- `JIT compiling*` slice 大量出现
- JIT 线程在 critical_tasks 中占用显著大核时间
- SR01 被触发

**Perfetto 检测**：
- Slice: `JIT compiling*`
- Thread: `Jit thread pool worker`
- 官方阈值: JIT >100ms, JIT compiled methods >65

**阈值**: 同 A5 中的 JIT 部分

**典型影响**: 50-300ms（相比有 Baseline Profile 慢约 30%）

**关联**: 与 B1(CPU调度) 交叉——JIT 线程在小核编译更慢。Baseline Profile 直接消除此问题。

**建议 [App层]**: 集成 Baseline Profile（Macrobenchmark 生成 + AGP 集成）。

---

### A13. 广播接收器处理

**机制**：启动后系统可能分发 pending 广播（`BOOT_COMPLETED`, `CONNECTIVITY_ACTION`）。如果 `onReceive()` 在主线程执行耗时操作，直接阻塞启动。

**现象特征**：
- `broadcastReceiveReg*` slice 在启动窗口中出现
- SR07 被触发

**Perfetto 检测**：
- Slice: `broadcastReceiveReg*`, `Broadcast dispatched*`
- 官方阈值: dispatched >15, received >50

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 启动期间广播数 | <5 | 5-15 | >15 |
| 广播处理总时间 | <20ms | 20-100ms | >100ms |

**典型影响**: 5-100ms

**关联**: 在 B12(Boot Storm) 场景下与大量 BOOT_COMPLETED 广播叠加。

**建议 [App层]**: 延迟注册非关键 BroadcastReceiver；避免在 onReceive 中做重操作。

---

### A14. Native 库加载 (.so)

**机制**：`System.loadLibrary()` → `dlopen()` → ① 读取 ELF 文件(IO) ② mmap 到内存(page fault) ③ RELRO 重定位 ④ `.init_array` 静态初始化函数（在 dlopen 返回前执行，**不可延迟**）⑤ `JNI_OnLoad`（注册 native methods）。大型 .so（libflutter.so ~10MB, libchrome.so ~50MB）加载时间显著。

**现象特征**：
- `dlopen:*.so` slice 耗时长
- D 状态（mmap page fault）+ Running（.init_array 执行）

**Perfetto 检测**：
- Slice: `dlopen: *.so`
- Thread state: D(do_page_fault, filemap_fault) + Running(.init_array)
- blocked_function: `do_page_fault`, `filemap_fault`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| Native lib 加载总时间 | <50ms | 50-200ms | >200ms |
| 单个大 .so | <30ms | 30-100ms | >100ms |

**典型影响**: 20-300ms

**关联**: 受 B5(IO速度) 和 B3(page cache) 影响。首次冷启动最慢（无 page cache）。

**建议 [App层]**: 延迟加载非关键 native 库；减小 .so 体积；使用 `ReLinker` 避免 `UnsatisfiedLinkError`。

---

### A15. 大资源/Asset 加载

**机制**：`BitmapFactory.decodeResource()`、VectorDrawable 光栅化、自定义字体加载在主线程执行时，消耗 CPU + 内存，可能触发 GC(A6)。

**现象特征**：
- `BitmapFactory`、`ResourcesManager#getResources` slice 耗时长
- Running 状态（CPU 密集解码）或 D 状态（资源文件 IO/page-cache 候选，需结合 `io_wait` / blocked_function 判断）

**Perfetto 检测**：
- Slice: `BitmapFactory`, `ResourcesManager#getResources`, `decode*`
- 官方阈值: ResourcesManager#getResources > 130ms

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 资源加载总时间 | <50ms | 50-130ms | >130ms |
| 主线程 Bitmap 解码 | <20ms | 20-50ms | >50ms |

**典型影响**: 20-200ms

**关联**: 是 A4(Layout Inflation) 的子问题。APK 资源排列优化可减少 page fault。

**建议 [App层]**: 使用 RGB_565 减少内存；延迟加载非首屏资源；启用资源压缩。

**注意**：以下场景也归入 A15：
- **大图首帧加载**（Bitmap decode 在首帧渲染路径中）：表现为 inflate 阶段的 BitmapFactory slice，但根因不是布局复杂度(A4)而是资源体积
- **动态特性交付/Split APK 资源准备**（Dynamic Feature Delivery、split install 的资源/代码解包）：首次运行时的一次性成本，可能表现为 D 状态 + 文件系统操作候选；是否属于 IO wait 需结合 `io_wait` / blocked_function，与 A5(DEX 加载) 和 A2(磁盘 IO) 交叉

---

### A16. 主线程重计算

**机制**：JSON 解析、加密/解密、数据结构构建、正则匹配、大量 String 操作等 CPU 密集型工作在主线程执行。主线程 Running 状态占比高但启动时间长时，这是待调查方向；该状态不区分业务指令、内核执行、内存停顿或低频运行。

**现象特征**：
- Q1(大核Running) 或 Q2(小核Running) 占比极高
- 热点 slice 的 `hot_slice_states` 显示 Running >> S+D
- 非框架的应用自定义 slice 占据大量 CPU 时间

**Perfetto 检测**：
- Thread state: Running 状态占比高
- hot_slice_states: per-slice Running 占绝对主导
- 需要 app 自定义 tracepoint 定位具体操作

**初筛参考**：单个操作超过 20ms 可优先调查；这不是 CPU 密集、可优化收益或系统因素已排除的证明。

**典型影响**: 20-500ms

**关联**: B1(CPU调度) 和 B2(CPU频率) 直接影响计算密集型操作耗时。B4(热节流) 可使此类操作时间翻倍。

**建议 [App层]**: 将重计算移至后台线程或 WorkManager；使用更高效的 JSON 库（如 Moshi 替代 Gson）。

---

### A17. Thread.sleep() / 显式延迟候选

**机制边界**：`Thread.sleep()` 会让调用线程等待；`Handler.postDelayed()` 只是安排稍后回调，不表示调用线程睡眠；`CountDownLatch.await()` 是同步等待，不能与固定睡眠混为一谈。

**Trace 观察**：S 状态中的 nanosleep 阻塞函数支持“该区间处于 nanosleep 路径等待”，不能单独定位 Java、框架或 native API。固定时长 S、源码中存在 sleep 分支、循环概率计算的期望时长均不足以证明本次命中及等待总量。

**因果准入**：关联同一线程/同一时间段的具体调用栈、事件、marker 或明确依赖；缺少这些时结论保持候选，不写“主动 sleep 导致全部 S”。源码只证明实现存在，不能用理论250ms与观测250ms相合来替代事件对应。缺 blocked_function 也不能确定是未采集，需区分窗口、数据源、解析/符号化与能力缺失。

**建议 [App层]**：确认该等待进入关键路径后，检查其真实同步需求；优先异步通知/回调，不能把替换为另一个主线程阻塞等待视为通用修复。耗时影响以实际区间与依赖为准，不给固定收益。

---

### A18. 自定义 View 构造函数开销

**机制**：自定义 View 的构造函数在 inflate 过程中被反射调用。如果构造函数中执行资源加载（Bitmap decode）、TypedArray 读取、Paint/Path 创建、业务逻辑初始化等，会阻塞 inflate 过程。

**现象特征**：
- inflate 阶段的子 slice 中某些非标准 View 耗时异常
- hot_slice_states 中 inflate 内部 Running 占比高

**Perfetto 检测**：
- inflate 子 slice 分析
- 需要 method tracing 定位具体构造函数

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 单个 View 构造函数 | <5ms | 5-20ms | >20ms |
| 自定义 View 总初始化 | <50ms | 50-150ms | >150ms |

**典型影响**: 10-100ms

**关联**: 是 A4(Layout Inflation) 的子问题。ViewStub 可延迟自定义 View 构造。

**建议 [App层]**: 将重操作从构造函数移到 onAttachedToWindow 或 lazily init；使用 ViewStub 延迟加载。

---

## B. 系统/平台层根因

---

### B1. CPU 核心分配 (big.LITTLE / EAS / uclamp)

**机制边界**：CPU 容量差异可能影响关键任务的执行成本，但核类型需要可信的 capacity/拓扑以及 machine/ucpu 身份。观测频率、CPU 编号、四核数量或均匀频率不能确定大小核；无容量证据时保持 unknown。相同容量只表示当前观察到的容量一致，不能命名为“全小核”。

**取证**：报告同一任务区间的核驻留、未知覆盖、运行与 Runnable、频率、迁移及约束。低大核占比或迁移只是观察，不证明“被困小核”、调度错误或损失时间；串行关键路径、任务需求和调度约束需要分别核实。

**建议 [系统层]**：先验证是否有可量化的放置问题，再检查 affinity/cgroup/uclamp/调度策略。不能按占比直接推荐 RT、固定 uclamp 或 Launch Boost；实际收益需要设备和负载下的验证。

---

### B2. CPU 频率调度候选 (Governor Ramp-up Delay)

**取证**：按实际 ucpu/machine 分别裁剪频率样本到初期与后段窗口，区分目标运行加权和全窗口加权，报告覆盖、缺失及零值。短启动可能没有后段窗口；不能把缺数据记为 0MHz 或“频率正常”。

**解释边界**：初期频率低于后段、均频低于观测峰值仅证明频率差异。观测峰值不是硬件上限，差值不是 governor 延迟或热节流证明。需要 DVFS 请求/响应、硬件/策略限制以及同区间关键任务证据；没有请求/限制证据时只能提出候选，也不能反向排除限频。

**建议 [系统层]**：确认频率供给进入关键路径后再评估策略，不能按观察到的频率比例承诺启动收益。

---

### B3. 内存压力

**机制**：内存压力通过多条路径影响启动：
1. **Page cache eviction**: DEX/.so/资源文件需从磁盘重新读取，I/O 从 <1ms 退化到 1-50ms/page
2. **kswapd 竞争**: 后台线程持续回收内存页，占用 CPU 和 IO 带宽
3. **Direct reclaim**: 分配速度超过 kswapd 回收速度时，分配线程（可能是主线程）被迫自己回收内存
4. **LMK/LMKD**: 杀后台进程释放内存，但被杀进程的资源释放消耗 CPU
5. **ZRAM compaction**: swap 到 ZRAM 需要压缩/解压，消耗 CPU

**现象特征**：
- D 状态异常偏高（>10%）
- `memory_pressure_in_range` 返回 pressure_level 为 high/critical
- blocked_function 含 `filemap_fault`、`do_page_fault` 大量出现
- kswapd 线程活跃

**Perfetto 检测**：
- Phase 2.56 `memory_pressure_in_range` skill
- LMK: `instants` table WHERE name='mem.lmk'
- Stdlib: `android.memory.process`, `android.oom_adjuster`
- Counter: `mem.mm.maj_flt`, `mem.mm.reclaim`
- blocked_function for direct reclaim: `__alloc_pages_slowpath`, `try_to_free_pages`, `shrink_*`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 启动前 LMK kills | 0 | 1-3 | >3 |
| Major page faults | <10 | 10-50 | >50 |
| Direct reclaim 主线程 | 0ms | <10ms | >10ms |

**典型影响**: 100-2000ms（极端低内存可使冷启动翻 3-5x）

**关联**: **最重要的交叉因素**。放大几乎所有 App 层 IO 问题(A2,A5,A8,A9,A14,A15)。与 B5(IO竞争) 叠加。kswapd 与 app 竞争 CPU(B1)。详见 C1。

**建议 [系统层]**: 检查后台进程 oom_adj 策略；启动场景下临时提升 Page Cache 优先级；优化 ZRAM 压缩参数。

---

### B4. 热节流

**机制**：设备温度超过阈值时，thermal governor 降低 CPU/GPU 的 `scaling_max_freq`。大核频率可能从 2.84GHz 降到 1.2GHz（~58%下降）。thermal governor 全局降频——不只降热源核心。即使 app 不是热源，仍被波及。连续多次启动、benchmarking 或高环境温度都可能触发。

**候选信号**（只提示 B2/B4，不证明限频或热节流）：
- 大核 cpufreq 最大值远低于设备标称最高频率
- 均频远低于峰值（差距 >10%）
- 低频持续整个启动期间

负载、调速器升频延迟、功耗/厂商策略同样会产生这些信号，频率比值本身不能区分它们。

**Perfetto 检测**（按证据强度）：
1. 限频：cpufreq 频率上限轨道（`power/cpu_frequency_limits`）在启动窗口内出现限频区段 — `invoke_skill("cpu_throttling_in_range")` 的 `limit_evidence`；无该轨道时限频未判定，不能用频率比值代替
2. 触发方：限频前后的散热设备档位（`thermal/cdev_update`）与温度轨道（`thermal/thermal_temperature`、thermal_zone） — `invoke_skill("cpu_frequency_limit_attribution")`；没有这些证据时只能写"限频已发生，触发方未判定"
3. 影响：限频是否约束了启动关键线程所在的 policy 与运行时长

**典型影响**: 50-500ms（CPU密集型启动在 50% 降频下耗时翻倍）

**关联**: 直接限制 B2(频率)。放大所有 CPU 密集型操作(A4,A5,A6,A12,A16)。是 B2 的上层控制。见 C3。

**建议 [系统层]**: 先确认限频与触发方（上面 1、2）；确认由温控触发后，测试场景可在设备冷却后重测，对比正常/限频状态下的启动差异，再评估 thermal governor 参数。

---

### B5. I/O 竞争

**机制**：多因素叠加：① 存储硬件速度（eMMC vs UFS 差 5-10x）② 文件系统开销（ext4 vs f2fs，后者在 SQLite 上快 130-250%）③ dm-verity（每个读取块 hash 验证增加 CPU 开销）④ Metadata encryption 增加路径长度 ⑤ 多进程并发 IO 抢占带宽。

**现象特征**：
- D/DK 状态高 + `io_wait=1` 或 blocked_function 含 IO/page-cache 系统相关
- `io_schedule`、`blk_queue_bio`、`submit_bio_wait` 模式
- B3(内存压力) 解释或排除后仍有高 D/DK + IO/page-cache 证据

**Perfetto 检测**：
- Thread state: D/DK + `io_wait=1` 或 blocked_function 含 `io_schedule`, `blk_*`, `ext4_*`, `f2fs_*`, `dm_*`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| IO 等待总占比 | <5% | 5-15% | >15% |
| 单次 IO 操作 | <5ms | 5-20ms | >20ms |

**典型影响**: 50-500ms

**关联**: 被 B3(内存压力) 放大。F2FS 对 A8(数据库) 场景更友好。dm-verity 的 CPU 开销在 B4(热节流) 时更明显。

**建议 [系统层]**: 评估存储硬件等级；检查 IO 调度器参数；F2FS 优于 ext4。

---

### B6. Binder 事务延迟

**机制**：启动期间大量 Binder 调用（getPackageInfo, getContentProvider, attachApplication）。每次调用包含：① Client 发送(ioctl) ② Dispatch delay(等待 server 端 binder 线程可用) ③ Server 处理(server_dur) ④ Server 端可能等待内部锁(B7) ⑤ Client 等待返回。

**现象特征**：
- SR06 被触发
- S 等待若出现 Binder 函数，需要区分线程池空闲接活与客户端同步事务等待
- `android_binder_txns` 中有长耗时事务

**Perfetto 检测**：
- Stdlib: `android.binder` → `android_binder_txns`
- 关键列: `aidl_name`, `client_dur`, `server_dur`, `client_ts`, `server_ts`, dispatch_delay = `server_ts - client_ts`
- Slice: `AIDL::java::IActivityManager::*::client`, `AIDL::java::IPackageManager::*::client`
- blocked_function: `binder_wait_for_work`, `binder_thread_read`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 主线程 Binder 阻塞总时间 | <50ms | 50-200ms | >200ms |
| 单次 Binder 调用 | <10ms | 10-20ms | >20ms |
| Dispatch delay | <5ms | 5-15ms | >15ms |

**典型影响**: 20-500ms

**解释边界**：`binder_wait_for_work` / `binder_thread_read` 单独不能证明客户端被事务阻塞，可能是服务线程等待工作。高 dispatch delay 是候选现象，需关联目标 transaction、实际 server 线程、调度与池占用；server_dur 长还可能包含计算、等待或嵌套调用，不能直接命名锁竞争。低总量或短事务只限定已观测的直接耗时，不能反向排除 Binder 依赖或说它不在关键路径。

**建议 [系统层]**: 优化 system_server Binder 线程池大小；减少 server 端锁竞争；检查 dispatch delay 趋势。

---

### B7. system_server 锁竞争

**机制**：system_server 中的关键锁：① `WindowManagerGlobalLock`（窗口管理全局锁）② AMS 内部锁（Activity 生命周期管理）③ PMS 锁（包管理器 getPackageInfo 等）。当 app 的 Binder 请求需要获取已被持有的锁，server 端 binder 线程等待，**client 端主线程完全阻塞**。

**现象特征**：
- Binder 调用 server_dur 远大于预期
- `android_monitor_contention` 中 system_server 有记录
- dispatch delay 正常但 server_dur 异常

**Perfetto 检测**：
- Stdlib: `android.monitor_contention` WHERE process_name='system_server'
- 关键列: `blocked_thread_name`, `blocking_thread_name`, `short_blocked_method`, `blocking_src`, `waiter_count`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| system_server 竞争总时间 | <20ms | 20-100ms | >100ms |
| 单次锁等待 | <5ms | 5-20ms | >20ms |
| 并发等待者 | 1-2 | 3-5 | >5 |

**典型影响**: 10-200ms

**关联**: 是 B6(Binder delay) 的 server 端根因。system_server 负载越高(B9,B12)锁竞争越严重。App 应减少启动期间的系统调用。

**建议 [系统层]**: 优化 system_server 锁粒度；检查 `android.anim` 线程是否长持 WMS 锁；Android 17 的 lock-free MessageQueue 可部分缓解。

---

### B8. 进程创建开销 (Zygote Fork)

**机制**：Cold start 进程创建路径：AMS → Zygote socket → `nativeForkAndSpecialize()`(COW fork) → PostFork → `RuntimeInit.commonInit()` → `ActivityThread.main()` → `ActivityThread.attach()` → AMS.attachApplication()。USAP(Android 10+) 预 fork 空进程可跳过部分初始化。

**现象特征**：
- `PostFork`、`ActivityThreadMain` slice 耗时异常
- 冷启动前段固定开销明显

**Perfetto 检测**：
- Slice: `PostFork`, `ActivityThreadMain`, `bindApplication`
- Stdlib: `android.app_process_starts` → `android_app_process_starts`

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| Fork → handleBindApplication | <100ms | 100-300ms | >300ms |
| PostFork | <20ms | 20-50ms | >50ms |

**典型影响**: 50-300ms（纯系统开销，app 无法控制）

**关联**: USAP 预 fork 可减少。B9(后台进程) 和 B12(并发启动) 下 Zygote 也可能忙碌。

**建议 [系统层]**: 启用 USAP；优化 Zygote 预加载类和资源。

---

### B9. 后台进程干扰

**机制**：启动期间其他进程的活动抢占 CPU/IO 资源：后台 sync adapter、job scheduler 任务、GMS core、后台 GC、后台 IO。主线程可能表现为 Runnable(R/R+) 等待；需要结合可运行范围、调度策略和同区间 CPU 交接判断，不能仅凭 R 证明所有可用核心被占满。

**现象特征**：
- Q3(Runnable) >10%
- `sched_latency` 中出现大量 >8ms 的严重延迟
- 同 CPU 上其他进程 CPU 时间占比 >20%

**Perfetto 检测**：
- Thread state: R/R+ 占比
- sched_slice: 检查同一 CPU 上其他进程调度
- Runnable 比例阈值是调查信号，须测量具体等待区间及目标可运行范围；低比例也不能排除短时关键路径干扰

优先检查已有系统证据中的实际 Runnable 区间、同一 ucpu/machine 的切出与紧接任务、逐核忙碌与目标身份。目标曾运行的 CPU 不等于它在等待时唯一可用的 CPU；全窗口其他进程 CPU 总量不是抢占或启动损失。只有对应时序和调度约束得到证据支持，才描述该片段的干扰。

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| Runnable 状态 | <10% | 10-15% | >15% |
| 后台 CPU 占用（目标核心） | <20% | 20-40% | >40% |

**典型影响**: 50-500ms

**关联**: 与 B1(CPU分配) 共同作用。与 B5(IO竞争) 叠加。OEM "app launch boost" 通过提升前台优先级缓解。

**建议 [系统层]**: 启动场景下降低后台进程优先级；推迟后台 job 执行；优化 cgroup 策略。

---

### B10. OEM 定制化开销

**机制**：OEM 添加的服务和框架（OPPO HyperBoost、vivo Jovi、小米 MIUI Boost、Honor TurboX、Samsung Game Booster）本身消耗启动时间（额外 Binder 调用、锁竞争），但也可能加速启动（大核 boost、频率提升、内存预回收）。

**现象特征**：
- 厂商特定的 atrace slice（`ColorOS*`、`HyperBoost*`、`MIUI*`、`Jovi*`、`TurboX*`）
- 异常的 Binder 调用到厂商 service

**Perfetto 检测**：
- Slice 名称匹配厂商特征模式
- 厂商特定 Binder service 调用

**典型影响**: -100ms(优化效果) 到 +100ms(额外开销)

**关联**: OEM 优化框架是 B1(CPU) 和 B2(频率) 的上层控制者。

**建议 [系统层]**: 评估厂商优化框架对目标 app 启动的实际效果。

---

### B11. SELinux 策略开销

**机制**：SELinux enforcing mode 下每次文件访问、IPC 都需要 policy check。通常开销极小（<1us/check），但 policy denial storm 时 audit log 写入可产生可观开销。

**典型影响**: <10ms（通常可忽略）

**关联**: 主要是 boot-time 因素，app-level 启动影响很小。

---

### B12. 并发启动 / Boot Storm

**机制**：设备重启后大量 app 响应 BOOT_COMPLETED 同时启动，或用户快速切换多个 app。CPU 被瓜分、Zygote 串行 fork、system_server 锁竞争加剧、IO 带宽瓜分、内存压力急升 → LMK → 启动-杀-启动循环。

**现象特征**：
- `android_app_process_starts` 5s 窗口内多个启动
- Q3(Runnable) 极高
- 系统整体 CPU 利用率接近 100%

**Perfetto 检测**：
- Stdlib: `android.app_process_starts`
- 检查启动窗口 ±5s 内的其他进程启动

**阈值**：
| 指标 | Good | Warning | Critical |
|------|------|---------|----------|
| 5s 窗口内并发启动 | 1 | 2-3 | >3 |
| 目标 app 子进程数 | 0 | 1 | >1 |

**典型影响**: 100-2000ms

**关联**: 同时放大 B1, B3, B5, B6, B7, B9 所有问题。是系统级最严重的组合因素。

**建议 [系统层]**: 延迟非关键 app 的 BOOT_COMPLETED 分发；限制并发 fork 数；优先保证前台 app 资源。

---

## C. 交叉因素

---

### C1. 内存压力放大 I/O (B3 × A2/A5/A8/A9/A14/A15)

**机制**：正常启动时 DEX/.so/资源可能在 page cache 中（<1ms 读取）。内存压力导致：
1. kswapd 回收 clean page → page cache 被驱逐
2. 下次读取触发 major page fault → 实际磁盘 IO
3. 磁盘 IO 延迟 1-50ms/page → 大量 major fault 累积

**识别方法**: 如果 D 状态高 + `memory_pressure_in_range` 显示 high/critical → 内存压力是 IO 慢的放大器，不是唯一根因。

**结论表述**: "系统内存压力（pressure_score=XX）显著放大了 IO 耗时。DEX 加载、native 库加载等文件访问因 page cache 被回收而退化为实际磁盘读取。建议清理后台进程后重测对比。"

---

### C2. CPU 调度与锁竞争交互 (B1 × A7)

**机制**：Thread A(主线程) 在大核等待锁 → Thread B(持有锁的后台线程) 在小核执行临界区。临界区在小核上执行时间 = 大核的 2-3x → 主线程等待时间相应增加。

**识别方法**: `android_monitor_contention` 中 blocking_thread 的 CPU 核心（通过 `sched_slice` 关联）是否为小核。

**结论表述**: "锁持有者 [thread_name] 被调度到小核(CPU X)，临界区执行时间约为大核的 Nx，放大了主线程的锁等待。"

---

### C3. 热节流复合 CPU 密集启动 (B4 × A4/A5/A12/A16)

**机制**：前一个操作（camera/游戏）使设备温度升高 → thermal governor 降频 → 所有 CPU 密集操作（class verification、JIT、layout inflate、JSON parse）受限制 → 执行时间约为正常的 频率比倒数（如 58%降频 → 2.4x 耗时）→ 更长执行 → 更多热量 → 可能进一步降频。

**识别方法**: 启动窗口内有限频区段（`cpu_throttling_in_range` 的 `limit_evidence`），且触发方证据指向温控（`cpu_frequency_limit_attribution`：散热设备升档与该上限值的写入配对，并有温度上下文）。只有 `cpufreq` 最大值低于标称值是 B2/B4 候选，不是 C3。

**结论表述**:
- 限频与温控触发均有证据："启动窗口内观测到限频（最大深度 XX%，由散热设备升档写入）。" 限频约束了启动关键线程所在 policy 时，才可补充"CPU 密集型操作耗时约为正常的 Yx（按频率比估算）"；建议设备冷却后重测对比。
- 有限频、触发方未判定："启动窗口内观测到限频（最大深度 XX%），触发方（温控或功耗/厂商策略）未判定。"
- 只有频率比值："大核最高频率为本 trace 峰值的 XX%，仅为频率观测；是否限频未判定。"

---

### C4. DEX 编译模式影响 (A5 × A12)

| 模式 | 启动影响 | 机制 |
|------|---------|------|
| `speed` | 最快 | 全量 AOT |
| `speed-profile` | 快（~30% faster than verify）| Baseline Profile 指导的选择性 AOT + DEX 布局优化 |
| `quicken` | 中等 | 验证 + 指令优化（Android 11-）|
| `verify` | 最慢 | 仅验证，依赖解释器+JIT |

**首次安装 vs 后续启动**：首次安装可能只有 `verify` 状态（cloud profile 尚未下发）→ 启动最慢。Startup Profile 额外通过 DEX 布局优化减少 page fault（15-30%）。

---

## D. 速查表

---

### D1. 从现象到根因的映射表

| 现象 | 候选方向 | 进一步确认所需证据 |
|------|---------|------------------|
| S 高且含 futex 路径 | 同步等待，可能关联 A7/A9 | 同一等待区间的对象/持有者/调用栈；也可能是条件变量或 join |
| S 高且含 Binder 函数 | B6/B7 或线程池空闲 | 目标客户端 transaction/reply 与服务端处理链，不能只看 wchan |
| D/DK 且含 io_schedule | A2/A8/B5 候选 | io_wait、文件/块 IO 与目标等待区间关联 |
| filemap/page fault 活动 | A5/A14/B3 等候选 | 文件页、回收原因、实际读取及目标区间；计数不证明读盘/内存压力 |
| nanosleep 等待 | A17 候选 | 同一事件调用栈/实现对应，不能直接认定 Java Thread.sleep |
| Running 高且自定义 inflate 名称 | A4/A18 或其他计算 | 实际函数实现及逐实例状态，模拟名称不能证明 View 创建 |
| Running 高且非框架 slice | A16 或其他运行成本 | 实现、调用链、运行状态分解；不能由名称证明 SDK/业务身份 |
| 已可靠分类的小核运行比例高 | B1 候选 | 实际容量、目标任务需求和放置约束；占比不证明错误摆核 |
| Runnable 高 | B9/B12 等候选 | 目标可运行范围、同区间资源与调度交接；低总量不排除局部影响 |
| bindApplication 长 | A1/A11/A5 等候选 | 窗口裁剪、子事件、运行/等待分解及实现 |
| JIT 信号 | A12/A5 候选 | 同区间任务、CPU 和关键路径关联，后台量不等于争抢 |
| 观测频率低于标称/峰值 | B2/B4 等候选 | 实际请求、硬件/策略/热限制与频率响应；比例不证明热节流 |

### D2. blocked_function → 根因速查

`blocked_function` 是 `sched/sched_blocked_reason` 提供的 kernel wchan 单帧，不是完整栈。解释 D-state、`io_wait` 或下列函数族时，优先调用 `lookup_knowledge("thread-state-blocked-reason")` 获取证据强度和下一步补证规则。

| blocked_function 模式 | 候选方向 | 说明与缺口 |
|----------------------|---------|------|
| `futex_wait*` | 同步等待候选 | 可能是锁、条件变量或 join；需对象/持有者/调用栈，不能定位 Java API |
| `__mutex_lock*`, `pthread_mutex_lock*` | A7(锁) | Native mutex |
| `binder_wait_for_work`, `binder_thread_read` | Binder 路径或空闲工作线程 | 需 transaction/reply 及线程角色，不能直接当客户端 IPC 阻塞 |
| `do_page_fault`, `filemap_fault`, `filemap_read` | A2(IO)/A5(DEX)/A14(.so)/B3(内存压力) | Page fault / page-cache read → 可能等待文件页 |
| `io_schedule` | A2(IO)/A8(数据库)/B5(IO竞争) | I/O 调度等待候选；命名为数据库/Provider 根因需业务证据 |
| `wait_on_page_bit` | 页状态等待 | 等待的页标志和操作类型尚需上下文，不能单独认定读取完成等待 |
| `ext4_*`, `f2fs_*` | A2(IO)/A8(数据库) | 文件系统操作候选 |
| `SyS_fsync`, `do_fsync` | A8(数据库)/A9(SP) | fsync 刷盘候选，需 SQLite/SP/Provider 证据补强 |
| `hrtimer_nanosleep`, `clock_nanosleep` | nanosleep 路径 | Java/native 调用来源未知，需对应栈/事件 |
| `epoll_wait` | 事件等待 | 是否预期空闲需任务/消息与deadline上下文，不能自动排除问题 |
| `art::gc::*`, `SuspendAll` | A6 等运行时活动候选 | 区分后台回收、暂停及其他挂起原因，并关联目标线程 |
| `__alloc_pages_slowpath`, `try_to_free_pages`, `shrink_*` | 分配/回收路径候选 | 单帧名称不覆盖完整路径；核实实际回收事件及目标线程 |
| `dm_*` | B5(IO竞争) | dm-verity / dm-crypt |
| `inet_*`, `tcp_*` | A3(网络) | 网络调用 |

### D3. 启动诊断阈值参考 (android_startup.sql)

实际阈值以当前工具/解析器版本为准；触发仅确定调查优先级，不代表原因已证实，未触发也不构成排除。

| 指标与初筛阈值 | 观测信号 | 候选类别 |
|------|------|---------|
| Runnable state >15% | 可运行等待较高，需调度上下文 | B1, B9 |
| Interruptible sleep (S) >2900ms | 异常等待 | A7, A9, B6 |
| D/DK >450ms | 不可中断等待较高，需 IO/回收关联才能归因 | A2, B3, B5 |
| OpenDexFilesFromOat >20% duration | DEX 加载慢 | A5 |
| bindApplication >1250ms | 应用绑定慢 | A1, A11 |
| View inflation >450ms | 布局膨胀慢 | A4 |
| ResourcesManager#getResources >130ms | 资源加载慢 | A15 |
| Class verification >15% duration | 类验证过多 | A5 |
| JIT activity >100ms | JIT 编译开销 | A12 |
| Lock contention >20% duration | 锁竞争严重 | A7 |
| Monitor contention >15% duration | Java monitor 竞争 | A7 |
| JIT compiled methods >65 | 过多 JIT 编译 | A12 |
| Broadcast dispatched >15 | 广播过多 | A13 |
| Binder transaction >20ms | 单次 Binder 慢 | B6 |

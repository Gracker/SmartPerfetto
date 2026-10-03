# SmartPerfetto Skills 开发指南

## 目录结构

```
skills/
├── atomic/                  # 原子能力 Skills (单一 SQL 查询)
│   ├── cpu_topology_detection.skill.yaml # CPU 拓扑检测
│   ├── rendering_pipeline_detection.skill.yaml # 渲染管线检测
│   ├── vrr_detection.skill.yaml   # VRR/LTPO 检测
│   ├── game_fps_analysis.skill.yaml # 游戏帧率分析
│   ├── gpu_metrics.skill.yaml     # GPU 指标分析
│   └── ...
├── composite/               # 组合 Skills (多步骤分析，所有设备通用)
│   ├── startup_analysis.skill.yaml    # 启动分析
│   ├── scrolling_analysis.skill.yaml  # 滑动卡顿分析
│   ├── memory_analysis.skill.yaml     # 内存分析
│   ├── cpu_analysis.skill.yaml        # CPU 分析
│   ├── binder_analysis.skill.yaml     # Binder 分析
│   ├── thermal_throttling.skill.yaml  # 热节流分析
│   ├── io_pressure.skill.yaml         # IO 压力分析
│   ├── navigation_analysis.skill.yaml # 界面跳转分析
│   ├── surfaceflinger_analysis.skill.yaml # SF 合成分析
│   └── ...
├── comparison/              # 对比分析 Skills
│   └── multi_trace_result_comparison.skill.yaml
├── pipelines/               # 渲染管线检测 Skills (含教学内容)
│   ├── android_view_standard_blast.skill.yaml
│   ├── surfaceview_blast.skill.yaml
│   ├── flutter_surfaceview_skia.skill.yaml
│   └── ...
├── deep/                    # 深度分析 Skills (调用栈级)
│   ├── cpu_profiling.skill.yaml
│   └── callstack_analysis.skill.yaml
├── modules/                 # 模块专家 Skills (按架构层组织)
│   ├── app/                 # 应用层模块
│   │   └── third_party_module.skill.yaml
│   ├── framework/           # 框架层模块
│   │   ├── ams_module.skill.yaml
│   │   ├── surfaceflinger_module.skill.yaml
│   │   ├── input_module.skill.yaml
│   │   └── art_module.skill.yaml
│   ├── kernel/              # 内核层模块
│   │   ├── scheduler_module.skill.yaml
│   │   └── binder_module.skill.yaml
│   └── hardware/            # 硬件层模块
│       ├── cpu_module.skill.yaml
│       └── gpu_module.skill.yaml
├── vendors/                 # 厂商定制 Skills (override)
│   ├── pixel/              # Google Pixel
│   ├── samsung/            # Samsung OneUI
│   └── ...
├── fragments/               # 可复用 SQL 片段 (CTEs)
├── docs/                    # SOP 文档
│   ├── startup.sop.md
│   └── scrolling.sop.md
└── custom/                  # 用户自定义 Skills (可选)
```

Skill inventory 以 `backend/skills/**/*.skill.yaml` 文件树为准，不要在文档或代码中写死总数。需要当前统计时运行：

```bash
rg --files backend/skills | rg '\.skill\.yaml$' | wc -l
```

## 可用 Skills 一览

| Skill ID | 名称 | 分类 | 描述 |
|----------|------|------|------|
| `startup_analysis` | 应用启动分析 | app_lifecycle | 冷启动、温启动、热启动性能分析 |
| `scrolling_analysis` | 滑动卡顿分析 | rendering | 滑动流畅度、帧率、Jank 原因 |
| `click_response_analysis` | 点击响应分析 | input | 输入事件处理延迟 |
| `navigation_analysis` | 界面跳转分析 | app_lifecycle | Activity/Fragment 跳转性能 |
| `memory_analysis` | 内存分析 | memory | GC、堆内存、内存泄漏 |
| `cpu_analysis` | CPU 分析 | cpu | 线程调度、核心分布 |
| `binder_analysis` | Binder 分析 | ipc | IPC 调用延迟 |
| `surfaceflinger_analysis` | SurfaceFlinger 分析 | rendering | 帧合成、GPU、VSYNC |

### 扩展 Skills (Atomic/Deep)

| Skill ID | 名称 | 类型 | 描述 |
|----------|------|------|------|
| `cpu_topology_detection` | CPU 拓扑检测 | atomic | 动态识别 Prime/Big/Mid/Little 核心 |
| `rendering_pipeline_detection` | 渲染管线检测 | atomic | 识别 View/Compose/Flutter/WebView/游戏等管线 |
| `vrr_detection` | VRR 检测 | atomic | 可变刷新率 (LTPO) 使用情况分析 |
| `game_fps_analysis` | 游戏帧率分析 | atomic | 30/45/60/90/120fps 游戏稳定性 |
| `gpu_metrics` | GPU 指标分析 | atomic | GPU 频率、利用率、渲染耗时 |
| `cpu_frequency_limit_attribution` | CPU 限频归因 | composite | 从 cpufreq policy 限频事件出发：谁触发、限频前负载、异常线程、厂商信号候选 |
| `cpu_freq_limit_timeline` | CPU 限频时间线 | atomic | 限频概览、去抖动限频区段与逐次限频变更事件 |
| `thermal_cooling_device_timeline` | 散热设备状态时间线 | atomic | 内核 cooling device 档位区段与转换；缺失不等于未热控 |
| `thermal_throttling` | 热节流分析 | composite | 温度监控与频率限制分析 |
| `io_pressure` | IO 压力分析 | composite | 系统 IO 负载与阻塞分析 |
| `cpu_profiling` | CPU Profiling | deep | 深度 CPU 调度与负载分析 |
| `callstack_analysis` | 调用栈分析 | deep | 函数级性能瓶颈分析 |

---

## 模块专家 Skills

### 概述

`modules/` 下的 Skill 按 Android 架构层（App / Framework / Kernel / Hardware）组织，每个文件覆盖一个组件。它们是普通的 composite Skill：和其他 Skill 一样通过 `invoke_skill` 执行，结果以 DataEnvelope 返回，发现通过 `diagnostics` / `synthesize` 产出，没有单独的调度协议。

### 模块 Skills 一览

| 模块 | 层级 | 组件 | 能力 |
|------|------|------|------|
| `scheduler_module` | kernel | Scheduler | 线程调度延迟、CPU 利用率、Runnable 分析 |
| `binder_module` | kernel | Binder | Binder 阻塞调用、跨进程延迟 |
| `surfaceflinger_module` | framework | SurfaceFlinger | 帧卡顿、GPU 合成时序 |
| `ams_module` | framework | AMS | 启动时序、Activity 生命周期、ANR |
| `input_module` | framework | Input | 点击响应、输入派发延迟 |
| `art_module` | framework | ART | GC 暂停、JIT 编译 |
| `cpu_module` | hardware | CPU | CPU 频率、热节流、大小核分布 |
| `gpu_module` | hardware | GPU | GPU 渲染、频率、利用率 |
| `third_party_module` | app | ThirdParty | 应用线程分析、主线程阻塞 |

### 模块 Skill YAML 格式

模块 Skill 在标准 Skill 基础上增加了 `module` 字段：

```yaml
name: scheduler_module
version: "1.0"
type: composite
category: kernel

meta:
  display_name: "内核调度分析"
  description: "分析线程调度延迟、CPU 利用率和大小核分配"
  tags: ["kernel", "scheduler", "cpu", "runnable"]

# 模块元数据 - 标明所属架构层和组件
module:
  layer: kernel                    # app | framework | kernel | hardware
  component: Scheduler             # 组件名称
  subsystems:                      # 子系统列表
    - runqueue
    - cfs
    - core_affinity

# 标准 Skill 字段...
steps:
  - id: runnable_analysis
    type: atomic
    sql: |
      SELECT thread_state.utid, thread.name AS thread_name, SUM(thread_state.dur)/1e6 AS runnable_ms
      FROM thread_state
      JOIN thread USING (utid)
      WHERE thread_state.state = 'R'
      GROUP BY thread_state.utid, thread.name
      ORDER BY runnable_ms DESC
      LIMIT 20
    save_as: runnable_data
    synthesize: true
```

### 创建新模块 Skill

1. 在 `skills/modules/{layer}/` 下创建 YAML 文件
2. 定义 `module` 字段标识层级和组件
3. 用标准 Skill 字段（`steps`、`diagnostics`、`synthesize`）产出证据和发现

---

## CLI 工具

### 列出所有 Skills

```bash
cd backend
npx tsx src/cli/index.ts list
```

输出示例（仅展示片段；实际数量和版本以命令输出为准）：
```
SmartPerfetto Skills

IPC:
  binder_analysis
    Binder 分析
    分析 Binder IPC 调用延迟和跨进程通信性能

RENDERING:
  scrolling_analysis
    滑动卡顿分析
    分析应用滑动流畅度、帧率、Jank 原因
    [sop]
...
```

### 验证 Skill 语法

```bash
# 先进入 backend
cd backend

# 验证指定 Skill
npx tsx src/cli/index.ts validate startup_analysis

# 验证所有 Skills
npm run validate:skills
```

验证内容：
- YAML 语法正确性
- 必需字段完整性 (name, version, steps)
- SQL 语法验证
- 变量引用正确性 (`${xxx}`)
- 步骤引用有效性 (save_as, iterator source, diagnostic inputs)

### 测试 Skill 执行

```bash
# 先进入 backend
cd backend

# 测试指定 Skill
npx tsx src/cli/index.ts test startup_analysis --trace /path/to/trace.perfetto

# 指定包名
npx tsx src/cli/index.ts test startup_analysis --trace /path/to/trace.perfetto --package com.example.app

# Vendor override 由 trace/runtime 上下文选择；当前 test 子命令没有 --vendor 参数
```

## API 端点

### Skill 执行 API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/skills` | 列出所有可用 Skills |
| GET | `/api/skills/:skillId` | 获取 Skill 详情 |
| POST | `/api/skills/execute/:skillId` | 执行指定 Skill |
| POST | `/api/skills/analyze` | 自动检测意图并执行 |
| POST | `/api/skills/detect-intent` | 检测问题对应的 Skill |
| POST | `/api/skills/detect-vendor` | 从 trace metadata 解析厂商 / SoC / OS（`trace_vendor@1`） |

#### 执行 Skill 示例

```bash
# 执行指定 Skill
curl -X POST http://localhost:3000/api/skills/execute/startup_analysis \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "xxx",
    "package": "com.example.app"
  }'

# 自动分析（根据问题自动选择 Skill）
curl -X POST http://localhost:3000/api/skills/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "xxx",
    "question": "分析应用启动性能",
    "package": "com.example.app"
  }'
```

### Skill 管理 API (Admin)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/admin/skills` | 列出所有 Skills (含详情) |
| GET | `/api/admin/skills/:id` | 获取 Skill 完整定义 |
| POST | `/api/admin/skills` | 创建新 Skill |
| PUT | `/api/admin/skills/:id` | 更新 Skill |
| DELETE | `/api/admin/skills/:id` | 删除 Skill (仅 custom) |
| POST | `/api/admin/skills/validate` | 验证 Skill YAML |
| POST | `/api/admin/skills/reload` | 重新加载所有 Skills |
| GET | `/api/admin/vendors` | 列出所有厂商 |
| GET | `/api/admin/vendors/:vendor/overrides` | 获取厂商 Overrides |

#### 权限控制

| 类型 | 路径 | 权限 |
|------|------|------|
| Atomic Skills | `skills/atomic/` | 只读 |
| Composite Skills | `skills/composite/` | 只读 |
| Deep Skills | `skills/deep/` | 只读 |
| Module Skills | `skills/modules/` | 只读 |
| Vendor Overrides | `skills/vendors/` | 只读 |
| Custom Skills | `skills/custom/` | 完全可编辑 |

## 快速开始

### 1. 创建新 Skill

每个 Skill 必须有一个 `xxx.skill.yaml` 机器可执行配置。只有确实需要
运行时教学或维护说明时，才增加可选 SOP；多数 atomic Skill 不需要一对一 SOP。

### 2. Skill YAML 格式

下面是一个最小的 composite Skill，覆盖最常用的字段。完整结构、全部 step 类型、
参数替换和显示配置以 [`docs/reference/skill-system.md`](../../docs/reference/skill-system.md)
为准；`npm run validate:skills` 会拒绝不符合当前 schema 的写法。

```yaml
# skills/composite/startup_overview_example.skill.yaml
name: startup_overview_example
version: "1.0.0"
type: composite
category: app_lifecycle
tier: B

meta:
  display_name: "应用启动概览"
  description: "列出启动事件并对慢启动给出诊断"
  tags: [startup, launch]

triggers:
  keywords:
    zh: [启动, 冷启动]
    en: [startup, launch]

prerequisites:
  modules:
    - android.startup.startups

inputs:
  - name: package
    type: string
    required: false
  - name: slow_startup_ms
    type: number
    required: false
    description: "慢启动阈值 (ms)"

steps:
  - id: startups
    type: atomic
    sql: |
      SELECT startup_id, ts AS start_ts, ts + dur AS end_ts,
             dur / 1e6 AS dur_ms, package, startup_type
      FROM android_startups
      WHERE ('${package}' = '' OR package = '${package}' OR package GLOB '${package}:*')
      ORDER BY ts
    display:
      layer: list
      title: "启动事件"
      columns:
        - { name: startup_id, type: number }
        - { name: start_ts, type: timestamp, clickAction: navigate_timeline }
        - { name: dur_ms, type: duration }
        - { name: startup_type, type: string }

  # 对每一行调用子 Skill；item_params 的值是当前行的列名
  - id: per_startup
    type: iterator
    source: startups
    item_skill: startup_main_thread_slices_in_range
    item_params:
      startup_id: startup_id
      start_ts: start_ts
      end_ts: end_ts
    max_items: 3
    display:
      layer: deep

  # 规则直接用参数名读阈值；作用域里没有 inputs 对象
  - id: diagnose
    type: diagnostic
    inputs: [startups]
    rules:
      - condition: "startups.data[0]?.dur_ms > (slow_startup_ms ?? 2000)"
        severity: critical
        confidence: high
        diagnosis: "首个启动耗时 ${startups.data[0].dur_ms}ms，超过阈值"
        suggestions:
          - "检查 Application.onCreate 耗时"
          - "优化 ContentProvider 初始化"
        evidence_fields:
          - startups.data[0]?.dur_ms
```

### 3. SOP 文档格式

```markdown
# 启动分析 SOP

## 概述
本 SOP 用于分析 Android 应用启动性能。

## 分析目标
- 启动总耗时
- 各阶段耗时分解
- 主线程阻塞原因
- CPU 资源使用情况

## 分析步骤

### Step 1: 获取启动事件
从 `android_startups` 表获取所有启动事件...

### Step 2: 分析关键阶段
检查以下关键阶段的耗时...

## 判断标准

| 指标 | 优秀 | 良好 | 警告 | 严重 |
|------|------|------|------|------|
| 冷启动时间 | <500ms | 500-1000ms | 1-2s | >2s |

## 常见问题及优化建议

### 问题1: 启动时间过长
**可能原因：**
1. Application.onCreate 耗时过长
2. ContentProvider 初始化慢
3. 主线程 IO 操作

**优化建议：**
1. 延迟初始化非必要组件
2. 使用 App Startup 库
3. 将 IO 移到后台线程
```

## 厂商定制

### 继承机制

厂商 override 声明它针对的基础 Skill，并列出该厂商特有的附加步骤。附加步骤不会自动
执行：运行时只把 override 的厂商名、显示名和附加步骤 id 作为提示挂在基础 Skill 的结果上
（见下文）。顶层字段只有 `extends`、`version`、`meta`、`vendor_detection`、
`additional_steps`，`validate:skills` 拒绝其他字段，并要求至少一个附加步骤。

```yaml
# skills/vendors/oppo/startup.override.yaml
extends: composite/startup_analysis
version: "1.0.0"

meta:
  display_name: "OPPO ColorOS 启动分析"
  vendor: oppo

# 记录厂商 trace 特征的元数据；运行时按目录名 / meta.vendor 选 override
vendor_detection:
  signatures:
    - pattern: "*ColorOS*"
      confidence: high

additional_steps:
  - id: check_coloros_boost
    name: "检查 ColorOS 加速引擎"
    sql: |
      SELECT s.name AS slice_name, s.dur/1e6 AS dur_ms
      FROM slice s
      WHERE s.name GLOB '*ColorOS*' OR s.name GLOB '*HyperBoost*'
```

### 厂商识别

厂商由 `backend/src/services/traceVendor/traceVendorResolver.ts` 从 trace 的
`metadata`（`android_device_manufacturer`、`android_build_fingerprint` 的 brand、
`android_soc_model`）按封闭映射表解析，不扫描 slice 名称，结果按 trace 身份缓存。
`invoke_skill` 在 Skill 自身查询完成后，按 `[OEM, SoC]` 顺序（例如 `xiaomi`、
`qualcomm`）查找本目录下的 override，把 `vendorOverride` 作为提示挂在结果上；
override 的步骤不会自动执行，等待有上限，超时或失败时不挂提示。override 由目录名
/ `meta.vendor` 选中，`vendor_detection.signatures` 只是记录厂商 trace 特征的元数据。

`vendor` 取值：`pixel`、`xiaomi`、`oppo`、`vivo`、`honor`、`huawei`、`samsung`、
`aosp`（AOSP / generic 构建）、`other`（识别到品牌但不在映射表中，如 nubia）、
`unknown`（trace 没有设备身份信息）。HarmonyOS 是 OS 而不是厂商。

### 厂商特有 Trace Tag

| 厂商 | 常见 Trace Tag | 用途 |
|------|---------------|------|
| OPPO | `ColorOS*`, `HyperBoost*` | 系统加速引擎 |
| vivo | `OriginOS*`, `Jovi*` | 智能优化 |
| 小米 | `MIUI*`, `Boost*` | MIUI 优化 |
| Honor | `MagicOS*`, `TurboX*` | GPU Turbo |
| MTK | `MTK*`, `MTKFB*` | 联发科平台 |
| Qualcomm | `QTI*`, `Adreno*` | 高通平台 |

## 变量说明

在 SQL 中可以使用以下变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `${package}` | 目标应用包名 | `com.example.app` |
| `${item.xxx}` | iterator 调用子 Skill 时的当前行 | `${item.startup_id}` |
| `${vendor}` | 解析出的厂商 id（仅 REST `/api/skills/execute`、`/api/skills/analyze` 传入；`invoke_skill` 不传，当前也没有 Skill 引用） | `oppo` |
| `${result.xxx.yyy}` | 之前步骤的结果引用 | `${result.startups.0.startup_id}` |

**重要提示**:
- **时间戳精度问题**: Perfetto 的时间戳是纳秒级大整数，超过 JavaScript 安全整数范围 (2^53)。
  在 iterator 子 Skill 中，**不要直接使用 `${item.ts}`**，应使用子查询获取时间戳：
  ```sql
  -- 错误: ${item.ts} 可能因精度丢失而截断
  AND s.ts >= ${item.ts}

  -- 正确: 使用子查询保持精度
  AND s.ts >= (SELECT ts FROM android_startups WHERE startup_id = ${item.startup_id})
  ```
- **主线程识别**: 使用 `t.tid = p.pid` 而非 `t.name = 'main'`，因为主线程名称通常是包名后缀

## Perfetto UI 跳转链接

为了支持用户点击时间戳直接跳转到 Perfetto UI 中的对应位置，查询结果应包含 `ts_str` 和 `dur_str` 字段：

```sql
SELECT
  s.name as slice_name,
  s.dur / 1e6 as dur_ms,              -- 用于显示（毫秒）
  printf('%d', s.ts) as ts_str,        -- 原始纳秒时间戳（字符串）
  printf('%d', s.dur) as dur_str       -- 原始纳秒时长（字符串）
FROM slice s
...
```

**前端构建跳转链接**:
```javascript
// 使用本地 Perfetto UI
const url = `http://localhost:10000/#!/?ts=${row.ts_str}&dur=${row.dur_str}`;

// 或使用官方 Perfetto UI（需要先上传 trace）
const url = `https://ui.perfetto.dev/#!/?ts=${row.ts_str}&dur=${row.dur_str}`;

// 可选参数: visStart, visEnd 设置可视区域
const url = `...?ts=${ts_str}&dur=${dur_str}&visStart=${startNs}&visEnd=${endNs}`;
```

**支持的 URL 参数**（参考 [Perfetto Deep Linking](https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui)）:
| 参数 | 说明 |
|------|------|
| `ts` | 时间戳（纳秒） |
| `dur` | 持续时间（纳秒） |
| `visStart`, `visEnd` | 可视区域范围 |
| `pid`, `tid` | 进程/线程 ID |
| `query` | 自动执行的 SQL 查询 |

## Skill 加载顺序

1. 加载 `atomic/` 目录下的原子 Skills
2. 加载 `composite/` 目录下的组合 Skills
3. 加载 `deep/` 目录下的深度分析 Skills
4. 加载 `modules/` 目录下的模块专家 Skills
5. 加载 `vendors/` 下全部厂商 override（按 `extends` 的 base Skill 索引；与具体 trace 无关）
6. 加载 `custom/` 目录下的自定义 Skills（如果存在）

厂商识别发生在分析时而非加载时，见上文“厂商识别”。

## 最佳实践

1. **保持 SQL 简洁** - 每个 step 做一件事
2. **设置合理阈值** - 基于真实数据统计
3. **添加 SOP 文档** - 让其他人理解你的分析逻辑
4. **厂商定制适度** - 只覆盖必要的部分
5. **版本管理** - 更新时递增版本号
6. **使用 optional** - 非必需的步骤设置 `optional: true`
7. **处理空结果** - 使用 `on_empty` 提供友好提示

## 贡献

欢迎提交新的 Skill 或改进现有 Skill！

1. Fork 本仓库
2. 根据 Skill 类型创建文件：
   - 单一查询 → `skills/atomic/`
   - 多步骤分析 → `skills/composite/`
   - 深度分析 → `skills/deep/`
   - 模块专家 → `skills/modules/{layer}/`
3. 添加对应的 SOP 文档到 `skills/docs/`
4. 在 `backend/` 运行 `npm run validate:skills` 验证
5. 提交 Pull Request

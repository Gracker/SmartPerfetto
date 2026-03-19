# SmartPerfetto Skills 开发指南

## 目录结构

```
skills/
├── atomic/                  # 原子能力 Skills (单一 SQL 查询)
│   ├── cpu_topology_detection.skill.yaml # CPU 拓扑检测
│   ├── rendering_arch_detection.skill.yaml # 渲染架构检测
│   ├── vrr_detection.skill.yaml   # VRR/LTPO 检测
│   ├── game_fps_analysis.skill.yaml # 游戏帧率分析
│   ├── gpu_metrics.skill.yaml     # GPU 指标分析
│   └── ...                  # 共 80 个原子技能
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
│   └── ...                  # 共 28 个组合技能
├── pipelines/               # 渲染管线检测 Skills (含教学内容)
│   ├── android_view_standard_blast.skill.yaml
│   ├── surfaceview_blast.skill.yaml
│   ├── flutter_surfaceview_skia.skill.yaml
│   └── ...                  # 共 30 个管线技能
├── deep/                    # 深度分析 Skills (调用栈级)
│   ├── cpu_profiling.skill.yaml
│   └── callstack_analysis.skill.yaml
├── modules/                 # 模块专家 Skills (跨领域专家系统)
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
| `rendering_arch_detection` | 渲染架构检测 | atomic | 识别 Flutter/Unity/WebView/HWUI |
| `vrr_detection` | VRR 检测 | atomic | 可变刷新率 (LTPO) 使用情况分析 |
| `game_fps_analysis` | 游戏帧率分析 | atomic | 30/45/60/90/120fps 游戏稳定性 |
| `gpu_metrics` | GPU 指标分析 | atomic | GPU 频率、利用率、渲染耗时 |
| `thermal_throttling` | 热节流分析 | composite | 温度监控与频率限制分析 |
| `io_pressure` | IO 压力分析 | composite | 系统 IO 负载与阻塞分析 |
| `cpu_profiling` | CPU Profiling | deep | 深度 CPU 调度与负载分析 |
| `callstack_analysis` | 调用栈分析 | deep | 函数级性能瓶颈分析 |

---

## 模块专家系统 (Cross-Domain Expert System)

### 概述

模块专家系统是 SmartPerfetto 的高级分析架构，模拟真实 Android 性能工程师的分析流程：

```
                    跨领域专家 (TypeScript "指挥官")
    ┌─────────────────┬─────────────────┬─────────────────┐
    │ PerformanceExpert│   PowerExpert   │  ThermalExpert  │
    │ (卡顿/启动/延迟)  │ (功耗/待机/唤醒) │ (温度/热节流)   │
    └────────┬─────────┴────────┬────────┴────────┬────────┘
             │                   │                 │
             │       对话协议 (Query/Response/Suggestion)
             │                   │                 │
    ┌────────▼───────────────────▼─────────────────▼────────┐
    │                    模块专家 (YAML Skills)              │
    ├─────────────┬─────────────┬─────────────┬─────────────┤
    │  App 层     │ Framework 层 │ Kernel 层   │ Hardware 层 │
    │ ThirdParty  │ AMS/SF/Input │ Sched/Binder│ CPU/GPU     │
    └─────────────┴─────────────┴─────────────┴─────────────┘
```

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

模块 Skill 在标准 Skill 基础上增加了 `module` 和 `dialogue` 字段：

```yaml
name: scheduler_module
version: "1.0"
type: composite
category: kernel

meta:
  display_name: "内核调度分析"
  description: "分析线程调度延迟、CPU 利用率和大小核分配"
  tags: ["kernel", "scheduler", "cpu", "runnable"]

# 模块元数据 - 标识这是一个模块专家
module:
  layer: kernel                    # app | framework | kernel | hardware
  component: Scheduler             # 组件名称
  subsystems:                      # 子系统列表
    - runqueue
    - cfs
    - core_affinity
  relatedModules:                  # 关联模块
    - hardware_cpu
    - framework_ams

# 对话接口 - 定义模块能回答的问题
dialogue:
  # 能力列表
  capabilities:
    - id: thread_scheduling_delay
      questionTemplate: "Why was thread {tid} delayed between {start_ts} and {end_ts}?"
      requiredParams: [tid, start_ts, end_ts]
      description: "Analyze why a specific thread had scheduling delays"

    - id: cpu_utilization
      questionTemplate: "What is the CPU utilization for package {package}?"
      requiredParams: [package]
      optionalParams: [start_ts, end_ts]

  # 结构化发现模式
  findingsSchema:
    - id: high_runnable_time
      severity: warning
      titleTemplate: "Thread scheduling delay: {delay_ms}ms in runnable state"
      descriptionTemplate: "Thread {tid} waited {delay_ms}ms in runnable state"
      evidenceFields: [tid, delay_ms, core_type, waker_thread]

  # 建议模式 - 引导跨领域专家进行下一步分析
  suggestionsSchema:
    - id: check_binder_waker
      condition: "waker_process != package"      # 触发条件
      targetModule: binder_module                # 建议的下一个模块
      questionTemplate: "What Binder calls did {waker_process} make to {package}?"
      paramsMapping:                             # 参数映射
        caller: waker_process
        callee: package
      priority: 1

# 标准 Skill 字段...
steps:
  - id: runnable_analysis
    type: atomic
    sql: |
      SELECT utid, thread.name, SUM(dur)/1e6 AS runnable_ms
      FROM thread_state
      JOIN thread USING (utid)
      WHERE state = 'R'
      GROUP BY utid
      ORDER BY runnable_ms DESC
      LIMIT 20
    save_as: runnable_data
    synthesize: true
```

### 对话协议

跨领域专家通过结构化消息与模块专家交互：

**Query (查询)**:
```typescript
{
  queryId: "q_001",
  targetModule: "scheduler_module",
  questionId: "cpu_utilization",
  params: { package: "com.example.app" },
  timeRange: { start: 123456789, end: 987654321 }
}
```

**Response (响应)**:
```typescript
{
  queryId: "q_001",
  success: true,
  data: { ... },
  findings: [
    {
      id: "high_runnable_time",
      severity: "warning",
      title: "Thread scheduling delay: 50ms",
      evidence: { tid: 1234, delay_ms: 50 }
    }
  ],
  suggestions: [
    {
      targetModule: "binder_module",
      questionTemplate: "What Binder calls blocked thread?",
      priority: 1
    }
  ],
  confidence: 0.85
}
```

### 假设管理

跨领域专家通过假设-验证循环找到根因：

1. **初始假设**: 根据用户查询和初步数据生成假设
2. **证据收集**: 向模块专家查询收集支持/反驳证据
3. **置信度更新**: 根据证据更新假设置信度
4. **决策**: 当置信度超过阈值时确认根因，或继续探索

```
假设: "卡顿由主线程 Binder 调用导致"
  ├─ [+0.3] scheduler_module: 主线程 Runnable 等待 50ms
  ├─ [+0.4] binder_module: 发现 10 次同步 Binder 调用
  └─ [-0.1] art_module: 无 GC 暂停
最终置信度: 0.6 → 继续收集证据...
```

### 创建新模块 Skill

1. 在 `skills/modules/{layer}/` 下创建 YAML 文件
2. 定义 `module` 字段标识层级和组件
3. 定义 `dialogue.capabilities` 声明能回答的问题
4. 定义 `dialogue.findingsSchema` 结构化输出格式
5. 定义 `dialogue.suggestionsSchema` 引导后续分析

---

## CLI 工具

### 列出所有 Skills

```bash
npm run skill:list
```

输出示例：
```
SmartPerfetto Skills

Found 8 skills

IPC:
  binder_analysis
    Binder 分析 v1.0.0
    分析 Binder IPC 调用延迟和跨进程通信性能

RENDERING:
  scrolling_analysis
    滑动卡顿分析 v1.0.0
    分析应用滑动流畅度、帧率、Jank 原因
    [sop]
...
```

### 验证 Skill 语法

```bash
# 验证指定 Skill
npm run skill:validate startup_analysis

# 验证所有 Skills
npm run skill:validate
```

验证内容：
- YAML 语法正确性
- 必需字段完整性 (name, version, steps)
- SQL 语法验证
- 变量引用正确性 (`${xxx}`)
- 步骤引用有效性 (save_as, for_each)

### 测试 Skill 执行

```bash
# 测试指定 Skill
npm run skill:test startup_analysis -- --trace /path/to/trace.perfetto

# 指定包名
npm run skill:test startup_analysis -- --trace /path/to/trace.perfetto --package com.example.app

# 指定厂商
npm run skill:test startup_analysis -- --trace /path/to/trace.perfetto --vendor oppo
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
| POST | `/api/skills/detect-vendor` | 检测 Trace 厂商 |

#### 执行 Skill 示例

```bash
# 执行指定 Skill
curl -X POST http://localhost:3001/api/skills/execute/startup_analysis \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "xxx",
    "package": "com.example.app"
  }'

# 自动分析（根据问题自动选择 Skill）
curl -X POST http://localhost:3001/api/skills/analyze \
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

每个 Skill 由两个文件组成：
- `xxx.skill.yaml` - 机器可执行的配置
- `xxx.sop.md` - 人类可读的 SOP 文档 (可选)

### 2. Skill YAML 格式

```yaml
# skills/composite/startup_analysis.skill.yaml
name: startup_analysis
version: "1.0.0"
type: composite
category: app_lifecycle
priority: high

# 元信息
meta:
  display_name: "应用启动分析"
  description: "分析应用冷启动、温启动、热启动的性能"
  icon: "rocket"
  tags:
    - startup
    - launch
    - cold start

# 触发条件
triggers:
  keywords:
    zh:
      - 启动
      - 冷启动
      - 热启动
    en:
      - startup
      - launch
      - cold start
  patterns:
    - ".*启动速度.*"
    - ".*launch.*time.*"

# 前置检查
prerequisites:
  required_tables:
    - android_startups
    - slice
    - thread
  optional_tables:
    - android_startup_events
  modules:
    - android.startup.startups

# 分析步骤
steps:
  - id: get_startups
    name: "获取启动事件"
    sql: |
      SELECT startup_id, ts, ts + dur as ts_end, dur/1e6 as dur_ms,
             package, startup_type
      FROM android_startups
      WHERE package GLOB '${package}*'
      ORDER BY ts ASC
    required: true
    save_as: startups
    on_empty: "未检测到启动事件"

  # NOTE: 使用子查询获取 ts，避免 JavaScript 大整数精度丢失问题
  # NOTE: 使用 t.tid = p.pid 识别主线程，而非 t.name = 'main'
  - id: analyze_phases
    name: "分析关键阶段"
    for_each: startups
    sql: |
      SELECT name, dur/1e6 as dur_ms,
             (ts - (SELECT ts FROM android_startups WHERE startup_id = ${item.startup_id}))/1e6 as relative_ms
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name GLOB '${package}*'
        AND t.tid = p.pid  -- Main thread: tid == pid
        AND s.ts >= (SELECT ts FROM android_startups WHERE startup_id = ${item.startup_id})
        AND s.ts <= (SELECT ts + dur FROM android_startups WHERE startup_id = ${item.startup_id})
      ORDER BY s.ts ASC

# 判断标准
thresholds:
  cold_start_time:
    unit: ms
    description: "冷启动时间"
    levels:
      excellent: { max: 500 }
      good: { min: 500, max: 1000 }
      warning: { min: 1000, max: 2000 }
      critical: { min: 2000 }
    suggestions:
      warning: "启动时间偏长，建议优化"
      critical: "启动时间过长，需要重点关注"

# 输出格式
output:
  title: "启动分析报告"
  sections:
    - id: overview
      title: "启动概览"
      type: summary
      from: startups
      fields:
        - { key: startup_type, label: "启动类型" }
        - { key: dur_ms, label: "耗时", unit: "ms" }
    - id: phases
      title: "阶段详情"
      type: table
      from: analyze_phases
      fields:
        - { key: name, label: "阶段" }
        - { key: dur_ms, label: "耗时", unit: "ms" }

# 诊断规则
diagnostics:
  - id: slow_startup
    condition: "startups.any.dur_ms > 2000"
    severity: critical
    message: "启动时间超过 2 秒"
    suggestions:
      - "检查 Application.onCreate 耗时"
      - "优化 ContentProvider 初始化"
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

厂商 Skill 可以继承并覆盖基础 Skill：

```yaml
# skills/vendors/oppo/startup.override.yaml
extends: composite/startup_analysis
version: "1.0.0"
description: "OPPO ColorOS 启动分析"

# 添加 OPPO 特有的检测
steps:
  # 继承所有基础步骤，添加新步骤
  - id: check_coloros_boost
    name: "检查 ColorOS 加速引擎"
    sql: |
      SELECT name, dur/1e6 as dur_ms
      FROM slice
      WHERE name GLOB '*ColorOS*' OR name GLOB '*HyperBoost*'

# 覆盖阈值（OPPO 设备可能有更好的优化）
thresholds:
  cold_start_time:
    levels:
      excellent: { max: 400 }  # OPPO 优化后标准更高
```

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
| `${item.xxx}` | for_each 循环中的当前项 | `${item.startup_id}` |
| `${prev.xxx}` | 上一步骤的结果 | `${prev.dur_ms}` |
| `${vendor}` | 检测到的厂商 | `oppo` |
| `${result.xxx.yyy}` | 之前步骤的结果引用 | `${result.startups.0.startup_id}` |

**重要提示**:
- **时间戳精度问题**: Perfetto 的时间戳是纳秒级大整数，超过 JavaScript 安全整数范围 (2^53)。
  在 for_each 循环中，**不要直接使用 `${item.ts}`**，应使用子查询获取时间戳：
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
5. 检测设备厂商（通过 trace 内容）
6. 加载对应厂商的 override Skills (`vendors/`)
7. 加载 `custom/` 目录下的自定义 Skills（如果存在）

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
4. 运行 `npm run skill:validate` 验证
5. 提交 Pull Request

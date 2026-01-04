# SmartPerfetto - AI 驱动的 Perfetto 分析平台

SmartPerfetto 是一个基于 AI 的 Perfetto 性能分析平台，通过 AI 助手帮助开发者更轻松地分析 Android 性能数据。

## 快速开始

```bash
# 一键启动前后端（开发模式）
./scripts/start-dev.sh
```

启动后访问：
- **Perfetto UI**: http://localhost:10000
- **Backend API**: http://localhost:3000

> 首次运行前需配置 `backend/.env`（参考 `.env.example`）

## 功能特性

- 🤖 **AI 智能分析**：使用自然语言提问，AI 自动生成 SQL 并分析 Trace 数据
- 📊 **多轮对话分析**：AI 会根据分析结果继续深入，直到完整回答你的问题
- 🧠 **智能模型切换**：根据问题复杂度自动选择最合适的 AI 模型（简单查询用 deepseek-chat，复杂分析用 deepseek-reasoner）
- 🔍 **空结果诊断**：查询无结果时自动分析 trace 内容并调整查询策略
- ⚡ **实时进度反馈**：通过 SSE 展示 AI 分析过程，了解每一步在做什么
- 🎯 **集成 Perfetto UI**：基于官方 Perfetto UI，保留完整的可视化能力
- 📋 **结果表格优化**：支持时间戳点击跳转、智能显示限制（最多 50 行）
- 🚀 **简单易用**：无需复杂配置，上传 Trace 即可开始分析

## Perfetto 子模块管理

SmartPerfetto 使用定制化的 Perfetto UI（通过 Git 子模块）。为了支持多端开发和与上游同步，我们使用了 fork 仓库和分支策略。

### 子模块配置

本项目使用自定义的 Perfetto fork：
- **Fork 仓库**: `git@github.com:Gracker/perfetto.git`
- **定制分支**: `smartperfetto`
- **上游仓库**: `https://github.com/google/perfetto.git`

### 首次克隆项目

如果你是第一次克隆 SmartPerfetto 项目：

```bash
# 克隆主项目
git clone git@github.com:Gracker/SmartPerfetto.git
cd SmartPerfetto

# 初始化并更新子模块（会自动切换到 smartperfetto 分支）
git submodule update --init --recursive
```

### 多设备开发同步

当你在不同设备上工作时，需要同步 perfetto 子模块的更新：

```bash
# 1. 拉取主项目的最新代码
git pull origin main

# 2. 更新 perfetto 子模块到最新的 smartperfetto 分支
cd perfetto
git checkout smartperfetto
git pull fork smartperfetto
cd ..

# 3. 在主项目中更新子模块指针
git add perfetto
git commit -m "chore: sync perfetto submodule to latest smartperfetto"
```

### 在 Perfetto 子模块中开发

当你需要修改 Perfetto UI 代码时：

```bash
# 1. 进入 perfetto 子模块
cd perfetto

# 2. 确认在 smartperfetto 分支
git branch  # 应该显示 * smartperfetto

# 3. 进行修改并提交
git add .
git commit -m "feat: your modification description"

# 4. 推送到你的 fork
git push fork smartperfetto

# 5. 回到主项目更新子模块指针
cd ..
git add perfetto
git commit -m "chore: update perfetto submodule with custom changes"
```

### 从上游（官方 Perfetto）合并更新

定期从官方 Perfetto 合并更新以获取最新功能和修复：

```bash
# 1. 进入 perfetto 子模块
cd perfetto

# 2. 确保在 smartperfetto 分支且所有更改已提交
git checkout smartperfetto
git status  # 确保没有未提交的更改

# 3. 获取上游最新代码
git fetch origin main

# 4. 合并上游更新到 smartperfetto 分支
git merge origin/main
# 如果有冲突，解决冲突后：
# git add .
# git commit -m "chore: merge upstream perfetto changes"

# 5. 推送到你的 fork
git push fork smartperfetto

# 6. 回到主项目更新子模块指针
cd ..
git add perfetto
git commit -m "chore: merge upstream perfetto updates"

# 7. 推送主项目的更新
git push origin main
```

**处理合并冲突**：

如果合并上游更新时出现冲突：

```bash
# 1. 查看冲突文件
git status

# 2. 手动解决冲突（保留 SmartPerfetto 的定制）
# 冲突标记 <<<<<<< 和 >>>>>>> 之间是需要解决的内容

# 3. 标记冲突已解决
git add <resolved-files>

# 4. 完成合并
git commit -m "chore: merge upstream perfetto (resolved conflicts)"

# 5. 验证 Perfetto UI 仍能正常工作
cd ui
npm run dev  # 测试 UI 是否正常启动
```

### 子模块故障排除

#### 子模块处于游离 HEAD 状态

```bash
cd perfetto
git checkout smartperfetto
cd ..
git add perfetto
git commit -m "fix: pin perfetto to smartperfetto branch"
```

#### 子模块显示"修改的内容"

```bash
# 查看子模块状态
cd perfetto
git status

# 如果有未提交的更改，先提交
git add .
git commit -m "feat: describe your changes"
git push fork smartperfetto

# 然后在主项目中更新指针
cd ..
git add perfetto
git commit -m "chore: update perfetto submodule"
```

#### 重置子模块到干净状态

```bash
# 清理子模块（慎用，会丢失本地更改）
git submodule deinit -f perfetto
rm -rf .git/modules/perfetto
git submodule update --init --recursive
cd perfetto
git checkout smartperfetto
```

### 架构说明

使用 fork + 分支策略的优势：

| 方面 | 说明 |
|------|------|
| **多端同步** | 所有开发者使用同一个 fork 和分支，代码自动同步 |
| **上游跟踪** | 清晰区分官方代码和 SmartPerfetto 定制 |
| **独立更新** | main 分支跟踪上游，smartperfetto 分支存储定制 |
| **协作友好** | 团队成员可以向 fork 提交 PR 来贡献定制 |

### 便捷脚本

为了简化日常操作，项目提供了两个便捷脚本：

#### 一键推送两个仓库

`./scripts/push-all.sh` - 同时推送主项目和 perfetto 子模块的更新

```bash
# 使用场景：当你修改了代码后，想一键推送到远程
./scripts/push-all.sh
```

**功能**：
- ✅ 检查主项目和子模块的工作区状态
- ✅ 推送 perfetto 子模块到 fork 的 smartperfetto 分支
- ✅ 推送主项目到 origin 的 main 分支
- ✅ 友好的错误提示和交互确认

#### 一键合并上游更新

`./scripts/sync-perfetto-upstream.sh` - 自动合并官方 perfetto 最新代码

```bash
# 使用场景：定期同步上游更新（建议每月一次）
./scripts/sync-perfetto-upstream.sh
```

**功能**：
- ✅ 自动获取上游最新代码
- ✅ 统计需要合并的提交数量
- ✅ 自动合并上游更新到 smartperfetto 分支
- ✅ 推送到 fork 仓库
- ✅ 更新主项目子模块指针
- ✅ 冲突时提供解决指引
- ✅ 友好的交互确认

**脚本特性**：
- 🎨 彩色输出，清晰易读
- 🔍 执行前检查工作区状态
- ⚠️ 未提交更改时给出警告
- 🚀 遇到错误立即退出
- 📝 详细的步骤提示和错误信息

## 已完成功能

- ✅ Perfetto UI AI 助手插件
- ✅ Trace 文件上传到后端
- ✅ 基于 WASM 的 TraceProcessor 集成
- ✅ AI SQL 生成（DeepSeek）
- ✅ 多轮分析编排器
- ✅ SSE 实时进度推送
- ✅ 中文进度提示
- ✅ 动态 AI 模型切换（根据问题复杂度自动选择 deepseek-chat 或 deepseek-reasoner）
- ✅ 空结果智能诊断（自动分析 trace 内容帮助 AI 调整查询策略）
- ✅ SQL 结果表格优化（时间戳跳转、bigint 支持、显示限制 50 行）
- ✅ **YAML 驱动的 Skill Engine**
  - 8 个基础分析 Skills (startup, scrolling, memory, cpu, binder, surfaceflinger, navigation, click_response)
  - 6 个厂商定制 (oppo, vivo, xiaomi, honor, mtk, qualcomm)
  - CLI 工具 (`npm run skill:list/validate/test`)
  - 管理 API (`/api/admin/skills`)
  - 自动意图检测和厂商识别
- ✅ **Session 与资源管理**
  - PortPool 端口池管理 (9100-9900)
  - TraceProcessor 进程生命周期管理
  - 前端 Session 持久化 (localStorage)
  - 优雅关闭与资源清理 (SIGTERM/SIGINT)
  - 资源监控 API (`/api/traces/stats`)
  - 手动清理 API (`/api/traces/cleanup`)
- ✅ **HTTP RPC 共享架构**
  - 前端和后端共享同一个 trace_processor 实例
  - 通过 HTTP RPC 模式实现数据一致性
  - CORS 支持，允许前端直接连接后端启动的 trace_processor
  - 自动端口分配和管理

## 待实现功能

- [ ] 分析结果的可视化增强
- [ ] 会话历史持久化
- [ ] 分析报告导出（PDF/HTML）
- [ ] 自定义 AI 模型配置界面
- [ ] Skill Web 管理界面（前端）
- [ ] Analysis in Tace（即把分析结果，重新展示在 Trace 里面，相当于把 Trace 拆开，在合适的地方加上分析的结果，然后再重新打包 Trace）

## 架构设计

### HTTP RPC 共享架构 (v2.0)

SmartPerfetto 采用 **HTTP RPC 共享架构**，前端和后端共享同一个 trace_processor 实例，实现数据一致性和资源高效利用：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Perfetto UI (http://localhost:10000)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       AI Assistant Panel                               │  │
│  │  1. 用户点击 "上传 Trace"                                              │  │
│  │  2. Trace 上传到后端 → 后端启动 trace_processor_shell (HTTP 模式)      │  │
│  │  3. 后端返回 HTTP RPC 端口 (如 9100)                                   │  │
│  │  4. 前端通过 HTTP RPC 连接到同一个 trace_processor                     │  │
│  │  5. 前端 UI 和 AI 后端 共享同一个 trace_processor 实例！               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     Timeline / Trace Viewer                          │    │
│  │    RPC @ 127.0.0.1:9100  ←── 连接到后端启动的 trace_processor        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          │ HTTP RPC           │ HTTP/SSE           │ HTTP RPC
          │ (SQL 查询)          │ (AI 分析)          │ (SQL 查询)
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────┐
│ trace_processor │  │   Backend API       │  │ trace_processor │
│  (port 9100)    │←─│  (port 3000)        │─→│  (同一实例!)     │
│                 │  │                     │  │                 │
│  ┌───────────┐  │  │  AI 分析编排器       │  │  ┌───────────┐  │
│  │ Trace     │  │  │  SQL 生成           │  │  │ 共享数据   │  │
│  │ 数据      │  │  │  结果分析           │  │  │           │  │
│  └───────────┘  │  └─────────────────────┘  │  └───────────┘  │
└─────────────────┘                           └─────────────────┘
        ↑                                              ↑
        └──────────────────────────────────────────────┘
                    同一个 trace_processor 进程
```

#### 数据流程

```
用户点击 "进入 RPC 模式"
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 1: 前端上传 Trace 到后端                                                │
│         POST /api/traces/upload                                             │
│         后端启动 trace_processor_shell (HTTP 模式)                           │
│         返回: { traceId: "xxx", port: 9101 }                                │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 2: 前端保存 pendingBackendTrace 到 localStorage                        │
│         { traceId, port, timestamp }                                        │
│         (因为后续 trace reload 会导致组件重新初始化，状态会丢失)               │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 3: 前端切换到 HTTP RPC 模式                                             │
│         • HttpRpcEngine.rpcPort = 9101                                      │
│         • openTraceFromHttpRpc() → 触发 trace reload                        │
│         • 组件重新初始化 (AIPanel 重新创建)                                   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 4: 组件初始化时检测 RPC 模式                                            │
│         • engine.mode === 'HTTP_RPC' → 确认进入 RPC 模式                     │
│         • autoRegisterWithBackend() → 从 localStorage 恢复 backendTraceId   │
│         • AI 分析就绪！                                                      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 5: 前端 UI 和 AI 后端 共享同一个 trace_processor                        │
│         • 前端 Timeline/Query 直接查询 → trace_processor (port 9101)        │
│         • AI 后端分析请求 → trace_processor (port 9101)                     │
│         • 数据完全一致！                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### RPC 模式检测与状态恢复

AI Assistant 面板根据 `engine.mode` 判断当前是否在 RPC 模式：

| 模式 | engine.mode | UI 显示 |
|------|-------------|---------|
| **普通模式** | `WASM` | "启用 AI 分析" 对话框，引导用户进入 RPC 模式 |
| **RPC 模式** | `HTTP_RPC` | 聊天界面，可以直接与 AI 对话分析 |

**状态恢复机制**：

由于 `openTraceFromHttpRpc()` 会触发 trace reload，导致 AIPanel 组件重新初始化，`backendTraceId` 会丢失。解决方案：

1. **上传前保存**: 在调用 `openTraceFromHttpRpc()` 前，将 `backendTraceId` 保存到 `localStorage`
2. **初始化时恢复**: 组件初始化时，如果检测到 RPC 模式且没有 `backendTraceId`，从 `localStorage` 恢复
3. **60秒有效期**: pending 数据有 60 秒有效期，防止使用过期数据

#### 架构优势

| 特性 | 说明 |
|------|------|
| **数据一致性** | 前端和后端查询同一份数据，结果完全同步 |
| **资源高效** | 只需一个 trace_processor 进程，减少内存占用 |
| **实时同步** | AI 分析结果可直接反映在 UI 上 |
| **简化调试** | 前端和后端使用相同的查询引擎 |

### Skill Engine V2 架构

SmartPerfetto 使用 YAML 驱动的 Skill 系统 V2，支持组合式分析、AI 辅助诊断和厂商定制：

```
┌─────────────────────────────────────────────────────────────────────┐
│                           用户请求                                   │
│  1. AI 对话: POST /api/trace-analysis/ask                           │
│  2. 直接 API: POST /api/perfetto-sql/startup                        │
│  3. Skill API: POST /api/skills/analyze                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         │                                           │
         ▼                                           ▼
┌────────────────────────────────────┐   ┌─────────────────────────────┐
│  PerfettoAnalysisOrchestrator      │   │   perfettoSqlRoutes.ts      │
│  (AI 助手分析流程)                  │   │   (直接 API 调用)            │
├────────────────────────────────────┤   └──────────────┬──────────────┘
│  generateSQL():                    │                  │
│  1. 尝试 Skill Engine V2 (YAML)    │                  │
│  2. 回退 PerfettoSqlSkill          │                  │
│  3. 最终 AI 生成 SQL               │                  │
└──────────────┬─────────────────────┘                  │
               │                                        │
               └────────────────┬───────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  SkillAnalysisAdapterV2                              │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  • detectIntent(question) → 关键词匹配 → skillId              │  │
│  │  • detectVendor(traceId)  → 自动检测厂商                      │  │
│  │  • analyze(request)       → 执行 Skill 返回结果               │  │
│  │  • listSkills()           → 返回所有可用 Skills               │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SkillExecutorV2                                 │
├─────────────────────────────────────────────────────────────────────┤
│  支持多种步骤类型:                                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  • atomic      - 执行单个 SQL 查询                           │    │
│  │  • skill       - 引用另一个 Skill                            │    │
│  │  • iterator    - 对数据源迭代执行                            │    │
│  │  • parallel    - 并行执行多个步骤                            │    │
│  │  • diagnostic  - 规则推理诊断                                │    │
│  │  • ai_decision - AI 决策判断                                 │    │
│  │  • ai_summary  - AI 生成总结                                 │    │
│  │  • conditional - 条件分支执行                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  执行流程:                                                           │
│  1. executeStep()      → 根据步骤类型分派执行                        │
│  2. substituteVars()   → 变量替换 (${package}, ${prev.xxx})         │
│  3. collectDisplay()   → 收集展示结果                               │
│  4. runDiagnostics()   → 执行诊断规则                               │
│  5. generateAISummary()→ AI 生成总结                                │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      skillRegistryV2                                 │
├─────────────────────────────────────────────────────────────────────┤
│  skills/                                                             │
│  ├── v2/                          # V2 Skills                       │
│  │   ├── atomic/                  # 3 个原子 Skills                 │
│  │   │   ├── binder_in_range.skill.yaml                             │
│  │   │   ├── cpu_slice_analysis.skill.yaml                          │
│  │   │   └── scheduling_analysis.skill.yaml                         │
│  │   │                                                               │
│  │   └── composite/               # 18 个组合 Skills                │
│  │       ├── scrolling_analysis.skill.yaml  # 滑动分析              │
│  │       ├── startup_analysis.skill.yaml    # 启动分析              │
│  │       ├── anr_analysis.skill.yaml        # ANR 分析              │
│  │       ├── memory_analysis.skill.yaml     # 内存分析              │
│  │       ├── cpu_analysis.skill.yaml        # CPU 分析              │
│  │       ├── gpu_analysis.skill.yaml        # GPU 分析              │
│  │       ├── binder_analysis.skill.yaml     # Binder 分析           │
│  │       ├── gc_analysis.skill.yaml         # GC 分析               │
│  │       ├── lmk_analysis.skill.yaml        # LMK 分析              │
│  │       └── ...更多...                                              │
│  │                                                                   │
│  ├── vendors/                     # 厂商定制                        │
│  │   ├── oppo/, vivo/, xiaomi/...                                   │
│  │   └── *.override.yaml          # 厂商覆盖配置                    │
│  │                                                                   │
│  └── custom/                      # 用户自定义 Skills                │
└─────────────────────────────────────────────────────────────────────┘
```

#### Skill V2 步骤类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `atomic` | 执行单个 SQL 查询 | `SELECT * FROM slice` |
| `skill` | 引用另一个 Skill | `skill: binder_in_range` |
| `iterator` | 对数据源迭代执行 | `for_each: janky_frames` |
| `parallel` | 并行执行多个步骤 | 同时查询多个表 |
| `diagnostic` | 规则推理诊断 | 条件匹配 + 置信度 |
| `ai_decision` | AI 决策判断 | 复杂场景让 AI 判断 |
| `ai_summary` | AI 生成总结 | 分析结果汇总 |
| `conditional` | 条件分支执行 | if-else 逻辑 |

#### Skill YAML 结构

```yaml
name: startup_analysis
version: "1.0.0"
category: app_lifecycle

triggers:
  keywords: [启动, startup, cold start]
  patterns: [".*启动.*时间.*"]

prerequisites:
  required_tables: [android_startups, slice]
  modules: [android.startup.startups]

steps:
  - id: get_startups
    sql: |
      SELECT * FROM android_startups
      WHERE package GLOB '${package}*'
    save_as: startups

  - id: analyze_phases
    for_each: startups
    sql: |
      SELECT name, dur/1e6 as dur_ms
      FROM slice WHERE ts >= ${item.ts}

thresholds:
  cold_start_time:
    levels:
      excellent: { max: 500 }
      warning: { min: 1000, max: 2000 }
      critical: { min: 2000 }

diagnostics:
  - id: slow_startup
    condition: "startups.any.dur_ms > 2000"
    severity: critical
    message: "启动时间超过 2 秒"
    suggestions: ["优化 Application.onCreate"]
```

#### 滑动分析 Skill (Expert Edition v3.0)

滑动分析 Skill 采用**分层递进式分析**架构，模拟专家分析流程：

```yaml
name: scrolling_analysis
version: "3.0.0"
analysis_mode: hierarchical  # 分层递进

# 分层分析流程
layers:
  # Layer 1: 环境检测 & 滑动区间识别
  - id: layer1_detection
    steps:
      - detect_refresh_rate      # 检测刷新率 (60/90/120Hz)
      - identify_scroll_sessions # 识别滑动区间 (通过Input事件)
      - identify_fling_sessions  # 识别 Fling 区间
      - build_complete_scroll_sessions  # 构建完整滑动区间

  # Layer 2: 区间级分析（对每个滑动区间迭代）
  - id: layer2_session_analysis
    iterate_over: complete_scroll_sessions
    steps:
      - get_session_frames      # 获取区间内所有帧
      - identify_janky_frames   # 识别掉帧帧
      - calculate_session_fps   # 计算区间 FPS

  # Layer 3: 帧级深度分析（对每个掉帧迭代）
  - id: layer3_frame_analysis
    iterate_over: janky_frames
    steps:
      - analyze_main_thread     # 分析主线程活动
      - analyze_render_thread   # 分析 RenderThread
      - analyze_cpu_scheduling  # 分析 CPU 调度状态
      - analyze_binder_calls    # 分析 Binder 调用
      - analyze_buffer_ops      # 分析 Buffer 操作
      - diagnose_frame_jank_cause  # 诊断掉帧原因

  # Layer 4: 汇总报告
  - id: layer4_summary
    steps:
      - summarize_all_sessions  # 所有区间 FPS 汇总
      - summarize_jank_causes   # 掉帧原因汇总
      - list_all_janky_frames   # 所有掉帧详情
```

**滑动区间划分**：
- **按压滑动 (Touch/Scroll)**：手指在屏幕上，View 根据 input 报点更新
- **Fling**：手指离开屏幕后，View 根据滑动曲线计算位置
- 一次完整滑动 = 按压滑动 + Fling
- FPS 分别统计：完整滑动 FPS + Fling FPS

**核心理念**：
- 过程展示优先（每个掉帧的位置和原因）
- 以一次完整滑动为分析单元
- 一份 Trace 可能有多个滑动区间，需分别分析

**诊断规则**：
```yaml
diagnostics:
  - condition: "frame_main_thread_ops.any.operation GLOB '*Binder*'"
    cause: "主线程Binder调用阻塞"
  - condition: "frame_main_thread_ops.any.operation GLOB '*onBind*'"
    cause: "RecyclerView onBindViewHolder耗时"
  - condition: "frame_buffer_ops.any.wait_status == '长等待'"
    cause: "Buffer等待(GPU积压)"
  - condition: "frame_cpu_states.any.state == 'R' AND time_percent > 20"
    cause: "CPU调度延迟(Runnable等待)"
```

#### CLI 工具

```bash
# 列出所有 Skills
npm run skill:list

# 验证 Skill YAML 语法
npm run skill:validate startup_analysis

# 测试 Skill 执行
npm run skill:test startup_analysis -- --trace /path/to/trace.perfetto
```

#### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/skills` | 列出所有 Skills |
| POST | `/api/skills/analyze` | 自动检测意图并执行 |
| POST | `/api/skills/execute/:skillId` | 执行指定 Skill |
| GET | `/api/admin/skills` | 管理 API |
| GET | `/api/admin/vendors` | 厂商列表 |

### Session 与资源管理架构

SmartPerfetto 使用完整的 Session 生命周期管理，确保资源（端口、进程、内存）正确分配和释放：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Frontend (Perfetto UI)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    AI Assistant Panel                                │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │  backendTraceId │  │  chatHistory    │  │  uploadStatus       │  │   │
│  │  │  (当前会话 ID)   │  │  (对话历史)      │  │  (上传状态)         │  │   │
│  │  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │   │
│  │           │                    │                      │              │   │
│  │           └────────────────────┴──────────────────────┘              │   │
│  │                                │                                     │   │
│  │                    localStorage (持久化存储)                          │   │
│  │                    • smartperfetto-ai-sessions (按 trace 索引的会话)   │   │
│  │                    • smartperfetto-ai-settings (AI 设置)              │   │
│  │                    • smartperfetto-pending-backend-trace (临时恢复)    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                   │                                         │
│  Actions:                         ▼                                         │
│  • 页面加载 → handleTraceChange() → loadSession() / createNewSession()    │
│  • RPC模式 → autoRegisterWithBackend() → 恢复 pendingBackendTrace         │
│  • 新建会话 → clearChat() → DELETE /api/traces/:id                         │
│  • 上传Trace → POST /api/traces/upload → saveSession()                     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                    HTTP/SSE        │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend API Server                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                    TraceProcessorService                            │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │  traces: Map<traceId, TraceInfo>                              │  │    │
│  │  │    • id, filename, status, uploadTime                         │  │    │
│  │  │    • processor: WorkingTraceProcessor                         │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                      │    │
│  │  API Endpoints:              │                                      │    │
│  │  • POST /upload      → initializeUpload() → completeUpload()       │    │
│  │  • DELETE /:id       → deleteTrace() → cleanup processor           │    │
│  │  • GET /stats        → getStats() 资源监控                          │    │
│  │  • POST /cleanup     → 强制清理所有资源                              │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 │                                           │
│  ┌──────────────────────────────┴─────────────────────────────────────┐    │
│  │                    WorkingTraceProcessor                            │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │  • traceId: string                                            │  │    │
│  │  │  • httpPort: number (从 PortPool 分配)                         │  │    │
│  │  │  • process: ChildProcess (trace_processor_shell)              │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                      │    │
│  │  Lifecycle:                  │                                      │    │
│  │  • constructor → PortPool.allocate(traceId)                        │    │
│  │  • start()     → spawn trace_processor_shell --http                │    │
│  │  • destroy()   → kill process → PortPool.release(traceId)          │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 │                                           │
│  ┌──────────────────────────────┴─────────────────────────────────────┐    │
│  │                         PortPool                                    │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │  范围: 9100 - 9900 (800 个端口)                                │  │    │
│  │  │  • availablePorts: Set<number>     可用端口池                  │  │    │
│  │  │  • allocations: Map<traceId, PortAllocation>  已分配记录       │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  │                                                                     │    │
│  │  Methods:                                                           │    │
│  │  • allocate(traceId) → 分配端口，记录分配信息                        │    │
│  │  • release(traceId)  → 释放端口，返回端口池                          │    │
│  │  • getStats()        → 返回端口使用统计                              │    │
│  │  • cleanupStale()    → 清理过期分配                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Graceful Shutdown                                 │   │
│  │  • SIGTERM/SIGINT → TraceProcessorFactory.cleanup()                 │   │
│  │                   → resetPortPool()                                  │   │
│  │                   → process.exit(0)                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (port 9100-9900)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    trace_processor_shell (per trace)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  • 每个 Trace 独立的进程                                                     │
│  • HTTP RPC 模式 (--http, --http-port)                                      │
│  • 执行 PerfettoSQL 查询                                                     │
│  • 进程生命周期与 Session 绑定                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Session 生命周期

```
加载 Trace                             进入 RPC 模式后
    │                                       │
    ▼                                       ▼
┌────────────────────┐              ┌───────────────────────┐
│ handleTraceChange()│              │ Trace Reload 触发      │
│ 获取 trace 指纹     │              │ 组件重新初始化          │
└─────────┬──────────┘              └───────────┬───────────┘
          │                                     │
          ▼                                     ▼
┌────────────────────┐              ┌───────────────────────┐
│ 检查现有 sessions   │              │ handleTraceChange()   │
│ 按 fingerprint 索引 │              │ 检测 engine.mode       │
└─────────┬──────────┘              └───────────┬───────────┘
          │                                     │
    ┌─────┴─────┐                               ▼
    ▼           ▼                       ┌───────────────────────┐
┌────────┐ ┌────────────┐               │ engine.mode ==        │
│ 有历史  │ │ 无历史      │               │   'HTTP_RPC'?         │
│ session│ │ session    │               │  ├── 是 → autoRegister │
└───┬────┘ └─────┬──────┘               │  └── 否 → 显示上传对话框│
    │            │                       └───────────────────────┘
    ▼            ▼
┌────────┐  ┌────────────┐
│loadSess│  │createNewSess│
│ ion()  │  │   ion()     │
└────────┘  └─────────────┘
```

**Trace 指纹 (Fingerprint)**：

基于 `trace.start + trace.end + trace.title` 生成，用于唯一标识一个 Trace。
注意：进入 RPC 模式后 title 会变化（添加 `RPC @ 127.0.0.1:port`），导致指纹变化。

#### 资源清理流程

```
用户点击 "Create New Session"
              │
              ▼
      ┌───────────────┐
      │   clearChat() │
      └───────┬───────┘
              │
              ├──────────────────────────────────────────┐
              │                                          │
              ▼                                          ▼
    ┌─────────────────┐                      ┌─────────────────────┐
    │ 清空前端状态     │                      │ DELETE /api/traces/:id│
    │ • chatHistory   │                      │                     │
    │ • backendTraceId│                      └──────────┬──────────┘
    │ • localStorage  │                                 │
    └─────────────────┘                                 ▼
                                             ┌─────────────────────┐
                                             │ deleteTrace()       │
                                             │ • 停止 processor    │
                                             │ • 释放端口           │
                                             │ • 删除文件           │
                                             └─────────────────────┘
```

### 职责分离

| 层级 | 职责 |
|------|------|
| **前端** | UI 显示、进度展示、用户交互、Session 状态持久化 |
| **后端** | 完整的分析闭环：理解 → 生成SQL → 执行 → 分析 → 判断 → 继续或回答 |
| **资源管理** | 端口分配与释放、进程生命周期、优雅关闭 |

### 架构设计评估

#### 设计优点

| 方面 | 评价 |
|------|------|
| **资源隔离** | 每个 Trace 独立进程，避免内存泄漏和状态污染 |
| **端口管理** | PortPool 集中管理，防止端口耗尽和冲突 |
| **生命周期** | 前端 → 后端 → 进程 三层联动，确保资源释放 |
| **可观测性** | `/stats` API 提供实时资源监控 |
| **容错性** | `/cleanup` API 支持故障恢复 |
| **优雅关闭** | 信号处理确保进程退出时资源清理 |

#### 潜在改进点

| 问题 | 现状 | 改进建议 |
|------|------|---------|
| **Session 持久化** | 仅 localStorage，服务端重启后丢失 | 可选：Redis/SQLite 持久化 |
| **多用户支持** | 单机单用户设计 | 需要：用户认证 + Session 隔离 |
| **进程池** | 每 Trace 一进程，资源消耗大 | 考虑：进程复用 + LRU 淘汰 |
| **健康检查** | 无 TraceProcessor 存活检测 | 建议：心跳检测 + 自动重启 |
| **并发限制** | 仅受端口数限制 (800) | 建议：可配置并发上限 |

#### 架构决策说明

1. **为什么使用 HTTP RPC 而非 IPC？**
   - `trace_processor_shell` 原生支持 HTTP 模式
   - 易于调试和监控
   - 支持跨机器部署（未来扩展）

2. **为什么前端使用 localStorage？**
   - 无需额外后端存储
   - 适合单用户桌面场景
   - 简化部署复杂度

3. **为什么每个 Trace 一个进程？**
   - 内存隔离，避免 Trace 间污染
   - 崩溃隔离，单进程失败不影响其他
   - 资源回收简单（kill 进程即可）

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm
- Python 3.x (用于 Perfetto 构建)
- trace_processor_shell (需要与前端 UI 版本匹配)

> **重要**: trace_processor_shell 二进制必须包含 `viz` stdlib 模块。推荐使用本地构建的版本 (`perfetto/out/ui/trace_processor_shell`)，而不是官方预编译版本，以确保与前端 UI 的兼容性。

### 安装依赖

```bash
# 安装后端依赖
cd backend
npm install

# Perfetto UI 依赖（首次运行时自动安装）
cd ../perfetto/ui
npm install
```

### 启动开发服务器

```bash
# 终端 1 - 启动后端
cd backend
npm run dev

# 终端 2 - 启动 Perfetto UI
cd perfetto/ui
./run-dev-server
```

### 访问应用

- **Perfetto UI**: http://localhost:10000
- **Backend API**: http://localhost:3000

## 使用指南

### 1. 打开 Perfetto UI

访问 http://localhost:10000

### 2. 打开 Trace 文件

- 点击 "Open trace file" 或拖拽 `.perfetto-trace` 文件到页面
- 等待文件加载完成

### 3. 打开 AI 助手

- 点击左侧边栏的 AI 助手图标
- AI 面板将在右侧展开

### 4. 上传 Trace 到后端

- 点击 AI 面板中的 **"上传到后端"** 按钮
- 等待上传完成（状态会显示为 "ready"）

### 5. 开始提问

在输入框中输入问题，例如：

```
> 帮我分析这段 Trace 中的 ANR 问题
> 找出所有耗时超过 100ms 的主线程操作
> 分析这段 Trace 中的内存分配情况
> 有没有明显的卡顿问题？
> 统计一下 CPU 使用情况
```

### 6. 查看分析过程

AI 会实时显示分析进度：

```
⏳ 🤔 正在生成查询...
⏳ ⏳ 正在执行查询...
⏳ 📊 正在分析结果...
📝 [最终分析结果]
```

### 可用命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/sql <query>` | 执行 SQL 查询 |
| `/goto <timestamp>` | 跳转到指定时间戳 |
| `/analyze` | 分析当前选中区域 |
| `/anr` | 快速检测 ANR |
| `/jank` | 快速检测掉帧 |
| `/slow` | 检测慢函数 (>16ms) |
| `/memory` | 分析内存使用 |
| `/export [csv|json]` | 导出查询结果 |
| `/clear` | 清除对话历史 |
| `/settings` | 打开设置 |

### 导出功能

分析结果支持导出为 CSV 或 JSON 格式：
- 点击结果表格上的 📄 CSV 或 📋 JSON 按钮
- 使用 `/export csv` 或 `/export json` 导出整个会话
- 导出的文件包含完整的查询结果和元数据

### 示例 Trace 文件

你可以从以下位置下载示例 Trace：

- [Perfetto BigTrace](https://storage.googleapis.com/perfetto.ui/bigtrace/)
- [Android Trace Examples](https://perfetto.dev/docs/quickstart/trace-viewer)

## 项目结构

```
SmartPerfetto/
├── perfetto/                 # Perfetto 官方 UI (Git Submodule)
│   ├── ui/
│   │   ├── src/
│   │   │   └── plugins/
│   │   │       └── com.smartperfetto.AIAssistant/  # AI 助手插件
│   │   │           ├── ai_panel.ts                  # 主面板组件
│   │   │           ├── commands.ts                  # 命令处理
│   │   │           └── plugin.ts                    # 插件入口
│   │   ├── run-dev-server                           # 启动脚本
│   │   └── build.js                                 # 构建脚本
│   │
│   └── perfetto/             # Perfetto 官方源码 (包含 SQL 库)
│       └── src/trace_processor/
│           ├── perfetto_sql/stdlib/                 # 标准库 (386 模板)
│           │   ├── android/                         # Android 分析模块
│           │   │   ├── startup/                     # 启动分析
│           │   │   ├── frames/                      # 帧渲染分析
│           │   │   ├── memory/                      # 内存分析
│           │   │   └── binder.sql                   # Binder 分析
│           │   ├── chrome/                          # Chrome 分析模块
│           │   ├── linux/                           # Linux 系统分析
│           │   └── sched/                           # 调度分析
│           └── metrics/sql/                         # 预定义指标 (141 模板)
│               └── android/                         # Android 指标
│
├── backend/                 # 后端 API 服务
│   ├── src/
│   │   ├── routes/
│   │   │   ├── traceAnalysisRoutes.ts          # 分析 API 路由
│   │   │   ├── simpleTraceRoutes.ts            # Trace 上传路由
│   │   │   ├── perfettoSqlRoutes.ts            # SQL 分析路由 (集成 Skill Engine)
│   │   │   ├── skillRoutes.ts                  # Skill 执行 API
│   │   │   └── skillAdminRoutes.ts             # Skill 管理 API
│   │   ├── controllers/
│   │   │   ├── skillController.ts              # Skill 执行控制器
│   │   │   └── skillAdminController.ts         # Skill 管理控制器
│   │   ├── services/
│   │   │   ├── traceProcessorService.ts        # Trace 处理服务
│   │   │   ├── workingTraceProcessor.ts        # TraceProcessor 进程管理
│   │   │   ├── portPool.ts                     # 端口池管理 (9100-9900)
│   │   │   ├── perfettoAnalysisOrchestrator.ts # 分析编排器
│   │   │   ├── analysisSessionService.ts       # 会话管理
│   │   │   ├── perfettoSqlSkill.ts             # SQL 生成技能 (Legacy)
│   │   │   ├── sqlTemplateEngine.ts            # SQL 模板引擎
│   │   │   │   ├── SQLTemplateEngine           # 基础模板引擎 (8 个内置模板)
│   │   │   │   └── EnhancedSQLTemplateEngine   # 增强引擎 (集成官方库)
│   │   │   ├── sqlKnowledgeBase.ts             # SQL 知识库
│   │   │   │   ├── SqlKnowledgeBase            # 表结构/函数定义
│   │   │   │   └── ExtendedSqlKnowledgeBase    # 官方模板索引
│   │   │   └── skillEngine/                    # Skill Engine V2 (YAML 驱动)
│   │   │       ├── skillLoaderV2.ts            # Skill 加载器 (skillRegistryV2)
│   │   │       ├── skillExecutorV2.ts          # Skill 执行器 (支持组合步骤)
│   │   │       ├── skillAnalysisAdapterV2.ts   # API 适配器
│   │   │       ├── types_v2.ts                 # V2 类型定义 (8 种步骤类型)
│   │   │       ├── smartSummaryGenerator.ts    # AI 摘要生成器
│   │   │       ├── answerGenerator.ts          # AI 回答生成器
│   │   │       ├── eventCollector.ts           # 执行事件收集器
│   │   │       └── index.ts                    # 统一导出
│   │   ├── cli/                                # CLI 工具
│   │   │   ├── index.ts                        # CLI 入口
│   │   │   └── commands/
│   │   │       ├── validate.ts                 # skill:validate
│   │   │       ├── test.ts                     # skill:test
│   │   │       └── list.ts                     # skill:list
│   │   ├── scripts/
│   │   │   ├── indexPerfettoSql.ts             # SQL 索引生成脚本
│   │   │   └── testSqlKnowledgeBase.ts         # 测试脚本
│   │   ├── types/
│   │   │   └── analysis.ts                     # 类型定义
│   │   └── index.ts                            # 入口文件
│   ├── skills/                                 # Skill 定义文件 (V2)
│   │   ├── v2/                                 # V2 Skills (21 个)
│   │   │   ├── atomic/                         # 原子 Skills (3 个)
│   │   │   │   ├── binder_in_range.skill.yaml
│   │   │   │   ├── cpu_slice_analysis.skill.yaml
│   │   │   │   └── scheduling_analysis.skill.yaml
│   │   │   └── composite/                      # 组合 Skills (18 个)
│   │   │       ├── scrolling_analysis.skill.yaml   # 滑动分析
│   │   │       ├── startup_analysis.skill.yaml     # 启动分析
│   │   │       ├── anr_analysis.skill.yaml         # ANR 分析
│   │   │       ├── memory_analysis.skill.yaml      # 内存分析
│   │   │       ├── cpu_analysis.skill.yaml         # CPU 分析
│   │   │       └── ...更多 (gpu, gc, lmk, binder 等)
│   │   ├── vendors/                            # 厂商定制
│   │   │   ├── oppo/, vivo/, xiaomi/...
│   │   │   └── *.override.yaml
│   │   ├── custom/                             # 用户自定义
│   │   └── README.md                           # Skill 开发指南
│   ├── data/
│   │   ├── perfettoSqlIndex.json               # 完整 SQL 索引 (527 模板)
│   │   └── perfettoSqlIndex.light.json         # 精简索引 (快速加载)
│   └── .env                                    # 环境变量
│
└── docs/                    # 文档
    └── plans/               # 设计文档
```

## 技术栈

### 前端 (Perfetto UI Plugin)

- **TypeScript** - 类型安全
- **Mithril.js** - Perfetto UI 使用的框架
- **SSE** - Server-Sent Events 用于实时更新

### 后端

- **Node.js + Express** - API 服务
- **TypeScript** - 类型安全
- **TraceProcessor WASM** - Perfetto Trace 处理引擎
- **OpenAI SDK** - 兼容 DeepSeek API
- **Multer** - 文件上传

### AI 服务

- **DeepSeek API** - SQL 生成和结果分析

## 环境变量

在 `backend/.env` 中配置：

```env
# API 服务
PORT=3000
NODE_ENV=development

# AI 服务配置
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com

# AI 模型配置
# 系统会根据问题复杂度动态切换模型：
# - 简单查询（统计、查找）: 使用 deepseek-chat（快速响应）
# - 复杂分析（为什么、优化建议、性能诊断）: 使用 deepseek-reasoner（深度推理）
DEEPSEEK_MODEL=deepseek-chat  # 默认/简单问题使用的模型

# 文件上传配置
MAX_FILE_SIZE=500MB
UPLOAD_DIR=./uploads

# Perfetto 配置 (可选，不设置则使用默认相对路径)
# TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell
# PERFETTO_PATH=/path/to/perfetto
```

## API 文档

### 上传 Trace

**POST** `/api/traces/upload`

Content-Type: `multipart/form-data`

| 参数 | 类型 | 说明 |
|------|------|------|
| file | File | Trace 文件 |

**响应**:
```json
{
  "success": true,
  "traceId": "uuid",
  "filename": "example.perfetto-trace",
  "size": 1234567
}
```

### 开始分析

**POST** `/api/trace-analysis/start`

Headers: `Content-Type: application/json`

| 参数 | 类型 | 说明 |
|------|------|------|
| traceId | string | Trace ID |
| question | string | 用户问题 |

**响应**: SSE 流式事件

```typescript
// 进度事件
type: 'progress'
data: {
  step: 'generating_sql' | 'executing_sql' | 'analyzing',
  message: '🤔 正在生成查询...'
}

// 分析完成
type: 'analysis_completed'
data: {
  answer: '分析结果...'
}
```

### 查询 Trace 状态

**GET** `/api/traces/:traceId`

**响应**:
```json
{
  "success": true,
  "trace": {
    "id": "uuid",
    "filename": "example.perfetto-trace",
    "status": "ready" | "uploading" | "error",
    "size": 1234567
  }
}
```

### 删除 Trace 并清理资源

**DELETE** `/api/traces/:traceId`

**说明**: 删除 Trace 文件，同时清理关联的 TraceProcessor 进程并释放端口

**响应**:
```json
{
  "success": true,
  "message": "Trace deleted successfully"
}
```

### 获取资源统计

**GET** `/api/traces/stats`

**说明**: 获取当前系统资源使用情况，包括端口池状态、处理器数量、Trace 列表

**响应**:
```json
{
  "success": true,
  "stats": {
    "portPool": {
      "total": 800,
      "available": 799,
      "allocated": 1,
      "allocations": [
        {
          "port": 9100,
          "traceId": "uuid",
          "allocatedAt": "2024-01-01T00:00:00.000Z"
        }
      ]
    },
    "processors": {
      "count": 1,
      "traceIds": ["uuid"]
    },
    "traces": {
      "count": 1,
      "items": [
        {
          "id": "uuid",
          "filename": "example.perfetto-trace",
          "status": "ready",
          "uploadTime": "2024-01-01T00:00:00.000Z"
        }
      ]
    }
  }
}
```

### 强制清理所有资源

**POST** `/api/traces/cleanup`

**说明**: 强制清理所有 TraceProcessor 进程和端口分配（用于故障恢复）

**响应**:
```json
{
  "success": true,
  "message": "Cleanup complete. Released 3 port allocations.",
  "stats": { ... }
}
```



## 开发说明

### 添加新的分析命令

编辑 `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/commands.ts`：

```typescript
export const COMMANDS = {
  // ... 现有命令
  '/mycommand': {
    description: '我的自定义命令',
    handler: async (args, state) => {
      // 实现命令逻辑
    }
  }
};
```

### 修改 AI 分析逻辑

编辑 `backend/src/services/perfettoAnalysisOrchestrator.ts`：

```typescript
class PerfettoAnalysisOrchestrator {
  // 修改分析循环逻辑
  private async runAnalysisLoop(...) {
    // ...
  }
}
```

### 修改 AI Prompt

编辑 `backend/src/services/perfettoSqlSkill.ts`：

```typescript
private getSystemPrompt(): string {
  return `你的自定义 Prompt...`;
}
```

## 故障排除

### Perfetto UI 无法启动

```bash
# 检查端口占用
lsof -ti:10000 | xargs kill -9

# 重新构建
cd perfetto/ui
node build.js --only-wasm-memory64
```

### Backend 无法启动

```bash
# 检查环境变量
cat backend/.env

# 检查日志
tail -f /tmp/backend.log
```

### AI 分析无响应

```bash
# 检查 API 配置
curl http://localhost:3000/debug

# 查看 orchestrator 日志
grep "Orchestrator" /tmp/backend.log
```

### HTTP RPC 模式 CORS 错误

如果看到 `Access-Control-Allow-Origin` 相关错误：

```bash
# 1. 可能是浏览器缓存了旧的 CORS 预检响应
# 解决方案：使用隐身模式或清除浏览器缓存

# 2. 检查 trace_processor 是否正确启动
pgrep -fl trace_processor

# 3. 验证 CORS 是否工作
curl -v -X OPTIONS -H "Origin: http://localhost:10000" http://127.0.0.1:9100/status
```

### trace_processor 版本不匹配

如果看到错误 `INCLUDE: unknown module 'viz.track_event_callstacks'`：

```bash
# 原因：trace_processor 二进制缺少 viz stdlib 模块

# 解决方案：使用本地构建的 trace_processor
# 1. 确保 perfetto/out/ui/trace_processor_shell 存在
ls -la perfetto/out/ui/trace_processor_shell

# 2. 如果不存在，构建它：
cd perfetto
tools/ninja -C out/ui trace_processor_shell

# 3. 验证版本包含 viz 模块：
echo "INCLUDE PERFETTO MODULE viz.slices; SELECT 1;" | \
  ./out/ui/trace_processor_shell --query-file /dev/stdin /path/to/trace.perfetto
```

### 构建失败

如果 Perfetto UI 构建失败：

```bash
cd perfetto/ui
# 清理并重新构建
rm -rf out/ node_modules/.cache
node build.js --only-wasm-memory64
```

## 许可证

MIT License

## 联系方式

- 项目地址: https://github.com/yourusername/smart-perfetto
- 邮箱: contact@smartperfetto.com

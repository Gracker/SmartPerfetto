# SmartPerfetto 面试准备指南

> 独立开发的 AI 驱动 Android 性能分析平台，基于 Claude Agent SDK + MCP 协议 + Perfetto UI 插件。

---

## 目录

- [一、项目概览与数据指标](#一项目概览与数据指标)
- [二、Before vs After：传统分析 vs SmartPerfetto](#二before-vs-after传统分析-vs-smartperfetto)
- [三、核心架构与技术亮点](#三核心架构与技术亮点)
- [四、面试场景 Q&A](#四面试场景-qa)
  - [场景一：项目深挖面](#场景一项目深挖面最常见15-20-分钟)
  - [场景二：系统设计面](#场景二系统设计面)
  - [场景三：行为面 / BQ 面](#场景三行为面--bq-面)
  - [场景四：技术细节追问](#场景四技术细节追问)
- [五、Vision & Gap：终极形态与当前差距](#五vision--gap终极形态与当前差距)
- [六、面试完整叙事线（5-8 分钟）](#六面试完整叙事线5-8-分钟)
- [附录：面试加分 Buzzword 清单](#附录面试加分-buzzword-清单)

---

## 一、项目概览与数据指标

### 一句话定位

AI 驱动的 Android 性能分析平台，把专家的分析方法论编码成 162 个 YAML Skill + 8 套场景策略，让 AI Agent 自动执行系统化分析，从 45-90 分钟手动分析缩短到 2-3 分钟。

### 硬数据

| 指标 | 数值 |
|------|------|
| 代码规模 | 16 万行 TypeScript + 5.1 万行 YAML |
| 分析 Skill | 162 个（74 atomic + 28 composite + 30 pipeline + 18 module + 2 deep） |
| 场景策略 | 8 套场景策略 + 6 个知识库模板 + 6 个 prompt 模板 |
| MCP 工具 | 18 个 |
| 测试 | 250 个测试文件，6 条 canonical trace 回归 |
| Token 节省 | SQL 摘要 ~85%，ArtifactStore 3 级缓存 |
| 场景分类延迟 | <1ms（纯关键词，无 LLM） |
| SSE 流延迟 | ~200ms |
| 生产依赖 | 仅 13 个 |
| 分析效率提升 | 20-30x（45-90min → 2-3min） |

---

## 二、Before vs After：传统分析 vs SmartPerfetto

### Before：传统 Perfetto 分析流程

| 步骤 | 耗时 | 说明 |
|------|------|------|
| 1. 抓 trace | 5 min | `adb shell perfetto` 或系统 Tracing，10-50MB |
| 2. 人肉看时间线 | 10-20 min | 几十条 track（CPU/线程/SurfaceFlinger/RenderThread/Binder），一帧帧找卡顿位置 |
| 3. 手写 SQL | 10-15 min | 几百张表、列名不直观，经常试错 |
| 4. 跨 track 关联 | 10-20 min | 同时看 5-6 条 track 交叉对比定位根因（Binder？GC？CPU 降频？GPU？） |
| 5. 写报告 | 10-15 min | 截图 + 数据 + 结论 |
| **总计** | **45-90 min** | 高度依赖经验，新人半年才能上手 |

**核心痛点：**

| 痛点 | 具体表现 |
|------|---------|
| 门槛高 | 要理解 VSync、RenderThread、Choreographer、SurfaceFlinger、Binder、CPU 调度等 10+ 子系统 |
| 效率低 | 一个问题 45-90 分钟，大量时间花在"找位置"和"试 SQL" |
| 容易遗漏 | 人工分析很难每次都检查所有维度（CPU/GPU/内存/Binder/GC/热降频） |
| 经验难传承 | 资深工程师脑子里的分析方法论，新人很难习得 |
| 无法规模化 | 团队每天可能有几十个性能问题，靠人工完全扛不住 |

### After：SmartPerfetto 分析流程

```
用户: "分析滑动卡顿"
        │
        ▼
[场景分类] ─── <1ms ──→ scrolling
        │
        ▼
[架构检测] ── 自动识别 ──→ Flutter / Standard / Compose / WebView
        │
        ▼
[自动规划] ── Plan 门控 ──→ "Phase 1: 帧概览 → Phase 2: 卡顿帧定位 → Phase 3: 根因分析"
        │
        ▼
[执行 Skills]
   ├─ L1: 总览（FPS 92.3, 卡顿率 8.7%, 共 487 帧）        ← 5 秒出结果
   ├─ L2: 帧列表（哪些帧卡了、卡了多久、什么类型）            ← 实时流式展示
   ├─ L3: 逐帧诊断（Frame #234: Binder 阻塞 23ms）         ← 点击跳转时间线
   └─ L4: 深度分析（调用栈、线程状态、阻塞链）                ← 按需展开
        │
        ▼
[4 层验证] ── 自动检查证据 + 假设闭环 ──→ 过滤误报
        │
        ▼
[输出报告] ── 结构化结论 + Mermaid 因果链 + 可点击的时间线书签
```

**关键对比：**

| 维度 | Before（手动） | After（SmartPerfetto） | 提升 |
|------|---------------|----------------------|------|
| 分析耗时 | 45-90 分钟 | 2-3 分钟 | **20-30x** |
| 覆盖维度 | 取决于经验，通常 3-5 个 | 162 个 Skill 系统扫描 | **全覆盖** |
| 门槛 | 至少 6 个月经验 | 自然语言提问 | **零门槛** |
| 一致性 | 不同人分析结果不同 | 策略驱动 + 验证 | **确定性** |
| 可追溯 | 分析过程在工程师脑子里 | 每步工具调用有日志 | **全链路可审计** |
| 知识沉淀 | 经验在人的脑子里 | 编码成 Skill + Strategy + 跨会话学习 | **可复用** |

---

## 三、核心架构与技术亮点

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│  Perfetto UI (Frontend Plugin)  :10000                      │
│  ┌──────────┐ ┌────────────┐ ┌──────────────┐              │
│  │ AI Panel │ │ SSE Stream │ │ DataEnvelope │              │
│  │ (Mithril)│ │  Handler   │ │  Renderer    │              │
│  └────┬─────┘ └─────┬──────┘ └──────┬───────┘              │
└───────┼─────────────┼───────────────┼───────────────────────┘
        │ HTTP        │ SSE           │ Schema-driven
┌───────┼─────────────┼───────────────┼───────────────────────┐
│  Express Backend  :3000                                      │
│  ┌────┴─────────────┴───────────────┴────────┐              │
│  │         ClaudeRuntime (Orchestrator)        │              │
│  │  ┌───────────┐  ┌──────────┐  ┌─────────┐ │              │
│  │  │ Scene     │  │ System   │  │ Verifier│ │              │
│  │  │ Classifier│  │ Prompt   │  │ (4-layer│ │              │
│  │  │ (<1ms)    │  │ Builder  │  │  gate)  │ │              │
│  │  └───────────┘  └──────────┘  └─────────┘ │              │
│  └──────────────────┬────────────────────────┘              │
│                     │ Claude Agent SDK                       │
│           ┌─────────┴──────────┐                            │
│           │  MCP Server        │                            │
│           │  (18 Tools)        │                            │
│           │  execute_sql       │   ┌──────────────────┐     │
│           │  invoke_skill      ├──►│ Skill Engine      │     │
│           │  submit_plan       │   │ 162 YAML Skills   │     │
│           │  submit_hypothesis │   │ L1→L2→L3→L4      │     │
│           │  lookup_knowledge  │   └──────────────────┘     │
│           │  ...               │                            │
│           └─────────┬──────────┘                            │
│                     │ HTTP RPC                               │
│           ┌─────────┴──────────┐                            │
│           │ trace_processor    │                            │
│           │ (C++ binary)       │                            │
│           │ :9100-9900         │                            │
│           └────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

### 亮点 1：确定性 + 概率性混合架构

```
用户提问 → 场景分类(scrolling/startup/ANR/general)
  ├─ 有匹配策略 → 确定性多阶段 Pipeline（Strategy 驱动，每次不遗漏）
  └─ 没有匹配 → 假设驱动的多轮推理（Claude 自主探索）
```

**面试话术：**
> "纯 LLM 做性能分析有两个问题：一是输出不稳定，二是容易遗漏关键步骤。所以我设计了双轨架构——对已知场景用外部 Strategy 文件约束分析步骤，保证每次不遗漏；对未知场景让 Agent 自主假设-验证。既有确定性保底，又有灵活性。"

### 亮点 2：18 个 MCP 工具（Plan 门控）

| 类别 | 工具 | 设计意图 |
|------|------|----------|
| 数据获取 | `execute_sql`, `invoke_skill`, `list_skills` | Claude 的"手" |
| 知识查询 | `lookup_sql_schema`, `list_stdlib_modules`, `lookup_knowledge` | Claude 的"参考资料" |
| 规划 | `submit_plan`, `update_plan_phase`, `revise_plan` | Claude 的"计划本" |
| 推理 | `submit_hypothesis`, `resolve_hypothesis`, `flag_uncertainty` | Claude 的"思考记录" |
| 记忆 | `write_analysis_note`, `fetch_artifact`, `recall_patterns` | Claude 的"笔记本" |

**关键设计：** `execute_sql` 和 `invoke_skill` 被 Plan 门控——必须先 `submit_plan` 才能执行查询，防止 Agent 上来就乱查。

### 亮点 3：Context Engineering（85% token 节省）

**问题：** LLM context window 有限，一个 Skill 可能返回 3000+ tokens。

**三层解决方案：**

| 技术 | 效果 | 原理 |
|------|------|------|
| SQL 摘要 | 2000 tokens → 300 tokens（85% 节省） | 统计分布 + Top10 感兴趣行，完整数据推前端 |
| ArtifactStore | 3000 tokens → 60 tokens（默认） | 3 级获取：summary(60t) → rows(200-400t) → full(1000+t) |
| 渐进式 prompt 裁剪 | 15+ section → 按优先级裁剪到 4500 token | 先砍知识库/错误对，永不砍用户意图和场景策略 |

### 亮点 4：4 层验证系统

| 层 | 内容 | 延迟 |
|----|------|------|
| 1. 启发式 | CRITICAL 必须有证据、不超 5 个 CRITICAL、已知误诊模式匹配 | <1ms |
| 2. Plan 遵守度 | 计划阶段是否执行、预期工具是否调用 | <1ms |
| 3. 假设闭环 | 所有 hypothesis 必须 confirmed 或 rejected | <1ms |
| 4. LLM 交叉验证 | 轻量模型(Haiku)验证结论的证据支撑度（可选） | ~200ms |

验证不通过 → 生成纠正 prompt → Agent 反思修正（最多 2 轮），不是全部重来。

### 亮点 5：162 个 YAML Skill 分层设计

```
L1（概览）─→ FPS、卡顿率、总帧数
L2（列表）─→ 卡顿帧列表、事件列表
L3（诊断）─→ 逐帧根因（CPU/Binder/GC）
L4（深度）─→ 调用栈、线程状态、阻塞链
```

前端通过 DataEnvelope 自描述数据契约自动渲染，新增 Skill 前端零改动。

### 亮点 6：跨会话学习

| 机制 | 说明 | 约束 |
|------|------|------|
| SQL 错误-修复对 | Claude 写错 SQL → 记录 error+fix → 下次相似错误自动注入 | 30 天 TTL，200 对上限，Jaccard>0.3 |
| 正模式记忆 | 记录成功分析的 trace 特征 + 方法 | 60 天 TTL，200 条上限 |
| 负模式记忆 | 记录失败的方法，避免重复犯错 | 90 天 TTL，100 条上限 |
| 学习型误诊模式 | 误诊出现 ≥2 次自动加入验证规则 | 90 天 TTL，30 条上限 |

---

## 四、面试场景 Q&A

### 场景一：项目深挖面（最常见，15-20 分钟）

#### Q1: "介绍一下你这个项目"（30 秒电梯演讲）

> "SmartPerfetto 是一个 AI 驱动的 Android 性能分析平台。它是 Google Perfetto trace viewer 的插件，核心是用 Claude Agent SDK 构建了一个自动化分析 Agent——工程师上传一个 trace 文件，AI 自动识别场景（滑动卡顿、启动慢、ANR），执行 162 个预定义的分析 Skill，给出分层的诊断报告。整个系统 16 万行 TypeScript + 5 万行 YAML 分析规则，有 250 个测试文件保证质量。"

#### Q2: "为什么要做这个？手动分析有什么问题？"

> "Android 性能分析有三个痛点：**一是门槛高**，要看懂 Perfetto trace 需要理解 VSync、RenderThread、Binder 调用链等十几个子系统，新人至少半年才能上手；**二是效率低**，一个复杂卡顿问题，资深工程师手动分析也要 30-60 分钟；**三是容易遗漏**，人工分析很难每次都检查所有维度（CPU 调度、GC、Binder、GPU、热降频等）。这个工具把专家经验编码成 162 个 YAML Skill + 8 套场景策略，让 AI Agent 按专家的分析方法论系统化执行。"

#### Q3: "整体架构是怎样的？"

> "分三层：前端是 Perfetto UI 的插件，用 SSE 实时接收分析结果；中间是 Express 后端，核心是 ClaudeRuntime 编排器，通过 MCP 协议给 Claude 暴露 18 个领域工具；底层是 Perfetto 的 C++ trace_processor，通过 HTTP RPC 执行 SQL 查询。**关键设计决策是：Claude 不直接操作数据，而是通过 MCP 工具间接操作**——这样我可以在工具层做 token 优化、错误学习、结果缓存。"

（配合上面的架构图讲解）

#### Q4: "Agent 是怎么工作的？一次分析的完整流程？"

> "一次分析有 5 个阶段：
> 1. **场景识别**：纯关键词匹配（<1ms），把用户问题分类为 scrolling/startup/ANR/general
> 2. **上下文构建**：检测渲染架构（Standard/Flutter/Compose/WebView）、前台 App、注入对应的场景策略
> 3. **规划**：Claude 必须先 submit_plan 才能使用 execute_sql 和 invoke_skill（Plan 门控机制）
> 4. **执行**：按计划调用 MCP 工具——执行 Skill 获取分层数据、写 SQL 查具体细节、记录假设和笔记
> 5. **验证**：4 层验证（规则检查 → Plan 遵守度 → 假设闭环 → 可选 LLM 交叉验证），不通过会生成纠正 prompt 让 Agent 反思修正，最多 2 轮"

#### Q5: "为什么要用 MCP 协议？为什么不直接让 LLM 写 SQL？"

> "三个原因：
> 1. **可控性**——MCP 工具有 Zod schema 校验，参数不合法直接拒绝
> 2. **可观测性**——所有工具调用都有日志，能看到 Claude 调了什么、传了什么、返回了什么
> 3. **token 优化空间**——execute_sql 有 summary 模式省 85% token；invoke_skill 结果存 ArtifactStore，Claude 默认只看 60 tokens 的摘要。如果让 LLM 直接写 SQL，这些优化都做不了。"

#### Q6: "162 个 Skill 是什么概念？为什么用 YAML？"

> "每个 Skill 是一个声明式的分析步骤。用 YAML 有三个好处：
> 1. **非工程师也能写**——性能专家不需要懂 TypeScript，直接写 SQL + 配置
> 2. **热更新**——开发环境下改 YAML 刷新浏览器就生效，不用重启后端
> 3. **自描述渲染**——前端通过 DataEnvelope 的 column 定义自动渲染表格，新增 Skill 前端零改动"

#### Q7: "最难的技术挑战是什么？"（必问题，推荐讲 Context Engineering）

> "最难的是 **Context Engineering**——怎么在有限的 token 预算内给 Claude 足够的上下文。
>
> 具体有三个子问题：
>
> **第一，系统 prompt 预算管理**。我的系统 prompt 由 15+ 个 section 组成，总量经常超 4500 tokens 上限。我实现了渐进式裁剪——按优先级排序，先砍知识库、再砍历史模式、再砍 SQL 错误对，但用户意图和场景策略永远不砍。
>
> **第二，Skill 结果太大**。一个滚动分析 Skill 可能返回 3000+ tokens。所以我设计了 ArtifactStore——结果先存下来，Claude 只看 summary（60 tokens），需要时调 fetch_artifact 按页拉取。配合 SQL 摘要，整体省了 85% 的 token。
>
> **第三，跨 turn 记忆**。SDK 会自动 compact 历史消息，早期 turn 的细节会丢失。所以我设计了 write_analysis_note 工具，让 Claude 把关键发现主动写下来。这些 notes 作为结构化数据注入到后续 turn 的 prompt 里，保证分析连贯性。"

#### Q8: "怎么保证 Agent 输出质量？30% 误报率怎么处理？"

> "四层验证系统：
> 1. **启发式检查**（<1ms）——CRITICAL 发现必须有证据、不能超过 5 个 CRITICAL、检测已知误诊模式
> 2. **Plan 遵守度**——检查所有计划阶段是否执行、预期工具是否调用
> 3. **假设闭环**——所有 submit_hypothesis 必须被 resolve，不能留 'formed' 状态
> 4. **可选 LLM 验证**——用轻量模型(Haiku)交叉验证结论
>
> 验证不通过 → 纠正 prompt → Agent 反思修正。同时有学习机制——误诊模式出现 ≥2 次就自动加入检测规则（90 天 TTL，30 条上限）。"

#### Q9: "有什么具体的数据指标吗？"

参见 [第一节的硬数据表格](#硬数据)。

---

### 场景二：系统设计面

#### Q10: "如果要支持多用户并发分析，你会怎么设计？"

> "现在是单机架构。如果要水平扩展：
> 1. **无状态化后端**——session state 从内存 Map 迁到 Redis，ArtifactStore 迁到对象存储
> 2. **trace_processor 池化**——现在每个 trace 独占一个进程（端口 9100-9900），可以改成 K8s Pod 池
> 3. **SSE → WebSocket + 消息队列**——用 Redis Pub/Sub 解耦分析进程和 API 进程
> 4. **CDN 分发 trace 文件**——trace 文件几十 MB，上传后存 S3"

#### Q11: "18 个 MCP 工具怎么设计的？怎么决定粒度？"

> "按**能力域**分组（数据获取/知识查询/规划/推理/记忆）。
>
> 粒度的设计原则：**每个工具对应一个认知动作，而不是一个技术操作**。比如没有把 'execute_sql' 拆成 'query_frames' 和 'query_threads'，因为 Claude 自己知道该查什么表。但把 'submit_hypothesis' 和 'resolve_hypothesis' 分开了，因为'提出假设'和'验证假设'是两个不同的认知步骤，分开能让验证层检查闭环。"

#### Q12: "Claude API 挂了怎么办？容错机制？"

> "三层容错：
> 1. **指数退避重试**——529/500/503 错误自动重试，2s → 4s → 8s，最多 3 次
> 2. **Watchdog + 断路器**——连续 3 次同一工具失败 → 注入策略切换提示；5 次调用中 60% 失败 → 触发断路器
> 3. **优雅降级**——LLM 验证层失败不阻塞主流程；SDK session 过期（4h）自动降级为完整上下文注入；场景分类失败回退到 general 策略"

---

### 场景三：行为面 / BQ 面

#### Q13: "你怎么从零开始设计这个系统的？"

> "按 3 个阶段迭代：
>
> **阶段一（v1-v2）**：最简单方案——直接调 DeepSeek API，把 trace 数据发过去。很快发现两个问题：context window 装不下完整数据，LLM 不了解 Perfetto 表结构经常写错 SQL。
>
> **阶段二（v2 → v3 过渡）**：抽象 Skill 系统——把常用 SQL 封装成 YAML，LLM 调用 Skill 而不是写原始 SQL。同时引入场景分类。
>
> **阶段三（v3）**：全面切到 Claude Agent SDK + MCP 协议。Agent 从'被动回答'变成'主动探索'，能自己规划、执行、验证。花最多时间在 Context Engineering 和验证系统上。"

#### Q14: "遇到过什么重大决策失误？"

> "最大的一次是**过早优化 prompt 措辞**。v3 初期花了很多时间精心设计 system prompt 的措辞，结果发现 Claude 对 prompt 的敏感度比预期低——真正影响输出质量的不是措辞，而是**给它什么工具、什么数据、什么约束**。后来把精力转到 Context Engineering 上（ArtifactStore、SQL 摘要、Plan 门控），效果立刻好了很多。
>
> 教训：**与其优化 prompt 的文字，不如优化 Agent 的环境。**"

#### Q15: "你怎么测试一个 AI Agent？输出是非确定性的"

> "分层测试策略：
> 1. **确定性层全覆盖**——Skill Engine、场景分类、SQL 摘要、DataEnvelope 渲染用常规单元测试
> 2. **Trace 回归测试**——6 条 canonical trace 必跑。不检查输出文字，检查结构性指标：是否执行了关键 Skill、是否检测到正确架构、是否有 CRITICAL 发现
> 3. **Skill 评估测试**——独立测试每个 YAML Skill 在特定 trace 上的 SQL 输出
> 4. **验证系统可测试**——启发式检查是纯函数，可以用预定义数据测试"

---

### 场景四：技术细节追问

#### Q16: "Plan 门控机制具体怎么实现的？"

> "`execute_sql` 和 `invoke_skill` 执行前调 `requirePlan()`——检查当前 session 是否已有 submit_plan 记录。没有则返回错误 '请先提交分析计划'。不做门控时 Claude 会上来就执行 20+ 条无关 SQL，加了门控后被迫先思考分析路径，效率和 token 消耗都改善了。"

#### Q17: "跨会话学习的 Jaccard 相似度怎么算的？"

> "不是简单 Jaccard——用了**加权 Jaccard**。trace 特征分 5 类 tag：
> - `arch`（架构）和 `scene`（场景）权重 3.0——最强信号
> - `domain`（App 家族）权重 2.0
> - `cat`（发现类别）权重 1.5
> - `finding`（具体标题）权重 0.5——太具体，降权
>
> 再乘以**时间衰减**（30 天半衰期指数衰减）和**频率增益**（`1 + log₂(1+matchCount) × 0.1`）。最终取 top 3 且分数 > 0.25 的注入 prompt。"

#### Q18: "前台 App 检测为什么需要 3 级 fallback？"

> "因为不同 trace 可用的数据源不同：
> - **Tier 1**: `android_battery_stats`——最可靠，但需要 battery stats tracing 开启
> - **Tier 2**: `android_oom_adj_intervals`——OOM adj=0 是前台，大部分 trace 有
> - **Tier 3**: `actual_frame_timeline_slice`——从 SurfaceFlinger layer 名解析包名（`TX - com.example.app/Activity#1234`）
>
> 每层有 sqlite_master 守卫——先检查表是否存在再查询，失败降级。保证不管 trace 怎么抓的都能尽力检测。"

---

## 五、Vision & Gap：终极形态与当前差距

### 终极形态：4 个层次

#### 层次一：实时分析（事后验尸 → 实时诊断）

```
现在：抓 trace → 上传 → 分析（事后，分钟级）
理想：实时 trace 流 → 边抓边分析 → 即时告警（实时，秒级）
```

> 需要流式 trace_processor 支持（Perfetto 上游在做但未就绪）。

#### 层次二：对比分析（单点 → 趋势）

```
现在：分析单个 trace
理想：对比 A/B trace → 自动识别回归
      版本 v1.0 vs v1.1 → 哪些指标退化了？
      优化前 vs 优化后 → 改进了多少？
```

> 工程师最常问的不是"这个 trace 怎么样"，而是"比上次好了还是差了"。

#### 层次三：CI/CD 集成（被动分析 → 主动防御）

```
现在：用户反馈卡 → 抓 trace → 分析（被动，用户已受影响）
理想：每次 CI 自动跑 benchmark → 自动抓 trace → 自动分析
      → 性能退化自动拦截 MR（主动，用户无感知）
```

> Gap 2（对比分析）是 Gap 3 的前置依赖。

#### 层次四：团队知识网络（单人工具 → 团队大脑）

```
现在：单用户，学习结果在本地
理想：团队共享分析模式 → 共享 Skill 库 → 跨项目知识迁移
      A 发现的 pattern → B 分析时自动提示
```

### 当前完成度（约 60-65%）

| 维度 | 完成度 | 现状 | 差什么 |
|------|--------|------|--------|
| 单 trace 分析 | 90% | 162 Skill、8 场景策略、4 层验证、多轮对话 | 误报率 ~30%，深度根因不够深 |
| Context Engineering | 85% | ArtifactStore、SQL 摘要、渐进裁剪、跨会话学习 | 长对话(>10 轮)上下文质量衰减 |
| 对比分析 | 20% | v2 有原型，v3 未迁移 | 需要全新对比 Skill 体系 + UI |
| 实时分析 | 0% | 纯事后分析 | 依赖 Perfetto 流式 trace_processor |
| CI/CD 集成 | 15% | 有 GitHub Actions 回归门禁 | 缺 benchmark 自动化 + 对比 + MR 拦截 |
| 团队协作 | 5% | 单用户，无认证 | 需要用户系统 + 共享模式库 |
| 报告导出 | 40% | CSV/JSON 导出 | 缺 PDF/HTML 可视化报告 |
| 厂商适配 | 70% | 8 大厂商 Skill 覆盖 | 私有 trace 格式未覆盖 |

### 最值得讲的 3 个 Gap

**Gap 1：误报率 30% → 目标 <10%**

> 4 层验证已拦截很多，根本原因是 LLM 对 Android 性能领域理解不够深。应对：加强知识库注入（已有 6 个知识模板）+ 学习型误诊模式（已实现）。长期看 fine-tuning 效果会更好，但目前 Claude 不支持。

**Gap 2：单 trace → 对比分析**

> 用户最想要的功能。技术上需要：同时加载两个 trace_processor 实例、对比 SQL、对比渲染组件。架构已预留端口池（9100-9900），但对比 Skill 和 UI 都还没做。

**Gap 3：事后分析 → CI/CD 集成**

> 需要三个组件：benchmark runner、baseline 管理、对比分析引擎（依赖 Gap 2）。

---

## 六、面试完整叙事线（5-8 分钟）

```
Opening (30s)
"我独立开发了一个 AI 驱动的 Android 性能分析平台..."

Before (1min)
"传统分析要 45-90 分钟，门槛高，容易遗漏，经验无法传承..."

After (2min)
"现在 2-3 分钟出完整报告，162 个 Skill 全维度扫描..."
（画架构图：Frontend ← SSE → Backend ← MCP → Claude SDK ← RPC → trace_processor）

核心技术亮点 (2min)
"三个最有意思的设计：
 1. Context Engineering（85% token 节省）
 2. 确定性+概率性混合架构
 3. 4 层验证系统"

Vision + Gap (2min)
"最终要做成 CI/CD 里的性能守门员，现在完成了约 65%，
最大的 gap 是对比分析和误报率..."

收尾 (30s)
"这个项目让我深刻理解了：AI Agent 不是调 API 的 demo，
而是一个完整的工程系统——规划、执行、验证、学习的闭环。"
```

### 主动引导追问方向

讲完一个点后用这些"钩子"引导面试官追问你准备好的话题：

- "这里有个有趣的 trade-off..."（引向混合架构/MCP 设计）
- "最难的其实不是这个，而是..."（引向 Context Engineering）
- "我们踩过一个坑..."（引向 prompt 优化失误/验证系统迭代）
- "这个设计背后有个依赖关系..."（引向 Gap 之间的依赖）

### 准备好的追问答案

- **"为什么不直接用 LLM"** → 30% 误报率、输出不稳定、不遵循分析步骤
- **"为什么用 MCP"** → 标准化工具协议、自动发现、和 Agent SDK 原生集成
- **"怎么保证质量"** → 4 层验证 + 6 条 canonical trace 回归测试
- **"怎么处理大数据"** → Artifact 分页 + SQL 摘要 + 渐进式 context 裁剪

---

## 附录：面试加分 Buzzword 清单

| 领域 | 术语 | 项目中的对应 |
|------|------|-------------|
| AI Engineering | **Context Engineering** | 15-section prompt + 渐进裁剪 + ArtifactStore |
| AI Engineering | **Tool Use / Function Calling** | 18 个 MCP 工具 |
| AI Engineering | **Guardrails** | 4 层验证 + Plan 门控 + Watchdog |
| AI Engineering | **Agentic Architecture** | 假设-验证循环 + 多轮反思修正 |
| System Design | **Schema-driven Rendering** | DataEnvelope 自描述数据契约 |
| System Design | **Progressive Disclosure** | L1→L4 分层结果 |
| System Design | **Circuit Breaker** | 工具调用断路器 |
| System Design | **Graceful Degradation** | 3 级 fallback + 验证层容错 |
| System Design | **Content-Code Separation** | Strategy/Skill 外置 Markdown/YAML |
| Engineering | **Deterministic + Probabilistic Hybrid** | 策略驱动 + 假设推理双轨 |
| Engineering | **Cross-session Learning** | 加权 Jaccard + 负模式 + SQL 错误对 |

---

> **核心记忆点：** 这个项目最独特的卖点不是"调了 Claude API"，而是**真正落地的 AI Agent 工程化**——规划、执行、验证、学习的完整闭环。在 2026 年，这是非常稀缺的实战经验。16 万行代码 + 162 个 Skill + 250 个测试文件，独立从零搭建，本身就是很强的信号。

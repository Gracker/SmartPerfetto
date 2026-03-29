# 从 Trace 到洞察：SmartPerfetto AI Agent 平台的 Harness Engineering 全拆解

> 一条用户提问如何变成一份完整的性能分析报告？这中间经历了场景分类、策略注入、动态 System Prompt 组装、MCP 工具编排、Artifact 压缩、SSE 实时流、多层验证、跨会话学习……本文逐层拆解 SmartPerfetto 的 AI Agent 架构，记录每一层的技术决策和工程取舍。

## 为什么需要一个 AI Agent 平台来分析 Perfetto Trace？

Perfetto trace 动辄几百 MB，包含数百万个 slice、上千条 track。传统的分析方式是：打开 Perfetto UI，凭经验目测时间线，手写 SQL 查数据，人脑关联因果链。这个流程对一个 Android 性能专家来说需要 30-60 分钟，对一个非专家可能需要数小时甚至无法完成。

SmartPerfetto 的目标是把这个专家级分析能力封装成一个 AI Agent：用户用自然语言提问（"分析这段 trace 的滑动性能"），Agent 自主完成场景识别、数据查询、假设验证、根因推理，最后输出结构化的分析结论。

但「调用一次 Claude API」和「构建一个生产级分析 Agent」之间的差距，恰恰就是 **Harness Engineering** ——围绕 LLM 构建的一整套工程基础设施。

## 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                    用户 (Perfetto UI 浏览器)                       │
│     ┌──────────────────────────────────────────────────────┐     │
│     │  AI Assistant Plugin (Mithril Component)             │     │
│     │  ├─ ai_panel.ts      — 对话面板 & 状态管理            │     │
│     │  ├─ sse_event_handlers.ts — SSE 事件解析 & 分发       │     │
│     │  ├─ data_formatter.ts    — DataEnvelope → UI 渲染     │     │
│     │  └─ session_manager.ts   — localStorage 会话持久化     │     │
│     └───────────────────┬──────────────────────────────────┘     │
└─────────────────────────┼────────────────────────────────────────┘
                          │ POST /api/agent/v1/analyze (SSE)
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Express 后端 (:3000)                            │
│                                                                   │
│  ┌─── agentRoutes.ts ─────────────────────────────────────────┐  │
│  │ 请求接入 → 建立 SSE 连接 → 调用 ClaudeRuntime.analyze()    │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
│                         ▼                                         │
│  ┌─── ClaudeRuntime (claudeRuntime.ts) ───────────────────────┐  │
│  │                                                             │  │
│  │  Phase 0: 并行预处理                                        │  │
│  │  ├─ classifyScene()          — 场景分类 (<1ms)              │  │
│  │  ├─ classifyQueryComplexity() — 复杂度路由 (hard rule/Haiku)│  │
│  │  ├─ detectFocusApps()        — 焦点应用检测                 │  │
│  │  └─ detectArchitecture()     — 渲染架构检测 (cached)        │  │
│  │                                                             │  │
│  │  Phase 1: 构建分析上下文                                    │  │
│  │  ├─ buildSystemPrompt()      — 动态 System Prompt 组装     │  │
│  │  ├─ createClaudeMcpServer()  — 17 个 MCP 工具注册          │  │
│  │  ├─ buildAgentDefinitions()  — Sub-Agent 定义              │  │
│  │  └─ loadLearnedSqlFixPairs() — 跨会话 SQL 学习             │  │
│  │                                                             │  │
│  │  Phase 2: SDK 调用 + 工具循环                               │  │
│  │  ├─ sdkQuery() ──► Claude Agent SDK ──► Anthropic API      │  │
│  │  │   └─ Stream: text_delta / tool_use / compact_boundary   │  │
│  │  ├─ MCP Server 执行工具                                     │  │
│  │  │   ├─ execute_sql → trace_processor_shell (SQLite)       │  │
│  │  │   ├─ invoke_skill → YAML Skill Engine (L1-L4)          │  │
│  │  │   ├─ submit_analysis_plan → Planning Gate               │  │
│  │  │   ├─ submit_hypothesis → Hypothesis Cycle               │  │
│  │  │   └─ fetch_artifact → ArtifactStore (3-level fetch)     │  │
│  │  └─ SSE Bridge: SDK stream → SSE events → 前端             │  │
│  │                                                             │  │
│  │  Phase 3: 验证 + 持久化                                     │  │
│  │  ├─ extractFindings()        — 结构化发现提取               │  │
│  │  ├─ verifyConclusion()       — 3 层验证                    │  │
│  │  ├─ saveAnalysisPattern()    — 跨会话模式学习              │  │
│  │  └─ generateReport()         — HTML 报告生成               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─── trace_processor_shell (共享进程) ───────────────────────┐  │
│  │  SQLite over HTTP RPC (端口 9100-9900)                     │  │
│  │  — Perfetto 原生 trace 查询引擎                             │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

在写任何代码之前，先要在脑子里跑通一个最小循环：

**用户提问 → 场景分类 → 组装 System Prompt → SDK 调用 (SSE stream) → 解析 stop_reason → tool_use 则执行 MCP 工具 → 工具结果追加到 messages → 反复迭代 → end_turn 则提取结论 → 验证 → 输出**

这个循环画清楚了，后面每一层的设计都是围绕「如何让这个循环在领域场景下更高效、更准确、更节省 token」展开的。

---

## 第一层：场景分类 — 用 <1ms 的关键词匹配省 3500 tokens

最直觉的做法是把所有场景的分析策略塞进 System Prompt。但 Perfetto 有 12 个分析场景（scrolling / startup / ANR / interaction / pipeline / game / memory / overview / scroll-response / touch-tracking / teaching / general），每个策略 500-3000 tokens，全部注入会导致 System Prompt 膨胀到 15000+ tokens，既浪费钱又稀释有效信息密度。

**Scene Classifier 的设计决策**：纯关键词匹配，零 LLM 调用。

```typescript
// sceneClassifier.ts — 12 场景，<1ms 执行
export function classifyScene(query: string): SceneType {
  const scenes = getRegisteredScenes(); // 从 .strategy.md frontmatter 加载
  const lower = query.toLowerCase();

  const sorted = scenes
    .filter(s => s.scene !== 'general')
    .sort((a, b) => a.priority - b.priority);  // ANR(1) → startup(2) → scrolling(3) → ...

  for (const scene of sorted) {
    // 复合模式优先（更精确）
    if (scene.compoundPatterns.some(p => p.test(query))) return scene.scene;
    // 再匹配单关键词
    if (scene.keywords.some(k => lower.includes(k))) return scene.scene;
  }
  return 'general';
}
```

**关键设计：关键词来自外部文件，不是硬编码。** 每个 `*.strategy.md` 的 YAML frontmatter 声明自己的 `keywords` 和 `compoundPatterns`：

```yaml
# scrolling.strategy.md frontmatter
---
scene: scrolling
priority: 3
keywords: [滑动, 掉帧, jank, scroll, fps, 帧率, 卡顿, 丢帧, frame drop]
compoundPatterns:
  - "(?:分析|看看|检查).*(?:滑动|滚动|列表)"
  - "(?:frame|帧).*(?:drop|丢|掉|卡)"
---
```

这意味着**添加新场景不需要改代码**——新建一个 `.strategy.md` 文件，声明关键词，重启即生效（DEV 模式下连重启都不需要）。

**Progressive Prompt Disclosure 的效果：** 当用户问 "分析启动性能" 时，只注入 `startup.strategy.md` 的内容，滑动、ANR、游戏等策略完全不出现在 System Prompt 中。实测省 ~3500 tokens/轮，按 30 轮分析计算，单次分析省约 10 万 tokens。

---

## 第二层：动态 System Prompt — 不是一个大字符串，是一条流水线

System Prompt 的组装不是字符串拼接，是一条 **有优先级、有预算、可降级** 的流水线。

### 组装顺序（固定优先级）

| 段落 | 来源 | 可变性 | 预估 tokens |
|------|------|--------|------------|
| 1. 角色声明 | `prompt-role.template.md` | 静态 | ~100 |
| 2. 分析方法论 | `prompt-methodology.template.md` + `{{sceneStrategy}}` | 半静态 | ~800 |
| 3. 输出格式规范 | `prompt-output-format.template.md` | 静态 | ~300 |
| 4. 渲染架构 | `arch-*.template.md` (Standard/Flutter/Compose/WebView) | 按 trace 动态 | ~200-400 |
| 5. 焦点应用 | 运行时检测 | 按 trace 动态 | ~100-200 |
| 6. 场景策略 | `*.strategy.md` (匹配的那个) | 按查询动态 | ~1500-3500 |
| 7. 选区上下文 | `selection-*.template.md` | 按交互动态 | ~100-300 |
| 8. 模式上下文 | `analysisPatternMemory.ts` | 按会话动态 | ~500-1000 |
| 9. 负面模式 | 同上 | 按会话动态 | ~200-400 |
| 10. 实体上下文 | `entityCapture.ts` (多轮) | 按对话动态 | ~100-300 |
| 11. SQL 纠错对 | `error_fix_pairs.json` | 跨会话学习 | ~200-500 |

### Token 预算执行

```typescript
const MAX_PROMPT_TOKENS = 4500;

function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += char.charCodeAt(0) > 0x2E80 ? 1.5 : 0.3; // CJK vs ASCII
  }
  return Math.ceil(tokens);
}
```

当总 tokens 超过 4500 时，**从底部开始逐段丢弃**：先丢 SQL 纠错对，再丢负面模式，再丢模式上下文……核心段（角色、方法论、输出格式）永远不丢。这个降级策略确保了即使上下文很丰富的多轮对话，System Prompt 也不会失控。

### 模板变量替换

所有 Prompt 内容都在 Markdown 文件中，TypeScript 只做加载和变量替换：

```typescript
// strategyLoader.ts
const content = loadPromptTemplate('methodology');
const rendered = renderTemplate(content, {
  sceneStrategy: buildSceneStrategySection(sceneType),
  architectureSection: buildArchitectureSection(arch),
  focusApps: buildFocusAppSection(apps),
});
```

模板使用 `{{variable}}` 语法，Skill YAML 使用 `${param|default}` 语法。两套语法刻意区分，避免混淆。

**为什么不把 Prompt 写在 TypeScript 里？** 因为 Prompt 调优的频率远高于代码修改。策略文件修改后 DEV 模式热加载，刷新浏览器即生效，无需重启后端——这让 Prompt 迭代的反馈循环从分钟级缩短到秒级。

---

## 第三层：复杂度路由 — 简单问题秒回，复杂问题深钻

不是所有问题都需要完整的多轮分析。"这个 trace 有多长？" 和 "分析滑动性能的根因" 的处理路径应该完全不同。

**Query Complexity Classifier** 实现两阶段分类：

### Stage 1：Hard Rules（0ms，无 LLM）

```typescript
function applyHardRules(input): { complexity: QueryComplexity } | null {
  if (input.hasSelectionContext)   return { complexity: 'full' };  // UI 框选
  if (input.hasReferenceTrace)     return { complexity: 'full' };  // 对比模式
  if (input.hasExistingFindings)   return { complexity: 'full' };  // 多轮深钻
  if (input.hasPriorFullAnalysis)  return { complexity: 'full' };  // 对话延续
  if (DETERMINISTIC_SCENES.has(input.sceneType)) return { complexity: 'full' };
  return null; // 进入 Stage 2
}
```

覆盖 ~70% 的查询，确定性场景（scrolling / startup / ANR / interaction / scroll-response）直接走完整分析路径。

### Stage 2：Haiku 分类（~1-2s）

剩余 ~30% 的模糊查询交给 Haiku 判断：

```
这个查询是简单的事实查询（可以用 1-2 步 SQL 回答），还是需要多步推理分析？
- 简单: "trace 时长多少" / "有哪些进程"
- 复杂: "为什么启动慢" / "分析卡顿原因"
```

Haiku 调用失败时 graceful degradation 到 `full`——宁可多分析，不要漏分析。

**Quick Path 的实际效果：** 简单查询 ~3-5 秒返回（1 轮 SDK 调用），完整分析 ~30-90 秒（5-15 轮）。用户体验上是「秒回 vs 深度分析」的自然分流。

---

## 第四层：MCP 工具系统 — Agent 的「手」

Claude Agent SDK 通过 MCP (Model Context Protocol) 让 Claude 调用外部工具。SmartPerfetto 运行一个 **进程内 MCP Server**（不是 stdio 子进程），注册 17 个工具：

### 9 个常驻工具

| 工具 | 用途 | 关键设计 |
|------|------|---------|
| `execute_sql` | 查询 trace_processor | SQL 纠错学习 + 结果摘要化 |
| `invoke_skill` | 执行 YAML Skill | 结果存入 ArtifactStore |
| `list_skills` | 发现可用 Skill | 按场景过滤 |
| `fetch_artifact` | 获取 Skill 结果详情 | 3 级 fetch (summary/rows/full) |
| `submit_analysis_plan` | 提交分析计划 | **Planning Gate** |
| `submit_hypothesis` | 提交/验证假设 | 假设生命周期管理 |
| `write_analysis_note` | 记录分析笔记 | Context Compact 后恢复 |
| `lookup_sql_schema` | 查询表结构 | 761 模板的 Schema Index |
| `detect_architecture` | 检测渲染架构 | 结果缓存 per traceId |

### 8 个条件工具（按场景/能力注入）

| 工具 | 条件 |
|------|------|
| `list_stdlib_modules` | 始终可用 |
| `lookup_knowledge` | 始终可用 |
| `get_pattern_matches` | 有历史模式时 |
| `query_perfetto_source` | 始终可用 |
| `get_comparison_context` | 对比模式时 |
| `compare_sql` | 对比模式时 |
| `compare_skill` | 对比模式时 |
| 子 Agent 工具 | 启用子 Agent 时 |

**条件工具 vs Deferred Tools：** 小八文章中 Claude Code 使用 Deferred Tools（低频工具不放入 tools 数组，按需通过 ToolSearch 加载）。SmartPerfetto 的条件工具是**场景感知**的——不是按调用频率延迟加载，而是根据当前分析场景决定是否注入。对比模式下才出现 `compare_sql`，这比通用的 deferred 机制更精准。

### Planning Gate — 先想再做

```typescript
function requirePlan(toolName: string): string | null {
  if (!planGateEnabled) return null;
  if (analysisPlan) return null;  // 已提交计划
  return `⚠ 请先调用 submit_analysis_plan 提交分析计划，再使用 ${toolName}。`;
}
```

Claude 必须先调用 `submit_analysis_plan` 声明要做什么，才能解锁 `execute_sql` 和 `invoke_skill`。这个 Gate 机制：
1. **强制规划** — 避免 Claude 跳过思考直接查数据
2. **可审计** — 计划被记录，Verifier 会检查 Claude 是否按计划执行
3. **可恢复** — Context Compact 后，计划作为恢复笔记注入

### REASONING_NUDGE — 每次工具调用后的反思提示

```typescript
const REASONING_NUDGE = '\n\n[REFLECT] 在执行下一步之前：这个数据的关键发现是什么？'
  + '是否支持/反驳你的假设？如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';
```

每次 `execute_sql` 或 `invoke_skill` 成功后，结果末尾追加这段 Nudge。成本 ~20 tokens/次，总计 ~200-300 tokens/分析。效果是迫使 Claude 在每步操作后显式推理，而不是机械地执行下一条 SQL。

### SQL 纠错学习 — 跨会话的错误记忆

```typescript
// 当 SQL 执行失败
recentSqlErrors.push({ errorSql, errorMessage, timestamp });

// 当后续 SQL 成功——用 Jaccard 相似度匹配
const matchingError = recentSqlErrors.find(err => {
  const errTokens = sqlContentTokens(err.errorSql);
  const fixTokens = sqlContentTokens(sql);
  const intersection = new Set([...errTokens].filter(t => fixTokens.has(t)));
  return intersection.size / Math.max(errTokens.size, fixTokens.size) > 0.3;
});

if (matchingError) {
  await logSqlErrorFixPair({ ...matchingError, fixedSql: sql }); // 持久化到磁盘
}
```

Jaccard 相似度计算刻意排除了 SQL 结构关键词（SELECT / FROM / WHERE 等）和 Perfetto 领域通用 token（upid / utid / dur 等），只比较**有意义的内容词**。这避免了「任何两条 Perfetto SQL 因为共享 SELECT FROM slice WHERE 就被认为相似」的误匹配。

跨会话学习：下次新分析开始时，最近 10 条纠错对被加载到 System Prompt，Claude 能直接避开已知的 SQL 错误模式。TTL 30 天，过期后自动清理（因为 Perfetto schema 可能变化）。

---

## 第五层：Artifact Store — 用引用代替复制，省 85% tokens

这是 SmartPerfetto 最核心的 token 优化机制之一。

**问题：** 一个 Skill 执行结果可能有 200 行数据、3000 tokens。Claude 在 15 轮分析中可能调用 5-8 个 Skill，如果每次都把完整结果放入 messages，仅 Skill 数据就占 15000-24000 tokens。

**解决方案：** Skill 结果不直接返回给 Claude，而是存入 ArtifactStore，只返回紧凑引用。

```typescript
class ArtifactStore {
  private artifacts: Map<string, StoredArtifact> = new Map();
  private readonly maxArtifacts = 50;  // LRU 容量

  store(entry): string {
    // 超容量时淘汰最久未访问的
    if (this.artifacts.size >= this.maxArtifacts) this.evictLRU();
    const id = `art_${++this.counter}`;
    this.artifacts.set(id, { ...entry, id, storedAt: Date.now(), lastAccessedAt: Date.now() });
    return id;
  }
}
```

**返回给 Claude 的紧凑引用（~440 tokens）：**

```
✅ scrolling_jank_summary 执行成功
📊 概要: 125 个 jank 帧，平均耗时 23.4ms
📎 Artifact ID: art_3 (详情: fetch_artifact("art_3", "rows", 0, 20))
```

**Claude 需要详情时的 3 级 fetch：**

| 级别 | 命令 | 返回内容 | tokens |
|------|------|---------|--------|
| `summary` | `fetch_artifact("art_3", "summary")` | 行数 + 列名 + 首行样本 | ~50 |
| `rows` | `fetch_artifact("art_3", "rows", 0, 20)` | 分页数据 (offset/limit) | ~200-500 |
| `full` | `fetch_artifact("art_3", "full")` | 完整数据 | ~3000 |

大多数情况下 Claude 只需要 summary 就够了——它可以根据概要判断是否需要深入查看。这个设计把数据的 **传输粒度决策权** 交给 Claude 自己，而不是一次性倾倒所有数据。

**同时，完整数据通过 SSE DataEnvelope 流向前端：**

```
ArtifactStore ──(compact ref)──► Claude 上下文 (~440 tokens)
     │
     └──(full DataEnvelope)──► SSE ──► 前端 UI 渲染 (~3000 tokens)
```

前端看到的是完整数据（表格、图表），Claude 看到的是摘要引用。两个消费者各取所需。

---

## 第六层：SSE Bridge — SDK 流到前端流的翻译层

Claude Agent SDK 的输出是一个混合类型的事件流（text_delta / tool_use / system 等），前端需要的是语义化的分析事件（进度 / 思考 / 工具执行 / 结论 / 答案）。SSE Bridge 承担这个翻译。

### 文本分类的 200ms 缓冲策略

Claude 的文本输出有两种语义：**中间推理（thought）** 和 **最终答案（answer）**。但 SDK 流里它们都是 `text_delta` 事件，没有显式区分。

```typescript
// 200ms 缓冲窗口判断文本类型
let textBuffer = '';
let bufferTimer: NodeJS.Timeout | null = null;

function onTextDelta(text: string) {
  textBuffer += text;
  if (!bufferTimer) {
    bufferTimer = setTimeout(() => {
      // 200ms 内没有 tool_use → 这是 answer
      emitUpdate({ type: 'answer_token', text: textBuffer });
      textBuffer = '';
      bufferTimer = null;
    }, 200);
  }
}

function onToolUseDetected() {
  // 有 tool_use 出现 → 之前的文本是 thought
  if (textBuffer) {
    emitUpdate({ type: 'thought', text: textBuffer });
    textBuffer = '';
  }
  clearTimeout(bufferTimer);
  bufferTimer = null;
}
```

**逻辑：** 如果一段文本后面紧跟 tool_use（200ms 内），说明 Claude 在「思考然后调用工具」——文本是 thought。如果 200ms 后没有 tool_use，说明 Claude 在输出最终答案。

这个启发式覆盖 ~95% 的情况。偶尔误分类时有补救机制：如果 buffer 已经 flush 为 answer 但随后检测到 tool_use，会回溯清理。

### SSE 事件语义化

| SDK 原始事件 | SSE 翻译后 | 前端用途 |
|-------------|-----------|---------|
| `system:init` | `progress` (starting) | 显示模型和工具信息 |
| `text_delta` (后跟 tool_use) | `thought` | 折叠显示中间推理 |
| `text_delta` (后无 tool_use) | `answer_token` | 流式渲染最终答案 |
| `tool_use` (execute_sql) | `agent_response` + `progress` | 显示 SQL 执行和结果 |
| `tool_use` (invoke_skill) | `agent_response` + `progress` | 显示 Skill 执行和数据 |
| `system:task_started` | `sub_agent_started` | 显示子 Agent 启动 |
| `system:task_completed` | `sub_agent_completed` | 显示子 Agent 完成 |
| `system:compact_boundary` | `progress` (warning) | 提示用户上下文被压缩 |
| end_turn | `conclusion` → `analysis_completed` | 显示结论 + 生成报告 |

**工具名称的友好化翻译：**

```typescript
function getFriendlyToolMessage(toolName: string, args: any): string {
  switch (toolName) {
    case 'mcp__smartperfetto__execute_sql': {
      const table = sql.match(/from\s+(\w+)/i)?.[1] || '';
      const tableHints = {
        actual_frame_timeline_event: '帧渲染数据',
        thread_state: '线程状态',
        android_launches: '应用启动',
        // ...
      };
      return hint ? `执行 SQL 查询: ${hint}` : '执行 SQL 查询';
    }
    // ...
  }
}
```

用户在前端看到的不是 `mcp__smartperfetto__execute_sql`，而是 `执行 SQL 查询: 帧渲染数据`。这层翻译让技术实现细节对用户透明。

---

## 第七层：YAML Skill 系统 — Agent 的领域知识库

如果 MCP 工具是 Agent 的「手」，YAML Skill 就是 Agent 的「领域专家知识」。

### Skill 是什么？

一个 Skill 是一个 **声明式的分析流程**，用 YAML 定义：

```yaml
# skills/atomic/scrolling_jank_summary.skill.yaml
id: scrolling_jank_summary
name: 滑动卡顿概要
description: 统计 jank 帧数量、分类和分布
type: atomic
scene: scrolling

inputs:
  - name: process_name
    type: string
    required: true
  - name: time_range_start
    type: number
    required: false

steps:
  - id: jank_overview
    type: sql
    sql: |
      SELECT
        jank_type,
        COUNT(*) as frame_count,
        AVG(dur) / 1e6 as avg_duration_ms
      FROM actual_frame_timeline_slice
      WHERE process_name = '${process_name}'
        AND ts >= ${time_range_start|0}
      GROUP BY jank_type
    display:
      level: overview
      title: Jank 帧分类统计
      columns:
        - { name: jank_type, type: string }
        - { name: frame_count, type: number }
        - { name: avg_duration_ms, type: duration, unit: ms }
```

### 四层结果架构 (L1-L4)

| 层级 | 用途 | 典型内容 |
|------|------|---------|
| L1 overview | 一眼看全貌 | "125 个 jank 帧，平均 23.4ms" |
| L2 list | 展开看数据 | 按 jank_type 分类的帧列表 |
| L3 diagnosis | 逐帧诊断 | 每个 jank 帧的阻塞分析 |
| L4 deep | 深度根因 | 阻塞链 + Binder 调用 + CPU 调度 |

这个分层让前端可以 **渐进式渲染**：先显示 L1 概要，用户点击展开 L2 列表，再点击某帧查看 L3 诊断。

### Skill 的规模

```
skills/
├── atomic/     — 82 个单步技能
├── composite/  — 31 个组合技能
├── pipelines/  — 32 个渲染管线技能
├── modules/    — 18 个模块技能
├── vendors/    — 厂商覆写 (Pixel/Samsung/Xiaomi/Honor/OPPO/Vivo/Qualcomm/MTK)
├── deep/       — 2 个深度根因技能
└── config/     — 结论场景模板
```

总计 **165+ 个 Skill**，覆盖 Android 性能分析的几乎所有维度。Claude 通过 `list_skills` 发现可用 Skill，通过 `invoke_skill` 执行。

### 厂商覆写机制

不同芯片平台（高通/联发科）、不同厂商（三星/小米/OPPO）的 trace 格式和字段名有差异。`.override.yaml` 让同一个 Skill 在不同厂商环境下自动适配：

```yaml
# skills/vendors/qualcomm/gpu_frequency.override.yaml
overrides:
  steps:
    - id: gpu_freq
      sql: |
        SELECT ts, value FROM counter
        WHERE track_id IN (
          SELECT id FROM counter_track WHERE name = 'gpufreq'  -- Qualcomm 专用字段名
        )
```

---

## 第八层：三层验证 — 拦截 ~30% 的 Agent 误诊

这是 SmartPerfetto 区别于大多数 AI Agent 应用的关键机制。LLM 会犯错——在性能分析领域，约 30% 的 Agent 结论包含不同程度的误诊。

### 第一层：启发式检查（无 LLM，~0ms）

```typescript
const HARDCODED_MISDIAGNOSIS_PATTERNS = [
  {
    pattern: /VSync.*(?:对齐异常|misalign|偏移)/i,
    message: 'VSync 对齐异常可能是正常的 VRR (可变刷新率) 行为',
  },
  {
    pattern: /Buffer Stuffing.*(?:严重|critical|掉帧)/i,
    message: 'Buffer Stuffing 是管线背压问题，非 App 逻辑缺陷',
  },
  {
    pattern: /(?:单帧|single frame|1帧).*(?:异常|critical|严重)/i,
    message: '单帧异常不应标记为 CRITICAL',
  },
];
```

这些是从历史分析中总结出的**高频误诊模式**。正则匹配，零成本。

### 第二层：Plan 遵从检查（无 LLM）

验证 Claude 是否按照 `submit_analysis_plan` 中声明的步骤执行。如果计划说要分析 CPU 调度，但结论中没有 CPU 相关发现，触发 WARNING。

### 第三层：LLM 独立验证（Haiku）

```typescript
const verificationResult = await sdkQuery({
  prompt: `你是一个独立的性能分析审查员。请审查以下分析结论：
    ${conclusion}

    原始数据证据：
    ${evidenceSummary}

    检查：
    1. 每个发现是否有数据证据支持？
    2. 因果推理链是否完整？
    3. 严重等级是否合理？`,
  options: { model: 'haiku', maxTurns: 1 },
});
```

用独立的 Haiku 模型审查 Sonnet 的结论——不同模型的偏见不同，交叉验证能捕获单模型的盲区。

### 纠正循环

当验证发现 ERROR 级问题时，不是直接丢弃结论，而是生成 **Correction Prompt** 让 Claude 自我纠正：

```
你的分析结论存在以下问题：
1. [ERROR] VSync 对齐异常被标记为 CRITICAL，但设备支持 VRR
2. [WARNING] 计划中的 CPU 调度分析未在结论中体现

请基于以上反馈修正你的分析结论。
```

纠正后的结论再次经过验证，最多重试 2 轮。

### 跨会话学习

验证中确认的误诊模式被持久化到 `logs/learned_misdiagnosis_patterns.json`：

```json
{
  "keywords": ["buffer stuffing", "critical"],
  "message": "Buffer Stuffing 不应标记为 CRITICAL",
  "occurrences": 3,
  "lastSeen": 1711699200000
}
```

TTL 90 天，出现 ≥2 次才激活，最多保留 30 条。这让验证系统随着使用越来越精准。

---

## 第九层：跨会话模式学习 — 越用越准的分析引擎

除了 SQL 纠错对和误诊模式，SmartPerfetto 还维护更宏观的**分析模式记忆**。

### 正向模式

当一次分析成功完成且验证通过时，提取关键特征存入模式库：

```typescript
const features = extractTraceFeatures(traceId);  // trace 特征
const insights = extractKeyInsights(conclusion);   // 关键洞察

saveAnalysisPattern({
  features,  // 例: { archType: 'flutter', scene: 'scrolling', jankRate: 0.15 }
  insights,  // 例: ["TextureView 双管线是主要瓶颈", "RenderThread updateTexImage 耗时过长"]
  timestamp: Date.now(),
});
```

下次遇到相似 trace 时，匹配到的模式会注入 System Prompt 作为参考：

```
## 历史分析参考
之前分析类似 trace (Flutter TextureView, 滑动场景, jank 率 ~15%) 时的关键发现：
- TextureView 双管线是主要瓶颈
- RenderThread updateTexImage 耗时过长
```

这不是让 Claude 直接复用结论，而是提供**方向性引导**——"上次这类 trace 的问题出在 X，这次也值得看看"。

### 负向模式

当分析失败或被验证否决时，记录"什么方向是错的"：

```typescript
saveNegativePattern({
  sceneType: 'scrolling',
  approach: '尝试用 GPU 频率解释 UI 线程掉帧',
  reason: 'GPU 频率正常，掉帧是 CPU 调度问题',
});
```

负向模式同样注入 System Prompt：

```
## 已知无效方向（请避免）
- 不要用 GPU 频率解释 UI 线程掉帧（之前尝试过，GPU 频率正常时该方向无效）
```

正向 + 负向模式的组合，让 Agent 在每个场景下逐渐积累「该看什么、不该看什么」的经验。

---

## 第十层：Sub-Agent 系统 — 并行深钻

单 Agent 的瓶颈在于串行执行。当分析需要同时深入帧渲染、CPU 调度和内存状态时，串行处理会显著拉长分析时间。

SmartPerfetto 定义了 3 个专家子 Agent：

| 子 Agent | 专长 | 工具子集 |
|---------|------|---------|
| `frame-expert` | 帧渲染、Compose、Jank、VSync | execute_sql + invoke_skill + fetch_artifact |
| `system-expert` | CPU、内存、Binder、Thermal | 同上 |
| `startup-expert` | 应用启动性能 | 同上 |

```typescript
// claudeAgentDefinitions.ts
const agents = [
  {
    name: 'frame-expert',
    instructions: '你是帧渲染专家，专注于...',
    tools: deriveSubAgentTools(ctx.allowedTools),  // 去除编排类工具
    model: 'sonnet',
    maxTurns: 8,
    bestEffort: true,
  },
  // ...
];
```

**关键约束：**
- 子 Agent 的工具集**去除了编排类工具**（submit_plan / submit_hypothesis / get_pattern_matches），防止子 Agent 干扰主 Agent 的分析流程
- 每个子 Agent 最多 8 轮（主 Agent 30 轮），控制成本
- 120 秒超时，超时后 graceful stop 并记录为 medium severity 发现
- `bestEffort: true` — 子 Agent 失败不阻塞主分析

---

## 第十一层：Context Compact 恢复 — 长分析不丢失关键信息

Claude Agent SDK 在上下文接近窗口限制时会自动压缩历史消息。这对短对话影响不大，但对 15-30 轮的深度分析可能导致早期关键发现丢失。

SmartPerfetto 的恢复策略：

1. **检测 Compact：** 监听 SDK 的 `compact_boundary` 事件
2. **写入恢复笔记：** 将当前的关键发现、分析计划、验证假设写入 `write_analysis_note`
3. **Prompt 注入：** 恢复笔记在 Compact 后自动出现在下一轮的 System Prompt 中

```typescript
if (msg.subtype === 'compact_boundary') {
  sdkCompactDetected = true;
  // 写入恢复笔记，包含：
  // - 当前分析计划
  // - 已验证的假设
  // - 关键发现列表
  // - 当前进度
}
```

这确保了即使上下文被压缩，分析的核心脉络不会断裂。

---

## 与通用 Agentic CLI 的架构对比

读了小八那篇「从零构建 Claude Code」的文章后，两个系统的对比非常有意思：

### 共同的 Harness 层

| 维度 | Claude Code (CLI) | SmartPerfetto (Web Platform) |
|------|-------------------|------------------------------|
| Agent Loop | while 循环，max 25 轮 | SDK 管理，max 30 轮 |
| SSE 流式处理 | 原生 fetch + ReadableStream | Express SSE + SDK Stream Bridge |
| System Prompt | 分段缓存 (static/dynamic) | 分段组装 (流水线 + Token 预算) |
| 工具系统 | 21 内置 + MCP 动态 | 17 MCP 工具 (进程内) |
| 上下文压缩 | 自动 Compact (85% 阈值) | SDK Auto-Compact + 恢复笔记 |
| 多 Agent | Sub-Agent + Background Agent | 3 专家 Sub-Agent + 超时管理 |
| 持久记忆 | Auto Memory (4 类文件) | Pattern Memory + SQL 纠错 + 误诊学习 |

### SmartPerfetto 的领域工程层（CLI 不需要）

| 维度 | 实现 | 价值 |
|------|------|------|
| **Scene Classification** | 关键词分类器 → 策略注入 | 省 token + 精准引导 |
| **Artifact Store** | LRU + 3 级 fetch | ~85% token 节省 |
| **YAML Skill 系统** | 165+ 声明式技能 | 零代码领域知识 |
| **3 层验证** | 启发式 + Plan 遵从 + LLM | 拦截 ~30% 误诊 |
| **Quick Path** | Hard rules + Haiku 分类 | 简单问题 3-5 秒 |
| **渲染架构检测** | Standard/Flutter/Compose/WebView | 架构感知分析 |
| **厂商覆写** | .override.yaml | 多平台适配 |
| **DataEnvelope** | 统一数据合约 | 前端 schema-driven 渲染 |

### 小八有但 SmartPerfetto 可以借鉴的

| 维度 | 小八的实现 | 可行性 |
|------|-----------|--------|
| **Prompt Caching** (cache_control) | 3 层缓存设计，静态段首次写入后续命中 | **值得做** — role/methodology/output-format 是静态的，可省 ~60% input 费用 |
| **LSP 集成** | 代码修改后自动获取编译器诊断 | 不适用 |
| **两阶段权限分类** | Pattern + Haiku 双保险 | 不适用（后端服务） |
| **Plugin Manifest** | 6 类扩展点的统一声明 | YAML Skill 已是更好的替代 |

---

## 核心工程认知

构建这套系统最深的一个认知是：**核心难点不在于调用 LLM API，而在于 Harness Engineering。**

调用 Claude API 是十行代码的事。但要让 Agent 在 Perfetto trace 这个领域真正可用，需要解决的问题远比「发一个请求等一个回复」复杂得多：

1. **如何在有限的上下文窗口里塞入最有效的信息？** → Scene Classifier + Token 预算 + Artifact 压缩
2. **如何让 Agent 先想再做？** → Planning Gate + Hypothesis Cycle + Reasoning Nudge
3. **如何处理 Agent 的错误？** → 3 层验证 + 纠正循环 + 跨会话学习
4. **如何让工具结果同时服务 Agent 和用户？** → Artifact Store (Claude 看摘要) + DataEnvelope (前端看全量)
5. **如何在多轮分析中不丢失上下文？** → Analysis Notes + Compact 恢复 + 实体追踪
6. **如何让系统随着使用越来越好？** → Pattern Memory + Negative Patterns + SQL Error-Fix Pairs + Misdiagnosis Learning

这些问题的答案不在模型能力里，而在围绕模型构建的工程基础设施里。这就是 Harness Engineering 的本质——**不是让 AI 更聪明，而是让 AI 在特定场景下更有效。**

---

## 附录：数据流向全景

```
用户: "分析这段 trace 的滑动性能"
  │
  ▼
[Scene Classifier] → scrolling (关键词: 滑动)
[Complexity Classifier] → full (hard rule: deterministic scene)
[Focus App Detector] → com.example.app (前台 12.3 秒)
[Architecture Detector] → Standard (置信度 95%)
  │
  ▼
[System Prompt Builder]
  ├─ prompt-role.template.md               (静态, ~100 tokens)
  ├─ prompt-methodology.template.md        (含 scrolling 策略, ~800 tokens)
  ├─ prompt-output-format.template.md      (静态, ~300 tokens)
  ├─ arch-standard.template.md             (按 trace, ~200 tokens)
  ├─ 焦点应用: com.example.app             (动态, ~100 tokens)
  ├─ scrolling.strategy.md                 (按场景, ~2500 tokens)
  ├─ 历史模式: "上次类似 trace 问题在 RenderThread" (~300 tokens)
  └─ SQL 纠错对: 2 条                      (~200 tokens)
  总计: ~4500 tokens ✓
  │
  ▼
[Claude Agent SDK] — 开始多轮分析
  │
  ├─ Turn 1: submit_analysis_plan(...)     → Planning Gate 解锁
  ├─ Turn 2: invoke_skill(scrolling_jank_summary) → ArtifactStore (art_1)
  ├─ Turn 3: execute_sql(VSync 分析)       → SQL 结果 + REASONING_NUDGE
  ├─ Turn 4: submit_hypothesis("RenderThread 阻塞导致掉帧")
  ├─ Turn 5: invoke_skill(frame_blocking_calls) → ArtifactStore (art_2)
  ├─ Turn 6: fetch_artifact(art_2, "rows", 0, 10) → 分页查看阻塞详情
  ├─ Turn 7: [Sub-Agent: frame-expert] 并行深钻帧渲染
  ├─ Turn 8: submit_hypothesis("RenderThread dequeueBuffer 耗时 > 8ms", verified=true)
  ├─ Turn 9: write_analysis_note("confirmed", "RenderThread 阻塞链: dequeueBuffer → ...")
  └─ Turn 10: 输出最终结论
  │
  ▼
[Verifier]
  ├─ Layer 1: 启发式 ✓ (无已知误诊模式匹配)
  ├─ Layer 2: Plan 遵从 ✓ (所有计划步骤已执行)
  └─ Layer 3: Haiku 验证 ✓ (证据链完整)
  │
  ▼
[Finding Extractor] → 3 个发现 (1 HIGH, 1 MEDIUM, 1 INFO)
[Pattern Memory] → 保存正向模式 (scrolling + Standard + RenderThread 阻塞)
[HTML Report] → /api/agent/v1/{sessionId}/report
  │
  ▼
[SSE Events → 前端]
  ├─ progress: "正在分析..."
  ├─ thought: "检查帧渲染数据..."
  ├─ agent_response: SQL 结果 + Skill 数据 (DataEnvelope)
  ├─ conclusion: 结构化分析结论
  └─ analysis_completed: { reportUrl, findings }
```

---

> **写在最后：** 这套系统从第一行代码到现在，经历了 agentv2 (DeepSeek) → agentv3 (Claude SDK) 的架构迁移，9 轮团队架构审查，8 轮 Agent 特征补全，3 轮 Stdlib 集成，持续的 E2E 验证和回归测试。165+ 个 YAML Skill、17 个 MCP 工具、12 个场景策略、6 个知识模板——这些数字背后是无数次「Agent 说了什么 → 验证发现它错了 → 修复 Harness 让它下次不再犯」的循环。Harness Engineering 不是一次性设计，是在实际分析中不断打磨的过程。

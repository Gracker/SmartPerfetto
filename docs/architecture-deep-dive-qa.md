# SmartPerfetto 架构文章 Q&A

> 这篇文章收集了[《从 Trace 到洞察：SmartPerfetto AI Agent 的 Harness Engineering 实战》](./architecture-deep-dive.md)发布后收到的技术问题，以问答形式展开讨论。

---

## Q1：为什么不用 Claude Code 的标准 Skill 系统，而要自建 YAML Skill？

**提问背景：** Claude Code 的 Skill 系统支持 `scripts/` 目录放确定性脚本，避免 LLM 泛化。既然可以用 scripts/ 执行固定的 SQL，为什么还要自建一套 YAML Skill 系统？YAML Skill 是不是本质上是一个让性能工程师按预定义规则执行 SQL 的工具？

### 关键区分：两套 Skill 不在同一个层面

Claude Code Skills 和 SmartPerfetto YAML Skills 解决的是不同阶段的问题：

```
开发阶段（我写代码时）:
  Claude Code + Skills/Hooks → 帮我开发 SmartPerfetto

运行阶段（用户分析 trace 时）:
  SmartPerfetto Backend + YAML Skills → 帮用户分析性能数据
```

Claude Code 的 Skill 运行在开发者的终端里，是 CLI 工具的扩展。SmartPerfetto 的 YAML Skill 运行在 Express 后端的 Skill Engine 中，是 Agent 在运行时通过 MCP 工具 `invoke_skill` 调用的分析单元。两者的执行环境、调用方式、数据流完全不同。

### 即使只看「确定性执行」，YAML Skill 有几个针对性设计

**1. 参数化 SQL，不是固定脚本**

性能分析的 SQL 不是写死的——同一个 Skill 需要接受不同的参数（进程名、时间范围、帧 ID 列表）：

```yaml
steps:
  - id: thread_state_distribution
    type: atomic
    sql: |
      SELECT state, SUM(dur) as total_dur
      FROM thread_state ts
      JOIN thread_track tt ON ts.track_id = tt.id
      WHERE tt.utid = ${main_thread_utid}
        AND ts.ts BETWEEN ${start_ts} AND ${end_ts}
      GROUP BY state
```

`${main_thread_utid}` 和 `${start_ts}` 是 Claude 调用 `invoke_skill` 时传入的参数。YAML Skill Engine 做参数替换后执行 SQL。如果用 scripts/，要么写 shell 脚本接收参数拼 SQL（容易出注入问题），要么写完整的 Python/Node 脚本——复杂度比 YAML 高很多。

**2. 自描述的输出格式（DataEnvelope）**

```yaml
    display:
      level: detail
      columns:
        - { name: state, type: string }
        - { name: total_dur, type: duration }
```

每个 step 声明了输出列的名称和类型。前端根据这个 schema 自动渲染表格——`duration` 类型自动格式化为 ms，`timestamp` 类型支持点击跳转到 Perfetto 时间线。scripts/ 方式的输出是自由文本，前端没法自动渲染。

**3. 可组合（composite + iterator）**

一个 composite Skill 可以引用多个 atomic Skill，iterator 可以遍历数据行逐帧分析。这种组合在 YAML 中是声明式的，Skill Engine 负责编排执行。scripts/ 方式要实现同样的组合需要自己写编排逻辑。

**4. 面向性能工程师，不是面向开发者**

提问者说对了：YAML Skill 本质上是一个让性能工程师按预定义规则贡献分析逻辑的工具。性能工程师知道该查什么 SQL、该看什么指标，但不一定会写 TypeScript。YAML 格式让他们直接定义 SQL 查询和输出格式，不需要碰后端代码。修改后 DEV 模式刷新浏览器即可生效。

### 对比总结

| 维度 | Claude Code scripts/ | SmartPerfetto YAML Skill |
|------|---------------------|--------------------------|
| 运行环境 | 开发者终端 (CLI) | Express 后端 (runtime) |
| 调用者 | 开发者通过 `/skill` 命令 | Agent 通过 `invoke_skill` MCP 工具 |
| 参数化 | 需要自己处理 | `${param|default}` 内置支持 |
| 输出格式 | 自由文本 | DataEnvelope (schema-driven) |
| 前端渲染 | 不涉及 | 自动表格/图表 |
| 组合能力 | 手动编排 | composite / iterator / conditional |
| 贡献门槛 | 需要写脚本 | 只写 YAML + SQL |

两者不是替代关系，而是在不同层面解决不同问题。

---

## Q2：「确定性 + 灵活性混合」具体是怎么实现的？

**提问背景：** 文章说「已知场景用 Strategy 文件约束必检项，但每个阶段内的具体查询和深钻方向由 Claude 自主决定」。这个约束和自主之间的边界在哪里？具体是怎么做到的？

### 三层机制配合

这个混合设计靠三层机制配合实现：Strategy 文件定义「必须做什么」，Planning Gate 强制「先计划再执行」，Verifier 事后检查「是否真的做了」。

### 第一层：Strategy 文件 — 有硬约束也有软指引

以滑动分析的 `scrolling.strategy.md` 为例，它定义了多个分析阶段，但每个阶段的约束强度不同：

**硬约束（必须执行，跳过会触发验证错误）：**

Phase 1.9 根因深钻是最严格的阶段，策略文件里直接用了 🔴 标记和「禁止」字样：

```markdown
**Phase 1.9 — 根因深钻（🔴 强制执行，不可跳过）：**

对 `batch_frame_root_cause` 中占比 >15% 的每个 reason_code，
**必须**选最严重的 1 帧执行深钻。
**⛔ 禁止**仅靠 batch_frame_root_cause 的统计分类直接出结论。

| 条件                    | 深钻动作                                    |
| 任何 reason_code Q4>20% | invoke_skill("blocking_chain_analysis", ...) |
| binder_overlap >5ms     | invoke_skill("binder_root_cause", ...)       |
| ...
```

**软指引（建议但可跳过）：**

Phase 1.5（架构感知分支）和 Phase 1.7（根因分支）用的是「建议」「改用」等措辞，Claude 可以根据实际数据决定是否执行：

```markdown
**Phase 1.5 — 架构感知分支：**

| 架构      | 调整动作 |
| Flutter   | 改用 flutter_scrolling_analysis |
| WebView   | 注意 CrRendererMain 线程 |
```

Strategy 文件的全部内容被原文注入 System Prompt，注入时加了一行硬性说明：

```
场景策略（必须严格遵循）
对于以下常见场景，已有验证过的分析流水线。必须完整执行所有阶段，不可跳过。
```

Claude 直接在 System Prompt 中看到这些阶段定义、🔴 标记和「禁止」字样。

### 第二层：Planning Gate — 强制先计划，但不限制计划内容

Claude 在执行任何 SQL 查询或 Skill 调用之前，必须先调用 `submit_plan` 提交分析计划。没有提交计划就调用 `execute_sql` 或 `invoke_skill` 会被直接拒绝：

```typescript
function requirePlan(toolName: string): string | null {
  if (analysisPlanRef.current) return null;  // 已有计划，放行
  return `必须先调用 submit_plan 提交分析计划，然后才能使用 ${toolName}`;
}
```

关键点在于：**Gate 只要求计划存在，不要求计划和 Strategy 的阶段完全对应。** Claude 可以提交任何结构的计划——它可以把 Phase 1 和 1.5 合并，可以加入 Strategy 没提到的额外步骤，也可以根据初步数据调整深钻方向。

提交计划时，系统会做场景感知的关键词检查（比如滑动场景检查计划中是否提到了「帧」「jank」等词），但这只是 **warning 级别**——计划即使不包含这些词也会被接受。

这个设计的目的是：强制 Claude 在动手之前先想清楚要做什么（规划纪律），但不限制它怎么想（规划自由）。

### 第三层：Verifier — 多维度事后检查

计划和执行之间可能有偏差——Claude 可能提交了计划但实际跳过了某个关键步骤。Verifier 在分析结束后做多维度事后检查，以启发式行为检查为主，同时补充计划/假设/场景完整性校验：

**a) 场景完整性检查**——分析输出是否覆盖了场景的核心内容：

```typescript
// 滑动场景：检查是否有显著掉帧但没做 Phase 1.9 深钻
case 'scrolling': {
  const hasSignificantJank = /* 检测文本中是否提到大量掉帧 */;
  const hasDeepDrill = /* 检测是否调用了 blocking_chain / binder_root_cause 等 */;
  if (hasSignificantJank && !hasDeepDrill) {
    issues.push({
      severity: 'error',
      message: '滑动分析有掉帧但缺少 Phase 1.9 根因深钻 — reason_code 只是分类标签，不是真正的根因'
    });
  }
}
```

**b) 假设闭环检查**——所有 `submit_hypothesis` 是否都有对应的 `resolve_hypothesis`。

**c) 因果链深度检查**——CRITICAL/HIGH 级别的 findings 是否包含足够的因果连接词和机制性术语（启发式文本匹配）。

**d) 可选的 LLM 复核**——用独立的 Haiku 模型做证据支撑度验证（可关闭）。

如果检查发现 ERROR 级别问题，会触发 Correction Prompt 让 Claude 补做。

注意 Verifier **不检查 Claude 的计划阶段是否匹配 Strategy 的阶段编号**——它检查的是「关键分析动作是否体现在输出中」，不是「计划格式是否正确」。

### 完整的约束光谱

把三层机制叠在一起，不同阶段的约束强度形成了一个光谱：

| 阶段 | Strategy 语气 | Planning Gate | Verifier 检查 | 约束强度 |
|------|-------------|:---:|:---:|:---:|
| Phase 1（概览） | 建议 | 需要计划 | 不单独检查 | 中 |
| Phase 1.5（架构分支） | 建议 | — | 不检查 | 低 |
| Phase 1.7（根因分支） | 建议+条件 | — | 不检查 | 低 |
| Phase 1.9（根因深钻） | 🔴 **必须/禁止** | — | **检查是否调用了深钻工具** | **高** |
| Phase 2（补充深钻） | 可选 | — | 不检查 | 无 |
| Phase 3（综合结论） | 必须覆盖分布 | — | 检查结论完整性 | 中 |

而 `general.strategy.md`（未匹配到场景时的 fallback）则完全是软指引：只给了一个按用户关注方向的路由决策树（CPU → cpu_analysis，内存 → memory_analysis），没有任何必须执行的阶段。Claude 在 general 场景下有完全的自主权。

### 一句话总结

**Strategy 文件告诉 Claude「分析滑动问题至少要做这几件事」，Planning Gate 确保它先想后做，Verifier 事后检查关键步骤有没有真的做。** 但在这个框架内，具体查什么数据、用哪个工具、按什么顺序，都是 Claude 根据实际数据自主决定的。

---

## Q3：Agent 和 Workflow 最大的区别在哪里？Agent 的能力边界在哪里、由什么决定？

**提问背景：** 我们在建设 Agent 的过程中，从最初默认 Agent 有能力理解并决策一切给它的 Skill，到现在几乎在 Skill 中写死了一棵决策树，这中间踩坑的出发点都是：「我们认为 Agent 有 xx 能力，但它没有」，导致其输出偏离我们的预期，于是我们不断地给 Skill 加边界，最后变成了一个写死的 Workflow。

### 本质区别：决策权在谁手里

Agent 和 Workflow 不是两个工具、两个框架——它们是同一个光谱的两端：

```
写死的 Workflow ◄──────────────────────────────────► 完全自主的 Agent
  │                                                        │
  开发者控制每个分支                               LLM 决定一切
  │                                                        │
  高确定性、低灵活性                               低确定性、高灵活性
```

| 维度 | Workflow | Agent |
|------|---------|-------|
| 控制流 | 开发者在代码中写死 `if/else` | LLM 自主选择下一步 |
| 工具选择 | 预定义执行顺序 | LLM 根据数据按需选择 |
| 分支条件 | 代码中的条件判断 | LLM 推理判断 |
| 失败处理 | `try/catch` + 重试逻辑 | LLM 自我反思 + 换方向 |
| 可预测性 | 确定性高 | 不确定性高 |
| 适应新场景 | 需要开发者加分支 | 可以自主探索 |

**但工程实践中，几乎没有人处在光谱的任何一端。** 纯 Workflow 无法处理未知场景；纯 Agent 在关键步骤上不可靠。实际落地的系统都在光谱的某个中间位置。

### 你们踩坑的根因：对 Agent 能力做了全局假设

「默认 Agent 有能力理解一切 → 发现它做不到 → 不断加约束 → 变成写死的 Workflow」——这个路径的根本问题在于：**对 Agent 的能力做了全局一刀切的判断。**

但 Agent 的能力在不同环节差异巨大：

| 能力维度 | LLM 可靠度 | 该交给谁 |
|---------|-----------|---------|
| **意图理解**（用户想干什么） | 高 ✅ | Agent（但简单场景可以用关键词匹配替代） |
| **计划制定**（分几步做、先做什么） | 中等 ⚠️ | 需要约束框架：Strategy 文件给框架，LLM 填细节 |
| **数据收集**（该查什么） | 中等 ⚠️ | 半自主：Skill 定义了查什么，Agent 决定顺序和参数 |
| **数据推理**（看到数据后归因） | 高 ✅ | Agent——这是 LLM 最大的价值 |
| **精确计算**（数值统计） | 极低 ❌ | 工具系统（SQL / Skill Engine） |
| **自我评估**（知道自己对不对） | 低 ⚠️ | 外部 Verifier，不信任 Agent 自评 |

正确的做法不是「全局选 Agent 或全局选 Workflow」，而是**按环节分配**：

```
场景识别     → Workflow（确定性逻辑，不需要 LLM 参与）
数据收集     → 半 Workflow（Skill 定义查什么，Agent 决定顺序和参数）
推理归因     → Agent（这是 LLM 的核心价值，给足数据就能做好）
输出格式     → Workflow（模板化，确定性）
质量验证     → Workflow（规则检查）+ Agent（LLM 复核）
```

### SmartPerfetto 的做法：约束强度光谱

SmartPerfetto 没有在 Agent 和 Workflow 之间二选一，而是对不同分析阶段设定了不同的约束强度（详见 Q2）。这里从「能力边界」的角度重新审视这个设计：

**高约束（Phase 1.9 根因深钻）——因为 Agent 在「决定是否深钻」这件事上不可靠：**

```markdown
# scrolling.strategy.md 中的 Phase 1.9

**Phase 1.9 — 根因深钻（🔴 强制执行，不可跳过）：**

对 batch_frame_root_cause 中占比 >15% 的每个 reason_code，
**必须**选最严重的 1 帧执行深钻。
**⛔ 禁止**仅靠 batch_frame_root_cause 的统计分类直接出结论。
```

为什么要硬约束？因为我们发现 Agent 有一个系统性偏差：**它倾向于在拿到概览数据后就直接出结论，跳过深钻**。这不是模型不够聪明——Claude 完全有能力做根因深钻——而是模型存在「路径依赖」：概览数据已经包含了统计分类（`reason_code`），对模型来说「直接用分类标签出结论」比「花 3 轮工具调用做逐帧深钻」的认知成本低得多。

**低约束（Phase 1.5 架构分支）——因为 Agent 在「根据数据选择工具」上足够可靠：**

```markdown
# scrolling.strategy.md 中的 Phase 1.5

**Phase 1.5 — 架构感知分支：**

| 架构      | 调整动作 |
| Flutter   | 改用 flutter_scrolling_analysis |
| WebView   | 注意 CrRendererMain 线程 |
```

这里用「改用」「注意」等建议性措辞，不强制。因为架构检测的结果（Flutter/WebView/Standard）已经被确定性代码放进了 system prompt，Agent 看到这个信息后选择正确 Skill 的概率很高。

**零约束（general 场景）——因为 Agent 在「未知场景自主探索」上是唯一选择：**

```yaml
# general.strategy.md — 只给路由决策树，不给任何必须执行的步骤

场景: general
priority: 99

当前查询未匹配到特定场景策略。请根据用户关注的方向，
使用以下决策树选择合适的分析路径。
```

general 场景没有任何硬约束，因为进入 general 意味着用户的问题超出了预定义场景，Workflow 无法处理。此时只能信任 Agent 的自主探索能力。

### Agent 能力边界的决定因素

Agent 的能力边界不取决于模型参数量或 benchmark 分数，而取决于三个工程因素：

**1. 观测能力——Agent 能"看到"什么数据**

同一个模型，给它 `scrolling_analysis` Skill 的 L2 结构化帧数据 vs 让它自己写 SQL 查原始表，分析质量差距非常显著。Agent 的上限由你给它的数据工具决定。SmartPerfetto 用 165 个 YAML Skill 封装了领域专家的查询逻辑，Agent 通过 `invoke_skill` 拿到的是处理过的、结构化的分析数据，而不是原始的百万行 trace 事件。

**2. 约束框架——Agent 在什么范围内决策**

不约束的 Agent 像一个没有任务清单的实习生——知识够但不知道该先做什么。Strategy 文件、Planning Gate、Verifier 多层机制共同定义了 Agent 的决策边界：Strategy 告诉它「至少要做什么」，Planning Gate 强制它「先想后做」，Verifier 事后检查「分析是否充分」（启发式检查 + 假设闭环 + 场景完整性 + 可选的 LLM 复核）。

**3. 反馈质量——Agent 做错后能否被纠正**

Agent 的 findings 中存在相当比例的问题（浅层归因、假阳性、遗漏关键步骤）。单纯依赖模型自我纠错效果有限。SmartPerfetto 用多层验证 + 外部纠错 prompt 来闭环：

```
Verifier 发现 ERROR → 生成 Correction Prompt → 触发 SDK 重试
                       ↑                        ↓
                 Learned patterns ← 累积历史误判模式
```

### 补充：Strategy 文件就是 SOP，这没问题

有人会指出：`scrolling.strategy.md` 读起来就像一份 SOP（标准作业程序）——有编号的 Phase、条件表、必做项、甚至直接写了 `invoke_skill("scrolling_analysis", {...})`。这和「在 Skill 里写死决策树」有什么区别？

**直说：在数据收集阶段，SmartPerfetto 的滑动分析就是一个 Workflow。** Strategy 文件就是 SOP，它把领域专家的分析经验编码成了确定性步骤。这是故意的。

关键在于理解 SOP 覆盖了什么、没覆盖什么：

**SOP 能覆盖的（数据收集）——Strategy 文件干的事：**

```
scrolling.strategy.md:
  Phase 1:   "调用 scrolling_analysis"              ← 写死了收集什么数据
  Phase 1.5: "Flutter 改用 flutter_scrolling_analysis" ← 写死了条件分支
  Phase 1.7: 条件表 → 深钻动作                       ← 写死了 if/then 表
  Phase 1.9: "🔴 占比>15% 的 reason_code 必须深钻"   ← 写死了必做项
```

**SOP 写不出来的（推理归因）——Agent 的价值所在：**

```
- 47 帧掉帧中，哪些帧是同一根因？（数据聚类）
- 19 帧 workload_heavy 里，哪帧"最严重"值得深钻？（优先级判断）
- 深钻发现 Binder 阻塞 23ms + 热降频同时存在，因果方向是什么？（因果推理）
- 最终结论怎么组织？给 App 开发者 vs 平台工程师的建议如何区分？（表达决策）
```

**不同场景的 SOP 程度不同：**

| Strategy 文件 | SOP 程度 | 原因 |
|--------------|---------|------|
| `scrolling.strategy.md` | **高** — Phase 编号 + 条件表 + 必做项 | 滑动分析方法论最成熟，最优数据收集路径已知 |
| `startup.strategy.md` | **中高** — 有 Phase 结构，深钻方向更开放 | 启动场景更多样（冷/温/热、不同瓶颈） |
| `anr.strategy.md` | **中** — 2-skill pipeline，但根因分析全靠推理 | ANR 根因高度多样 |
| `general.strategy.md` | **低** — 只有路由决策树，无必做项 | 未知场景，无法 SOP 化 |

`scrolling.strategy.md` 是 SOP 程度最高的，因为滑动分析方法论最成熟。`general.strategy.md` 几乎没有 SOP，因为用户问题完全不可预测。

**所以正确的理解是：SmartPerfetto = 「SOP 驱动的数据收集 + Agent 驱动的推理归因」。**

SOP 解决「分析滑动问题至少要看哪些数据」——这个问题有确定性答案，用 SOP 是对的。Agent 解决「拿到数据后怎么推理因果、怎么组织结论」——这个问题每个 trace 不同，写不成 SOP。

**回到你们的踩坑：问题不是「Skill 变成了 SOP」——数据收集阶段就应该用 SOP。问题是「SOP 吃掉了推理」——如果 SOP 连结论都写死了（"看到 X 就输出 Y"），Agent 就真的退化成 Workflow 了。关键是让 SOP 止步于数据收集，把推理留给 Agent。**

### 一句话总结

**Agent 和 Workflow 的区别不是「智能 vs 写死」，而是「决策权的分配方式」。Agent 的能力边界由「观测能力 × 约束框架 × 反馈质量」共同决定。正确的做法是按环节分配决策权——在 Agent 可靠的环节给自主权，在 Agent 不可靠的环节加约束——而不是全局一刀切。**

---

## Q4：Agent 的架构需要从业务视角进行改进吗？

**提问背景：** Agent 的架构有过不同的设计和演进——从最初的 ReAct 架构，到 LangGraph 的节点式架构，不同的 Agent 架构设计会给它带来怎样的影响？在搭建自己的业务 Agent 时，是否需要考虑架构对 Agent 性能的影响？例如 SmartPerfetto 是在 Claude Agent SDK 的基础上基于业务理解加入了不同的 Skill 加载模式。

### 三种主流架构的本质差异

| 架构 | 控制流模型 | 开发者角色 | 适合场景 |
|------|----------|-----------|---------|
| **ReAct** | 线性循环：Think → Act → Observe → Think... | 定义工具 | 工具少、路径短的简单任务 |
| **LangGraph 节点式** | DAG 图：节点=步骤，边=条件跳转 | 设计图结构 + 定义节点 + 写跳转条件 | 步骤明确、分支有限的确定性流程 |
| **SDK 原生** | SDK 管理 turn loop，开发者只定义 tools | 定义工具 + 注入上下文 | 工具多、路径不可预测、需要 LLM 自主编排 |

它们的核心区别在于**「谁来决定下一步做什么」**：

- **ReAct**：LLM 在每一步都做完整决策（想什么、做什么、用什么工具），框架只负责转发
- **LangGraph**：开发者预定义了所有可能的路径（节点+边），LLM 只在节点内部做局部决策
- **SDK 原生**：SDK 管理对话循环，LLM 自主选择工具，开发者通过 system prompt 和工具设计来间接约束

### SmartPerfetto 选择 SDK 原生 + 自建约束层的原因

SmartPerfetto 的架构是 **Claude Agent SDK（SDK 原生）+ 三层约束（Strategy/Planning Gate/Verifier）**：

```
Claude Agent SDK 提供:                SmartPerfetto 自建:
├─ Turn loop（自动管理多轮对话）      ├─ Scene Classification（场景路由，<1ms）
├─ Tool dispatching（MCP 工具调用）   ├─ Strategy Injection（按场景注入分析策略）
├─ Streaming（SSE 事件流）           ├─ Planning Gate（强制先规划再执行）
├─ Session resume（多轮上下文恢复）   ├─ Verifier（事后验证 + 纠错重试）
└─ Sub-agent orchestration           ├─ ArtifactStore（3 级缓存压缩 token）
                                     ├─ Conditional Tool Loading（按场景注入/隐藏工具）
                                     └─ Cross-Session Memory（模式记忆 + 负面记忆）
```

**为什么不用 LangGraph？**

性能分析的根因推理路径是**不可预测的**。同样一个「滑动卡顿」，根因可能是：
- Binder 阻塞 → 需要追踪 system_server 端的线程状态
- GPU 渲染慢 → 需要查 GPU frequency 和 fence wait
- GC 暂停 → 需要看 Java heap 和 GC events
- 热降频 → 需要查 thermal zone 和 CPU frequency
- 锁竞争 → 需要查 monitor contention
- 以上多个原因组合

如果用 LangGraph，你需要为每一种根因路径预定义一个 DAG 节点和跳转条件。性能分析有 21 个 reason_code，每个可以组合深钻——排列组合后的路径数量使得 DAG 图变得不可维护。

更根本的问题是：**在看到数据之前，你不知道该走哪条路径**。LangGraph 的 DAG 图假设开发者能提前预知所有分支条件，但性能分析的分支条件取决于运行时数据。

**SDK 原生架构的优势：**

LLM 自主选择工具路径，但通过三层约束确保关键步骤不被跳过：

```python
# LangGraph 需要预定义的 DAG:
graph.add_edge("overview", "check_binder")
graph.add_edge("overview", "check_gpu")
graph.add_edge("overview", "check_gc")
# ... 每加一种根因就要改图结构

# SmartPerfetto 的 Strategy 只需要声明:
# "对占比 >15% 的每个 reason_code，必须选最严重的 1 帧执行深钻"
# Agent 自主决定具体调哪个深钻工具
```

### 关键业务导向的架构设计

以下是 SmartPerfetto 基于业务理解做的架构改进，每一个都直接对应一个业务问题：

**1. 条件化工具加载——减少 Agent 的决策空间**

SmartPerfetto 的 MCP 工具总数可达 ~20 个（8 个 always-on + 最多 12 个条件注入），但一次分析只注入其中的子集：

```typescript
// claudeMcpServer.ts — 按模式切换工具集

if (options.lightweight) {
  // 事实性查询（如"帧率是多少"）：只给 3 个工具
  toolEntries = [executeSql, invokeSkill, lookupSqlSchema];
} else {
  // 完整分析：8 个 always-on + 按上下文条件注入
  // 比较模式 → 注入 compare_skill, execute_sql_on, get_comparison_context
  // 假设管理 → 注入 submit_hypothesis, resolve_hypothesis, flag_uncertainty
  // 规划工具 → 注入 submit_plan, update_plan_phase, revise_plan
}
```

**业务原因：** 工具越多，Agent 选错工具的概率越大。一个只需要快速回答「帧率是多少」的查询，如果看到十几个规划/假设/比较工具，Agent 可能会过度分析。

**2. Sub-Agent 场景门控——避免不必要的并行开销**

```typescript
// claudeAgentDefinitions.ts — 只在复杂场景启用 sub-agent

const ORCHESTRATOR_ONLY_TOOLS = new Set([
  'submit_plan', 'update_plan_phase', 'revise_plan',
  'submit_hypothesis', 'resolve_hypothesis', 'flag_uncertainty',
  'compare_skill', 'execute_sql_on', 'get_comparison_context',
]);

// Sub-agent 只拿到数据收集工具，不拿规划/假设工具
// 设计原则：sub-agents collect evidence, orchestrator makes diagnosis
```

| 场景 | Sub-Agent 配置 | 原因 |
|------|---------------|------|
| scrolling | frame-expert + system-expert | 帧分析和系统分析适合拆分，由 orchestrator 协调 |
| startup | startup-expert + system-expert | 启动阶段分析和资源竞争分析适合拆分 |
| anr | 无 sub-agent | ANR 是 2-skill 管线，额外 sub-agent 反而增加开销 |

> 注：sub-agent 的实际并行性取决于 SDK 内部调度策略，我们按并行采证来设计 prompt，但实际执行可能是串行的。

**3. Lightweight vs Full 双模式——快问快答不走完整管线**

当用户问「这个 trace 的帧率是多少」时，不需要走完整的 Planning → Skill → Verification 管线。SmartPerfetto 的 `ClaudeRuntime` 在入口处做复杂度分类：

```
analyze(query)
  ↓
queryComplexity === 'quick'
  → analyzeQuick(): 3 个工具，无 Planning Gate，无 Verifier
  → 直接回答事实性问题

queryComplexity === 'full'
  → 完整管线：Planning → Skill → Verification → Correction
  → 系统化分析
```

**业务原因：** 用户的提问中有相当比例是事实性查询（「帧率多少」「有没有 ANR」），走完整管线会不必要地增加延迟。

### 对「是否需要从业务角度改进架构」的回答

**需要，但改进方向不是换底层框架（ReAct → LangGraph），而是在现有框架上加业务约束层。** 具体建议：

1. **从你的 Skill 决策树中提取 Strategy 文件**：把写死在代码里的 `if/else` 决策逻辑，改写为自然语言的分析策略（Markdown 文件），按场景注入 system prompt。这样领域专家可以直接修改分析逻辑，不需要碰代码。

2. **加 Planning Gate**：`requirePlan()` 的实现极其简单（不到 10 行代码），但效果显著——强制 Agent 先想后做，经验上能大幅减少跑偏。

3. **加事后 Verifier**：不检查 Agent 的中间步骤是否「正确」（这个很难判断），只检查关键步骤是否「发生了」（这个很容易判断）。

4. **按场景/复杂度动态调整工具集和约束强度**：不是所有查询都需要同样的分析深度，给简单查询开一条快速通道。

### 一句话总结

**架构选择是业务问题，不是技术问题。ReAct/LangGraph/SDK 只是控制流的不同实现方式——真正影响 Agent 性能的是你在控制流之上搭建的约束层。SmartPerfetto 选择 SDK 原生不是因为它最先进，而是因为性能分析的根因路径不可预测，预定义 DAG 不如让 Agent 在约束框架内自主探索。**

---

## Q5：性能 AI 智能体应该如何做好场景识别？

**提问背景：** 想做场景识别、路由到正确的 Skill，在建设这部分的时候应该更多基于「用户原声」还是「日志」，或者有什么更好的方法？场景识别的几条路径各有问题：代码匹配（关键词匹配会导致筛选结果过大或过小）、LLM 理解（LLM 的理解不一定准确）、日志还原（能筛选有无滑动，但不一定是用户关注的问题）。

### SmartPerfetto 的做法：三层信号、分工明确

SmartPerfetto 的场景识别不是靠单一信号源，而是三层信号配合，每层解决不同的问题：

```
Layer 1: 用户原声 — 关键词匹配 → 场景类型（scrolling / startup / anr / ...）
Layer 2: Trace 数据 — 确定性检测 → 架构信息（Flutter / WebView / Standard / Compose）
Layer 3: 数据完整性 — 表存在性检查 → 可用分析维度（有无 GPU 数据、有无热降频数据）
```

**Layer 1：用户原声（关键词匹配，<1ms）**

```typescript
// sceneClassifier.ts — 46 行代码，完成了全部场景分类

export function classifyScene(query: string): SceneType {
  const scenes = getRegisteredScenes();  // 从 12 个 .strategy.md 的 frontmatter 加载
  const lower = query.toLowerCase();

  const sorted = scenes
    .filter(s => s.scene !== 'general')
    .sort((a, b) => a.priority - b.priority);  // ANR(1) > startup(2) > scrolling(3) > ...

  for (const scene of sorted) {
    // 先匹配 compound patterns（更具体，如「启动.*慢」）
    if (scene.compoundPatterns.some(p => p.test(query))) return scene.scene;
    // 再匹配单关键词
    if (scene.keywords.some(k => lower.includes(k))) return scene.scene;
  }
  return 'general';  // 兜底
}
```

关键词定义在每个 Strategy 文件的 YAML frontmatter 中，不是硬编码在 TypeScript 里：

```yaml
# scrolling.strategy.md frontmatter
keywords:
  - 滑动
  - 卡顿
  - 掉帧
  - jank
  - scroll
  - fps
  - 帧
  - frame
  - 列表
  - 流畅
  - fling
  - stuttering
  - dropped frame
  - 不流畅
  # ... 共 30+ 关键词
```

**为什么用关键词匹配而不是 LLM？**

1. **成本**：场景分类在每次分析的入口处执行，关键词匹配 <1ms + 0 tokens；LLM 调用 ~500ms + ~500 tokens
2. **确定性**：分类错误的代价非常高（会注入错误的 Strategy 文件），关键词匹配的行为完全可预测
3. **足够准确**：在性能分析领域，用户的提问高度格式化——说「滑动卡顿」的就是在问滑动，说「启动慢」的就是在问启动。不需要 LLM 来"理解"

**关键词匹配不够的地方怎么办？**

关键词匹配的确有边界——当用户说「这个 app 为什么慢」时，关键词无法确定是启动慢还是滑动慢。SmartPerfetto 的处理方式是：**匹配不到就 fallback 到 `general` 场景**，让 Agent 在 general 策略的路由决策树中自主选择方向。

```yaml
# general.strategy.md — 没有任何硬约束，只给路由建议

| 用户关注方向       | 推荐路径 |
| CPU / 调度 / 线程  | invoke_skill("cpu_analysis") |
| 内存 / OOM / 泄漏  | invoke_skill("memory_analysis") |
| 不确定方向         | invoke_skill("scene_reconstruction") → 按场景路由 |
```

这个设计的核心思路是：**不要试图在入口处 100% 准确分类，而是让准确的情况走快速路径（关键词 → Strategy），不确定的情况走探索路径（general → Agent 自主路由）。**

**Layer 2：Trace 数据——架构检测（确定性代码）**

场景分类只解决了「用户想分析什么」，但同一个场景（如滑动）在不同渲染架构下的分析路径完全不同：

| 架构 | 渲染管线 | 分析差异 |
|------|---------|---------|
| Standard Android | UI Thread → RenderThread → SurfaceFlinger | 主线程 + RenderThread 双线分析 |
| Flutter TextureView | 1.ui → texture → RenderThread updateTexImage | 双出图管线，需要分析 Flutter engine 线程 |
| Flutter SurfaceView | 1.ui → 1.raster → BufferQueue → SurfaceFlinger | 单出图管线，不经过 RenderThread |
| WebView | CrRendererMain → Viz Compositor | Chromium 渲染管线，线程名不同 |
| Compose | UI Thread (Composition) → RenderThread | 和 Standard 类似但有 Composition 阶段 |

架构检测委托给 YAML skill `rendering_pipeline_detection`——它在 SQL 层做线程/Slice 信号采集、管线打分、子变体判定，支持 24 种细粒度渲染架构。TypeScript 侧（`architectureDetector.ts`）只负责调用 skill 和映射结果，不做直接的 if/else 判断：

```
rendering_pipeline_detection skill (SQL)
  → 采集线程信号（1.ui / 1.raster / CrRendererMain / RenderThread ...）
  → 管线打分（FLUTTER_TEXTUREVIEW / WEBVIEW_BLINK / ANDROID_VIEW_STANDARD ...）
  → architectureDetector.ts 映射为 ArchitectureInfo 类型
```

检测结果被注入到 system prompt 中（通过 `arch-flutter.template.md` 等模板），Agent 看到架构信息后选择对应的分析工具。

**Layer 3：数据完整性——能力寄存器**

Trace 采集配置不同，可用的数据维度也不同。有的 trace 没有 GPU frequency 数据，有的没有 thermal zone。SmartPerfetto 在分析开始前探测 18 个数据维度的可用性：

```
frame_rendering: ✅ (456 rows)
cpu_scheduling: ✅ (12000 rows)
gpu: ❌ (无 gpu_frequency counter)
thermal_throttling: ✅ (4 zones)
binder_ipc: ✅ (890 transactions)
```

这个信息同样注入 system prompt，告诉 Agent 哪些维度可以分析、哪些维度数据缺失。避免 Agent 调用没有数据支撑的 Skill 后得到空结果再换方向——这种试错浪费 1-2 个工具调用的 token。

### 对提问中三条路径的评价

**1. 代码匹配（关键词）：可以用，但要设计好兜底**

提问者说「关键词匹配会导致筛选结果过大或过小」。SmartPerfetto 的经验是：

- **优先级排序**解决「过大」问题：ANR(1) > startup(2) > scrolling(3)，同时命中多个关键词时取优先级最高的
- **Compound patterns** 解决精度问题：`/启动.*慢/` 比单独匹配「启动」更精确
- **`general` 兜底**解决「过小」问题：匹配不到就不猜，交给 Agent 自主探索

**2. LLM 理解：不建议用在分类入口，可以用在兜底路径**

LLM 的分类在 SmartPerfetto 中不是 Layer 1，而是 `general` 场景中 Agent 的自主路由——这时 Agent 已经拿到了 trace 数据，可以结合数据做更准确的判断。

**3. 日志还原：适合做 Layer 2 的补充信号**

日志能告诉你「trace 中有什么」（有无滑动事件、有无 ANR），但不能告诉你「用户关心什么」。SmartPerfetto 的数据完整性探测就是这个角色——它不参与场景分类，但为 Agent 提供数据可用性信息。

### 一句话总结

**场景识别不要试图用一个信号源解决所有问题。用关键词匹配做快速路由（准确的情况），用 `general` 兜底做 Agent 自主探索（不确定的情况），用 trace 数据做架构和完整性补充。关键词匹配 + 优先级排序 + compound patterns + 兜底策略，46 行代码就够了。**

---

## Q6：「确定性步骤 + AI 自主探索」，如何更好地发挥 AI 自主探索能力？

**提问背景：** 目前线上 Skill 运行的时候发现，AI 自主探索、下钻根因容易跑偏，给出不正确的结果。比如 SmartPerfetto 博客中提到的例子——在前期定位到 RenderThread 被 Binder 阻塞后（基于确定性步骤），后面的多个假设形成和验证是纯 AI 发挥吗，还是说针对 Binder 阻塞我们可能给 AI 一些常见的原因作为引导让它自己排查？

### 先回答核心问题：不是纯 AI 发挥，也不是写死引导

SmartPerfetto 的做法是**结构化推理框架 + 按需知识注入**：

```
确定性步骤产出数据
  ↓
Agent 形成假设（自主，但有推理框架约束）
  ↓
Agent 选择验证工具（自主，但有 Strategy 建议）
  ↓
验证结果反馈
  ↓
假设成立 → 深入 / 假设不成立 → 回退换方向
  ↓
Verifier 事后检查
```

三个关键机制让 AI 自主探索变得更可靠：

### 机制 1：假设管理工具——给推理过程加结构

SmartPerfetto 提供了 `submit_hypothesis` 和 `resolve_hypothesis` 两个 MCP 工具，不是让 Agent 在内心独白中隐式推理，而是**强制外显化**：

```
Agent 调用:
  submit_hypothesis({
    description: "system_server Binder 响应慢导致 RenderThread 阻塞",
    expected_evidence: "system_server 端对应 Binder 事务的 thread_state 显示长时间 Runnable/Sleeping"
  })

Agent 调用:
  execute_sql("SELECT ... FROM thread_state WHERE utid = ... AND ts BETWEEN ...")

Agent 调用:
  resolve_hypothesis({
    id: "h1",
    outcome: "rejected",
    evidence: "system_server 端 Binder 线程状态正常，响应耗时 <2ms，
              RenderThread 阻塞原因是 dequeueBuffer 等待 SurfaceFlinger"
  })
```

**为什么有效？** 假设管理工具迫使 Agent 在行动之前明确声明「我在验证什么」和「我预期看到什么」。这有两个好处：
1. **防止目标漂移**——Agent 不会在收集数据的过程中忘了自己最初想验证什么
2. **可审计**——每个假设都有完整记录，Verifier 可以检查是否所有假设都被 resolved

### 机制 2：知识注入——不是写死引导，是按需加载领域知识

> "针对 Binder 阻塞我们可能给 AI 一些常见的原因作为引导吗？"

是的，但不是写死在 Skill 中，而是通过 `lookup_knowledge` MCP 工具**按需加载**。Agent 发现 Binder 阻塞后，可以调用：

```
invoke lookup_knowledge("binder-ipc")
```

返回一份 Binder IPC 的知识模板（`knowledge-binder-ipc.template.md`），包含：

- Binder 事务的典型阻塞原因分类（server 端忙、进程冻结、CPU 调度延迟、oneway 队列满）
- 每种原因的排查路径和关键指标
- 常见误判场景（如 oneway 事务不会阻塞调用方）

**关键设计：知识是 Agent 主动拉取的，不是系统强制注入的。** 目前共有 8 个知识模板（rendering-pipeline、binder-ipc、gc-dynamics、cpu-scheduler、thermal-throttling、lock-contention、startup-root-causes、data-sources），如果在 system prompt 中预先注入全部模板，会消耗大量 token 且大部分不相关。通过 MCP 工具按需加载，Agent 只在需要时才获取对应领域的背景知识。

SmartPerfetto 还在 Strategy 文件中提供了**条件化的深钻建议表**，这也是一种引导：

```markdown
# scrolling.strategy.md Phase 1.9

| 条件                          | 深钻动作 |
| 任何 reason_code Q4>20%       | invoke_skill("blocking_chain_analysis", ...) |
| binder_overlap >5ms           | invoke_skill("binder_root_cause", ...) |
| cpu_runnable_ratio >30%       | invoke_skill("cpu_analysis", ...) |
| thermal_throttle detected     | invoke_skill("thermal_throttling", ...) |
| gc_pause_total >10ms          | invoke_skill("gc_analysis", ...) |
```

这个表不是写死的决策树——它是给 Agent 的**查找表**。Agent 看到数据后，根据数据中的指标值决定走哪一行。如果数据不匹配任何一行，Agent 可以自主探索。

### 机制 3：ReAct Reasoning Nudge——在工具返回时触发反思

在数据工具（`execute_sql` / `invoke_skill`）成功返回的**前几次**调用中，SmartPerfetto 在结果末尾附加一段推理提示：

```typescript
// claudeMcpServer.ts

const REASONING_NUDGE = '\n\n[REFLECT] 在执行下一步之前：' +
  '这个数据的关键发现是什么？是否支持/反驳你的假设？' +
  '如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';

// 只在前 N 次数据工具调用时附加，之后停止（控制 token 成本）
const REASONING_NUDGE_MAX_CALLS = 4;
```

**成本极低（~20 tokens/次，前 4 次共 ~80 tokens），但效果显著。** 之所以不是全程附加，是为了在分析后半段控制 token 开销——前几次 nudge 已经建立了「收到数据 → 先反思 → 再行动」的模式。没有这个 nudge，Agent 倾向于连续调用工具而不停下来思考——收集了 5 次数据但没有形成任何中间结论，最后的总结质量很差。

### 用图片中的 Binder 例子走一遍完整流程

```
1. 先看总览 → 发现 47 帧卡顿，P90 = 23.5ms
   [确定性：invoke_skill("scrolling_analysis")]

2. 根据总览决定方向 → 40% 卡在 APP 阶段，优先看 App 侧
   [确定性：数据驱动，Strategy 文件建议]

3. 选代表帧深钻 → Frame #234 RenderThread 被 Binder 阻塞 23ms
   [确定性：invoke_skill("jank_frame_detail")]

--- 以下进入 AI 自主探索 ---

4. Agent 主动加载知识：lookup_knowledge("binder-ipc")
   → 获取 Binder 阻塞常见原因分类表
   [AI 决策 + 知识引导]

5. Agent 形成假设：submit_hypothesis("system_server Binder 响应慢")
   预期证据：server 端 thread_state 长时间 Sleeping/Runnable
   [AI 推理，假设工具强制外显]

6. Agent 验证：execute_sql("查 Binder 对端 thread_state")
   → 发现 system_server CPU 调度延迟，不是 Binder 响应慢
   [AI 自主工具调用]

7. [REFLECT] nudge 触发反思
   Agent: "假设 1 不成立，server 端 thread_state 显示 Runnable 排队，
          真正原因是 CPU 调度延迟"
   → resolve_hypothesis(outcome: "refined",
       evidence: "system_server CPU 调度延迟导致 Binder 线程排队")
   [AI 推理 + 知识模板中的排查路径]

8. Agent 深入：execute_sql("查 CPU frequency + thermal zone")
   → 发现热降频，CPU 大核被限频到 50%
   [AI 自主选择下一步深钻方向]

9. 综合结论：RenderThread Binder 阻塞 ← system_server CPU 调度延迟 ← 热降频
   [AI 归纳，形成 WHY 链]

--- Verifier 事后检查 ---

10. Verifier 启发式检查：
    - 文本模式匹配：结论中是否体现深钻分析（而非仅引用概览数据）
    - 假设闭环：所有 submit_hypothesis 是否都有对应的 resolve_hypothesis
    - 场景完整性：滑动分析是否包含帧/卡顿相关内容
    - 因果链启发式：是否有足够的因果连接词和机制性术语
    [确定性：启发式规则检查，非精确验证]
```

注意 Step 4-9 全部是 AI 自主探索，但受到三个约束：
- **假设工具**迫使推理外显化（Step 5, 7）
- **知识注入**提供领域排查路径（Step 4）
- **REFLECT nudge**在前几次工具返回后触发反思（Step 7）

### 如何让 AI 自主探索更可靠：四个实操建议

**1. 给数据，不给结论**

Skill 应该返回结构化数据（帧耗时、线程状态分布、阻塞函数列表），而不是已经得出的结论（「RenderThread 阻塞是因为 Binder」）。让 AI 自己从数据中推理结论，比让它基于别人给的结论做进一步分析更可靠。

**2. 给框架，不给路径**

Strategy 文件应该定义「必须做什么」（Phase 1.9 必须深钻），而不是「怎么做」（先查 A 再查 B 再查 C）。Agent 在有框架约束的情况下自主选择路径，比在没有任何约束下自由探索要可靠得多，又比写死路径灵活得多。

**3. 给知识，不给答案**

知识模板应该包含「可能的原因分类和排查方法」，而不是「如果看到 X 就是 Y」。前者帮助 Agent 建立推理框架，后者把 Agent 变回 Workflow。

**4. 验证行为，不验证结论**

Verifier 应该用启发式规则检查「分析输出是否体现了关键动作」（结论中是否有深钻分析痕迹、假设是否都已 resolved、因果链是否有足够深度），而不是试图判断「结论是否正确」（这个你在离线评估中用 LLM Judge 做，不应该在运行时做）。注意这是文本模式匹配级别的启发式检查，不是精确的工具调用日志审计。

### 一句话总结

**AI 自主探索的可靠性不是靠「写死引导」来保证的，而是靠三个机制：假设管理工具让推理外显化、按需知识注入提供领域排查框架、ReAct nudge 防止盲目工具调用。关键原则是「给数据不给结论、给框架不给路径、给知识不给答案」。**

---

## Q7：每一轮的 Prompt 是怎么拼接的？

**提问背景：** 大模型 Agent 的输出质量很大程度取决于 system prompt 的设计。SmartPerfetto 在每次分析时是如何构造 prompt 的？不同场景、不同轮次之间 prompt 有什么变化？token 预算怎么控制？

### 总体设计：四层分层拼接 + 缓存优化

SmartPerfetto 的 system prompt 不是一个静态字符串，而是由 `buildSystemPrompt()` 函数（`claudeSystemPrompt.ts:260`）在每次 SDK 查询前**动态拼接**的。拼接遵循一个核心原则：

> **按「稳定性」排序——越不容易变化的内容越靠前，越动态的内容越靠后。**

这个设计的原因是 **Anthropic API 的自动缓存机制**：system prompt 超过 1024 tokens 时，API 会自动对 prompt 前缀做缓存。如果把不变的部分放在最前面，多轮对话中大部分 prompt 可以命中缓存，显著降低延迟和成本：

```
Same trace + same scene:     ~4000 tokens cached (~80% savings)
Same trace + different scene: ~800 tokens cached  (~18% savings)
Different trace:              ~400 tokens cached   (~8% savings)
```

### 四层拼接结构

```
┌───────────────────────────────────────────────────────┐
│  Tier 1: STATIC（进程生命周期内不变）                    │
│  ┌─────────────────────────────────────────────────┐  │
│  │ prompt-role.template.md        (~200 tokens)    │  │
│  │ → 角色定义：Android 性能分析专家                    │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ prompt-output-format.template.md (~850 tokens)  │  │
│  │ → 输出格式：[CRITICAL]/[HIGH]/[MEDIUM]/[LOW]     │  │
│  │ → 根因推理链格式、Mermaid 因果链规则               │  │
│  │ → Slice 嵌套规则、CPU 频率估算指南                 │  │
│  └─────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────┤
│  Tier 2: PER-TRACE（同一 trace 内稳定）                 │
│  ┌─────────────────────────────────────────────────┐  │
│  │ 架构信息            (~150 tokens)                │  │
│  │ → "Flutter TextureView, 置信度 92%"              │  │
│  │ → + arch-flutter.template.md 架构指南            │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 焦点应用             (~100 tokens)               │  │
│  │ → "com.example.app (主焦点), 帧数 456"           │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 数据完整性           (~200 tokens, 可被丢弃)      │  │
│  │ → 只报告缺失/不足的维度，可用维度不报告            │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ SQL 知识库参考       (~300 tokens, 可被丢弃)      │  │
│  │ → 从 Perfetto stdlib 索引匹配到的表/视图/函数     │  │
│  └─────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────┤
│  Tier 3: PER-QUERY（场景/查询变化时变化）               │
│  ┌─────────────────────────────────────────────────┐  │
│  │ 方法论 + 场景策略     (~1200 tokens)             │  │
│  │ → prompt-methodology.template.md                │  │
│  │ → {{sceneStrategy}} = scrolling.strategy.md     │  │
│  │   或 startup/anr/general 等 12 套策略之一        │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 子代理协作指南        (~200 tokens, 可被丢弃)     │  │
│  │ → 何时委托 vs 直接调用                           │  │
│  │ → 滑动场景专用并行证据收集指南                     │  │
│  └─────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────┤
│  Tier 4: PER-INTERACTION（每次查询都可能变化）           │
│  ┌─────────────────────────────────────────────────┐  │
│  │ 用户选区上下文        (~300 tokens, 不可丢弃)     │  │
│  │ → 时间范围选区 (selection-area.template.md)      │  │
│  │ → 或 Slice 选区 (selection-slice.template.md)   │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 比较模式上下文        (条件注入)                   │  │
│  │ → 双 trace 对比方法论 + 工具说明                  │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 对话上下文            (~500 tokens)              │  │
│  │ → 分析笔记 (≤10 条, 按优先级排序)                │  │
│  │ → 之前的 findings (≤10 条)                       │  │
│  │ → 已知实体 (用于 drill-down)                     │  │
│  │ → 对话摘要 (跨轮压缩, ≤2000 tokens)             │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ SQL 踩坑记录          (≤5 条, 可被丢弃)          │  │
│  │ → ERROR → BAD SQL → FIX SQL                    │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 历史分析经验          (跨会话模式记忆, 可被丢弃)   │  │
│  │ 历史踩坑记录          (跨会话负面记忆, 可被丢弃)   │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ 历史分析计划          (≤3 轮, 可被丢弃)           │  │
│  │ → 各阶段 ✓/⊘/○ 状态 + 摘要                     │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 模板加载与变量替换

所有 prompt 内容都在 Markdown 文件中定义（详见 Q1），TypeScript 只做加载和变量替换：

```typescript
// strategyLoader.ts — 模板系统

// 1. 加载模板（DEV 模式跳过缓存，刷新浏览器即生效）
loadPromptTemplate('prompt-methodology')  // → strategies/prompt-methodology.template.md

// 2. 加载场景策略（从 YAML frontmatter 中提取 keywords，body 作为策略内容）
getStrategyContent('scrolling')  // → strategies/scrolling.strategy.md 的 Markdown body

// 3. 变量替换
renderTemplate(methodologyTemplate, { sceneStrategy })
// 将 {{sceneStrategy}} 替换为 scrolling.strategy.md 的内容
```

**模板文件清单：**

| 类别 | 文件 | 用途 |
|------|------|------|
| **静态模板** | `prompt-role.template.md` | 角色定义 |
| | `prompt-output-format.template.md` | 输出格式规则（91 行） |
| | `prompt-quick.template.md` | 快速模式精简 prompt |
| **方法论** | `prompt-methodology.template.md` | 分析方法论（含 `{{sceneStrategy}}` 占位符） |
| **架构指南** | `arch-standard.template.md` | Standard Android 渲染指导 |
| | `arch-flutter.template.md` | Flutter 引擎指导 |
| | `arch-compose.template.md` | Jetpack Compose 指导 |
| | `arch-webview.template.md` | WebView 指导 |
| **选区模板** | `selection-area.template.md` | 时间范围选区（`{{startNs}}`, `{{endNs}}`...） |
| | `selection-slice.template.md` | Slice 选区（`{{eventId}}`, `{{ts}}`...） |
| **比较模式** | `comparison-methodology.template.md` | 双 trace 对比方法论 |
| **场景策略** | 12 个 `*.strategy.md` | scrolling/startup/anr/memory/... |
| **知识模板** | 8 个 `knowledge-*.template.md` | 按需加载的领域知识（非 prompt 注入） |
| **辅助模板** | `prompt-complexity-classifier.template.md` | Quick/Full 分流判定（不注入 prompt，但决定走哪条路径） |

### Token 预算管理

**预算上限：** 4500 tokens（`MAX_PROMPT_TOKENS`）。纠错重试时，如果检测到 SDK auto-compact（对话历史被自动压缩），会将预算降到 3000 tokens 以留出空间；否则复用原始 prompt。

**Token 估算方法：** 混合中英文估算——中文字符按 1.5 tokens/字，ASCII 按 0.3 tokens/字。这是粗略近似，但用于预算管理足够准确。

**超预算时的渐进丢弃策略：**

当拼接完成后 token 数超出预算，按优先级从低到高依次丢弃整个 section：

```
丢弃顺序（最先丢弃 → 最后丢弃）：
1. Perfetto SQL 知识库参考  → Agent 可以用 lookup_sql_schema 工具替代
2. Trace 数据完整度        → 有帮助但 Agent 运行时也能发现数据缺失
3. 历史分析经验            → 跨会话模式记忆，非关键
4. 历史踩坑记录            → 跨会话负面记忆，可丢弃
5. SQL 踩坑记录            → 锦上添花
6. 子代理协作              → 只在 sub-agent 启用时有用
7. 历史分析计划            → 补充性上下文
```

**永不丢弃的内容：**
- 角色定义、输出格式（Tier 1 静态）
- 架构信息、焦点应用（Tier 2 per-trace）
- 方法论 + 场景策略（Tier 3 核心）
- 用户选区上下文（用户的显式意图）
- 对话上下文（之前的 findings 和分析笔记）

### 上下文构建的完整流程

在 `ClaudeRuntime.analyze()` 中，prompt 拼接前需要经过二十多个准备阶段（Phase）来收集所有上下文：

```
Phase 0:   选区上下文日志
Phase 0.5: 焦点应用检测（3 种方法：battery_stats / oom_adj / frame_timeline）
Phase 1:   Skill 执行器初始化
Phase 2:   架构检测（LRU 缓存，同 trace 只检测一次）
Phase 2.5: 厂商检测（OEM 定制化，LRU 缓存）
Phase 2.8: 比较模式上下文（双 trace 模式）
Phase 2.9: 数据完整性探测（18 个维度，~50ms）
Phase 3:   会话上下文 + 对话历史
Phase 4:   实体存储（drill-down 引用）
Phase 5:   场景分类（关键词匹配，<1ms）
Phase 5.5: 跨会话模式记忆匹配
Phase 6:   ArtifactStore + 分析笔记
Phase 6.5: 分析计划（当前 + 历史）
Phase 6.6: Watchdog 反馈引用
Phase 6.7: 假设状态
Phase 6.8: 不确定性标记
Phase 7:   SQL 错误追踪
Phase 8:   MCP Server 创建（注入以上所有状态）
Phase 9:   (已移除)
Phase 10:  SQL 知识库上下文
Phase 11:  Sub-agent 定义
Phase 12:  SQL error-fix pairs
Phase 13:  → buildSystemPrompt(context) → 最终 prompt
```

所有 Phase 的结果汇入 `ClaudeAnalysisContext` 对象，传给 `buildSystemPrompt()` 做最终拼接。

### Quick vs Full 双模式

不是所有查询都需要完整的 4500-token prompt。当用户问事实性问题（如「帧率是多少」）时，SmartPerfetto 使用精简的 quick prompt：

```typescript
// buildQuickSystemPrompt() — ~1500 tokens
// 加载 prompt-quick.template.md
// 只注入 {{architectureContext}} 和 {{focusAppContext}}
// 无方法论、无场景策略、无对话上下文
```

| 维度 | Quick Mode | Full Mode |
|------|-----------|-----------|
| 目标 tokens | ~1500 | ~4500 |
| 场景策略 | 无 | 12 套之一 |
| 方法论 | 无 | prompt-methodology.template.md |
| 对话上下文 | 无 | findings + notes + entity + summary |
| Planning Gate | 无 | 有 |
| Verifier | 无 | 有 |
| 适用场景 | 「帧率多少」「有没有 ANR」 | 「分析滑动卡顿」「分析启动性能」 |

### 多轮对话中 Prompt 的变化

在多轮分析中（用户追问或 drill-down），prompt 的变化取决于 **SDK session 是否命中 resume**：

**第 1 轮：** 无对话上下文、无历史计划、无分析笔记

**第 2 轮起 — SDK session resume 命中（4 小时内）：**
- SDK 内部已持有完整对话历史，**不重复注入** `previousFindings` 和 `conversationSummary`
- 但仍注入：分析笔记（≤10 条）、实体上下文（drill-down 引用）、历史计划（≤3 轮）
- Tier 1-3 保持不变，命中 ~80% 缓存

**第 2 轮起 — SDK session 过期或不可用：**
- 手动注入上一轮的 findings 为「之前的分析发现」（≤10 条）
- 手动注入对话摘要（`sessionContext.generatePromptContext(2000)`，≤2000 tokens）
- 分析笔记、实体上下文、历史计划同上

**纠错重试轮：** 如果检测到 SDK auto-compact（对话历史被自动压缩），token 预算从 4500 降到 3000，渐进丢弃会更激进地移除非关键 section。如果没有发生 auto-compact，复用原始 system prompt。

### 一个具体例子：滑动分析的 Prompt 拼接

用户输入 `"分析滑动卡顿"`，Flutter TextureView 架构，第 1 轮：

```
[Tier 1] prompt-role.template.md                    → "你是 Android 性能分析专家..."
[Tier 1] prompt-output-format.template.md            → 输出格式规则
[Tier 2] "架构: Flutter TextureView, 置信度 92%"     → + arch-flutter.template.md
[Tier 2] "焦点应用: com.example.app (主焦点)"        → 帧数 + 检测方法
[Tier 2] "数据完整性: gpu ❌ 疑似未采集"              → 只报缺失/不足，可用的不报
[Tier 2] SQL 知识库: android_frames, slice_self_dur   → stdlib 匹配结果
[Tier 3] prompt-methodology + scrolling.strategy.md   → Phase 1→1.5→1.9→3 完整策略
[Tier 4] (无选区、无对话上下文、无历史计划)

预估: ~3200 tokens, 在 4500 预算内, 无需丢弃
```

用户追问 `"深入分析第 3 帧"`，第 2 轮（SDK session resume 命中）：

```
[Tier 1-3] 与第 1 轮相同（命中 ~80% 缓存）
[Tier 4] 对话上下文 (SDK 已持有对话历史，不重复注入 findings):
  - 分析笔记: "⚠️ [假设] 主要 jank 原因是 RenderThread Binder 阻塞"
  - 实体上下文: frame#3 的 ID 和时间范围
  - 历史计划: "✓ Phase 1 概览, ✓ Phase 1.9 深钻, ○ Phase 3 结论"
  (previousFindings 和 conversationSummary 由 SDK session 内部管理，不在 prompt 中重复)

预估: ~3400 tokens, 在预算内
```

### 一句话总结

**Prompt 按「稳定性」四层排序（Static → Per-Trace → Per-Query → Dynamic），利用 API 前缀缓存实现多轮对话 ~80% token 节省。模板系统让领域专家可以直接编辑分析策略而不碰 TypeScript。超预算时按优先级渐进丢弃，但永远保留角色定义、场景策略和用户选区——这三者决定了分析的方向和范围。**

---

## Q8：SmartPerfetto 有哪些 Skill？

**提问背景：** SmartPerfetto 的分析能力由 YAML Skill 承载。完整的 Skill 清单可以帮助理解系统的分析覆盖范围。

### 总览

| 分类 | 数量 | 说明 |
|------|------|------|
| Atomic | 87 | 单步检测/统计，一条或几条 SQL 完成 |
| Composite | 29 | 组合多个 atomic skill，支持 iterator/conditional |
| Deep | 2 | 深度剖析（callstack、CPU profiling） |
| Pipeline | 29 | 渲染管线检测 + 教学（24+ 种架构） |
| Module | 18 | 模块化配置：app/framework/hardware/kernel |
| **合计** | **165** | |

---

### Atomic Skills（87 个）

单步数据提取和检测，是所有高层 Skill 的构建基础。

**帧渲染与掉帧：**

| Skill ID | 一句话描述 |
|----------|-----------|
| consumer_jank_detection | 从 SF 消费端角度检测真正的掉帧（per-layer buffer 枯竭） |
| frame_blocking_calls | 识别每个掉帧帧期间的阻塞调用（GC、Binder、锁、IO） |
| frame_production_gap | 检测帧生产间隙：连续帧之间的 gap 超过 1.5× VSync |
| frame_pipeline_variance | 检测帧时长抖动与高方差区间 |
| render_pipeline_latency | 分解帧渲染全链路各阶段耗时 |
| render_thread_slices | 分析 RenderThread 的时间片分布 |
| app_frame_production | 分析应用主线程的帧生产情况 |
| sf_frame_consumption | 分析 SurfaceFlinger 消费帧的情况 |
| sf_composition_in_range | 分析 SurfaceFlinger 合成延迟 |
| sf_layer_count_in_range | 统计时间范围内 SF 活跃图层数量 |
| present_fence_timing | 分析 Present Fence 时序，检测实际显示延迟 |
| game_fps_analysis | 针对游戏场景的帧率分析，支持固定帧率模式 |

**VSync 与刷新率：**

| Skill ID | 一句话描述 |
|----------|-----------|
| vsync_period_detection | 检测 VSync 周期，返回刷新率和置信度 |
| vsync_config | 从 trace 中解析实际的 VSync 周期和刷新率设置 |
| vsync_alignment_in_range | 分析帧与 VSync 信号的对齐情况 |
| vsync_phase_alignment | 分析输入事件与 VSync 的相位关系，定位跟手延迟瓶颈 |
| vrr_detection | 检测设备是否使用可变刷新率（VRR/LTPO/Adaptive Sync） |

**CPU 与调度：**

| Skill ID | 一句话描述 |
|----------|-----------|
| cpu_topology_detection | 从 cpufreq 动态检测 CPU 大小核拓扑 |
| cpu_topology_view | 创建可复用 SQL VIEW `_cpu_topology` |
| cpu_slice_analysis | 分析 CPU 时间片分布（动态拓扑检测） |
| cpu_load_in_range | 分析指定时间范围内各 CPU 核心的负载情况 |
| cpu_cluster_load_in_range | 计算大核簇和小核簇的整体 CPU 负载百分比 |
| cpu_freq_timeline | 分析各 CPU 核心的频率变化时间线 |
| cpu_throttling_in_range | 检测 CPU 热控限频情况 |
| sched_latency_in_range | 分析线程调度等待时间分布，检测 CPU 争抢 |
| scheduling_analysis | 分析线程调度延迟（Runnability） |
| task_migration_in_range | 分析线程在大小核之间的迁移频率 |
| thread_affinity_violation | 检测主线程/RenderThread 的高频迁核行为 |
| thermal_predictor | 基于 CPU 频率趋势预测热限频风险 |
| cache_miss_impact | 统计 cache-miss 计数器并评估波动 |

**GPU：**

| Skill ID | 一句话描述 |
|----------|-----------|
| gpu_render_in_range | 分析 GPU 渲染耗时和 Fence 等待 |
| gpu_freq_in_range | 分析 GPU 频率变化情况 |
| gpu_metrics | 分析 GPU 频率、利用率和渲染性能 |
| gpu_power_state_analysis | 分析 GPU 频率状态切换，识别降频压力与抖动 |

**主线程分析：**

| Skill ID | 一句话描述 |
|----------|-----------|
| main_thread_states_in_range | 统计区间内主线程状态、阻塞函数与占比 |
| main_thread_slices_in_range | 统计区间内主线程切片耗时分布 |
| main_thread_sched_latency_in_range | 统计主线程 Runnable 等待时间分布 |
| main_thread_file_io_in_range | 统计区间内主线程文件 IO 相关切片耗时 |

**Binder IPC：**

| Skill ID | 一句话描述 |
|----------|-----------|
| binder_in_range | 分析指定时间范围内的 Binder 事务 |
| binder_blocking_in_range | 分析同步 Binder 调用中对端进程的响应延迟 |
| binder_root_cause | 对慢 Binder 事务进行服务端/客户端阻塞原因归因 |
| binder_storm_detection | 检测 Binder 事务风暴：短时间内过多 IPC 调用 |

**锁与同步：**

| Skill ID | 一句话描述 |
|----------|-----------|
| lock_contention_in_range | 分析指定时间范围内的锁竞争情况 |
| futex_wait_distribution | 统计 futex/mutex 锁等待分布与耗时 |

**启动专用（19 个）：**

| Skill ID | 一句话描述 |
|----------|-----------|
| startup_events_in_range | 查询启动事件及 TTID/TTFD 指标 |
| startup_slow_reasons | 启动慢原因（Google 官方分类 + 自检）v3.0 |
| startup_critical_tasks | 自动识别启动区间内所有活跃线程，按 CPU 时间排序 |
| startup_thread_blocking_graph | 利用 waker_utid 构建线程间的 block/wakeup 关系图 |
| startup_jit_analysis | 分析 JIT 编译线程对启动速度的影响 |
| startup_cpu_placement_timeline | 按时间桶分析主线程核类型变化，检测启动初期被困小核 |
| startup_freq_rampup | 分析冷启动初期 CPU 频率爬升速度，检测升频延迟 |
| startup_binder_pool_analysis | 分析启动期间 Binder 线程池利用率和饱和度 |
| startup_hot_slice_states | 分析启动区间内 Top N 热点 Slice 的线程状态分布 |
| startup_main_thread_states_in_range | 统计启动阶段主线程 Running/Runnable/Blocked 占比 |
| startup_main_thread_slices_in_range | 统计启动阶段主线程切片热点 |
| startup_binder_in_range | 统计启动阶段 Binder 调用分布 |
| startup_main_thread_file_io_in_range | 统计启动阶段主线程文件 IO |
| startup_sched_latency_in_range | 统计启动阶段主线程 Runnable 等待时延 |
| startup_main_thread_sync_binder_in_range | 统计启动阶段主线程同步 Binder 耗时 |
| startup_main_thread_binder_blocking_in_range | 分析启动阶段主线程同步 Binder 阻塞明细 |
| startup_breakdown_in_range | 统计启动阶段各归因原因耗时占比 |
| startup_gc_in_range | 统计启动阶段 GC 切片及主线程占比 |
| startup_class_loading_in_range | 统计启动阶段类加载切片耗时 |

**内存与 GC：**

| Skill ID | 一句话描述 |
|----------|-----------|
| gc_events_in_range | 查询给定进程的 GC 事件和可选时间范围 |
| memory_pressure_in_range | 分析指定时间范围内的内存压力指标 |
| page_fault_in_range | 分析 Page Fault 和内存回收对性能的影响 |

**输入与触摸：**

| Skill ID | 一句话描述 |
|----------|-----------|
| input_events_in_range | 提取区间内的原始输入事件，分析分发延迟 |
| input_to_frame_latency | 测量每个 MotionEvent 到对应帧 present 的延迟 |
| touch_to_display_latency | 测量从触摸到帧渲染的端到端延迟 |
| scroll_response_latency | 测量滚动手势从输入到首帧渲染的响应延迟 |

**系统与设备：**

| Skill ID | 一句话描述 |
|----------|-----------|
| system_load_in_range | 分析系统整体 CPU 利用率和进程活跃度 |
| device_state_snapshot | 采集 trace 期间的设备环境信息（屏幕、电量、温度等） |
| device_state_timeline | 追踪设备状态随时间的变化 |
| wakelock_tracking | 追踪 Wake Lock 持有情况，检测电池功耗异常 |

**其他：**

| Skill ID | 一句话描述 |
|----------|-----------|
| blocking_chain_analysis | 分析主线程阻塞链：谁阻塞了主线程？唤醒者在做什么？ |
| anr_main_thread_blocking | 深度分析 ANR 中主线程阻塞原因 |
| anr_context_in_range | 提取第一个 ANR 事件数据用作时间窗口锚点 |
| app_lifecycle_in_range | 追踪 Activity/Fragment 生命周期事件 |
| compose_recomposition_hotspot | 检测 Jetpack Compose 重组热点 |
| webview_v8_analysis | 分析 WebView V8 引擎：GC、脚本编译、执行时间 |
| rendering_pipeline_detection | 识别应用渲染管线类型（24 种细粒度检测） |
| pipeline_key_slices_overlay | 查询管线关键 Slice 的 ts/dur 用于时间线 overlay |

---

### Composite Skills（29 个）

组合多个 atomic skill，支持 iterator（逐帧/逐事件深钻）和 conditional（条件分支）。

| Skill ID | 一句话描述 |
|----------|-----------|
| scrolling_analysis | 滑动分析主入口：概览 → 帧列表 → 根因分类 → 逐帧诊断 |
| flutter_scrolling_analysis | Flutter 特定帧分析，使用 Flutter 线程模型 |
| jank_frame_detail | 分析特定掉帧的详细原因：深钻 jank 原因和根因分类 |
| startup_analysis | 启动分析主入口：Iterator 模式、大小核分析、四象限 |
| startup_detail | 分析单个启动事件：主线程耗时、Binder、CPU 大小核占比 |
| anr_analysis | ANR v3.0 分析：系统问题 vs 应用问题、分类处理 |
| anr_detail | 单个 ANR 事件详情：四象限、Binder 依赖、死锁检测 |
| cpu_analysis | CPU 分析：时间分布、大小核分析、调度链路 |
| gpu_analysis | GPU 分析：频率分布、内存使用、帧渲染关联 |
| memory_analysis | 内存分析：GC 事件、GC 与帧关联、线程状态 |
| gc_analysis | GC 分析：基于 stdlib android_garbage_collection_events |
| binder_analysis | Binder 深度分析：事务基础、线程状态 |
| binder_detail | 单个 Binder 事务详情：CPU 大小核、四象限、阻塞原因 |
| thermal_throttling | 温度监控、热节流检测、CPU 频率相关性 |
| lock_contention_analysis | 锁竞争多维度分析：基于 android.monitor_contention |
| surfaceflinger_analysis | SF 帧合成性能：GPU/HWC 合成比例、慢合成检测 |
| click_response_analysis | 点击响应分析：基于 stdlib android_input_events |
| click_response_detail | 单个慢输入事件详情：延迟分解、四象限、主线程阻塞 |
| scroll_session_analysis | 单个完整滑动区间：Touch 阶段 vs Fling 阶段 FPS |
| navigation_analysis | Activity/Fragment 跳转性能：生命周期、转场动画 |
| lmk_analysis | LMK 分析：原因分布、时间线、频率 |
| dmabuf_analysis | DMA Buffer 分析：分配、释放、泄漏检测 |
| block_io_analysis | Block IO 分析：设备级统计、队列深度、长耗时 IO |
| io_pressure | IO 阻塞数据检测、IO Wait 时间、严重度评估 |
| suspend_wakeup_analysis | 休眠/唤醒分析：时间分布、唤醒源排行 |
| network_analysis | 网络分析：流量概览、应用流量、协议分布 |
| irq_analysis | 硬中断和软中断的频率、耗时、嵌套情况 |
| scene_reconstruction | 通过用户输入和屏幕状态还原用户操作场景 |
| state_timeline | 四泳道连续状态时间线：设备/用户/应用/系统 |

---

### Deep Skills（2 个）

深度剖析，通常需要更长的执行时间。

| Skill ID | 一句话描述 |
|----------|-----------|
| cpu_profiling | CPU 性能剖析：使用热点和调度效率深度分析 |
| callstack_analysis | Running 状态下的调用栈热点分析 |

---

### Pipeline Skills（28 个）

渲染管线检测 + 教学。每个 pipeline skill 对应一种渲染架构，包含管线描述、关键线程、性能指标和优化建议。

| Skill ID | 渲染架构 |
|----------|---------|
| pipeline_android_view_standard_blast | Android 12+ 标准 HWUI + BLASTBufferQueue |
| pipeline_android_view_standard_legacy | Android 12 前标准 HWUI + Legacy BufferQueue |
| pipeline_android_view_software | CPU Skia 软件渲染，无 RenderThread |
| pipeline_android_view_mixed | View + SurfaceView 混合渲染 |
| pipeline_android_view_multi_window | 同进程多窗口（Dialog/PopupWindow） |
| pipeline_android_pip_freeform | 画中画和自由窗口模式 |
| pipeline_compose_standard | Jetpack Compose + HWUI RenderThread |
| pipeline_flutter_textureview | Flutter PlatformView 降级模式 |
| pipeline_flutter_surfaceview_skia | Flutter + Skia 引擎（JIT Shader） |
| pipeline_flutter_surfaceview_impeller | Flutter + Impeller 引擎（预编译 Shader） |
| pipeline_webview_gl_functor | 传统 WebView，App RenderThread 同步等待 |
| pipeline_webview_surface_control | 现代 WebView + Viz/OOP-R 独立合成 |
| pipeline_webview_textureview_custom | X5/UC 等定制 WebView 内核 |
| pipeline_webview_surfaceview_wrapper | WebView 全屏视频包装模式 |
| pipeline_chrome_browser_viz | Chrome Viz 合成器，多进程架构 |
| pipeline_opengl_es | 直接 OpenGL ES / EGL 渲染 |
| pipeline_vulkan_native | 原生 Vulkan 渲染 |
| pipeline_angle_gles_vulkan | ANGLE: OpenGL ES → Vulkan 翻译层 |
| pipeline_game_engine | Unity/Unreal/Godot 等游戏引擎 |
| pipeline_surfaceview_blast | 独立 SurfaceView + BLAST 同步 |
| pipeline_textureview_standard | SurfaceTexture 纹理采样/合成模式 |
| pipeline_camera_pipeline | Camera2/HAL3 多流相机渲染 |
| pipeline_video_overlay_hwc | HWC 视频层硬件加速叠加 |
| pipeline_hardware_buffer_renderer | Android 14+ HBR API 直接 Buffer 渲染 |
| pipeline_surface_control_api | NDK SurfaceControl 直接事务提交 |
| pipeline_variable_refresh_rate | VRR/ARR + FrameTimeline 动态刷新率 |
| pipeline_imagereader_pipeline | ImageReader API：ML 推理、录屏、自定义相机 |
| pipeline_software_compositing | SF CPU 软件合成回退（GPU 不可用时） |

> 注：`_base.skill.yaml` 是 Pipeline Skill 的基础模板文件，不注册为可用 Skill，不计入总数。

---

### Module Skills（18 个）

模块化分析配置，按层级组织。Agent 通过 `list_skills` 发现并按需调用。

**硬件层（5 个）：**

| Skill ID | 一句话描述 |
|----------|-----------|
| cpu_module | CPU 频率、热节流和电源状态 |
| gpu_module | GPU 渲染、频率和显存使用 |
| memory_module | 内存带宽、LMK、dmabuf、PSI、缺页 |
| thermal_module | 温度传感器、热节流检测、冷却策略 |
| power_module | Wake Lock、CPU idle、电源模式、休眠/唤醒 |

**框架层（6 个）：**

| Skill ID | 一句话描述 |
|----------|-----------|
| surfaceflinger_module | 帧渲染时序、卡顿原因、GPU 合成 |
| choreographer_module | VSync 信号、doFrame 回调、帧生产管线 |
| ams_module | 应用生命周期、进程管理、启动时序 |
| wms_module | 窗口动画、Activity 转场、多窗口 |
| art_module | GC、JIT 编译和内存分配 |
| input_module | 触摸延迟、输入派发和点击响应 |

**内核层（4 个）：**

| Skill ID | 一句话描述 |
|----------|-----------|
| scheduler_module | 线程调度延迟、CPU 利用率、大小核分配 |
| binder_module | 跨进程调用、阻塞事务、调用延迟 |
| lock_contention_module | Mutex/Futex、Java monitor、死锁检测 |
| filesystem_module | Block IO、文件操作、数据库、SharedPreferences |

**应用层（3 个）：**

| Skill ID | 一句话描述 |
|----------|-----------|
| launcher_module | 主屏性能、应用启动、小部件更新 |
| systemui_module | 状态栏、通知栏、快速设置、导航栏 |
| third_party_module | 第三方应用性能、卡顿和资源使用 |

---

### Skill 之间的关系

```
Module Skills (配置层)
  └→ 定义分析范围和关注点

Composite Skills (编排层)
  ├→ 引用多个 Atomic Skills
  ├→ Iterator: 逐帧/逐事件遍历深钻
  └→ Conditional: 按数据条件分支

Atomic Skills (执行层)
  └→ 直接执行 SQL，返回 DataEnvelope

Pipeline Skills (知识层)
  └→ 渲染管线教学 + 检测

Deep Skills (剖析层)
  └→ Callstack / CPU profiling 深度分析
```

**Agent 的典型调用路径（以滑动分析为例）：**
```
invoke_skill("scrolling_analysis")          ← Composite，内部调用多个 Atomic
  → consumer_jank_detection                 ← Atomic，检测掉帧
  → 逐帧 iterator → jank_frame_detail      ← Composite，每帧深钻
    → main_thread_states_in_range           ← Atomic
    → binder_blocking_in_range              ← Atomic
    → frame_blocking_calls                  ← Atomic
```

---

*（持续更新，收到新问题后补充）*

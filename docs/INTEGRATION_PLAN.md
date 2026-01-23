# SmartPerfetto Agent 系统改进计划

> 本文档基于 `INTELLIGENT_AGENT_DESIGN.md` 的目标设计，结合现有 `ARCHITECTURE.md` 和 `FLOW.md` 的实现，制定从"指令执行器"到"智能分析专家"的改进路线图。
> 
> ⚠️ 说明：当前仅保留 AgentDrivenOrchestrator 主链路，文档中的 Master/OrchestratorBridge 相关内容已过时。

## 1. 差距分析 (Gap Analysis)

### 1.1 核心差距总览

| 维度 | 当前状态 | 目标状态 | 差距等级 |
|------|----------|----------|----------|
| **意图理解** | 指令驱动 (用户说分析滑动 → 执行滑动 Skill) | 意图驱动 (理解用户要解决什么问题) | 🔴 高 |
| **分析模式** | 单轮执行 (执行 → 返回结果) | 多轮探索 (假设 → 验证 → 深入) | 🔴 高 |
| **架构识别** | 不识别 (假设所有都是标准 RecyclerView) | 自动识别 (Standard/Flutter/WebView/Compose) | 🔴 高 |
| **根因定位** | 返回数据表格 | 判断 App/System 问题 + 具体组件 | 🔴 高 |
| **专家能力** | 通用 SubAgent (Planner/Evaluator) | 领域专家 (Launch/Interaction/System Expert) | 🟡 中 |
| **决策逻辑** | 线性 Pipeline (5 阶段) | 动态状态机 (条件分支决策) | 🟡 中 |
| **数据层次** | L1 基本覆盖 | L1-L4 完整覆盖 | 🟡 中 |
| **对话上下文** | 部分支持 (Session Context) | 完整多轮上下文 + 引用之前发现 | 🟡 中 |
| **Session Fork** | 基础实现 | 完整的 Fork + Merge + Context Isolation | 🟢 低 |
| **Skill 体系** | 已有 YAML Skills | 原子化 + 无状态 + 作为 Agent 工具 | 🟢 低 |

### 1.2 详细差距分析

#### A. 架构识别能力 (Architecture Detector)

**当前状态:**
- 无架构识别逻辑
- 所有分析假设是标准 Android View + RenderThread 架构
- `scrolling_analysis` Skill 直接查询 RenderThread 的 DrawFrame

**目标状态:**
- 分析前自动检测渲染架构
- 根据架构加载不同的 Skills 或分析策略
- 支持: Standard、Flutter、WebView/Chrome、Compose、SurfaceView、GLSurfaceView

**需要的改进:**
```
1. 新增 ArchitectureDetector 模块
   - 输入: Trace 的进程列表、线程名称、关键 Slice
   - 输出: { type: 'STANDARD' | 'FLUTTER' | 'WEBVIEW' | 'COMPOSE' | ..., version?: string }

2. 识别逻辑:
   - Flutter: 检查是否有 `1.ui`, `1.raster` 线程，或 `flutter::` 开头的 Slice
   - WebView: 检查 `CrRendererMain`, `Compositor`, `viz::` Slice
   - Compose: 检查 `doFrame` 中是否有 `Recomposition` Slice
   - Standard: 有 RenderThread + DrawFrame 但无上述特征
```

#### B. 意图理解与智能决策

**当前状态 (MasterOrchestrator):**
```typescript
// backend/src/agent/core/masterOrchestrator.ts
// 5阶段线性 Pipeline:
// PLAN → EXECUTE → EVALUATE → REFINE → CONCLUDE
```

**目标状态:**
```
用户输入: "滑动有点卡"
   ↓
意图解析: 用户想解决滑动性能问题，需要定位根因
   ↓
智能决策:
   1. 先看整体 FPS，确认是否真的有问题
   2. 如果有问题，判断是 App 还是 System
   3. 深入到具体组件 (RenderThread/SF/Binder/...)
   4. 给出结论 + 建议
```

**需要的改进:**
```
1. 增强 PlannerAgent 的意图解析能力
   - 不只是"映射到哪个 Skill"，而是"用户想解决什么问题"
   - 生成分析计划时考虑"分支决策点"

2. 在 PipelineExecutor 中支持"条件分支"
   - EXECUTE 阶段的结果可以触发不同的后续路径
   - 而不是固定的 EXECUTE → EVALUATE
```

#### C. 专家 Agent 体系

**当前状态 (SubAgents):**
```
backend/src/agent/agents/
├── base/
│   └── baseSubAgent.ts       # 通用基类
├── planner/
│   └── plannerAgent.ts       # 规划 Agent
├── evaluator/
│   └── evaluatorAgent.ts     # 评估 Agent
└── workers/
    └── analysisWorker.ts     # 执行 Agent
```

**目标状态 (Expert Agents):**
```
backend/src/agent/experts/
├── base/
│   └── baseExpert.ts         # 专家基类 (状态机驱动)
├── launchExpert.ts           # 启动分析专家
├── interactionExpert.ts      # 滑动/点击分析专家
└── systemExpert.ts           # 系统级分析专家

每个 Expert 是一个状态机:
- 有明确的分析决策树
- 可以调用多个 Skills 作为工具
- 可以 Fork 子会话进行深入分析
```

**需要的改进:**
```
1. 设计 Expert Agent 基类
   - 状态机框架 (states, transitions, conditions)
   - 工具调用接口 (executeTool)
   - Fork 会话接口 (forkSession)

2. 实现领域 Expert
   - InteractionExpert: 滑动分析决策树
   - LaunchExpert: 启动分析决策树
   - SystemExpert: 系统级分析
```

#### D. 根因定位与分类

**当前状态:**
- 返回 FPS 数据、卡顿帧列表
- 不主动判断问题在哪

**目标状态:**
- 自动分类: App 问题 vs 系统问题
- 定位具体组件: UI Render / VSync / SF / Binder / Scheduling
- 给出结论和建议

**需要的改进:**
```
1. 在 scrolling_analysis Skill 中增加根因分类逻辑
   - 检查 SF 状态 → 正常则看 App，异常则是系统问题
   - 检查 RenderThread 耗时分布 → 定位 measure/layout/draw/render
   - 检查 Binder 调用 → 是否有跨进程阻塞

2. 新增分类输出字段
   - problem_category: 'APP' | 'SYSTEM' | 'MIXED'
   - problem_component: 'RENDER_THREAD' | 'MAIN_THREAD' | 'SURFACE_FLINGER' | 'BINDER' | ...
   - root_cause_summary: "App 的 RenderThread Draw 阶段耗时过长，平均 22ms"
```

---

## 2. 改进计划 (Implementation Plan)

### Phase 1: 架构识别基础 (Foundation)
**目标**: 在分析前能够自动识别渲染架构
**预计周期**: 1-2 周

#### 1.1 ArchitectureDetector 模块

**新增文件:**
```
backend/src/agent/detectors/
├── architectureDetector.ts   # 主检测器
├── flutterDetector.ts        # Flutter 特征检测
├── webviewDetector.ts        # WebView 特征检测
└── composeDetector.ts        # Compose 特征检测
```

**接口设计:**
```typescript
interface ArchitectureInfo {
  type: 'STANDARD' | 'FLUTTER' | 'WEBVIEW' | 'COMPOSE' | 'SURFACEVIEW' | 'GL';
  version?: string;           // 如 Flutter 3.29
  engine?: string;            // 如 WebView 的 X5/UC/Chromium
  surfaceType?: string;       // 如 WebView 的 SurfaceView/TextureView
  confidence: number;         // 置信度 0-1
  detectionEvidence: string[];// 检测依据
}

class ArchitectureDetector {
  async detect(traceProcessor: TraceProcessorService): Promise<ArchitectureInfo>;
}
```

**检测 SQL 示例:**
```sql
-- 检测 Flutter
SELECT DISTINCT thread.name
FROM thread
WHERE thread.name LIKE '%.ui' OR thread.name LIKE '%.raster';

-- 检测 WebView/Chrome
SELECT DISTINCT process.name
FROM process
WHERE process.name LIKE '%chromium%' OR process.name LIKE '%webview%';

-- 检测 Compose
SELECT DISTINCT slice.name
FROM slice
WHERE slice.name LIKE '%Recomposition%' OR slice.name LIKE '%Compose%';
```

#### 1.2 集成到分析流程

**修改 MasterOrchestrator:**
```typescript
// 在 PLAN 阶段之前增加架构检测
async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
  // Step 0: 架构检测 (新增)
  const architecture = await this.architectureDetector.detect(traceProcessor);

  // 将架构信息加入上下文
  this.context.set('architecture', architecture);

  // Step 1: 规划 (传入架构信息)
  const plan = await this.planner.plan(request, architecture);

  // ...后续流程
}
```

---

### Phase 2: 智能决策增强 (Intelligence)
**目标**: 支持条件分支决策，实现专家级分析逻辑
**预计周期**: 2-3 周

#### 2.1 决策树框架

**新增文件:**
```
backend/src/agent/decision/
├── decisionTree.ts           # 决策树基类
├── scrollingDecisionTree.ts  # 滑动分析决策树
└── launchDecisionTree.ts     # 启动分析决策树
```

**决策树设计:**
```typescript
interface DecisionNode {
  id: string;
  type: 'CHECK' | 'ACTION' | 'CONCLUDE';
  check?: {
    condition: string;        // 检查条件的描述
    skill?: string;           // 需要执行的 Skill
    evaluate: (result: any) => boolean;
  };
  action?: {
    skill: string;            // 执行的 Skill
    params?: Record<string, any>;
  };
  conclusion?: {
    category: 'APP' | 'SYSTEM' | 'MIXED';
    component: string;
    summary: string;
  };
  next?: {
    true?: string;            // 条件为真时的下一节点
    false?: string;           // 条件为假时的下一节点
  };
}

// 滑动分析决策树示例
const scrollingDecisionTree: DecisionNode[] = [
  {
    id: 'check_fps',
    type: 'CHECK',
    check: {
      condition: 'FPS 是否正常 (>= 55)?',
      skill: 'scrolling_analysis',
      evaluate: (result) => result.avg_fps >= 55
    },
    next: { true: 'conclude_normal', false: 'check_sf' }
  },
  {
    id: 'check_sf',
    type: 'CHECK',
    check: {
      condition: 'SurfaceFlinger 是否正常?',
      skill: 'sf_analysis',
      evaluate: (result) => result.sf_avg_duration < 4
    },
    next: { true: 'check_app', false: 'conclude_sf_issue' }
  },
  // ...更多节点
];
```

#### 2.2 增强 PipelineExecutor

**修改 PipelineExecutor 支持分支:**
```typescript
// 当前: 线性执行 PLAN → EXECUTE → EVALUATE → REFINE → CONCLUDE
// 目标: 支持基于结果的条件分支

async executeWithDecisionTree(tree: DecisionNode[]): Promise<AnalysisResult> {
  let currentNode = tree[0];
  const executionPath: string[] = [];

  while (currentNode) {
    executionPath.push(currentNode.id);

    if (currentNode.type === 'CHECK') {
      const result = await this.executeSkill(currentNode.check.skill);
      const condition = currentNode.check.evaluate(result);
      currentNode = tree.find(n => n.id === currentNode.next[condition ? 'true' : 'false']);
    } else if (currentNode.type === 'ACTION') {
      await this.executeSkill(currentNode.action.skill, currentNode.action.params);
      currentNode = tree.find(n => n.id === currentNode.next?.true);
    } else if (currentNode.type === 'CONCLUDE') {
      return { conclusion: currentNode.conclusion, path: executionPath };
    }
  }
}
```

---

### Phase 3: Expert Agent 体系 (Experts)
**目标**: 实现领域专家 Agent，替代通用 SubAgent
**预计周期**: 3-4 周

#### 3.1 Expert 基类设计

**新增文件:**
```
backend/src/agent/experts/
├── base/
│   ├── baseExpert.ts         # 专家基类
│   └── stateMachine.ts       # 状态机实现
├── interactionExpert.ts      # 滑动/点击专家
├── launchExpert.ts           # 启动专家
└── systemExpert.ts           # 系统专家
```

**BaseExpert 设计:**
```typescript
abstract class BaseExpert {
  protected context: AnalysisContext;
  protected stateMachine: StateMachine;

  // 专家的核心方法
  abstract async analyze(input: ExpertInput): Promise<ExpertOutput>;

  // 工具调用
  protected async executeTool(skillName: string, params?: any): Promise<any>;

  // 会话分叉
  protected async forkSession(reason: string, context: any): Promise<ExpertOutput>;

  // 获取决策树
  abstract getDecisionTree(): DecisionNode[];
}

class InteractionExpert extends BaseExpert {
  async analyze(input: ExpertInput): Promise<ExpertOutput> {
    // 1. 架构检测
    const arch = await this.detectArchitecture();

    // 2. 根据架构选择分析策略
    const strategy = this.selectStrategy(arch);

    // 3. 执行决策树
    return this.executeDecisionTree(strategy.decisionTree);
  }

  getDecisionTree(): DecisionNode[] {
    return scrollingDecisionTree;
  }
}
```

#### 3.2 专家注册与路由

**修改 MasterOrchestrator:**
```typescript
class MasterOrchestrator {
  private experts: Map<string, BaseExpert> = new Map();

  constructor() {
    // 注册专家
    this.experts.set('interaction', new InteractionExpert());
    this.experts.set('launch', new LaunchExpert());
    this.experts.set('system', new SystemExpert());
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    // 1. 意图分析 → 选择专家
    const intent = await this.analyzeIntent(request.query);
    const expert = this.selectExpert(intent);

    // 2. 专家执行分析
    return expert.analyze({
      query: request.query,
      traceProcessor: this.traceProcessor,
      context: this.context
    });
  }

  private selectExpert(intent: AnalysisIntent): BaseExpert {
    switch (intent.category) {
      case 'SCROLLING':
      case 'CLICK':
        return this.experts.get('interaction');
      case 'LAUNCH':
        return this.experts.get('launch');
      case 'CPU':
      case 'MEMORY':
      case 'IO':
        return this.experts.get('system');
      default:
        return this.experts.get('interaction'); // 默认
    }
  }
}
```

---

### Phase 4: 根因分类与输出增强 (Root Cause)
**目标**: 自动分类问题类型，给出结论和建议
**预计周期**: 2 周

#### 4.1 增强 Skill 输出

**修改 scrolling_analysis.skill.yaml:**
```yaml
name: scrolling_analysis
type: composite

steps:
  # 现有步骤...

  # 新增: 根因分类
  - id: root_cause_classification
    type: analysis
    inputs:
      - jank_frames
      - sf_status
      - binder_calls
    logic: |
      // 分类逻辑
      if (sf_status.abnormal) {
        return { category: 'SYSTEM', component: 'SURFACE_FLINGER' };
      }
      if (renderthread_avg > 16) {
        return { category: 'APP', component: 'RENDER_THREAD' };
      }
      // ...
    output:
      problem_category: string
      problem_component: string
      confidence: number
      evidence: string[]

output:
  # 现有输出...

  # 新增结构化结论
  conclusion:
    category: $root_cause_classification.problem_category
    component: $root_cause_classification.problem_component
    summary: "根据分析，{category}问题，主要在{component}组件"
    suggestions:
      - "检查 {component} 相关代码"
      - "考虑优化 {optimization_target}"
```

#### 4.2 前端展示增强

**修改结果展示组件:**
```typescript
// perfetto/ui/src/components/skill/l1-summary.ts
class L1Summary {
  view() {
    const conclusion = this.data.conclusion;

    return m('.l1-summary', [
      // 现有内容...

      // 新增: 结论卡片
      conclusion && m('.conclusion-card', {
        class: conclusion.category === 'APP' ? 'app-issue' : 'system-issue'
      }, [
        m('.category-badge', conclusion.category),
        m('.component', conclusion.component),
        m('.summary', conclusion.summary),
        m('.suggestions', conclusion.suggestions.map(s => m('.suggestion', s)))
      ])
    ]);
  }
}
```

---

### Phase 5: 多轮对话增强 (Multi-turn)
**目标**: 完整的多轮对话支持，保持上下文连贯
**预计周期**: 2 周

#### 5.1 对话上下文增强

**增强 SessionContext:**
```typescript
interface ConversationTurn {
  id: string;
  timestamp: number;
  query: string;
  intent: AnalysisIntent;
  result: AnalysisResult;
  findings: Finding[];        // 本轮发现
}

interface Finding {
  id: string;
  type: 'ISSUE' | 'INSIGHT' | 'QUESTION';
  description: string;
  data: any;
  referenceable: boolean;     // 是否可被后续引用
}

class EnhancedSessionContext {
  private turns: ConversationTurn[] = [];
  private findings: Map<string, Finding> = new Map();

  // 添加新的对话轮次
  addTurn(turn: ConversationTurn): void;

  // 获取之前的发现
  getFinding(id: string): Finding;

  // 查询相关上下文
  queryContext(keywords: string[]): ConversationTurn[];

  // 生成上下文摘要 (用于 LLM)
  generateContextSummary(): string;
}
```

#### 5.2 上下文感知的响应生成

**修改 AnswerGenerator:**
```typescript
class AnswerGenerator {
  async generate(
    result: AnalysisResult,
    context: EnhancedSessionContext
  ): Promise<string> {
    // 引用之前的发现
    const previousFindings = context.getRecentFindings(3);

    // 生成响应时包含上下文
    const prompt = `
      之前的分析发现:
      ${previousFindings.map(f => f.description).join('\n')}

      本次分析结果:
      ${JSON.stringify(result)}

      请生成自然语言响应，可以引用之前的发现 (如"刚才提到的会话2...")
    `;

    return this.llm.generate(prompt);
  }
}
```

---

### Phase 6: 深层分析能力扩展 (Deep Analysis)
**目标**: 支持 L2+ 级别的深入分析
**预计周期**: 3-4 周

#### 6.1 L2: Running 状态分析

**新增 Skill:**
```yaml
# backend/skills/v2/deep/callstack_analysis.skill.yaml
name: callstack_analysis
type: deep_analysis
level: 2

preconditions:
  - trace_has_callstacks: true

steps:
  - id: hot_functions
    sql: |
      SELECT
        symbol.name as function_name,
        COUNT(*) as sample_count,
        SUM(perf_sample.weight) as total_weight
      FROM perf_sample
      JOIN stack_sample_frame ON perf_sample.callstack_id = stack_sample_frame.callstack_id
      JOIN symbol ON stack_sample_frame.symbol_id = symbol.id
      GROUP BY symbol.name
      ORDER BY total_weight DESC
      LIMIT 20

  - id: call_paths
    sql: |
      -- 热点函数的调用路径
      ...
```

#### 6.2 系统级 Skills

**新增 Skill:**
```yaml
# backend/skills/v2/system/io_pressure.skill.yaml
name: io_pressure
type: system_analysis

steps:
  - id: io_wait_summary
    sql: |
      SELECT
        process.name,
        SUM(CASE WHEN slice.name = 'iowait' THEN slice.dur ELSE 0 END) as io_wait_ns
      FROM slice
      JOIN thread USING (utid)
      JOIN process USING (upid)
      GROUP BY process.name
      ORDER BY io_wait_ns DESC

# backend/skills/v2/system/thermal_throttling.skill.yaml
name: thermal_throttling
type: system_analysis

steps:
  - id: thermal_events
    sql: |
      SELECT ts, value
      FROM counter
      WHERE counter.name LIKE '%thermal%'
      ORDER BY ts
```

---

## 3. 实施优先级与依赖关系

```
┌─────────────────────────────────────────────────────────────────┐
│                    实施优先级图                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Phase 1: 架构识别 ──────────────────────────────────┐          │
│  (1-2周)                                              │          │
│  [ArchitectureDetector]                               │          │
│           │                                           │          │
│           ▼                                           │          │
│  Phase 2: 智能决策 ◀───────────────────────────────────          │
│  (2-3周)                                              │          │
│  [DecisionTree + EnhancedPipeline]                    │          │
│           │                                           │          │
│           ├─────────────────────────┐                 │          │
│           ▼                         ▼                 │          │
│  Phase 3: Expert 体系      Phase 4: 根因分类          │          │
│  (3-4周)                   (2周)                      │          │
│  [BaseExpert +            [EnhancedSkillOutput +     │          │
│   InteractionExpert +      FrontendConclusion]        │          │
│   LaunchExpert]                    │                  │          │
│           │                        │                  │          │
│           └──────────┬─────────────┘                  │          │
│                      ▼                                │          │
│             Phase 5: 多轮对话                         │          │
│             (2周)                                     │          │
│             [EnhancedContext +                        │          │
│              ContextAwareResponse]                    │          │
│                      │                                │          │
│                      ▼                                │          │
│             Phase 6: 深层分析                         │          │
│             (3-4周)                                   │          │
│             [L2CallstackAnalysis +                    │          │
│              SystemSkills]                            │          │
│                                                       │          │
└─────────────────────────────────────────────────────────────────┘

总预计周期: 13-17 周 (约 3-4 个月)
```

---

## 4. 关键文件变更清单

### 4.1 新增文件

```
backend/src/agent/
├── detectors/
│   ├── architectureDetector.ts       # Phase 1
│   ├── flutterDetector.ts            # Phase 1
│   ├── webviewDetector.ts            # Phase 1
│   └── composeDetector.ts            # Phase 1
├── decision/
│   ├── decisionTree.ts               # Phase 2
│   ├── scrollingDecisionTree.ts      # Phase 2
│   └── launchDecisionTree.ts         # Phase 2
├── experts/
│   ├── base/
│   │   ├── baseExpert.ts             # Phase 3
│   │   └── stateMachine.ts           # Phase 3
│   ├── interactionExpert.ts          # Phase 3
│   ├── launchExpert.ts               # Phase 3
│   └── systemExpert.ts               # Phase 3

backend/skills/v2/
├── deep/
│   ├── callstack_analysis.skill.yaml # Phase 6
│   └── cpu_profiling.skill.yaml      # Phase 6
├── system/
│   ├── io_pressure.skill.yaml        # Phase 6
│   └── thermal_throttling.skill.yaml # Phase 6
```

### 4.2 修改文件

```
backend/src/agent/core/
├── masterOrchestrator.ts             # Phase 1, 2, 3
├── pipelineExecutor.ts               # Phase 2
└── modelRouter.ts                    # (可能需要微调)

backend/src/agent/context/
└── sessionContext.ts                 # Phase 5

backend/src/services/
└── answerGenerator.ts                # Phase 4, 5

backend/skills/v2/composite/
└── scrolling_analysis.skill.yaml     # Phase 4

perfetto/ui/src/components/skill/
├── l1-summary.ts                     # Phase 4
└── conclusion-card.ts                # Phase 4 (新增)
```

---

## 5. 验收标准

### Phase 1 验收
- [ ] 能正确识别标准 Android View 应用
- [ ] 能正确识别 Flutter 应用 (包括区分 3.27 和 3.29+)
- [ ] 能正确识别 WebView/Chrome 应用
- [ ] 能正确识别 Jetpack Compose 应用
- [ ] 识别结果包含置信度和依据

### Phase 2 验收
- [ ] 决策树框架可运行
- [ ] 滑动分析决策树实现了"FPS低 → 检查SF → 检查App"的分支逻辑
- [ ] Pipeline 能根据检查结果执行不同路径

### Phase 3 验收
- [ ] InteractionExpert 能处理滑动分析请求
- [ ] LaunchExpert 能处理启动分析请求
- [ ] Expert 能调用多个 Skills 作为工具
- [ ] Expert 能 Fork 子会话进行深入分析

### Phase 4 验收
- [ ] scrolling_analysis 输出包含 problem_category 和 problem_component
- [ ] 前端能展示结论卡片，区分 App/System 问题
- [ ] 结论包含具体的优化建议

### Phase 5 验收
- [ ] 第二轮对话能引用第一轮的发现
- [ ] 响应能自然地说"刚才提到的会话2..."
- [ ] 上下文能在多轮对话中保持连贯

### Phase 6 验收
- [ ] 当 trace 包含 callstack 时，能进行热点函数分析
- [ ] 能分析 IO 压力、thermal throttling
- [ ] 深层分析结果能整合到最终结论中

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 架构识别准确率不高 | 分析策略选择错误 | 增加置信度阈值，低置信度时请用户确认 |
| 决策树逻辑复杂 | 难以维护和调试 | 可视化决策树，详细日志记录每个分支 |
| Expert 之间边界不清 | 职责重叠或遗漏 | 明确定义每个 Expert 的入口条件 |
| 多轮上下文过长 | Token 超限 | 实现上下文压缩和摘要 |
| trace 缺少深层数据 | L2+ 分析无法执行 | 在分析前检查数据可用性，给出采集建议 |

---

## 修订历史

| 日期 | 版本 | 修改内容 |
|------|------|----------|
| 2026-01-16 | v1.0 | 初始版本，完整的 6 阶段改进计划 |

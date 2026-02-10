# SmartPerfetto 完整流程图

> 本文档详细描述从用户输入到最终呈现的完整数据流程
> 
> ⚠️ 说明：当前仅保留 AgentDrivenOrchestrator 主链路，历史内容若涉及 Master/PerfettoAnalysisOrchestrator 已不再适用。

## 0. 重要架构说明

当前已统一为单一主链路：

- 路由: /api/agent/*
- Orchestrator: AgentDrivenOrchestrator
- 会话管理: 内存 sessions Map + SSE 流

---


## 1. 总体流程概览 (当前系统 A)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          用户分析请求完整流程                                 │
│                                                                              │
│  用户输入                                                                    │
│     │                                                                        │
│     ▼                                                                        │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │ 1. Frontend │────►│ 2. API      │────►│ 3. 分析循环 │────►│ 4. Skills │ │
│  │    输入处理  │     │    路由     │     │    执行     │     │    执行   │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └───────────┘ │
│                                                                    │        │
│                                                                    ▼        │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │ 8. 结果渲染 │◄────│ 7. SSE 流   │◄────│ 6. 答案生成 │◄────│ 5. SQL    │ │
│  │    显示     │     │    传输     │     │    综合     │     │    查询   │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └───────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. 详细流程分解

### Phase 1: 用户输入处理 (Frontend)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Phase 1: 用户输入处理                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1.1: 用户在 AI Panel 输入                                      │    │
│  │                                                                      │    │
│  │  用户输入: "分析这个 trace 的滑动性能问题"                            │    │
│  │                                                                      │    │
│  │  触发: <textarea> oninput → this.state.input = value                │    │
│  │  位置: ai_panel.ts:787-788                                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1.2: 发送消息                                                  │    │
│  │                                                                      │    │
│  │  触发: Enter 键 或 点击发送按钮                                       │    │
│  │  调用: sendMessage()                                                │    │
│  │  位置: ai_panel.ts:1249-1275                                        │    │
│  │                                                                      │    │
│  │  处理流程:                                                           │    │
│  │  1. const input = this.state.input.trim()                           │    │
│  │  2. 验证输入非空                                                     │    │
│  │  3. 添加用户消息到 messages[]                                        │    │
│  │  4. 清空输入框                                                       │    │
│  │  5. 判断消息类型                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1.3: 消息类型路由                                              │    │
│  │                                                                      │    │
│  │  if (input.startsWith('/')) {                                       │    │
│  │      // 命令处理 (本地)                                              │    │
│  │      await this.handleCommand(input)                                │    │
│  │      // /sql, /jank, /anr, /slow, /memory, /clear 等                │    │
│  │  } else {                                                           │    │
│  │      // 自然语言处理 (发送到后端)                                     │    │
│  │      await this.handleChatMessage(input)                            │    │
│  │  }                                                                  │    │
│  │                                                                      │    │
│  │  位置: ai_panel.ts:1290-1345                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1.4: 调用后端 API                                              │    │
│  │                                                                      │    │
│  │  前置检查:                                                           │    │
│  │  - backendTraceId 必须存在 (trace 已上传到后端)                      │    │
│  │                                                                      │    │
│  │  API 调用:                                                          │    │
│  │  POST ${backendUrl}/api/agent/analyze                      │    │
│  │  {                                                                  │    │
│  │    traceId: "trace-abc123",                                         │    │
│  │    question: "分析这个 trace 的滑动性能问题",                         │    │
│  │    maxIterations: 10                                                │    │
│  │  }                                                                  │    │
│  │                                                                      │    │
│  │  响应:                                                              │    │
│  │  { analysisId: "session_1234567890_xyz", success: true }            │    │
│  │                                                                      │    │
│  │  位置: ai_panel.ts:2006-2083                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1.5: 建立 SSE 连接                                             │    │
│  │                                                                      │    │
│  │  await this.listenToSSE(analysisId)                                 │    │
│  │                                                                      │    │
│  │  GET ${backendUrl}/api/agent/${analysisId}/stream          │    │
│  │                                                                      │    │
│  │  开始监听服务器推送的事件...                                          │    │
│  │                                                                      │    │
│  │  位置: ai_panel.ts:2085-2150                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 2: API 路由处理 (Backend - traceAnalysisRoutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Phase 2: API 路由处理                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2.1: 接收分析请求                                              │    │
│  │                                                                      │    │
│  │  POST /api/agent/analyze                                   │    │
│  │                                                                      │    │
│  │  router.post('/analyze', async (req, res) => {                      │    │
│  │    const { traceId, question, maxIterations = 10 } = req.body       │    │
│  │    ...                                                              │    │
│  │  })                                                                 │    │
│  │                                                                      │    │
│  │  位置: traceAnalysisRoutes.ts:445-530                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2.2: 验证和初始化                                              │    │
│  │                                                                      │    │
│  │  1. 验证 traceId 和 question 非空                                    │    │
│  │  2. 获取服务实例 (懒加载)                                            │    │
│  │     const { traceProcessorService, sessionService, orchestrator }   │    │
│  │       = getServices()                                               │    │
│  │  3. 验证 trace 存在                                                  │    │
│  │     const trace = traceProcessorService.getTrace(traceId)           │    │
│  │                                                                      │    │
│  │  位置: traceAnalysisRoutes.ts:27-48                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2.3: 创建分析会话                                              │    │
│  │                                                                      │    │
│  │  sessionService.createSession({                                     │    │
│  │    traceId,                                                         │    │
│  │    question,                                                        │    │
│  │    userId: undefined,                                               │    │
│  │    maxIterations,                                                   │    │
│  │  })                                                                 │    │
│  │                                                                      │    │
│  │  会话存储在 AnalysisSessionService 的 sessions Map 中                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2.4: 启动后台分析                                              │    │
│  │                                                                      │    │
│  │  // 非阻塞启动                                                       │    │
│  │  orchestrator.startAnalysis(sessionId).catch(...)                   │    │
│  │                                                                      │    │
│  │  // 立即返回 analysisId                                              │    │
│  │  res.json({ success: true, analysisId: sessionId })                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2.5: SSE 流连接处理                                            │    │
│  │                                                                      │    │
│  │  GET /api/agent/:sessionId/stream                          │    │
│  │                                                                      │    │
│  │  router.get('/:sessionId/stream', (req, res) => {                   │    │
│  │    // 设置 SSE headers                                              │    │
│  │    res.setHeader('Content-Type', 'text/event-stream')               │    │
│  │    res.setHeader('Cache-Control', 'no-cache')                       │    │
│  │    res.setHeader('Connection', 'keep-alive')                        │    │
│  │                                                                      │    │
│  │    // 注册 SSE 监听器到 sessionService                               │    │
│  │    sessionService.registerSSEClient(sessionId, res)                 │    │
│  │  })                                                                 │    │
│  │                                                                      │    │
│  │  位置: traceAnalysisRoutes.ts:224-300                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 3: 分析循环执行 (PerfettoAnalysisOrchestrator)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Phase 3: 分析循环执行                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 3.1: 启动分析                                                  │    │
│  │                                                                      │    │
│  │  startAnalysis(sessionId)                                           │    │
│  │  位置: perfettoAnalysisOrchestrator.ts:165-204                      │    │
│  │                                                                      │    │
│  │  1. 获取会话信息                                                     │    │
│  │     const session = sessionService.getSession(sessionId)            │    │
│  │  2. 验证 trace 存在                                                  │    │
│  │     const trace = traceProcessor.getTrace(session.traceId)          │    │
│  │  3. 更新状态: GENERATING_SQL                                        │    │
│  │  4. 调用 runAnalysisLoop(sessionId)                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 3.2: 主分析循环                                                │    │
│  │                                                                      │    │
│  │  runAnalysisLoop(sessionId)                                         │    │
│  │  位置: perfettoAnalysisOrchestrator.ts:209-572                      │    │
│  │                                                                      │    │
│  │  while (iteration < maxIterations) {                                │    │
│  │    iteration++                                                      │    │
│  │                                                                      │    │
│  │    // Step 1: 生成 SQL                                              │    │
│  │    emit: { type: 'progress', step: 'generating_sql' }               │    │
│  │    const sqlResult = await generateSQL(sessionId, question)         │    │
│  │                                                                      │    │
│  │    // 如果是 Skill Engine 结果，直接处理并返回                        │    │
│  │    if (sqlResult.skillEngineResult) {                               │    │
│  │      → 处理分层结果 (L1/L2/L4)                                       │    │
│  │      → 发送 skill_layered_result 事件                                │    │
│  │      → 生成最终答案并返回                                            │    │
│  │    }                                                                │    │
│  │                                                                      │    │
│  │    // Step 2: 执行 SQL                                              │    │
│  │    emit: { type: 'progress', step: 'executing_sql' }                │    │
│  │    const queryResult = await executeSQL(sessionId, sql)             │    │
│  │                                                                      │    │
│  │    // Step 3: 检查错误 → 重试                                        │    │
│  │    if (queryResult.error) {                                         │    │
│  │      question = buildFixPrompt(sql, error)                          │    │
│  │      continue                                                       │    │
│  │    }                                                                │    │
│  │                                                                      │    │
│  │    // Step 4: 检查空结果 → 诊断并调整                                 │    │
│  │    if (queryResult.rowCount === 0) {                                │    │
│  │      question = buildAdjustPromptWithDiagnosis(...)                 │    │
│  │      continue                                                       │    │
│  │    }                                                                │    │
│  │                                                                      │    │
│  │    // Step 5: 收集成功结果                                           │    │
│  │    sessionService.addCollectedResult(sessionId, result)             │    │
│  │                                                                      │    │
│  │    // Step 6: 评估完整性                                             │    │
│  │    const evaluation = await evaluateResultCompleteness(...)         │    │
│  │    if (evaluation.completeness === COMPLETE) break                  │    │
│  │  }                                                                  │    │
│  │                                                                      │    │
│  │  // 生成最终答案                                                     │    │
│  │  const finalAnswer = await generateFinalAnswer(sessionId)           │    │
│  │  sessionService.completeSession(sessionId, finalAnswer)             │    │
│  │  emitCompleted(sessionId, finalAnswer, startTime)                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 4: SQL 生成策略

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Phase 4: SQL 生成策略                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 4.1: 多层次尝试                                                │    │
│  │                                                                      │    │
│  │  generateSQL(sessionId, question)                                   │    │
│  │  位置: perfettoAnalysisOrchestrator.ts:582-770                      │    │
│  │                                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │ 策略 1: Skill Engine (YAML Skills) - 仅首次迭代          │        │    │
│  │  │                                                          │        │    │
│  │  │ if (isFirstIteration) {                                  │        │    │
│  │  │   const skillId = skillAdapter.detectIntent(question)    │        │    │
│  │  │   if (skillId) {                                         │        │    │
│  │  │     const result = await skillAdapter.analyze({          │        │    │
│  │  │       traceId, skillId, question, packageName            │        │    │
│  │  │     })                                                   │        │    │
│  │  │     return { skillEngineResult: result }                 │        │    │
│  │  │   }                                                      │        │    │
│  │  │ }                                                        │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  │                              │                                       │    │
│  │                              ▼ (未匹配到 Skill)                      │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │ 策略 2: Legacy Perfetto SQL Skill                        │        │    │
│  │  │                                                          │        │    │
│  │  │ const perfettoResult = await perfettoSqlSkill.analyze({  │        │    │
│  │  │   traceId, question                                      │        │    │
│  │  │ })                                                       │        │    │
│  │  │ if (perfettoResult.sql) return { sql, explanation }      │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  │                              │                                       │    │
│  │                              ▼ (Legacy Skill 未命中)                 │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │ 策略 3: AI 生成 (DeepSeek/OpenAI)                        │        │    │
│  │  │                                                          │        │    │
│  │  │ const messages = buildSQLGenerationMessages(question)    │        │    │
│  │  │ const completion = await openai.chat.completions.create({│        │    │
│  │  │   model: getModelForQuestion(question),                  │        │    │
│  │  │   messages                                               │        │    │
│  │  │ })                                                       │        │    │
│  │  │ return parseSQLResponse(completion)                      │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  │                              │                                       │    │
│  │                              ▼ (AI 不可用)                           │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │ 策略 4: Mock SQL (关键词匹配)                            │        │    │
│  │  │                                                          │        │    │
│  │  │ return generateMockSQL(question)                         │        │    │
│  │  │ // jank → frame duration query                           │        │    │
│  │  │ // anr → long slice query                                │        │    │
│  │  │ // startup → start event query                           │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 5: Skills 执行 (SkillAnalysisAdapter)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Phase 5: Skills 执行                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5.1: 意图检测                                                  │    │
│  │                                                                      │    │
│  │  skillAdapter.detectIntent(question)                                │    │
│  │  位置: skillEngine/skillAnalysisAdapter.ts                          │    │
│  │                                                                      │    │
│  │  问题: "分析滑动性能"                                                │    │
│  │  匹配: scrolling_analysis                                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5.2: 加载 Skill 定义                                           │    │
│  │                                                                      │    │
│  │  从 skills/composite/scrolling_analysis.skill.yaml 加载              │    │
│  │                                                                      │    │
│  │  Skill 结构:                                                         │    │
│  │  {                                                                   │    │
│  │    name: "scrolling_analysis",                                       │    │
│  │    type: "composite",                                                │    │
│  │    steps: [                                                          │    │
│  │      { id: "vsync_config", sql: "...", display: { level: "summary" }}│    │
│  │      { id: "performance_summary", sql: "...", display: { level: "summary" }}│
│  │      { id: "scroll_sessions", sql: "...", display: { level: "list" }}│    │
│  │      ...                                                             │    │
│  │    ],                                                                │    │
│  │    diagnostics: [...]                                                │    │
│  │  }                                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5.3: 执行 Skill Steps                                          │    │
│  │                                                                      │    │
│  │  for (const step of skill.steps) {                                  │    │
│  │    // 替换变量                                                       │    │
│  │    const sql = substituteVariables(step.sql, context)               │    │
│  │                                                                      │    │
│  │    // 执行查询                                                       │    │
│  │    const result = await traceProcessor.query(traceId, sql)          │    │
│  │                                                                      │    │
│  │    // 按 level 组织结果                                              │    │
│  │    if (step.display.level === 'summary') {                          │    │
│  │      layers.L1[step.id] = result                                    │    │
│  │    } else if (step.display.level === 'list') {                      │    │
│  │      layers.L2[step.id] = result                                    │    │
│  │    } else if (step.display.level === 'deep') {                      │    │
│  │      layers.L4[step.id] = result                                    │    │
│  │    }                                                                │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5.4: 执行诊断规则                                              │    │
│  │                                                                      │    │
│  │  for (const diagnostic of skill.diagnostics) {                      │    │
│  │    const matched = evaluateCondition(diagnostic.condition, layers)  │    │
│  │    // e.g., "jank_rate > 0.1" → true                                │    │
│  │                                                                      │    │
│  │    if (matched) {                                                   │    │
│  │      diagnostics.push({                                             │    │
│  │        id: diagnostic.id,                                           │    │
│  │        severity: diagnostic.severity,  // 'critical'                │    │
│  │        message: diagnostic.message,                                 │    │
│  │        suggestions: diagnostic.suggestions                          │    │
│  │      })                                                             │    │
│  │    }                                                                │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5.5: 返回分层结果                                              │    │
│  │                                                                      │    │
│  │  return {                                                           │    │
│  │    skillId: "scrolling_analysis",                                   │    │
│  │    skillName: "滑动分析",                                            │    │
│  │    layeredResult: {                                                 │    │
│  │      layers: {                                                      │    │
│  │        L1: { vsync_config: {...}, performance_summary: {...} },     │    │
│  │        L2: { scroll_sessions: [...] },                              │    │
│  │        L4: { scroll_frames: [...] }                                 │    │
│  │      },                                                             │    │
│  │      defaultExpanded: ['L1', 'L2'],                                 │    │
│  │      metadata: { skillName, version, executedAt }                   │    │
│  │    },                                                               │    │
│  │    diagnostics: [...],                                              │    │
│  │    executionTimeMs: 1500                                            │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 6: SSE 事件流传输

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Phase 6: SSE 事件流传输                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  事件发射流程                                                        │    │
│  │                                                                      │    │
│  │  PerfettoAnalysisOrchestrator                                       │    │
│  │       │                                                             │    │
│  │       │ emitProgress / emitSkillLayeredResult / emitCompleted       │    │
│  │       ▼                                                             │    │
│  │  AnalysisSessionService.emitSSE(sessionId, event)                   │    │
│  │       │                                                             │    │
│  │       │ 遍历 sseClients                                             │    │
│  │       ▼                                                             │    │
│  │  res.write(`event: ${event.type}\n`)                                │    │
│  │  res.write(`data: ${JSON.stringify(event)}\n\n`)                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  SSE 事件时序示例                                                    │    │
│  │                                                                      │    │
│  │  Time    Event Type             Content                              │    │
│  │  ─────────────────────────────────────────────────────────────       │    │
│  │  T+0ms   progress               { step: 'generating_sql' }           │    │
│  │  T+500ms skill_layered_result   { layers: {L1, L2, L4}, ... }        │    │
│  │  T+600ms skill_diagnostics      { diagnostics: [...] }               │    │
│  │  T+1s    progress               { step: 'generating_answer' }        │    │
│  │  T+3s    analysis_completed     { answer, metrics, reportUrl }       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  主要事件类型                                                        │    │
│  │                                                                      │    │
│  │  | 事件类型            | 数据结构                    | 用途          │    │
│  │  |---------------------|----------------------------|---------------|    │
│  │  | progress            | {step, message}            | 进度更新      │    │
│  │  | sql_generated       | {stepNumber, sql}          | SQL 生成完成  │    │
│  │  | sql_executed        | {stepNumber, sql, result}  | SQL 执行完成  │    │
│  │  | skill_layered_result| {layers, metadata}         | Skill 分层结果│    │
│  │  | skill_diagnostics   | {diagnostics[]}            | 诊断结果      │    │
│  │  | skill_section       | {sectionId, columns, rows} | 单个数据段    │    │
│  │  | analysis_completed  | {answer, metrics, reportUrl}| 分析完成     │    │
│  │  | error               | {error, recoverable}       | 错误信息      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 7: 前端结果渲染

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Phase 7: 前端结果渲染                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 7.1: SSE 事件解析                                              │    │
│  │                                                                      │    │
│  │  listenToSSE(analysisId)                                            │    │
│  │  位置: ai_panel.ts:2085-2150                                        │    │
│  │                                                                      │    │
│  │  const reader = response.body.getReader()                           │    │
│  │  while (!done) {                                                    │    │
│  │    const { value, done: streamDone } = await reader.read()          │    │
│  │    const chunk = decoder.decode(value)                              │    │
│  │    // 解析 SSE 格式                                                  │    │
│  │    await handleSSEEvent(eventType, data)                            │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 7.2: 事件处理路由                                              │    │
│  │                                                                      │    │
│  │  handleSSEEvent(type, data)                                         │    │
│  │                                                                      │    │
│  │  switch (type) {                                                    │    │
│  │    case 'progress':                                                 │    │
│  │      this.updateProgressMessage(`⏳ ${data.message}`)               │    │
│  │      break                                                          │    │
│  │                                                                      │    │
│  │    case 'skill_layered_result':                                     │    │
│  │      this.handleSkillLayeredResult(data)                            │    │
│  │      // → 渲染 L1/L2/L4 层级组件                                    │    │
│  │      break                                                          │    │
│  │                                                                      │    │
│  │    case 'skill_diagnostics':                                        │    │
│  │      this.handleDiagnostics(data.diagnostics)                       │    │
│  │      break                                                          │    │
│  │                                                                      │    │
│  │    case 'analysis_completed':                                       │    │
│  │      this.handleAnalysisComplete(data)                              │    │
│  │      this.state.isLoading = false                                   │    │
│  │      break                                                          │    │
│  │                                                                      │    │
│  │    case 'error':                                                    │    │
│  │      this.addMessage({                                              │    │
│  │        role: 'assistant',                                           │    │
│  │        content: `❌ 错误: ${data.message}`                          │    │
│  │      })                                                             │    │
│  │      break                                                          │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 7.3: 分层结果渲染                                              │    │
│  │                                                                      │    │
│  │  skill_layered_result 事件触发渲染:                                  │    │
│  │                                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │  L1 概览层 (默认展开)                                    │        │    │
│  │  │  ┌─────────────────────────────────────────────┐        │        │    │
│  │  │  │ VSync 配置: 120Hz, 8.33ms                   │        │        │    │
│  │  │  └─────────────────────────────────────────────┘        │        │    │
│  │  │  ┌─────────────────────────────────────────────┐        │        │    │
│  │  │  │ 性能概览: 1000 帧, 卡顿率 15%, FPS 98       │        │        │    │
│  │  │  └─────────────────────────────────────────────┘        │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  │                                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │  L2 列表层 (点击展开)                                    │        │    │
│  │  │  ▶ 滑动会话列表 (5 个会话)                               │        │    │
│  │  │    └─ Session 1: 10:00-10:05, 200 帧, 卡顿 12%          │        │    │
│  │  │    └─ Session 2: 10:10-10:12, 150 帧, 卡顿 5%           │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  │                                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────┐        │    │
│  │  │  L4 深度层 (按需加载)                                    │        │    │
│  │  │  ▶ 卡顿帧详情                                           │        │    │
│  │  │    └─ Frame 42: 25ms, App 主线程阻塞                    │        │    │
│  │  │    └─ Frame 108: 32ms, GPU 渲染超时                     │        │    │
│  │  └─────────────────────────────────────────────────────────┘        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.x 实现补充（2026-02-11）

`skill_layered_result` 的前端处理链路已补齐以下契约：

- 统一从 `display.columns` / `columnDefinitions` 归一化列定义，按列定义顺序渲染。
- 对 `clickAction: navigate_range` 的列，若依赖 `durationColumn`，则对应时长列即使隐藏也保留原始值。
- 展示时长统一按 `ms` 格式化；时间跳转依赖的原始区间仍按 `ns` 传递。

相关实现：
- `backend/src/services/skillEngine/skillAnalysisAdapter.ts`
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`

## 3. 待整合的 MasterOrchestrator 功能

以下功能已在 MasterOrchestrator 中实现，但尚未集成到前端调用路径：

### 3.1 Hooks 系统

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Hooks 系统                                          │
│                                                                              │
│  位置: backend/src/agent/hooks/                                             │
│                                                                              │
│  事件类型:                                                                   │
│  - tool:use        工具调用前后                                             │
│  - subagent:start  SubAgent 开始执行                                        │
│  - subagent:complete  SubAgent 执行完成                                     │
│  - session:start   会话开始                                                 │
│  - session:end     会话结束                                                 │
│                                                                              │
│  用途:                                                                       │
│  - 性能监控                                                                  │
│  - 审计日志                                                                  │
│  - 请求拦截和修改                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Context 隔离

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Context 隔离                                          │
│                                                                              │
│  位置: backend/src/agent/context/                                           │
│                                                                              │
│  策略:                                                                       │
│  - PlannerPolicy: 只看 sessionId, traceId, intent                           │
│  - EvaluatorPolicy: 看 intent, plan, previousResults (摘要)                  │
│  - WorkerPolicy: 看 plan, traceProcessor, 相关依赖                          │
│                                                                              │
│  目的:                                                                       │
│  - 减少 token 浪费                                                          │
│  - 避免信息泄露                                                              │
│  - 提高 Agent 专注度                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Context 压缩

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Context 压缩                                          │
│                                                                              │
│  位置: backend/src/agent/compaction/                                        │
│                                                                              │
│  配置:                                                                       │
│  - maxContextTokens: 8000                                                   │
│  - compactionThreshold: 6000 (80%)                                          │
│  - preserveRecentCount: 3                                                   │
│  - strategy: 'sliding_window'                                               │
│                                                                              │
│  流程:                                                                       │
│  - 估算 token 数量                                                          │
│  - 超过阈值时压缩旧结果                                                      │
│  - 保留最近 N 个结果和 Critical Findings                                     │
│  - 生成历史摘要                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Session Fork

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Session Fork                                          │
│                                                                              │
│  位置: backend/src/agent/fork/                                              │
│                                                                              │
│  功能:                                                                       │
│  - forkFromCheckpoint: 从检查点分叉会话                                      │
│  - compareForks: 比较两个分叉的结果                                          │
│  - mergeFork: 合并分叉到父会话                                               │
│  - listForks: 列出会话树                                                     │
│                                                                              │
│  合并策略:                                                                   │
│  - replace: 完全替换父会话结果                                               │
│  - append: 追加到父会话结果                                                  │
│  - merge_findings: 只合并 Findings                                          │
│  - cherry_pick: 选择性合并                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 整合计划

### 目标

将 MasterOrchestrator 的增强功能集成到前端实际使用的 `/api/agent/analyze` 路径。

### 方案

**方案 A: 路由转发 (推荐)**

修改 `traceAnalysisRoutes.ts`，让 `/api/agent/analyze` 内部调用 `MasterOrchestrator`：

```typescript
// traceAnalysisRoutes.ts
router.post('/analyze', async (req, res) => {
  // 使用 MasterOrchestrator 而不是 PerfettoAnalysisOrchestrator
  const orchestrator = new MasterOrchestrator({...});
  const result = await orchestrator.handleQuery(question, traceId, options);
  // 转换结果格式以兼容现有前端
  broadcastResult(sessionId, convertToLegacyFormat(result));
});
```

**方案 B: 替换 Orchestrator**

直接将 `PerfettoAnalysisOrchestrator` 替换为 `MasterOrchestrator`，需要确保所有功能兼容。

---

## 附录: 关键数据结构

### 分析会话 (AnalysisSession)

```typescript
interface AnalysisSession {
  id: string;
  traceId: string;
  question: string;
  status: AnalysisState;
  currentIteration: number;
  maxIterations: number;
  collectedResults: CollectedResult[];
  messages: Message[];
  createdAt: Date;
  completedAt?: Date;
  answer?: string;
}
```

### Skill 分层结果

```typescript
interface LayeredResult {
  layers: {
    L1?: Record<string, StepResult>;  // 概览层
    L2?: Record<string, StepResult>;  // 列表层
    L3?: Record<string, Record<string, StepResult>>;  // 会话层
    L4?: Record<string, Record<string, StepResult>>;  // 深度层
  };
  defaultExpanded: string[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}
```

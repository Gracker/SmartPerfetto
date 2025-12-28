# SmartPerfetto AI Assistant Design

**Date**: 2025-12-26
**Last Updated**: 2025-12-28
**Status**: ✅ Implemented (Backend AI Architecture)

---

## 实现概述

原始设计采用本地 Ollama AI 方案，实际实现时改为**后端 AI 服务架构**：

| 原始设计 | 实际实现 |
|---------|---------|
| 本地 Ollama (localhost:11434) | DeepSeek API (后端) |
| 前端直接调用 AI | 前端通过 SSE 调用后端 API |
| 简单命令执行 | 多轮分析编排器 |
| 无进度反馈 | 实时 SSE 进度推送 |

**变更原因**：
- 本地 AI 模型质量不稳定
- 需要更强的分析能力
- 前后端职责更清晰

---

## 最终架构

```
┌─────────────────────────────────────────────────────────────┐
│                   Perfetto UI (Local)                       │
│                      http://localhost:10000                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┬──────────────────────────────────────┐    │
│  │   Timeline  │          AI Assistant Panel          │    │
│  │             │  ┌─────────────────────────────────┐ │    │
│  │   [Trace]   │  │ > 帮我分析 ANR 问题             │ │    │
│  │             │  │                                 │ │    │
│  │   [Panels]  │  │ ⏳ 🤔 正在生成查询...            │ │    │
│  │             │  │ ⏳ ⏳ 正在执行查询...            │ │    │
│  │             │  │ ⏳ 📊 正在分析结果...            │ │    │
│  │             │  │                                 │ │    │
│  │             │  │ 📝 [分析结果...]                │ │    │
│  │             │  └─────────────────────────────────┘ │    │
│  └─────────────┴──────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ POST /api/trace-analysis/start
                              │ SSE (进度事件)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend API Server                        │
│                      http://localhost:3000                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         PerfettoAnalysisOrchestrator                │   │
│  │                                                     │   │
│  │  runAnalysisLoop(question, traceId):               │   │
│  │    while (!isComplete && iterations < max):        │   │
│  │      1. emitProgress('生成查询...')                │   │
│  │      2. sql = generateSQL(question, context)       │   │
│  │      3. emitProgress('执行查询...')                │   │
│  │      4. result = executeSQL(sql, traceId)          │   │
│  │      5. emitProgress('分析结果...')                │   │
│  │      6. insight = analyzeResult(sql, result)       │   │
│  │      7. isComplete = shouldContinue(insight)       │   │
│  │    8. answer = generateFinalAnswer(allInsights)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌───────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │ TraceProcessor│  │ AnalysisSession  │  │  AI SDK    │ │
│  │   Service     │  │     Service      │  │ (DeepSeek) │ │
│  │               │  │                  │  │            │ │
│  │ - WASM引擎    │  │ - SSE推送        │  │ - SQL生成  │ │
│  │ - Trace管理   │  │ - 会话状态       │  │ - 结果分析 │ │
│  └───────────────┘  └──────────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心组件

### 1. PerfettoAnalysisOrchestrator

分析编排器，负责完整的分析闭环。

**职责**：
- 理解用户提问
- 生成 SQL 查询
- 执行查询并分析结果
- 判断是否需要继续查询
- 生成最终答案

**文件位置**：`backend/src/services/perfettoAnalysisOrchestrator.ts`

**关键方法**：
```typescript
async analyzeQuestion(traceId: string, question: string, sessionId: string): Promise<void>

private async runAnalysisLoop(
  question: string,
  traceId: string,
  sessionId: string
): Promise<void>

private async generateSQL(question: string): Promise<{sql: string, reasoning: string}>
private async executeSQL(sql: string, traceId: string): Promise<QueryResult>
private async analyzeQueryResult(sql: string, result: QueryResult): Promise<string>
private async evaluateResultCompleteness(insight: string): Promise<boolean>
private async generateFinalAnswer(insights: string[]): Promise<string>
```

### 2. TraceProcessorService

Trace 处理服务，管理 WASM TraceProcessor 实例。

**职责**：
- 管理 Trace 文件存储
- 创建/销毁 TraceProcessor 实例
- 执行 SQL 查询
- 单例模式确保全局唯一

**文件位置**：`backend/src/services/traceProcessorService.ts`

**关键方法**：
```typescript
async createProcessor(traceId: string): Promise<WasmBridgeProxy>
async executeQuery(traceId: string, sql: string): Promise<QueryResult>
async deleteProcessor(traceId: string): Promise<void>
```

### 3. AnalysisSessionService

会话管理服务，负责 SSE 推送。

**职责**：
- 管理分析会话状态
- SSE 事件推送
- 进度消息分发

**文件位置**：`backend/src/services/analysisSessionService.ts`

**SSE 事件类型**：
```typescript
// 进度事件
{
  type: 'progress',
  timestamp: number,
  data: {
    step: 'generating_sql' | 'executing_sql' | 'analyzing',
    message: '🤔 正在生成查询...'
  }
}

// 分析完成
{
  type: 'analysis_completed',
  timestamp: number,
  data: {
    answer: string
  }
}
```

### 4. AIPanel (Frontend)

前端 AI 面板组件。

**职责**：
- UI 显示
- 用户交互
- SSE 事件监听
- 进度展示

**文件位置**：`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`

**关键方法**：
```typescript
async handleChatMessage(message: string): Promise<void>
private async listenToSSE(analysisId: string): Promise<void>
private handleSSEEvent(eventType: string, data?: any): void
```

---

## 数据流

### 分析请求流程

```
1. 用户输入问题
   │
   ▼
2. 前端: handleChatMessage()
   │   检查 Trace 是否已上传
   │
   ▼
3. POST /api/trace-analysis/start
   │   { traceId, question }
   │
   ▼
4. 后端: analyzeQuestion()
   │   创建 SSE 会话
   │
   ▼
5. 分析循环
   │
   ├→ 生成 SQL (AI)
   │  emitProgress('🤔 正在生成查询...')
   │
   ├→ 执行 SQL (WASM)
   │  emitProgress('⏳ 正在执行查询...')
   │
   ├→ 分析结果 (AI)
   │  emitProgress('📊 正在分析结果...')
   │
   └→ 判断是否继续
      │
      ├→ 需要继续 → 下一轮
      │
      └→ 完成 → 生成最终答案
              emit('analysis_completed')
```

---

## AI Prompt 策略

### System Prompt

```
You are an expert in Android performance analysis using Perfetto.

Your task is to help users analyze Perfetto trace files by:
1. Generating SQL queries to answer specific questions
2. Analyzing query results to extract insights
3. Determining if more information is needed
4. Providing comprehensive final answers

Available tables:
- slice: Timing information for schedulable slices
- thread: Thread information
- process: Process information
- thread_track: Per-thread tracks
- sched: Kernel scheduling information

Focus on:
- ANR (Application Not Responding) detection
- Frame jank analysis
- Main thread blocking
- CPU usage patterns
- Memory allocations

When generating SQL:
- Use precise WHERE clauses
- Limit results when appropriate
- Join tables when needed
- Consider performance implications
```

### Context 注入

每次 AI 调用时注入的上下文：
- 用户原始问题
- 当前 Trace 的元数据（如果可用）
- 之前几轮的查询和分析结果
- 当前查询的 SQL 和结果

---

## 技术决策记录

### 1. 为什么选择后端 AI 而非本地 Ollama？

| 方面 | 本地 Ollama | 后端 DeepSeek |
|------|------------|--------------|
| 模型质量 | 不稳定 | 高质量 |
| 分析能力 | 有限 | 强大 |
| 部署复杂度 | 高 | 低 |
| 网络依赖 | 无 | 需要 |
| 成本 | 免费 | 按量计费 |

**决策**：选择后端 AI，优先保证分析质量。

### 2. 为什么使用 SSE 而非 WebSocket？

| 方面 | SSE | WebSocket |
|------|-----|-----------|
| 实现复杂度 | 低 | 中 |
| 单向通信 | ✅ | ❌ |
| 自动重连 | ✅ | 需要实现 |
| 浏览器支持 | 广泛 | 广泛 |

**决策**：SSE 足够满足单向进度推送需求。

### 3. 为什么需要多轮分析循环？

单次 SQL 查询往往无法完整回答复杂问题。例如：
- "分析 ANR 问题" 需要先找到长阻塞，再分析原因
- "统计 CPU 使用" 需要分进程、分线程统计

多轮循环让 AI 可以：
1. 先得到初步结果
2. 判断是否需要更多信息
3. 继续深入分析
4. 最终给出完整答案

---

## 实现状态

### ✅ 已完成

- [x] Perfetto UI AI 助手插件
- [x] 后端分析 API
- [x] TraceProcessor WASM 集成
- [x] 多轮分析编排器
- [x] SSE 实时进度推送
- [x] DeepSeek API 集成
- [x] 中文进度提示
- [x] 超时保护机制

### 🚧 进行中

- [ ] PerfettoSqlSkill SOP 完善

### 📋 待实现

- [ ] 预定义命令 (`/anr`, `/jank`, `/memory`)
- [ ] 分析结果可视化增强
- [ ] 会话历史持久化
- [ ] 多 AI 模型支持

---

## 相关文件

### 后端
- `backend/src/services/perfettoAnalysisOrchestrator.ts` - 分析编排器
- `backend/src/services/traceProcessorService.ts` - Trace 处理服务
- `backend/src/services/analysisSessionService.ts` - 会话管理
- `backend/src/services/perfettoSqlSkill.ts` - SQL 生成技能
- `backend/src/routes/traceAnalysisRoutes.ts` - 分析 API 路由
- `backend/src/routes/simpleTraceRoutes.ts` - Trace 上传路由

### 前端
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts` - 主面板
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/commands.ts` - 命令定义
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/plugin.ts` - 插件入口

### 类型定义
- `backend/src/types/analysis.ts` - 分析相关类型

---

## 参考资料

- [Perfetto Documentation](https://perfetto.dev/docs/)
- [Perfetto SQL Reference](https://perfetto.dev/docs/analysis/sql-queries)
- [DeepSeek API](https://platform.deepseek.com/docs)

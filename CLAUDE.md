# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Architecture Overview

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
                │                                     │
                └───────── HTTP RPC (9100-9900) ──────┘
                                  │
                    trace_processor_shell (Shared)
```

**Core Concepts:**
- Frontend/backend share `trace_processor_shell` via HTTP RPC
- Agent-Driven hypothesis analysis (假设驱动分析)
- Domain Agents collect evidence via SQL queries
- Analysis logic in YAML Skills (`backend/skills/`)
- Results layered: L1 (overview) → L2 (list) → L4 (deep)
- SSE for real-time streaming

---

## Backend Structure

### Agent System (v4.0 - Agent-Driven)

**Core:** `backend/src/agent/core/`
| Component | Purpose |
|-----------|---------|
| agentDrivenOrchestrator.ts | 主协调器，假设驱动多轮分析 |
| pipelineExecutor.ts | 流水线执行 (plan→execute→evaluate→refine→conclude) |
| circuitBreaker.ts | 熔断器，触发用户介入 |
| modelRouter.ts | 多模型路由 (DeepSeek/OpenAI/Anthropic/GLM) |
| stateMachine.ts | 状态机 (IDLE→PLANNING→HYPOTHESIS→ROUNDS→CONCLUSION) |

**Domain Agents:** `backend/src/agent/agents/domain/`
| Agent | Purpose |
|-------|---------|
| frameAgent.ts | 帧渲染分析 |
| cpuAgent.ts | CPU 调度与负载 |
| memoryAgent.ts | 内存分配与 GC |
| binderAgent.ts | IPC/Binder 事务 |
| additionalAgents.ts | Startup、Interaction、ANR、System |

**Planning & Strategy:** `backend/src/agent/agents/`
- plannerAgent.ts - 意图理解、任务分解
- evaluatorAgent.ts - 结果质量评估
- iterationStrategyPlanner.ts - 迭代策略决策（是否继续下一轮）

**Communication:** `backend/src/agent/communication/`
- agentMessageBus.ts - Agent 间消息总线

**Context & State:**
- `context/enhancedSessionContext.ts` - 多轮对话上下文
- `context/contextBuilder.ts` - 按角色过滤上下文（Planner/Evaluator/Worker Policy）
- `compaction/contextCompactor.ts` - Token 溢出防护（滑动窗口策略）
- `state/checkpointManager.ts` - 暂停/恢复
- `fork/forkManager.ts` - 会话分叉

**Experts:** `backend/src/agent/experts/`
- launchExpert.ts, interactionExpert.ts, systemExpert.ts
- `crossDomain/` - 跨域分析
  - baseCrossDomainExpert.ts - 跨域基类
  - hypothesisManager.ts - 假设生命周期管理
  - dialogueProtocol.ts - Agent 通信协议
  - experts/performanceExpert.ts - 性能综合分析

**Tools:** `backend/src/agent/tools/`
- sqlExecutor - SQL 查询执行
- frameAnalyzer - 帧分析
- skillInvoker - Skill 调用
- dataStats - 数据统计

**Detectors:** `backend/src/agent/detectors/`
- standardDetector.ts, composeDetector.ts, flutterDetector.ts, webviewDetector.ts

### Key Services

| Service | Location | Purpose |
|---------|----------|---------|
| TraceProcessorService | services/traceProcessorService.ts | HTTP RPC 查询 (端口池 9100-9900) |
| SkillExecutor | services/skillEngine/skillExecutor.ts | YAML Skill 引擎 |
| HTMLReportGenerator | services/htmlReportGenerator.ts | 报告生成 |
| SessionLogger | services/sessionLogger.ts | JSONL 会话日志 |
| AutoAnalysisService | services/autoAnalysisService.ts | 自动分析服务 |

---

## Data Flow

```
User Query → POST /api/agent/analyze → AgentDrivenOrchestrator
    │
    ├─ Round 1:
    │   ├─ LLM 理解意图 → 生成假设 (Hypotheses)
    │   ├─ 分派任务 → Domain Agents (Frame/CPU/Memory/Binder)
    │   ├─ Agents 执行 SQL → 收集 Evidence
    │   ├─ 综合 Findings (severity: critical/warning/info)
    │   └─ IterationStrategyPlanner → 评估置信度
    │
    ├─ Round N (if confidence < threshold):
    │   └─ 深入分析，补充证据
    │
    └─ Conclusion → analysis_completed SSE event
```

---

## Skill System

**Types:** atomic, composite, iterator, parallel, diagnostic, ai_decision, ai_summary, conditional, skill

**Layered Results:**
- **L1 (overview):** 聚合指标 - `display.level: overview/summary`
- **L2 (list):** 数据列表 - `display.level: list/detail` + expandableData
- **L4 (deep):** 详细分析 - `display.level: deep/frame`

**Skill Example:**
```yaml
name: scrolling_analysis
type: composite
steps:
  - id: summary
    sql: "SELECT COUNT(*) as total..."
    display: { level: overview, title: "概览" }
  - id: jank_frames
    sql: "SELECT frame_id, ts, dur..."
    display:
      level: list
      columns:
        - { name: ts, type: timestamp, clickAction: navigate_timeline }
        - { name: dur, type: duration, format: duration_ms }
```

**Location:** `backend/skills/` (atomic/, composite/, deep/)

---

## DataEnvelope (v2.0)

统一数据契约 - 数据自描述，前端按配置渲染。

```typescript
interface DataEnvelope<T> {
  meta: { type, version, source, skillId?, stepId? };
  data: T;  // { columns, rows, expandableData }
  display: { layer, format, title, columns?: ColumnDefinition[] };
}

interface ColumnDefinition {
  name: string;
  type: 'timestamp' | 'duration' | 'number' | 'string' | 'percentage' | 'bytes';
  format?: 'duration_ms' | 'timestamp_relative' | 'compact';
  clickAction?: 'navigate_timeline' | 'navigate_range' | 'copy';
}
```

**Type Generation:** `npm run generate:frontend-types` (auto-run by start-dev.sh)

---

## Frontend

**Plugin:** `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`
- ai_panel.ts - 主 UI
- sql_result_table.ts - 数据表格 (schema-driven)
- ai_service.ts - 后端通信

---

## API Endpoints

**Agent (唯一主链路):**
- `POST /api/agent/analyze` - 启动分析 (创建 AgentDrivenOrchestrator)
- `GET /api/agent/:sessionId/stream` - SSE 实时流
- `GET /api/agent/:sessionId/status` - 轮询状态
- `POST /api/agent/:sessionId/respond` - 响应断路器
- `POST /api/agent/scene-reconstruct` - 场景重建（独立功能）

**Logs:**
- `GET /api/agent/logs/:sessionId` - 会话日志
- `GET /api/agent/logs/:sessionId/errors` - 仅错误

**Trace:**
- `POST /api/traces/register-rpc` - 注册 RPC

---

## SSE Events (Agent-Driven)

| Event | Phase Mapping | Description |
|-------|---------------|-------------|
| progress | starting, understanding, concluding | 阶段进度 |
| hypothesis_generated | hypotheses_generated | 假设生成 |
| round_start | round_start | 新一轮开始 |
| agent_task_dispatched | tasks_dispatched | 任务批量分派 |
| agent_dialogue | task_dispatched | 单任务分派 |
| agent_response | task_completed | Agent 完成任务 |
| synthesis_complete | synthesis_complete | 综合结果 |
| strategy_decision | strategy_decision | 迭代策略决定 |
| analysis_completed | - | 分析完成 |
| error | - | 错误 |

---

## Session Management

- 路由层内存 `Map<sessionId, AnalysisSession>` 管理会话
- 每 30 分钟清理过期会话
- 支持多轮对话（复用 sessionId）
- AnalysisSession 包含: orchestrator, sseClients, result, hypotheses, agentDialogue

---

## Quick Start

```bash
./scripts/start-dev.sh  # Auto-builds trace_processor_shell
# Backend @ :3000, Frontend @ :10000
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty data | 检查 stepId 匹配 YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| Debug | 查看 `backend/logs/sessions/*.jsonl` |

---

## Environment

```bash
# backend/.env
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
```

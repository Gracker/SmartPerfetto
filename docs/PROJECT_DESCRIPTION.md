# SmartPerfetto Project Description

## Overview

**SmartPerfetto** is an AI-powered Android performance analysis platform that integrates with Google's Perfetto trace viewer to provide intelligent, automated diagnosis of performance issues in Android applications.

## Target Users

- **Android App Developers** - Diagnose jank, slow startup, ANR in their apps
- **Framework Engineers** - Analyze system-level performance (SurfaceFlinger, Binder, WMS)
- **Performance Optimization Specialists** - Deep dive into CPU scheduling, memory pressure, thermal throttling
- **Linux Kernel Engineers** - Investigate scheduler behavior, lock contention, I/O pressure

## Problem Statement

Perfetto traces contain millions of data points across dozens of subsystems. Manual analysis requires:
- Deep knowledge of Android internals
- Expertise in SQL query writing
- Understanding of what to look for in different scenarios
- Time-consuming correlation across multiple tracks

SmartPerfetto automates this process by:
1. Understanding user intent in natural language (Chinese/English)
2. Matching queries to pre-defined analysis strategies
3. Executing deterministic SQL pipelines or adaptive LLM-driven exploration
4. Presenting layered results from overview to deep diagnosis

## Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SmartPerfetto                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Frontend (Perfetto UI Plugin)                      │   │
│  │  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐   │   │
│  │  │  AI Panel   │  │ SQL Result Table│  │   SSE Event Handler    │   │   │
│  │  │  (Chat UI)  │  │ (Schema-driven) │  │  (Real-time updates)   │   │   │
│  │  └─────────────┘  └─────────────────┘  └─────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                              HTTP/SSE @ :10000                               │
│                                    │                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Backend (Express @ :3000)                        │   │
│  │                                                                        │   │
│  │  ┌────────────────────────────────────────────────────────────────┐   │   │
│  │  │                 Agent Orchestrator (v6.0)                       │   │   │
│  │  │  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐   │   │   │
│  │  │  │    Intent    │  │    Strategy     │  │   Circuit       │   │   │   │
│  │  │  │Understanding │  │    Registry     │  │   Breaker       │   │   │   │
│  │  │  └──────────────┘  └─────────────────┘  └──────────────────┘   │   │   │
│  │  │                                                                 │   │   │
│  │  │  ┌────────────────────────────────────────────────────────┐    │   │   │
│  │  │  │              Dual-Executor Pattern                      │    │   │   │
│  │  │  │  ┌──────────────────┐    ┌──────────────────────────┐  │    │   │   │
│  │  │  │  │StrategyExecutor  │    │  HypothesisExecutor      │  │    │   │   │
│  │  │  │  │(Deterministic)   │    │  (Adaptive LLM)          │  │    │   │   │
│  │  │  │  │                  │    │                          │  │    │   │   │
│  │  │  │  │ Stage 0: Discover│    │ Round 1: Hypothesis      │  │    │   │   │
│  │  │  │  │ Stage 1: Overview│    │ Round N: Refine          │  │    │   │   │
│  │  │  │  │ Stage 2: Detail  │    │ Conclude: Synthesize     │  │    │   │   │
│  │  │  │  └──────────────────┘    └──────────────────────────┘  │    │   │   │
│  │  │  │                                                         │    │   │   │
│  │  │  │  ┌──────────────────────────────────────────────────┐  │    │   │   │
│  │  │  │  │           Follow-up Executors                     │  │    │   │   │
│  │  │  │  │  Clarify | Compare | Extend | DrillDown          │  │    │   │   │
│  │  │  │  └──────────────────────────────────────────────────┘  │    │   │   │
│  │  │  └────────────────────────────────────────────────────────┘    │   │   │
│  │  └────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                        │   │
│  │  ┌────────────────────────────────────────────────────────────────┐   │   │
│  │  │                    Skill Engine (102 Skills)                    │   │   │
│  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │   │   │
│  │  │  │ Atomic  │ │Composite│ │  Deep   │ │ Module  │ │Pipeline │   │   │   │
│  │  │  │  (30)   │ │  (27)   │ │   (2)   │ │  (15)   │ │  (25)   │   │   │   │
│  │  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │   │   │
│  │  └────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                        │   │
│  │  ┌────────────────────────────────────────────────────────────────┐   │   │
│  │  │                     Domain Agents                               │   │   │
│  │  │    Frame | CPU | Memory | Binder | System | Startup | ANR      │   │   │
│  │  └────────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                           HTTP RPC @ 9100-9900                               │
│                                    │                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    trace_processor_shell                              │   │
│  │                    (Shared with Perfetto UI)                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

#### 1. Agent Orchestrator (v6.0 - Conversation-Aware)

The orchestrator is a thin coordination layer that:
- Parses user intent (Chinese/English natural language)
- Matches to pre-defined strategies (scrolling, startup, etc.)
- Routes to appropriate executor
- Manages multi-turn conversation context
- Handles circuit breaker interventions

**Key Innovation:** Dual-Executor Pattern
- **StrategyExecutor** - Deterministic multi-stage pipelines for common scenarios
- **HypothesisExecutor** - Adaptive LLM-driven exploration for edge cases

#### 2. Strategy System

Strategies encode domain expertise as deterministic pipelines:

**Scrolling Strategy (3 Stages):**
```
Stage 0 (Discovery):
  └─ scroll_session_analysis → Find janky scroll sessions

Stage 1 (Overview):
  └─ scrolling_analysis → FPS, frame drop stats per session

Stage 2 (Detail):
  └─ jank_frame_detail → Per-frame root cause analysis
     └─ [direct_skill mode: zero LLM overhead]
        ├─ cpu_load_in_range
        ├─ binder_blocking_in_range
        ├─ sched_latency_in_range
        └─ ... (12 range-based skills)
```

#### 3. Skill Engine

Skills are YAML-defined analysis units:

```yaml
name: scrolling_analysis
type: composite
description: Comprehensive scrolling performance analysis
inputs:
  - { name: package, type: string, required: false }
  - { name: start_ts, type: number, required: false }
  - { name: end_ts, type: number, required: false }
steps:
  - id: performance_summary
    sql: |
      WITH vsync_period AS (...),
           frame_stats AS (...),
           jank_classification AS (...)
      SELECT total_frames, jank_frames, fps_avg, ...
    display:
      level: overview
      title: "Performance Summary"

  - id: jank_frame_list
    sql: |
      SELECT frame_id, ts, dur_ms, jank_type, ...
    display:
      level: list
      columns:
        - { name: ts, type: timestamp, clickAction: navigate_timeline }
        - { name: dur_ms, type: duration, format: duration_ms }
```

**Skill Categories:**
- **Atomic (30)** - Single SQL query, deterministic
- **Composite (27)** - Multi-step analysis workflows
- **Deep (2)** - CPU/callstack profiling
- **Module (15)** - Framework/hardware/kernel expertise
- **Pipeline (25)** - Rendering pipeline definitions
- **Vendor (8)** - OEM-specific overrides

#### 4. Multi-Turn Conversation Support

**EntityStore** tracks entities across turns:
- Processes: `com.example.app`
- Threads: `RenderThread`, `main`
- Frames: `frame_id: 1436069`
- Intervals: `session_id: 5`

**Follow-up Executors:**
- **ClarifyExecutor** - Answer questions about previous results
- **ExtendExecutor** - Analyze more entities with same context
- **ComparisonExecutor** - Compare multiple frames/sessions
- **DrillDownResolver** - Navigate to specific timestamps

#### 5. Circuit Breaker

Protects against infinite loops and user intervention:
- State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
- Force-close: User can override (max 5 times, 30s cooldown)
- Timeout: 5 minutes for user response

### Data Flow

```
User Query: "分析滑动卡顿"
    │
    ▼
POST /api/agent/v1/analyze
    │
    ├─ Intent Understanding
    │   └─ Parse: intent=scrolling, followUpType=null
    │
    ├─ Strategy Matching
    │   └─ Match: scrollingStrategy (trigger: '滑动')
    │
    ├─ StrategyExecutor
    │   ├─ Stage 0: scroll_session_analysis
    │   │   └─ SQL → extract FocusIntervals (janky sessions)
    │   ├─ Stage 1: scrolling_analysis
    │   │   └─ SQL → FPS/frame stats
    │   └─ Stage 2: jank_frame_detail (per-interval)
    │       └─ DirectSkillExecutor (zero LLM)
    │           └─ 12 range-based skills per frame
    │
    ├─ Entity Capture
    │   └─ Populate EntityStore with frames/sessions
    │
    └─ Conclusion Generation
        └─ SSE: analysis_completed
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agent/v1/analyze` | POST | Start analysis |
| `/api/agent/v1/:sessionId/stream` | GET | SSE real-time stream |
| `/api/agent/v1/:sessionId/status` | GET | Poll status |
| `/api/agent/v1/:sessionId/respond` | POST | Circuit breaker response |
| `/api/traces/register-rpc` | POST | Register trace_processor |
| `/api/skills/*` | GET | Skill management |
| `/api/sessions/*` | GET | Session management |
| `/api/export/*` | POST | Result export |

### SSE Events

| Event | Description |
|-------|-------------|
| `progress` | Phase updates (starting, understanding, concluding) |
| `hypothesis_generated` | Initial hypotheses |
| `round_start` | New analysis round |
| `stage_start` | Strategy stage started |
| `agent_task_dispatched` | Task sent to agent |
| `agent_response` | Agent completed task |
| `synthesis_complete` | Findings synthesized |
| `analysis_completed` | Final results |
| `error` | Error occurred |

## Technology Stack

- **Backend:** Node.js, Express, TypeScript
- **Frontend:** Mithril.js (Perfetto UI framework)
- **Trace Processing:** trace_processor_shell (Perfetto)
- **LLM Integration:** DeepSeek, OpenAI, Anthropic, GLM (configurable)
- **Testing:** Jest, ts-jest
- **Build:** esbuild, npm scripts

## Getting Started

```bash
# Start development environment
./scripts/start-dev.sh

# Backend @ :3000, Frontend @ :10000
```

## Configuration

```bash
# backend/.env
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
```

## Project Structure

```
SmartPerfetto/
├── backend/
│   ├── src/
│   │   ├── agent/
│   │   │   ├── core/           # Orchestrator, executors
│   │   │   ├── agents/         # Domain agents
│   │   │   ├── strategies/     # Analysis strategies
│   │   │   ├── context/        # Session context, entity store
│   │   │   ├── decision/       # Decision trees
│   │   │   ├── detectors/      # Architecture detection
│   │   │   ├── experts/        # Cross-domain experts
│   │   │   └── tools/          # SQL executor, skill invoker
│   │   ├── services/
│   │   │   ├── skillEngine/    # Skill loader, executor
│   │   │   └── ...             # Other services
│   │   └── routes/             # API endpoints
│   ├── skills/
│   │   ├── atomic/             # Single-step skills
│   │   ├── composite/          # Multi-step skills
│   │   ├── deep/               # Profiling skills
│   │   ├── modules/            # Expert modules
│   │   ├── pipelines/          # Rendering pipelines
│   │   └── vendors/            # OEM overrides
│   └── tests/
├── perfetto/                   # Perfetto UI submodule
│   └── ui/src/plugins/
│       └── com.smartperfetto.AIAssistant/
└── docs/
    └── plans/                  # Implementation plans
```

## Key Design Decisions

1. **Dual-Executor Pattern** - Balance determinism (strategies) with flexibility (hypotheses)
2. **Direct Skill Mode** - Zero LLM overhead for range-based SQL queries
3. **Entity Tracking** - Cross-turn continuity for multi-round conversations
4. **Layered Results** - L1 (overview) → L2 (list) → L3 (session) → L4 (deep)
5. **DataEnvelope Contract** - Schema-driven rendering in frontend

## Future Roadmap

1. **Memory Pressure Analysis** - PSI metrics, kswapd activity
2. **GPU Power State Tracking** - DVFS effectiveness
3. **Thermal Prediction** - Throttling forecasting
4. **Enhanced Test Coverage** - Target 70%+
5. **Performance Benchmarks** - Skill execution metrics

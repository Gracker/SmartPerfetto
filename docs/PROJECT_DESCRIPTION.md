# SmartPerfetto Project Description

## Overview

**SmartPerfetto** is an AI-powered Android performance analysis platform that integrates with Google's Perfetto trace viewer. It uses Claude Agent SDK to automatically analyze performance traces, identify root causes of jank/ANR/startup issues, and provide actionable optimization suggestions with evidence-backed reasoning.

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

LLMs alone cannot solve this because:
1. **Data scale** — Traces are 50-500MB binary protobuf; far exceeds any context window
2. **Precision** — LLMs hallucinate numbers; performance analysis requires exact P50/P90/P99 statistics
3. **Structured methodology** — Root cause analysis requires multi-phase, cross-subsystem reasoning
4. **Reliability** — Same trace should produce consistent conclusions

SmartPerfetto solves this by giving Claude precise "instruments" (SQL queries via trace_processor) and structured "methodology" (scene-specific strategies), letting the LLM focus on reasoning and synthesis.

## Architecture

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
        │                                            │
        └──────── HTTP RPC (9100-9900) ──────────────┘
                           │
             trace_processor_shell (Shared)
```

### Core Components

| Component | Purpose |
|-----------|---------|
| **ClaudeRuntime** | Main orchestrator: scene classification → dynamic system prompt → Claude Agent SDK → verification |
| **MCP Server** | 18 tools bridging Claude to trace data (SQL, Skills, schema lookup, planning, hypothesis) |
| **Skill Engine** | 140 YAML-defined analysis pipelines producing layered results (L1 overview → L4 deep root cause) |
| **Scene Classifier** | Keyword-based routing (<1ms) to 12 scene-specific strategies |
| **Verifier** | 4-layer quality check (heuristic + plan + hypothesis + LLM) with reflection retry |
| **Artifact Store** | Caches skill results as compact references (~3000 tokens saved per invocation) |
| **SQL Summarizer** | Compresses SQL results to stats + samples (~85% token savings) |

### Data Flow

```
User Query: "分析滑动卡顿"
    │
    ├─ Scene Classification → "scrolling" (<1ms, keyword-based)
    ├─ System Prompt Assembly → role + methodology + scrolling strategy + output format
    │
    ├─ Claude Agent SDK (autonomous MCP tool calls)
    │   ├─ submit_plan → structured 3-phase analysis plan
    │   ├─ invoke_skill("scrolling_analysis") → L1 overview + L2 frame list
    │   ├─ invoke_skill("jank_frame_detail") → L3 per-frame diagnosis
    │   ├─ execute_sql → supplementary queries
    │   ├─ lookup_knowledge("cpu-scheduler") → background knowledge
    │   └─ submit_hypothesis → resolve_hypothesis → evidence-driven conclusions
    │
    ├─ 4-Layer Verification → evidence check, plan adherence, hypothesis resolution
    │
    └─ Structured Report → findings + causal chains (Mermaid) + optimization suggestions
        └─ SSE streaming → Frontend real-time display
```

### Skill Categories (140 total)

| Category | Count | Description |
|----------|-------|-------------|
| **Atomic** | 80 | Single SQL query (VSync detection, CPU topology, GPU metrics, ...) |
| **Composite** | 28 | Multi-step analysis (scrolling, startup, ANR, memory, ...) |
| **Pipeline** | 30 | Rendering pipeline detection + teaching (30 Android render architectures) |
| **Deep** | 2 | CPU profiling, callstack analysis |

### MCP Tools (18)

**Core Data Access (8, always available):**
execute_sql, invoke_skill, list_skills, detect_architecture, lookup_sql_schema, query_perfetto_source, list_stdlib_modules, lookup_knowledge

**Planning & Hypothesis (8, conditional):**
submit_plan, update_plan_phase, revise_plan, submit_hypothesis, resolve_hypothesis, write_analysis_note, fetch_artifact, flag_uncertainty

**Memory & Patterns (2):**
recall_patterns, learned misdiagnosis pattern system

## Technology Stack

- **Backend:** Node.js, Express, TypeScript (strict)
- **Frontend:** Mithril.js (Perfetto UI framework)
- **AI Runtime:** Claude Agent SDK (Anthropic) via MCP protocol
- **Trace Processing:** trace_processor_shell (Perfetto, WASM + HTTP RPC)
- **Testing:** Jest, ts-jest (44 test files, 1029 tests)
- **Build:** esbuild, npm scripts

## Key Design Decisions

1. **Content-driven, not code-driven** — Analysis strategies in `.strategy.md`, skills in `.skill.yaml`; new scenarios = new files, zero code changes
2. **Claude as autonomous orchestrator** — Claude decides which tools to call, not hardcoded pipelines
3. **Evidence-first verification** — 4-layer check ensures every CRITICAL finding has data backing
4. **Layered results (L1-L4)** — Progressive detail from overview to per-frame root cause
5. **DataEnvelope v2.0** — Schema-driven rendering; frontend auto-renders 140 skills without per-skill UI code
6. **Token engineering** — Artifact store + SQL summarizer + progressive prompt dropping keeps context efficient

## Getting Started

```bash
# Configure
cp backend/.env.example backend/.env
# Edit with your Anthropic API key

# Start
./scripts/start-dev.sh
# Backend @ :3000, Frontend @ :10000
```

For detailed technical documentation, see [docs/technical-architecture.md](technical-architecture.md).

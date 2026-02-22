# SmartPerfetto Comprehensive Project Review

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete architectural review, identify issues, create state machine diagrams, review skills from Android/Linux expert perspective, simplify code, and enhance test coverage.

**Architecture:** AI-driven Perfetto trace analysis platform with dual-executor pattern (Strategy-Driven deterministic + Hypothesis-Driven adaptive), YAML-based skill system, and multi-turn conversation support.

**Tech Stack:** TypeScript/Node.js backend (Express), Perfetto trace_processor_shell (HTTP RPC), YAML skills, Jest testing, SSE streaming

---

## Executive Summary

### Project Overview

**SmartPerfetto** is an AI-powered Android performance analysis platform that:
- Integrates with Google's Perfetto trace viewer
- Executes SQL queries against trace_processor_shell via HTTP RPC
- Uses LLM-powered analysis with deterministic fallbacks
- Supports multi-turn conversations with entity tracking
- Provides layered results (L1 overview → L4 deep analysis)

### Architecture Highlights

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SmartPerfetto                                │
├─────────────────────────────────────────────────────────────────────┤
│  Frontend (Perfetto UI Plugin @ :10000)                              │
│    └─ AI Panel, SQL Result Table, SSE Client                        │
├─────────────────────────────────────────────────────────────────────┤
│  Backend (Express @ :3000)                                           │
│    ├─ Agent Orchestrator (v6.0 Conversation-Aware)                  │
│    │    ├─ Intent Understanding + Hypothesis Generation             │
│    │    ├─ Strategy Registry (scrolling, launch, etc.)              │
│    │    └─ Dual-Executor Pattern                                    │
│    │         ├─ StrategyExecutor (deterministic pipelines)          │
│    │         └─ HypothesisExecutor (adaptive LLM loops)             │
│    ├─ Skill Engine (102 YAML skills)                                │
│    │    ├─ Atomic (30) - single SQL queries                         │
│    │    ├─ Composite (27) - multi-step analysis                     │
│    │    ├─ Deep (2) - CPU/callstack profiling                       │
│    │    ├─ Module (15) - framework/hardware/kernel experts          │
│    │    ├─ Pipeline (25) - rendering pipeline definitions           │
│    │    └─ Vendor (8) - OEM-specific overrides                      │
│    └─ Domain Agents (Frame, CPU, Memory, Binder)                    │
├─────────────────────────────────────────────────────────────────────┤
│  trace_processor_shell (HTTP RPC @ 9100-9900)                        │
│    └─ Shared instance with Perfetto UI                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Findings Summary

| Category | Status | Critical Issues |
|----------|--------|-----------------|
| Architecture | ✅ Well-designed | Clean executor interface, good separation |
| Skills System | ⚠️ Needs optimization | SQL performance, code duplication |
| Test Coverage | ❌ Insufficient | ~30-35% coverage, missing orchestration tests |
| Hardcoded Values | ⚠️ Several found | VSync periods, jank thresholds, limits |
| Documentation | ✅ Good | CLAUDE.md is comprehensive |

---

## Part 1: Architectural Analysis

### 1.1 Core Components

#### AgentRuntime
**File:** `backend/src/agentv2/runtime/agentRuntime.ts`

**Responsibilities:**
- Thin coordination layer delegating to specialized executors
- Multi-turn conversation context management
- Executor routing (Strategy → Hypothesis → Follow-up)
- Single write-back point for EntityStore

**Issues Found:**
1. Entity type check is hardcoded for only 2 types (frame, session) - Line ~165
2. No validation that referenced entities actually exist

#### Strategy System
**Files:** `backend/src/agent/strategies/`

**Scrolling Strategy (3-Stage Pipeline):**
```
Stage 0 (overview) → scroll_session_analysis → extract janky sessions
Stage 1 (session_overview) → scrolling_analysis → FPS/frame stats
Stage 2 (per_interval) → jank_frame_detail → per-frame deep dive
```

**Issues Found:**
1. **CRITICAL:** Hardcoded 33ms vsync fallback (Line 262) - wrong for 90Hz/120Hz
2. BigInt arithmetic silently fails in try-catch (Lines 135-137)
3. `toFiniteNumber()` silently converts NaN to 0

#### Executor System

| Executor | Mode | Issues |
|----------|------|--------|
| StrategyExecutor | Deterministic | Expandable data binding assumes frame_id column exists |
| HypothesisExecutor | Adaptive LLM | Strategy decision validation missing |
| DirectSkillExecutor | Zero LLM | Parameter mapping fallback logic complex |
| ClarifyExecutor | Read-only | No issues found |
| ComparisonExecutor | Multi-entity | No issues found |
| ExtendExecutor | Incremental | No issues found |

### 1.2 Hardcoded Values Inventory

| Location | Value | Impact | Recommendation |
|----------|-------|--------|----------------|
| scrollingStrategy.ts:262 | 33ms vsync | Wrong on 90/120Hz | Detect from trace or config |
| frameAgent.ts:120-121 | Jank thresholds (15%/5%) | No device customization | Make configurable |
| circuitBreaker.ts:45-57 | Force-close limits (5/30s/5min) | Not tunable | Move to config |
| directSkillExecutor.ts:38 | Concurrency limit (6) | Fixed | Make configurable |

### 1.3 Missing Features

1. **Memory Pressure Detection** - No PSI metrics, kswapd analysis
2. **GPU Power State Analysis** - Missing DVFS effectiveness metrics
3. **Thread Affinity Violation** - Can't detect CPU pinning failures
4. **Frame Pipeline Variance** - No anomalous frame path detection
5. **Thermal Prediction** - Can't predict throttling activation

---

## Part 2: State Machine Diagrams

### 2.1 Agent Orchestration State Machine

```
                              ┌─────────────────┐
                              │      IDLE       │
                              └────────┬────────┘
                                       │ analyze()
                                       ▼
                              ┌─────────────────┐
                              │   UNDERSTANDING │
                              │   (Intent Parse)│
                              └────────┬────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │                                      │
                    ▼                                      ▼
          ┌─────────────────┐                    ┌─────────────────┐
          │ FOLLOW_UP_ROUTE │                    │    PLANNING     │
          │ (clarify/extend │                    │ (Hypothesis Gen)│
          │  /compare/drill)│                    └────────┬────────┘
          └────────┬────────┘                             │
                   │                                      │
                   │                    ┌─────────────────┴────────────────┐
                   │                    │                                   │
                   │                    ▼                                   ▼
                   │          ┌─────────────────┐              ┌─────────────────┐
                   │          │ STRATEGY_EXEC   │              │ HYPOTHESIS_EXEC │
                   │          │ (Multi-stage)   │              │ (Multi-round)   │
                   │          └────────┬────────┘              └────────┬────────┘
                   │                   │                                │
                   │                   │         ┌───────────┐          │
                   │                   └────────►│  ROUNDS   │◄─────────┘
                   │                             │ (Execute) │
                   │                             └─────┬─────┘
                   │                                   │
                   │        ┌──────────────────────────┼──────────────────────────┐
                   │        │                          │                          │
                   │        ▼                          ▼                          ▼
                   │  ┌───────────┐            ┌─────────────┐           ┌─────────────┐
                   │  │ CONTINUE  │            │  DEEP_DIVE  │           │    PIVOT    │
                   │  │ (iterate) │            │  (focus)    │           │ (redirect)  │
                   │  └─────┬─────┘            └──────┬──────┘           └──────┬──────┘
                   │        │                         │                         │
                   │        └─────────────────────────┼─────────────────────────┘
                   │                                  │
                   │                                  ▼
                   │                         ┌─────────────────┐
                   │                         │   CONCLUDING    │
                   │                         │ (Synthesis)     │
                   │                         └────────┬────────┘
                   │                                  │
                   └──────────────────────────────────┼───────────────────────────
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │   COMPLETED     │
                                             │ (analysis_done) │
                                             └─────────────────┘
```

### 2.2 Circuit Breaker State Machine

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    ▼                                             │
            ┌─────────────┐                                       │
            │   CLOSED    │◄──────────────────────────────────────┤
            │  (Normal)   │                                       │
            └──────┬──────┘                                       │
                   │                                              │
                   │ failure_count >= threshold                   │
                   ▼                                              │
            ┌─────────────┐                                       │
            │    OPEN     │                                       │
            │  (Blocked)  │───────────────────────────────────────┤
            └──────┬──────┘                                       │
                   │                                              │
                   │ cooldown_elapsed                             │
                   ▼                                              │
            ┌─────────────┐      success_count >= 3               │
            │  HALF_OPEN  │───────────────────────────────────────┘
            │  (Testing)  │
            └──────┬──────┘
                   │
                   │ failure
                   ▼
            ┌─────────────┐
            │    OPEN     │
            │  (Re-block) │
            └─────────────┘

Force Close Path (User Intervention):
  OPEN ───[user_force_close]──► CLOSED
  (max 5 times per session, 30s cooldown)
```

### 2.3 Strategy Executor Pipeline

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        StrategyExecutor Pipeline                          │
└──────────────────────────────────────────────────────────────────────────┘

                         prebuiltIntervals?
                               │
              ┌────────────────┴────────────────┐
              │ YES                             │ NO
              ▼                                 ▼
      Skip Discovery              ┌─────────────────────┐
      (Stage 0/1)                 │    STAGE 0          │
              │                   │   (Discovery)       │
              │                   │  scroll_session     │
              │                   │   _analysis         │
              │                   └──────────┬──────────┘
              │                              │
              │                    extractIntervals()
              │                              │
              │                              ▼
              │                   ┌─────────────────────┐
              │                   │    STAGE 1          │
              │                   │ (Session Overview)  │
              │                   │ scrolling_analysis  │
              │                   └──────────┬──────────┘
              │                              │
              │                    extractFrameIntervals()
              │                              │
              └──────────────────────────────┤
                                             │
                                             ▼
                                  ┌─────────────────────┐
                                  │    STAGE 2          │
                                  │  (Per-Interval)     │
                                  │ jank_frame_detail   │
                                  │ [direct_skill mode] │
                                  └──────────┬──────────┘
                                             │
                            For each FocusInterval:
                            ├─ cpu_load_in_range
                            ├─ binder_blocking_in_range
                            ├─ sched_latency_in_range
                            └─ ... (12 range skills)
                                             │
                                             ▼
                                  ┌─────────────────────┐
                                  │   CONCLUSION        │
                                  │ (Generate Summary)  │
                                  └─────────────────────┘
```

### 2.4 Multi-Turn Conversation Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                    Multi-Turn Conversation State                        │
└────────────────────────────────────────────────────────────────────────┘

Turn 1: "分析滑动卡顿"
    │
    ▼
┌─────────────────┐
│  Initial Query  │
│  StrategyExec   │───► EntityStore populated with:
└─────────────────┘     - scroll_sessions (from Stage 0)
                        - jank_frames (from Stage 1)
                        - FocusIntervals (extracted)

Turn 2: "分析第3帧" or Click frame_id in table
    │
    ▼
┌─────────────────┐     Resolution Priority:
│  DrillDown      │     1. Explicit params (UI payload)
│  Resolution     │     2. EntityStore cache hit ◄── Skip re-query!
└─────────────────┘     3. Finding details
    │                   4. SQL enrichment
    ▼                   5. Ask user (fallback)
┌─────────────────┐
│DirectDrillDown  │───► Per-frame deep analysis
│   Executor      │     (zero LLM overhead)
└─────────────────┘

Turn 3: "继续分析 CPU 调度"
    │
    ▼
┌─────────────────┐
│  ExtendExecutor │───► Reuse FocusIntervals
└─────────────────┘     Add cpu_analysis skill
                        Mark new analyzed entities

Turn 4: "对比第2帧和第5帧"
    │
    ▼
┌─────────────────┐
│ComparisonExec   │───► Resolve both entities
└─────────────────┘     Run drill-down for each
                        Generate diff report
```

---

## Part 3: Skills Review (Android/Linux Expert Perspective)

### 3.1 Current Skill Coverage Assessment

**Well-Covered Areas:**
- ✅ Frame rendering pipeline (app_frame_production, consumer_jank_detection)
- ✅ CPU scheduling (scheduling_analysis, cpu_load_in_range)
- ✅ Binder IPC (binder_analysis, binder_blocking_in_range)
- ✅ Memory/GC (gc_analysis, lmk_analysis)
- ✅ SurfaceFlinger composition (sf_composition_in_range)

**Gaps Identified:**

| Missing Skill | Priority | Use Case | Status (2026-02-22) |
|---------------|----------|----------|-----------------------|
| memory_pressure_in_range | HIGH | PSI metrics, kswapd activity | Implemented (`backend/skills/atomic/memory_pressure_in_range.skill.yaml`) |
| gpu_power_state_analysis | HIGH | GPU DVFS, power domain transitions | Implemented (`backend/skills/atomic/gpu_power_state_analysis.skill.yaml`) |
| thread_affinity_violation | MEDIUM | CPU pinning failures | Implemented (`backend/skills/atomic/thread_affinity_violation.skill.yaml`) |
| frame_pipeline_variance | MEDIUM | Anomalous frame path detection | Implemented (`backend/skills/atomic/frame_pipeline_variance.skill.yaml`) |
| thermal_predictor | MEDIUM | Throttling prediction | Implemented (`backend/skills/atomic/thermal_predictor.skill.yaml`) |
| futex_wait_distribution | LOW | Futex vs mutex patterns | Implemented (`backend/skills/atomic/futex_wait_distribution.skill.yaml`) |
| cache_miss_impact | LOW | L3 cache efficiency | Implemented (`backend/skills/atomic/cache_miss_impact.skill.yaml`) |

### 3.2 SQL Performance Issues

**Critical Issues:**

1. **Large LIMIT without filtering** (10 files)
   ```yaml
   # rendering_pipeline_detection.skill.yaml
   LIMIT 10000  # May load excessive data
   ```
   **Fix:** Add pre-filtering by timestamp range

2. **O(N) subqueries in SELECT** (17 occurrences)
   ```sql
   -- Current (slow)
   SELECT (SELECT buffer_count FROM buffer_events b
           WHERE b.ts <= v.vsync_ts ORDER BY b.ts DESC LIMIT 1)

   -- Better (use window function)
   SELECT LAG(buffer_count) OVER (ORDER BY ts)
   ```

3. **VSync detection duplicated 4+ times**
   - scrolling_analysis.skill.yaml (4 times)
   - jank_frame_detail.skill.yaml
   **Fix:** Extract to reusable `vsync_period_detection` atomic skill

4. **50+ CTEs in single query** (scrolling_analysis)
   - Risk of query planner timeout
   - **Fix:** Split into staged queries, materialize intermediates

### 3.3 Recommended New Skills

```yaml
# 1. memory_pressure_in_range.skill.yaml
name: memory_pressure_in_range
type: atomic
description: Analyze PSI memory pressure and reclaim activity
inputs:
  - { name: start_ts, type: number, required: true }
  - { name: end_ts, type: number, required: true }
steps:
  - id: psi_analysis
    sql: |
      SELECT
        ts,
        CAST(value AS REAL) / 1000000 as pressure_percent,
        track.name as pressure_type
      FROM counter c
      JOIN counter_track track ON c.track_id = track.id
      WHERE track.name LIKE 'mem.%psi%'
        AND ts >= ${start_ts} AND ts <= ${end_ts}
      ORDER BY ts

# 2. thread_affinity_violation.skill.yaml
name: thread_affinity_violation
type: atomic
description: Detect threads running on unexpected CPU clusters
inputs:
  - { name: start_ts, type: number, required: true }
  - { name: end_ts, type: number, required: true }
  - { name: thread_name, type: string, required: true }
steps:
  - id: affinity_violations
    sql: |
      WITH cpu_clusters AS (
        -- Detect big/little from max frequency
        SELECT cpu,
          CASE WHEN max_freq >= (SELECT MAX(max_freq) * 0.75 FROM ...)
               THEN 'big' ELSE 'little' END as cluster
        FROM cpu_freq_view
      )
      SELECT s.ts, s.dur, s.cpu, cc.cluster,
        t.name as thread_name
      FROM sched_slice s
      JOIN thread t ON s.utid = t.id
      JOIN cpu_clusters cc ON s.cpu = cc.cpu
      WHERE t.name LIKE '%${thread_name}%'
        AND s.ts >= ${start_ts} AND s.ts <= ${end_ts}
        -- RenderThread should be on big cores
        AND (t.name LIKE '%RenderThread%' AND cc.cluster = 'little')
```

### 3.4 Skill System Improvements

| Improvement | Effort | Impact |
|-------------|--------|--------|
| Extract VSync detection to atomic skill | Low | Reduce duplication |
| Add parameter validation at YAML load | Medium | Catch errors early |
| Implement skill composition macros | High | Enable DRY patterns |
| Add SQL query plan analysis | Medium | Detect slow queries |
| Create skill dependency graph | Low | Visualize relationships |

---

## Part 4: Test Coverage Enhancement Plan

### 4.1 Current State

- **Total Test Files:** 18
- **Lines of Test Code:** ~16,700
- **Estimated Coverage:** 30-35%
- **Critical Gaps:** Orchestration, Routes, Domain Agents

### 4.2 Priority Test Additions

**Priority 1 (Critical - Orchestration Flow):**

```typescript
// tests/integration/orchestration.test.ts
describe('AgentRuntime', () => {
  describe('Strategy Matching', () => {
    it('should route scrolling query to StrategyExecutor');
    it('should route unknown query to HypothesisExecutor');
    it('should handle follow-up drill-down via DirectDrillDownExecutor');
  });

  describe('Multi-Turn Conversation', () => {
    it('should cache entities across turns');
    it('should resolve drill-down from EntityStore cache');
    it('should extend analysis with previous FocusIntervals');
  });
});
```

**Priority 2 (API Routes):**

```typescript
// tests/integration/agentRoutes.full.test.ts
describe('POST /api/agent/analyze', () => {
  it('should stream SSE events for scrolling analysis');
  it('should handle circuit breaker intervention');
  it('should return proper error for invalid trace');
});
```

**Priority 3 (Domain Agents):**

```typescript
// tests/unit/frameAgent.test.ts
describe('FrameAgent', () => {
  it('should execute jank_frame_detail skill');
  it('should generate correct severity based on jank rate');
  it('should handle missing frame data gracefully');
});
```

### 4.3 Test Infrastructure Improvements

1. **Add E2E test with sample trace file**
2. **Create mock TraceProcessorService for unit tests**
3. **Add performance benchmarks for skill execution**
4. **Implement coverage threshold enforcement (target: 70%)**

---

## Part 5: Code Simplification Targets

### 5.1 Files to Simplify

| File | Lines | Issue | Action |
|------|-------|-------|--------|
| scrollingStrategy.ts | 486 | Complex interval extraction | Extract to helper module |
| strategyExecutor.ts | 700+ | Expandable data binding complex | Split into separate class |
| skillExecutor.ts | 28,993 bytes | Monolithic | Extract step executors |
| agentRoutes.ts | 1979 | Route handlers too large | Extract to controllers |

### 5.2 Refactoring Patterns

1. **Extract VSync Detection**
   - Current: Duplicated in 4+ files
   - Target: Single `vsyncPeriodDetector.ts` module

2. **Interval Extraction**
   - Current: Inline in scrollingStrategy.ts
   - Target: `intervalExtractor.ts` with unit tests

3. **Parameter Mapping**
   - Current: Complex fallback logic in directSkillExecutor
   - Target: `parameterMapper.ts` with clear cascade

---

## Part 6: Implementation Tasks

### Task 1: Fix Hardcoded VSync Period

**Files:**
- Modify: `backend/src/agent/strategies/scrollingStrategy.ts:262`

**Step 1: Add VSync period inference**
```typescript
// Add to helpers.ts
export function inferVsyncPeriodNs(traceContext: any): bigint {
  // Try from detected refresh rate
  const vsyncNs = traceContext.detectedVsyncPeriodNs;
  if (vsyncNs && vsyncNs > 0n) return vsyncNs;

  // Fallback to device config
  const refreshRate = traceContext.deviceRefreshRate || 60;
  return BigInt(Math.round(1_000_000_000 / refreshRate));
}
```

**Step 2: Replace hardcoded value**
```typescript
// Before
const estimatedEndTs = startTs + BigInt(33_000_000); // 33ms

// After
const vsyncPeriodNs = inferVsyncPeriodNs(traceContext);
const estimatedEndTs = startTs + vsyncPeriodNs * 2n; // 2 vsync periods
```

---

### Task 2: Make Jank Thresholds Configurable

**Files:**
- Modify: `backend/src/agent/agents/domain/frameAgent.ts:120-121`
- Create: `backend/src/config/thresholds.ts`

**Step 1: Create threshold config**
```typescript
// backend/src/config/thresholds.ts
export interface JankThresholds {
  criticalRate: number;  // default: 15
  criticalCount: number; // default: 30
  warningRate: number;   // default: 5
  warningCount: number;  // default: 10
}

export const DEFAULT_JANK_THRESHOLDS: JankThresholds = {
  criticalRate: 15,
  criticalCount: 30,
  warningRate: 5,
  warningCount: 10,
};
```

**Step 2: Update frameAgent to use config**

---

### Task 3: Extract VSync Detection Skill

**Files:**
- Create: `backend/skills/atomic/vsync_period_detection.skill.yaml`

**Step 1: Create atomic skill**
```yaml
name: vsync_period_detection
type: atomic
description: Detect VSync period from trace data
steps:
  - id: detect_vsync
    sql: |
      WITH vsync_intervals AS (
        SELECT
          ts - LAG(ts) OVER (ORDER BY ts) AS interval_ns
        FROM counter c
        JOIN counter_track t ON c.track_id = t.id
        WHERE t.name = 'VSYNC-sf'
      ),
      percentile AS (
        SELECT interval_ns,
          PERCENT_RANK() OVER (ORDER BY interval_ns) as pct
        FROM vsync_intervals
        WHERE interval_ns > 0
      )
      SELECT
        AVG(interval_ns) as vsync_period_ns,
        1000000000.0 / AVG(interval_ns) as refresh_rate_hz
      FROM percentile
      WHERE pct BETWEEN 0.25 AND 0.75
```

---

### Task 4: Add Missing Memory Pressure Skill

**Files:**
- Create: `backend/skills/atomic/memory_pressure_in_range.skill.yaml`

*(Implementation as shown in Section 3.3)*

---

### Task 5: Add Orchestration Integration Tests

**Files:**
- Create: `backend/tests/integration/orchestration.test.ts`

*(Test cases as shown in Section 4.2)*

---

### Task 6: Run Code Simplifier

**Action:** Use `code-simplifier:code-simplifier` skill on:
1. `scrollingStrategy.ts`
2. `strategyExecutor.ts`
3. `agentRoutes.ts`

---

## Appendix A: File Inventory

### Core Agent Files (129 total)
- `backend/src/agent/core/` - 20 files
- `backend/src/agent/agents/` - 15 files
- `backend/src/agent/strategies/` - 5 files
- `backend/src/agent/executors/` - 7 files
- `backend/src/agent/context/` - 8 files
- ... (see CLAUDE.md for full list)

### Skills Files (102 total)
- `backend/skills/atomic/` - 30 files
- `backend/skills/composite/` - 27 files
- `backend/skills/deep/` - 2 files
- `backend/skills/modules/` - 15 files
- `backend/skills/pipelines/` - 25 files
- `backend/skills/vendors/` - 8 files

### Test Files (18 total)
- `backend/src/tests/` - 7 files
- `backend/src/agent/core/__tests__/` - 7 files
- `backend/src/agent/context/__tests__/` - 2 files
- `backend/src/services/__tests__/` - 2 files

---

## Appendix B: Decision Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Use dynamic VSync detection | Support 60/90/120/144Hz displays | 2026-01-27 |
| Extract threshold config | Enable per-device customization | 2026-01-27 |
| Create VSync atomic skill | DRY principle, reduce duplication | 2026-01-27 |
| Target 70% test coverage | Industry standard for production code | 2026-01-27 |

---

## Appendix C: Blocked Items (Require User Input)

1. **Vendor-specific skill overrides** - Need access to Samsung/Xiaomi/etc. trace samples
2. **GPU power state analysis** - Need documentation on trace format for GPU power domains
3. **E2E test with real trace** - Need sample trace file committed to repo

---

## Next Steps

1. ☐ Fix hardcoded VSync period (Task 1)
2. ☐ Make jank thresholds configurable (Task 2)
3. ☐ Extract VSync detection skill (Task 3)
4. ☐ Add memory pressure skill (Task 4)
5. ☐ Add orchestration tests (Task 5)
6. ☐ Run code simplifier (Task 6)
7. ☐ Review and merge changes

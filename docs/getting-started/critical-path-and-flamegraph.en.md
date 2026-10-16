# Critical Path And Flamegraph

[English](critical-path-and-flamegraph.en.md) | [中文](critical-path-and-flamegraph.md)

<!-- i18n-headings: paired -->

These two entry points in the AI Assistant panel analyze one local question
about the current trace: what a selected task is waiting on, and which call
stacks the CPU time goes to. They do not start an Agent analysis, and their
results do not enter the conversation history, HTML reports, or analysis-result
snapshots. Hand a result to the conversation when you want to dig further.

## Prerequisites

- The trace is bound to the backend in the AI Assistant (the panel shows the
  current trace as connected).
- The caller can read the trace (`trace:read`). The AI summary additionally
  requires the `agent:run` permission: reading a trace is not enough to spend
  the workspace's model.
- The AI summary uses the caller's current Provider Manager profile through a
  one-shot Claude runtime call.

## Critical Path Wait Chain

1. Select a `thread_state` task with a valid duration on the timeline.
2. Click **Critical-path analysis** next to the AI Assistant preset questions.
3. The drawer shows the anomaly assessment, wakeup chain, related modules, next
   steps, and hypotheses with **Copy verification SQL**.
4. **Continue in the conversation** puts a question containing only ids and
   numbers in the composer (it is not sent automatically); the Agent
   re-acquires the evidence from those ids.

Reading the result:

- The headline is attributable time: other threads' work, runnable, and
  uninterruptible segments. Perfetto ends a critical path at IRQ, swapper, and
  io_wait wakes; those external S/I segments are listed separately as
  chain-end waits, never recursed into, and never read as idle on their own.
- A wait is judged idle only when it falls between two slices and attributable
  time is low. A wait inside a slice whose chain ends in a peer's event wait
  gets a warning, for example a lock holder waiting on the network.
- The drawer explains why no chain is shown when the selected task is running;
  the window has no sleeping, uninterruptible, or runnable time; Perfetto
  returned no critical path (the trace may lack `sched_waking`); the thread has
  no scheduling records in the window; or the wait lasts until the end of the
  trace.

## Flamegraph

1. Open the **火焰图** (flamegraph) tab in the AI Assistant view; the page reads
   the current trace automatically.
2. The page first checks whether the trace contains CPU call-stack samples (the
   Perfetto summary tree) and says so when it does not.
3. Click **分析火焰图数据** (analyze flamegraph data) to see self and total
   hotspots, hot paths, categories, and a Chinese AI summary.

The backend prefers the repository's Rust analyzer (`rust/flamegraph-analyzer`;
`FLAMEGRAPH_ANALYZER_BIN` selects an executable and
`FLAMEGRAPH_ANALYZER_TIMEOUT_MS` adjusts the timeout). When it is unavailable,
the backend falls back to the TypeScript implementation and says so in a
warning. The flamegraph page and its AI summary are Chinese only.

## AI Summary Fallback

The AI summary (feature `critical_path_ai_summary` / `flamegraph_ai_summary`)
becomes a rule-based fallback summary, while the analysis itself still returns,
when AI is disabled, the caller lacks `agent:run`, the current Provider is not
the Claude Agent SDK runtime, credentials are missing, the call times out, or
the client disconnects. `aiSummary.fallbackReason` and `warnings` state the
reason. Disabling AI never makes these entry points return 403. When the request
connection drops, the backend cancels unfinished queries and model calls.

## Deployment And API

The critical-path drawer calls the workspace route
`POST /api/workspaces/:workspaceId/critical-path/:traceId/analyze`; the
flamegraph page calls `GET /api/flamegraph/:traceId/availability` and
`POST /api/flamegraph/:traceId/analyze`. Under enterprise/OIDC deployments the
legacy `/api/critical-path/*` and the non-workspace `/api/flamegraph/*` answer
410, so the flamegraph page is unavailable there. Request and response fields
are in the [API Reference](../reference/api.en.md); AI switches are in the
[Configuration Guide](configuration.en.md).

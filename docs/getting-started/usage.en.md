# Basic Usage

[English](usage.en.md) | [中文](usage.md)

## Recommended Trace Content

SmartPerfetto works best with Android 12+ traces, especially traces that include FrameTimeline data. Common atrace categories:

| Scene | Minimum categories | Useful extras |
|---|---|---|
| Scrolling | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| Startup | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |
| GPU / rendering | `gfx`, `view`, `sched` | `freq`, `gpu`, `binder_driver` |

## UI Analysis Flow

1. Open `http://localhost:10000`.
2. Load a `.pftrace` or `.perfetto-trace` file.
3. Open the SmartPerfetto AI Assistant panel.
4. Choose an analysis mode: fast, full, or auto.
5. Ask a natural-language question.
6. Wait for SSE streaming output, table evidence, and the final conclusion.

## Common Prompt Templates

```text
Analyze scrolling jank
Analyze startup performance
Analyze this ANR
What is the app package name and main process in this trace?
Why is the main thread blocked in my selected range?
Compare scrolling behavior between this trace and the reference trace
```

## Analysis Mode Selection

| Mode | Good for | Avoid for |
|---|---|---|
| Fast | Package name, process name, trace overview, simple facts | Heavy analysis such as startup or scrolling jank |
| Full | Startup, scrolling, ANR, complex rendering root cause | A single simple fact query |
| Auto | Default daily use | Cases with strict cost or depth requirements |

Fast mode defaults to 10 turns. Heavy Skills can still return large JSON and exhaust turns, so complex performance investigations should use full mode.

## Selection and Follow-Up

The frontend sends area selections or track-event selections to the backend as `selectionContext`. Good prompts include:

```text
Only inspect my selected time range. Why did the UI thread slow down?
Is there a Binder or scheduling problem around this slice?
```

Follow-up questions reuse the current session. Switching between fast, full, and auto starts a new SDK session so lightweight and full contexts do not mix.

## Reading Output

SmartPerfetto answers usually contain three evidence types:

- SQL results directly from `trace_processor_shell`.
- Skill results from YAML analysis pipelines under `backend/skills/`, rendered in L1-L4 layers.
- Agent conclusions based on SQL, Skills, strategies, and verifier output.

The conclusion should trace back to tables, time ranges, threads, slices, or Skill results. Suggestions that are not supported by trace data should not be treated as confirmed findings.

## Generated Reports

After agent analysis completes, the backend generates an HTML report. The UI reads the report through `/api/agent/v1/:sessionId/report`; the general report endpoint is `/api/reports/:reportId`.

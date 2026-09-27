# Basic Usage

[English](usage.en.md) | [中文](usage.md)

For the full feature map, entry points, and expected outputs, see [Feature Overview](features.en.md).
For the Windows portable path from download through first analysis, see the [Windows guide](windows.en.md).

## Recommended Trace Content

SmartPerfetto works best with Android 12+ traces, especially traces that include FrameTimeline data. Common atrace categories:

| Scene | Minimum categories | Useful extras |
|---|---|---|
| Scrolling | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| Startup | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |
| GPU / rendering | `gfx`, `view`, `sched` | `freq`, `gpu`, `binder_driver` |

## UI Analysis Flow

1. Open the URL supplied by the runtime; Windows portable uses the actual `Open:` URL printed by the launcher, while Docker defaults to `http://localhost:10000`.
2. Load a `.pftrace` or `.perfetto-trace` file.
3. Open the SmartPerfetto AI Assistant panel.
4. Choose an analysis mode: conversation, fast, full, or auto.
5. Ask a natural-language question.
6. Wait for SSE streaming output, table evidence, and the final conclusion.

The answer appears as soon as its text is final, marked "Answer ready;
verification in progress". The one no-tool semantic review keeps running, and
its verdict then completes the same message without rewriting the text. Stop
during that review ends only the review: the answer is still saved, with its
verification recorded as stopped at the user's request (unverified). Pressing
Stop again forces the run to end; SmartPerfetto still waits a few seconds for
the answer to be saved. If saving does not finish in that time, the answer you
read is kept as an unverified, incomplete turn (for registered source or
knowledge, it is not kept). If the run fails or disconnects before the verdict,
the answer stays and is marked as not verified.

In the CLI (`smp run`, `smp ask`, `smp compare`, `smp capture --analyze` and the
REPL), Ctrl-C works the same way per turn. After the text answer has been
printed, the first Ctrl-C stops only its verification and the turn is saved.
Before that answer, or on the next Ctrl-C, the turn is aborted and not saved
(exit code 130; the REPL returns to its prompt). A further Ctrl-C, or a turn
that has not stopped within about 2 seconds, exits immediately with 130.
`--format json`/`ndjson` print no early answer, so their first Ctrl-C aborts.
Once the turn is saved, Ctrl-C no longer applies to it.

Auto mode first returns a scene inventory for mixed-action traces. The timeline lists detected startup, scrolling, click, navigation, device-state, ANR, and related scenes, then shows scope buttons. Select all scenes or one scene family before SmartPerfetto runs the matching startup, scrolling, click, or other deep-dive analysis.

Incomplete CLI results show the reason and available diagnostics, distinguishing
no narrative from narrative that failed quality checks. A limited summary after
the investigation turn cap remains `partial` / `max_turns`; review unfinished
questions before continuing with `smp ask`. See the [CLI reference](../reference/cli.en.md#global-options).

## Scene Reconstruction

After loading a Trace, select a Provider and click **Scene Reconstruction**. The investigation examines actions and state changes across the Trace, showing what the user was doing, the device state and the application's response for each interval. Auto mode's scene inventory remains available for selecting a deep-dive scope.

Read unknowns, evidence checks and coverage gaps alongside the timeline. Missing input does not mean the device was idle, and a finished investigation does not mean every action was confirmed. Cancelled, failed and partial results retain their status so you can decide whether to investigate further or record a Trace with the missing data.

Scene reports are retained for 7 days by default and require continued access to the original Trace. Deleting the Trace makes its reports unavailable. See the [Scene Reconstruction Architecture Contract](../architecture/scene-reconstruction.en.md) for implementation and evidence boundaries.

## Converse Before Starting Analysis

At the investigation turn limit, the remaining budget can produce one no-tool
summary of findings, gaps and next steps while retaining partial status. Follow-up
questions inherit these limitations and retrieve older details when needed.
The same conversation can recover after reopening or a backend restart, following
current owner, provider, trace and source authorization checks. The page reports
failed saves, interrupted runs and source history that is no longer readable.

`Conversation` is the default entry. Without an open trace, the top-bar AI
entry opens a dedicated conversation page. With a trace open, the same mode
attaches the current trace inside the AI Assistant panel. Use it to clarify a
goal, discuss performance concepts, or query authorized source code. It asks an
explicit question when context is missing and produces a confirmable full-
analysis handoff only when trace-level causal work is actually needed; it never
starts that heavy analysis by itself.

Rapid follow-ups reuse one session and stop the older run first. New
conversation, clear, Provider, output-language, Workspace, source-authorization,
or attached-trace changes establish a new security boundary. A no-trace
conversation has no trace-query tools. An authorized registered local source
root remains searchable/readable on demand even without an index; the index is
an optional graph and retrieval accelerator.

## Use Analysis-Result Actions

Actions below a completed analysis run only after an explicit click. **Go to
timestamp** centers and visibly zooms the target time, **Open table** returns to
the evidence rows behind the conclusion, and **Save evidence** stores an
evidence or result snapshot in the current conversation. Use `/pins` to view saved results.
Saving evidence does not pin a Perfetto timeline track or automatically add it
to later AI context. The same action evidence is saved only once.

## Agent-Assisted External Feedback

When a completed result says signals may be worth reporting or contributing:

1. Click **Ask the Agent whether to report this**.
2. Review its decision, ownership, contribution type, and missing evidence.
3. Answer required questions and manually inspect everything that may become
   public.
4. Confirm sensitive-data review and create a GitHub draft.
5. Recheck the preview, then explicitly open and submit the GitHub issue.

SmartPerfetto never submits it automatically or turns the action into thumbs
feedback or a Self-Evolution proposal. Public feedback is unavailable for
private/code-aware results; security reports use a private advisory. See
[Agent-Assisted GitHub Feedback](agent-assisted-feedback.en.md).

## Self-Evolution Admin Flow

Self-Evolution is off by default and does not change the analysis flow above.
After a public analysis, regular users can submit thumbs feedback. Authorized
administrators can open **AI Assistant Settings -> Evolution** to inspect state
and start explicit curation.

The control-plane sequence is:

```text
curate -> gate -> inspect before/after and evidence -> accept/reject
        -> optional export -> apply -> verify a new analysis -> revert
```

“No proposal” is normal when there is not enough effective public feedback.
Private feedback never enters curation. Apply/revert also requires dedicated
deployment switches and an external persistent data directory. See
[Self-Evolution Usage And Acceptance](self-evolution.en.md) for permissions,
failures, and complete acceptance tests.

## Common Prompt Templates

```text
Analyze scrolling jank
Analyze startup performance
Analyze this ANR
What is the app package name and main process in this trace?
Why is the main thread blocked in my selected range?
Compare scrolling behavior between the baseline and comparison traces
Compare with the other result
Compare AR-1234abcd
```

## Live Raw Trace Comparison

To query two raw traces in one conversation, click `compare_arrows` in the AI
Assistant header. Left/top is the baseline and right/bottom is the comparison;
both selectors can choose any trace in the current workspace, and `Swap`
reverses the comparison direction. You can refer to baseline/comparison or use
the actual left/right/top/bottom layout.

With no trace open, enter the trace-free AI Assistant page and click
`Dual Trace` to open two empty panes. Each pane can upload a local trace
directly; a successful upload remains in the current workspace and is selected
in that pane. Occupied panes expose `Replace file`. The two uploads are
independent, while an active analysis locks upload and replacement controls.

The current page trace is only the initial baseline. It is not required to stay
in the pair, so two historical traces can be compared directly. Closing the
visual dual view may retain AI comparison context; `Exit Comparison` clears the
pair. The CLI equivalent is:

The most recent pair, layout, and completed analysis references are stored per
workspace. Browser reload or a normal backend restart restores them while the
trace assets remain available. An unfinished run is reported as interrupted
and must be started again.

```bash
smp compare baseline.pftrace comparison.pftrace \
  --query "Compare startup and scrolling" --mode full
```

See [Dual Trace Workspace](../architecture/dual-trace-workspace.en.md) for the
full state model.

## Multi-Trace Analysis Result Comparison

After AI analysis has completed on two or more traces, you can type `Compare with the other result` in the AI input. When the current window has a latest analysis result and there is exactly one clear other candidate in the same workspace, SmartPerfetto uses the current result as the baseline and starts the comparison automatically.

Each completed AI analysis shows a `Result ID` next to the result title, such as `AR-1234abcd`. If more than one candidate exists, or you want to specify the target, say `Compare AR-1234abcd`. You can also say `Compare AR-11111111 and AR-22222222`; when multiple IDs are present, the first ID is the baseline and the later IDs are candidates.

You can also use the AI Assistant toolbar's `fact_check` entry to open analysis result comparison. Select one `Baseline` and one or more `Candidate` results; SmartPerfetto returns standard metric deltas, significant-change summary, and an HTML comparison report.

This compares completed analysis results and does not require the other Perfetto UI window to stay open. See [Multi-Trace Analysis Result Comparison](multi-trace-result-comparison.en.md) for the full workflow.

## Analysis Mode Selection

| Mode | Good for | Avoid for |
|---|---|---|
| Conversation | Goal clarification, performance concepts, authorized source, and deciding whether trace analysis is needed | Requests that should immediately run full trace causal analysis |
| Fast | Package name, process name, trace overview, simple facts | Heavy analysis such as startup or scrolling jank |
| Full | Startup, scrolling, ANR, complex rendering root cause | A single simple fact query |
| Auto | Mixed-script traces where you want to inspect scenes before choosing a deep-dive scope | Cases where you already know the single scene and want to run full analysis directly |

Fast mode defaults to 50 turns and can be overridden by runtime-specific
quick-turn configuration. Heavy Skills can still exhaust the budget, so
complex investigations should use full mode.

## Selection and Follow-Up

The frontend sends area selections or track-event selections to the backend as `selectionContext`, containing only event/track identity and time bounds. Card display queries are not attached as hidden evidence; the backend re-queries names, thread/process identity, and anomaly status. Good prompts include:

```text
Only inspect my selected time range. Why did the UI thread slow down?
Is there a Binder or scheduling problem around this slice?
```

Follow-up questions reuse the current session. Switching between conversation, fast, full, and auto starts a new SDK session so lightweight and full contexts do not mix.

`/anr` and `/jank` use the same backend evidence, claim-verification, and report path as ordinary analysis. They are blocked when backend policy disables AI.

## Source And Android Internals Background

- To map trace findings to local source, register through UI `Codebases` or
  `smp codebase preview/register`, then select the codebase explicitly for the
  analysis. A registered live root supports bounded search/read without an
  index; `reindex` is optional acceleration.
- The built-in Android Internals Knowledge Pack ships with the product. Use
  `smp knowledge-pack status`, or `update --check` to check without installing.
- A private Android Internals checkout is separate from the built-in Pack and
  requires a path allowlist, rights acknowledgement, provider consent, and a
  request-selected source id.

Source and background knowledge do not replace current-trace SQL/Skill
evidence. Code-Aware defaults to `CodeRef` metadata. See
[Code-Aware](code-aware-analysis.en.md) and
[Android Internals Knowledge](android-internals-knowledge.en.md).

With source selected, full analysis first establishes occurrence with
Trace/Skill/SQL. A queryable symbol, slice, Binder descriptor, or build-id
anchor requires bounded source lookup; otherwise the run records a structured
reason such as `not_needed`, `disallowed`, or `no_queryable_anchor`. The source
receipt distinguishes selected, queried, and actually used codebases, search
coverage, and a `corroborated|compatible|ambiguous|unverified` mechanism
status. Trace proves what happened; a `CodeRef` explains how the implementation
could cause it. A `CodeRef` alone cannot promote a trace occurrence to a
verified root cause.

Web chat keeps only a safe collapsible receipt with no file paths, source
snippets, search query, or free-text reason. HTML reports, CLI artifacts, and
snapshot/API surfaces may retain safe relative `CodeRef` values and bindings,
but still contain no absolute root or source body.

## CLI Batch And Android Capture

Deterministic batch analysis does not require an LLM:

```bash
smp batch skill startup_analysis launch-a.pftrace launch-b.pftrace \
  --json-out batch.json --out batch.html
```

For Android capture, generate a side-effect-free proposal/config before using a
connected device:

```bash
smp capture suggest "Analyze Camera open-to-first-preview latency" \
  --app com.example.camera
smp capture config --preset camera --app com.example.camera \
  --duration 20 --out camera.pbtxt
smp capture android --config camera.pbtxt --out camera.perfetto-trace
```

`suggest` and `config` do not access a device; only `capture android` records
through adb/tracebox. See the [CLI Reference](../reference/cli.en.md) for
platform and `--analyze` boundaries.

## Reading Output

SmartPerfetto answers usually contain three evidence types:

- SQL results directly from `trace_processor_shell`.
- Skill results from YAML analysis pipelines under `backend/skills/`, rendered in L1-L4 layers.
- Agent conclusions based on SQL, Skills, strategies, and verifier output.

Comparable metrics, phase timings, rankings and trace differences are good
candidates for compact Markdown tables in the final answer, followed by
mechanisms, impact and limits. These are evidence summaries, not copies of all
intermediate query rows. Values still need original references and clear units,
trace sides, windows and delta direction. Missing is not zero; incomparable data
does not justify a delta or ratio. Tables do not replace material findings or
causal explanations.

The conclusion should trace back to tables, time ranges, threads, slices, or Skill results. Suggestions that are not supported by trace data should not be treated as confirmed findings.

The final conclusion is the primary deliverable: an overview can lead, followed by all material findings, evidence and uncertainty. Quick/full budgets share one conclusion contract without a fixed word, table-row or claim-count limit. Intermediate table previews only limit display. The model retains locators for all evidence artifacts, including later, empty and unavailable results, for authorized on-demand reads. Actual provider or review capacity limits remain explicit incomplete states, never a partial answer presented as complete and verified.

## Generated Reports

After agent analysis completes, the backend generates an HTML report. The UI reads the report through `/api/agent/v1/:sessionId/report`; the general report endpoint is `/api/reports/:reportId`.

## Reading system investigation results

System analysis applies to relevant performance scenes. Each turn identifies target tasks, time windows and dependencies before explaining relevant frequency, system utilization, quadrants, preemption and scheduling observations. CPU placement ratios and observed priority alone do not establish scheduling policy, preemption motive or a bottleneck.

The UI, HTML report and CLI distinguish system investigation coverage from system evidence coverage. The former evaluates whether the answer explains applicable dimensions; the latter requires trusted acquisition records. A checked explanation may explicitly identify insufficient evidence. Historical results without these fields display Not checked; restoring or comparing saved results does not trigger new trace acquisition. Bounded questions and existing-evidence-only requests retain their original scope.

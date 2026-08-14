# Feature Overview

[English](features.en.md) | [中文](features.md)

<!-- i18n-headings: paired -->

This guide is for SmartPerfetto users. It explains what the product can do, where to trigger each feature, and what output to expect. For installation and configuration, see [Quick Start](quick-start.en.md) and [Configuration Guide](configuration.en.md).

## 1. AI Assistant Inside Perfetto UI

SmartPerfetto embeds an AI Assistant panel inside Perfetto UI. After loading a `.pftrace` or `.perfetto-trace`, you can ask natural-language questions such as:

```text
Analyze startup performance
Analyze scrolling jank
Analyze this ANR
Why is the main thread blocked in my selected range?
```

Entry points:

- Open `http://localhost:10000`.
- Load a trace.
- Open the SmartPerfetto AI Assistant panel.
- Choose `fast`, `full`, or `auto`.
- Ask a question.

Output:

- The AI calls backend TraceProcessor, SQL, Skills, and scene strategies.
- The UI streams progress, SQL/Skill evidence, tables, and the final conclusion.
- Conclusions should trace back to concrete time ranges, threads, slices, SQL rows, or Skill results.

### Browser Trace Tools And Local WASM

The committed Perfetto frontend also includes trace exploration capabilities
that run directly in the browser:

- Trace Doctor diagnostics and a unified Stack Samples/flamegraph entry point.
- Raw multi-trace open/merge, Video Frames, and Pixel input-lifecycle and CUJ
  views.
- Experimental Memscope/OOM views, shown only when the trace contains the
  required data and the corresponding experimental capability is available.
- Local WASM parsing for zstd-compressed traces and `strace -ttt` input, plus
  Perfetto UI query flows that execute multiple SQL statements at once.

These capabilities belong to the local browser timeline and Perfetto plugins.
Raw multi-trace open/merge is separate from SmartPerfetto dual-trace AI
comparison, and new WASM capabilities do not automatically extend backend AI,
Skills, CLI, or HTML reports. Those surfaces continue to use the packaged,
pinned native `trace_processor_shell` until an independent upgrade passes the
five-platform verification gates.

### Smart Analysis Mode

Auto mode is designed for traces that contain a full test script, such as cold start, warm start, scrolling, taps, Back/Home, screen on/off, and another launch in one recording. It does not deep-dive every scene immediately. Instead, the main AI panel first returns a scene inventory:

- Lists detected startup, scrolling, inertial scrolling, click, navigation, device-state, ANR, and related scenes in timeline order.
- Marks which scenes are eligible for deep dives and which are only marker or context evidence.
- Shows scope buttons such as `All`, `Startup`, `Scrolling`, `Click`, `Navigation`, `Device`, and `ANR`.
- After the user chooses a scope, SmartPerfetto runs the matching startup, scrolling, or other deep-dive path with the same evidence and conclusion contract as the dedicated analysis mode.

## 2. Common Performance Scenarios

SmartPerfetto includes Android performance analysis scenarios for common trace investigations.

| Scenario | Example prompt | Typical output |
|---|---|---|
| Startup | `Analyze startup performance`, `Why is startup slow?` | Startup phase breakdown, main-thread blocking, key slices, duration metrics |
| Scrolling/Jank | `Analyze scrolling jank`, `How was FPS in this scroll?` | FPS/Jank metrics, slow frames, UI/RenderThread/scheduler evidence |
| ANR | `Analyze this ANR` | Main-thread wait, Binder/lock/scheduler signals, likely root cause |
| Interaction latency | `Why did this tap respond slowly?` | Input-to-render path, main-thread and rendering-thread delay |
| Memory/CPU | `Check memory pressure`, `Why is CPU high?` | Process/thread stats, scheduling and resource evidence |
| Rendering pipeline | `Analyze this rendering path` | App, Framework, SurfaceFlinger, HWC/GPU evidence |

Output:

- Use `fast` for lightweight facts.
- Use `full` or `auto` for startup, scrolling, ANR, and complex rendering root-cause analysis.
- When evidence is incomplete, SmartPerfetto should preserve uncertainty instead of presenting guesses as facts.

## 3. Selection-Aware Follow-Up

SmartPerfetto sends Perfetto area selections and track-event selections to AI Assistant. Select a time range or event first, then ask:

```text
Only inspect my selected time range. Why did the UI thread slow down?
Is there a Binder or scheduling problem around this slice?
```

Entry points:

- Select a time range or event in the Perfetto timeline.
- Ask a question in AI Assistant.

Output:

- The AI focuses on the selected context first.
- Useful for reducing a large trace to one tap, one scroll, one frame, or one suspicious slice.
- Follow-up questions reuse the current session so you can narrow the root cause step by step.

## 4. Evidence Tables, Skill Results, And Traceable Conclusions

SmartPerfetto output usually contains three evidence types:

- SQL results from `trace_processor_shell`.
- Skill results from built-in YAML analysis pipelines, often rendered as L1-L4 layers from overview to deep root cause.
- Agent conclusions based on SQL, Skills, strategies, and verifier checks.

Output:

- Turns dense timelines into readable causal chains.
- Key numbers should have sources, not only natural-language statements.
- Complex analyses should include optimization direction, validation ideas, and remaining uncertainty.

## 5. HTML Analysis Reports

After an AI analysis completes, the backend generates an HTML report.

Entry points:

- Complete an AI analysis in AI Assistant.
- Open the report link returned by the UI.
- The backend also exposes `/api/reports/:reportId`.

Output:

- Packages the question, evidence, conclusion, and suggestions into a readable report.
- Useful for team sharing, issues, and regression records.

## 6. Live Trace Comparison

Live trace comparison places the current page's current trace and one workspace-history reference trace in a repositionable dual view, so the AI can query both traces in one conversation.

Entry points:

- Click `compare_arrows` in the AI Assistant header.
- `Open Dual View` immediately opens a current-plus-empty-reference shell; no separate history picker is required first.
- Both panes have a selector. Either pane can show current or history. Selecting history in the pane that holds current atomically moves current to the other pane.
- History options lead with the trace filename. Upload time/file size are appended only when same-name records need disambiguation; internal ids are never the main label.
- Once selected, history is the sole reference. The supported pair remains the current page's current parent plus one historical reference; arbitrary history-versus-history pairs are not supported.
- You can switch horizontal/vertical layout, drag the splitter, maximize/minimize either side, or open either side in a new tab.
- The dual-view toolbar keeps an explicit `AI Assistant` button visible. It collapses or restores the conversation panel without closing or reloading either trace pane.
- Layout changes, maximize/minimize, and AI Panel hide/show do not reload dual-view iframes. Only explicit dual-view exit, current-trace unload, or workspace switch destroys them.
- `Exit Dual View` releases the visual workspace while its two-trace AI context may remain; `Exit Comparison` clears the reference trace.
- Ask a comparison question, for example `Compare scrolling behavior between this trace and the reference trace`, `Why is the left trace slower to start`, or `What frequency difference exists between the top and bottom traces`.

Output:

- The AI can access both current/reference raw traces in one analysis.
- The AI Panel sends current/reference, left/right, top/bottom, active side, dual-view open state, split ratio, and maximized/minimized state to the backend.
- When the user says "left", "right", "top", "bottom", "current", or "reference", the AI resolves that wording against the actual pane mapping; after dual-view exit, current/reference wording still works.
- Useful for temporary two-trace comparison.
- This mode is live analysis, not cross-window or cross-user persistent result comparison.

See [Dual Trace Workspace Operation Model](../architecture/dual-trace-workspace.en.md) for the full interaction model.

## 7. Multi-Trace Analysis Result Comparison

Multi-trace analysis result comparison compares completed AI analysis results. It does not require the other Perfetto UI window to stay open.

Entry points:

- Complete at least two AI analyses and wait for `Ready result` or `Partial result` in the AI Assistant header.
- Shortcut: type `Compare with the other result`, or specify a result by the `Result ID` shown next to the result title, for example `Compare AR-1234abcd`.
- Click the `fact_check` icon to open analysis result comparison.
- Choose one `Baseline` and one or more `Candidate` results.
- Optional: `Share` a private result to make it workspace-visible.
- Optional: click the row-level `travel_explore` icon to view similar snapshot
  or case hints. These hints are `navigation_hint_only`.
- Click `Start comparison`.

Output:

- Standard metric matrix and deltas between baseline/candidates.
- Standardized metrics such as startup duration and FPS/Jank when available.
- 2 or more snapshots in one comparison.
- Similar historical result hints before starting a formal comparison, without
  treating similarity as diagnostic evidence.
- When there is exactly one clear other candidate, the AI can start the comparison from a natural-language request; when the target is ambiguous, it asks you to choose.
- Significant change count and an HTML comparison report.

See [Multi-Trace Analysis Result Comparison](multi-trace-result-comparison.en.md) for the full workflow.

## 8. Android Internals Knowledge

SmartPerfetto separates Android Internals background knowledge into two sources:

- a signed Knowledge Pack bundled with npm, Docker, source, and portable
  products, available offline and updatable through a TUF stable channel;
- a user-allowed private checkout guarded by path, rights, provider-consent,
  and request-level source-id checks.

Entry points:

- CLI: `smp knowledge-pack status` and `smp knowledge-pack update --check`.
- AI analysis: the runtime retrieves the built-in Pack when relevant; a private
  source must be selected explicitly for the request.
- Admin API: `/api/rag/android-internals/*` manages private checkouts only.

Output:

- Pack/private content is background knowledge, never current-trace SQL/Skill
  evidence.
- Reports retain source, version, fingerprint, and snippet hashes; logs/SSE do
  not project excerpt bodies.
- Updates do not silently switch active sessions; revocation requires a new
  analysis context.

See [Android Internals Knowledge Pack And Private Knowledge](android-internals-knowledge.en.md).

## 9. Code-Aware Local Source Analysis

Code-Aware Analysis lets users register local App, AOSP, kernel, or OEM SDK source trees with SmartPerfetto. By default, the model sees only `CodeRef` metadata, not raw source text.

Entry points:

- `Codebases` tab in AI Assistant settings: preview, register, reindex, and audit.
- CLI: `smp codebase preview/register/reindex/symbols`.
- During analysis, explicitly pass `--code-aware metadata_only` and `--codebase-id <id>`, or choose a registered codebase in the UI.

Output:

- Maps call stacks, native frames, or kernel symbols to relative file paths, line ranges, and symbols.
- Reports show `CodeRef` metadata; raw source text is fetched only through the controlled excerpt endpoint.
- If no codebase is configured for the session, the normal trace-only analysis path is unchanged.

See [Code-Aware Analysis](code-aware-analysis.en.md) for the full workflow.

## 10. Provider Management And Runtime Switching

SmartPerfetto supports UI-managed model providers and `.env` configuration.

Entry points:

- `Providers` tab in AI Assistant settings.
- `backend/.env` or Docker root `.env`.
- Provider/runtime switcher near the AI input.

Output:

- Supports Anthropic, Claude/Anthropic-compatible providers, and OpenAI/OpenAI-compatible providers.
- The active Provider Manager profile takes priority over `.env`.
- The protected `/api/runtime-health` endpoint shows the current credential
  source for troubleshooting; public `/health` exposes only readiness and version.

See [Configuration Guide](configuration.en.md) for setup details.

## 11. Controlled Self-Evolution

Self-Evolution turns effective public feedback into reviewable proposals and
compares a baseline and candidate on fixed validation/holdout cases. It is off
by default and intended for authorized maintainers and administrators.

Entry points:

- Thumbs up/down after a normal analysis.
- **AI Assistant Settings -> Evolution** control plane.
- `/api/admin/self-evolution` admin API.

Output:

- Every analysis uses an immutable RunManifest to pin attribution and overlay
  generation.
- Private feedback stays in a private local path; only effective public
  feedback can enter explicit curation.
- A proposal needs fixed paired evaluation and human acceptance before explicit
  apply. Overlays can be reconciled and reverted and never commit, push, or call
  GitHub automatically.
- Missing external persistence, permissions, or a valid gate binding fails
  closed; the default state does not change normal analysis.

See [Self-Evolution Usage And Acceptance](self-evolution.en.md) for the complete
workflow and tests.

## 12. Agent-Assisted GitHub Feedback

After an analysis, SmartPerfetto detects signals worth reporting or
contributing from that run's persisted receipt, evidence, and runtime
attribution. On user request, an independent Agent decides whether a public
report is appropriate, which surface owns it, what the user can contribute,
and what evidence is still missing.

- Works for current and historical completed messages without reading the
  current session's temporary result.
- Review pins the source run's provider/runtime snapshot; mismatch produces
  explicit fallback, never a silent model switch.
- Agent output must reference real signals, claims, evidence, and Skills and
  passes deterministic validation and redaction.
- Private/code-aware analysis disables public feedback; security reports use a
  private advisory.
- It creates a reviewable GitHub draft only and never submits or triggers
  Self-Evolution automatically.

See [Agent-Assisted GitHub Feedback](agent-assisted-feedback.en.md) for the
workflow, privacy boundary, and tests.

## 13. Automation, API, And CLI

SmartPerfetto also provides workspace APIs, a CLI, and MCP tools for automation.

Entry points:

- Workspace API: [API Reference](../reference/api.en.md) for batch traces,
  explicit snapshot promotion, the comparison bridge, and trace-config proposals.
- CLI: [CLI Reference](../reference/cli.en.md) for local sessions, batch,
  capture, and report automation.
- MCP/agent hosts: [MCP Tools Reference](../reference/mcp-tools.en.md) for
  request-scoped tools in compatible hosts.

Output:

- Integrate trace analysis into scripts, CI, batch jobs, or internal platforms.
- `smp batch skill` runs one deterministic Skill across a bounded local trace
  set and exports JSON/HTML. The workspace batch API also supports explicit
  snapshot promotion and a comparison bridge.
- `smp capture suggest/config` creates side-effect-free Android capture
  proposals. With a connected device, `smp capture android` records the trace;
  presets such as Camera declare the required evidence categories.
- Reuse the same Skills, strategies, reports, and evidence-backed output flow.

## 14. Runtime And Distribution Options

SmartPerfetto supports multiple runtime paths:

| Mode | Best for | Notes |
|---|---|---|
| Docker | Users and quick deployments | Uses committed prebuilt Perfetto UI; no local submodule build required |
| Portable packages | Users who do not want Docker | Windows, macOS, and Linux packages include Node runtime, backend, prebuilt UI, and trace_processor |
| Local source run | Developers and debugging | `./start.sh` starts backend and prebuilt UI |
| Dev mode | Perfetto UI plugin development | `./scripts/start-dev.sh` watches the `perfetto/` submodule frontend |

Runtime setup is in [Quick Start](quick-start.en.md). Packaging and release details are in [Portable Packaging](../reference/portable-packaging.en.md).
See [Platform Compatibility And Verification Boundaries](../reference/platform-compatibility.en.md)
for the distinction between host OS, actual target, static validation,
target-native smoke, and published acceptance. UI and CLI application-update
checks only report the version and matching action; they do not replace the
running directory. See [Application Updates](application-updates.en.md).

## Which Feature Should I Use?

| Goal | Recommended entry |
|---|---|
| Ask a quick fact about one trace | AI Assistant + `fast` |
| Deeply analyze startup, scrolling, or ANR | AI Assistant + `full` or `auto` |
| Inspect one selected time range or slice | Perfetto selection + AI Assistant |
| Produce a shareable conclusion | HTML report |
| Temporarily compare a reference trace in this conversation | `compare_arrows` live trace comparison |
| Compare completed results across windows or users | `fact_check` multi-trace result comparison |
| Retrieve Android Internals background | Built-in Knowledge Pack; explicit knowledge source for private material |
| Map findings to local source files and line ranges | Code-Aware Analysis |
| Decide whether an analysis is worth reporting and what to contribute | “Ask the Agent whether to report this” below the result |
| Review and apply a qualified analysis improvement | Settings -> Evolution |
| Run one deterministic analysis across local traces | `smp batch skill` |
| Propose a config, then record from an Android device | `smp capture suggest/config/android` |
| Integrate with scripts or platforms | API / CLI / MCP tools |

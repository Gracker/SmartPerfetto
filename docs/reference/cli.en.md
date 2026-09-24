<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# SmartPerfetto CLI

[English](cli.en.md) | [中文](cli.md)

SmartPerfetto CLI is the official terminal entry point. Use `smp` or
`smartperfetto` to configure, diagnose, analyze traces, ask follow-up questions,
run SQL, run Skills, export reports, and manage local history without starting
the Web UI.

## Install

```bash
npm install -g @gracker/smartperfetto
```

Node.js 24 LTS is required. The npm CLI package bundles pinned
`trace_processor_shell` prebuilts for Linux x64, macOS arm64, and Windows x64.
On unsupported platforms the CLI downloads the pinned binary; if automatic
download is unavailable, set `TRACE_PROCESSOR_PATH` to an existing local
executable.
The CLI package is the standalone terminal product; it does not start or bundle
the Web UI launcher. Use Docker or a GitHub portable package for the browser
experience.

## Global Options

```text
Usage: smp [options] [command]

Options:
  -V, --version             output the version number
  -f, --file <trace>        trace file to analyze (shortcut for `analyze <trace>`)
  -p, --prompt <question>   analysis prompt (shortcut for --query)
  -q, --query <question>    analysis question (alias for --prompt)
  --session-dir <path>      override session storage root (default: ~/.smartperfetto)
  --env-file <path>         path to explicit .env file (skips default env chain)
  --verbose                 show verbose event stream
  --no-color                disable ANSI colors
  --resume <sessionId>      start the REPL with this session already loaded
  -h, --help                display help for command
```

For parallel regression jobs, give each case a different
`--session-dir /tmp/smp-sessions/<case>` and use the same directory for subsequent
`ask`, `list`, and `report` commands. Shared SQLite already waits up to five
seconds for locks; separate directories isolate test state and do not replace
investigation of persistent contention.

Session markers: `✓` delivered with checks passed or not applicable; `~`
delivered but checks did not complete (for example an invalid conclusion
declaration or a timed-out semantic review) — do not treat it as verified; `!`
the run did not finish, or claims contradicted the evidence and quality checks
failed; `✗` failed. The claim-verification line under the conclusion separates
claims whose references matched the captured evidence, propositions a finite
proof established, claims the whole review verified, contradicted claims and
values rounded without an approximation marker (unverified, not contradicted);
whole-answer issues such as undeclared assertions, which leave the answer
unverified (`~`) rather than contradicted, follow `also:`, and the
review's not-checked reason is kept in every status. The HTML report and the
receipt's claim audit use the same counts. While the final semantic review runs,
a `final_review` progress line shows its start (with its deadline) and outcome.
Without findings, confidence is a fixed baseline and
the text output omits it. JSON/NDJSON `complete` events carry `deliveryVerdict`
(`completed`/`unverified`/`partial`/`failed`).

Incomplete runs display their termination reason and available diagnostics,
distinguishing absent narrative from narrative that failed quality checks.
JSON/NDJSON also retain `terminationMessage` and `hasConclusion`.
`quality_gate_failed` can mean invalid declarations or evidence bindings, not
missing report sections. A budget above one reserves one no-tool summary of
returned data, findings, gaps and next steps; exhaustion remains `partial` /
`max_turns`. The original deadline, authorization and explicit cost budget still
apply. OpenCode records observed turns and retains the result without an extra
call if it has overshot the remaining allowance. `smp ask` passes history
separately from the new question, retains completeness metadata and allows
on-demand recall of older text. Evidence from a reloaded trace remains historical,
not newly verified evidence for the new trace identity.

## Core Workflow

```bash
smp run trace.perfetto-trace "Analyze why startup is slow"
smp ask <sessionId> "Why is RenderThread slow?"
smp repl --resume <sessionId>
```

Compatibility commands remain available:

```bash
smp analyze trace.perfetto-trace --query "Analyze why startup is slow"
smp resume <sessionId> --query "Follow up"
smp list
smp show <sessionId>
smp report <sessionId> --open
smp rm <sessionId>
```

Analysis commands support machine-readable output:

```bash
smp run trace.perfetto-trace "Analyze why startup is slow" --format json
smp resume <sessionId> --query "Follow up" --format ndjson
```

Supported `--format` values: `text`, `json`, `ndjson`.

## Application Updates

```bash
smp update check
smp update check --format json
```

This checks the stable npm release and returns the current build identity,
check time, status, and explicit upgrade command. It is notification-only and
never installs a package, replaces files, or mutates the current process.
Interactive text commands may print a once-per-day, per-target-version reminder
to stderr after completion. CI, redirected output, `--format json` / `--json`,
help, version, and the `update` command itself never receive an extra reminder.
Set `SMARTPERFETTO_UPDATE_CHECK=off` to disable application update checks.

## Config And Providers

```bash
smp doctor --format text
smp doctor --format json
smp probe
smp config init
smp config init --force
smp provider list
smp provider list --format json
smp provider test system
smp provider test <providerId> --format json
```

`smp probe` loads the strategy registry with the exact artifact being invoked
(dist or tsx) and prints `strategies OK <N>`, or the parse error with file and
requirement context on failure. A strategy-file/parser version skew kills every
analysis session at startup; use it as a pre-batch gate on the same build.

CLI configuration and Web UI configuration are separate by default. The CLI
Provider store is `<CLI home>/runtime/data/providers.json`, normally
`~/.smartperfetto/runtime/data/providers.json`; a source Web backend defaults to
`backend/data/providers.json`. A Web Provider change applies to the CLI only
when both processes explicitly use the same `SMARTPERFETTO_BACKEND_DATA_DIR`.

For first-time CLI setup, run `smp config init`, then edit the printed env file,
usually `~/.smartperfetto/env`. When `--env-file` is not passed, the CLI loads:

1. `backend/.env` from the package or source backend directory.
2. `~/.smartperfetto/env`, which overrides earlier values.

If you pass `--env-file /path/to/env`, the CLI reads only that file. Enable only
one CLI provider source for first setup: an active profile already present in
the current CLI store, one Claude-compatible env block, or one OpenAI-compatible
env block. `smp provider list` and `smp provider test <providerId>` inspect that
CLI store; the CLI does not currently add, edit, or activate profiles.

Runtime checks follow the actually selected provider/runtime:

- Claude Agent SDK requires an API key/auth token or Bedrock/Vertex configuration.
  A proxy URL or Claude Code login alone fails preflight, doctor, and system provider tests.
- OpenAI Agents SDK requires `OPENAI_API_KEY` or a local
  `localhost` / `127.0.0.1` / `0.0.0.0` OpenAI-compatible endpoint.
- Ollama providers use the OpenAI-compatible runtime.

When `SMARTPERFETTO_AI_ENABLED=false`, `smp doctor` prints the AI policy.
`smp analyze`, `smp resume`, `smp provider test`, and
`smp capture android --analyze` return `AI_DISABLED` before runtime/provider
checks; `smp query`, deterministic `smp skill`, `smp batch skill`,
`smp capture config`, capture without `--analyze`, and `smp provider list`
remain available. Invalid `SMARTPERFETTO_AI_ENABLED` values fail closed and are
reported as `aiPolicy.env.valid=false` in doctor JSON.

The first CLI productization pass does not include `provider add/edit`; key
writing still goes through env files or a later secure interaction design.

## Android Internals Knowledge Pack

```bash
smp knowledge-pack status
smp knowledge-pack status --format json
smp knowledge-pack update --check
smp knowledge-pack update
```

`status` reports the active Pack, bundled snapshot, and signed-channel state.
`update --check` refreshes and verifies TUF metadata without installing
content; `update` atomically installs the stable Pack after signature, version,
hash, and revocation checks pass. The bundled snapshot distributed with npm,
Docker, source, and portable packages remains available offline. Analysis
projects provenance, version, and snippet hashes into logs/SSE; background
content is not represented as trace evidence.

See [Android Internals Knowledge Pack And Private Knowledge](../getting-started/android-internals-knowledge.en.md)
for licensing, updates, and private-source boundaries.

## Trace Query And Skills

```bash
smp query trace.perfetto-trace --sql "select count(*) as cnt from slice"
smp query trace.perfetto-trace --sql "select count(*) from slice" --format json

smp skill trace.perfetto-trace startup_slow_reasons
smp skill trace.perfetto-trace startup_slow_reasons --params '{"package":"com.example"}' --format json
```

`query` and `skill` do not start the Web UI. `skill` loads SmartPerfetto's YAML
Skills and SQL fragments.

## Batch Trace Skill

```bash
smp batch skill startup_analysis launch-a.pftrace launch-b.pftrace
smp batch skill startup_analysis \
  --trace-list traces.txt \
  --params '{"package":"com.example"}' \
  --concurrency 2 \
  --format json \
  --out batch-report.html \
  --json-out batch-result.json
```

`smp batch skill` runs one deterministic YAML Skill across multiple local
traces. It does not require or call an LLM provider. CLI input is local trace
paths; `--trace-list` reads one path per line, skipping blank lines and `#`
comments. Paths are resolved to absolute paths before deduplication.

Supported output formats are `text`, `json`, and `ndjson`. `text` and `ndjson`
emit one progress/result event per trace, then the final `BatchTraceRunV1`.
When `--out` or `--json-out` is omitted, artifacts are written under:

```text
~/.smartperfetto/
└── batch-runs/<runId>/
    ├── result.json
    └── report.html
```

Defaults are 100 traces per run, concurrency 2, and max CLI concurrency 4.
They can be tuned with `SMARTPERFETTO_BATCH_TRACE_MAX_TRACES`,
`SMARTPERFETTO_BATCH_TRACE_DEFAULT_CONCURRENCY`, and
`SMARTPERFETTO_BATCH_TRACE_MAX_CLI_CONCURRENCY`. Standard startup / scrolling
metrics are promoted to analysis-result comparison metric keys; unmapped
numeric values remain batch-local metrics and are not forced into standard
comparison keys.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | All traces completed |
| `1` | At least one trace failed, or the whole batch failed |
| `2` | Invalid CLI input, such as no traces, non-object `--params`, or invalid concurrency |

The first release does not support raw batch SQL, remote workers, browser UI
execution, or automatic analysis-result snapshot creation. To use batch results
in multi-result comparison, use the workspace Batch Trace API explicit snapshot
promotion / comparison bridge.

## Code-Aware Analysis

Register a local codebase first, then explicitly expose it to an analysis
session. Registration does not attach source automatically, and indexing is an
optional accelerator:

```bash
smp codebase preview /path/to/app --kind app_source --path-filter app/src/main/ --exclude-glob '**/generated/**'
smp codebase register /path/to/app --kind app_source --name MyApp --path-filter app/src/main/ --exclude-glob '**/generated/**' --dry-run
smp codebase register /path/to/app --kind app_source --name MyApp --path-filter app/src/main/ --exclude-glob '**/generated/**'
smp codebase list
smp codebase list --format json

# Supplying both option families replaces both pathFilters and excludeGlobs
smp codebase selection cb_xxx \
  --path-filter app/src/main/ \
  --exclude-glob '**/generated/**'

# Provider-send consent and current-scope/new-language authorization
smp codebase consent cb_xxx --enable
smp codebase authorize-selection cb_xxx
smp codebase authorize-extensions cb_xxx

# Lifecycle audit, exact pending-candidate CAS, and deletion
smp codebase audit cb_xxx --format json
smp codebase pending cb_xxx --accept --candidate generation_xxx
smp codebase pending cb_xxx --reject --candidate generation_xxx

# Optional index for semantic/symbol lookup and patch workflows
smp codebase reindex cb_xxx
smp codebase symbols MainActivity --codebase-id cb_xxx

# Destructive: retire the registration and remove all indexed generations
smp codebase delete cb_xxx --yes

smp run trace.perfetto-trace \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  "Find the startup bottleneck and map it to source code"
```

`metadata_only` exposes only `CodeRef` metadata to the model; raw source text is
not persisted into sessions, reports, or exports. `provider_send` can send
snippets only when the codebase was registered with `--send-to-provider` and the
current analysis also uses `--code-aware provider_send`. Supplying only
`--codebase-id` defaults to `metadata_only`; combining a codebase ID with
`--code-aware off` is rejected. A run is trace-only only when no codebase or
knowledge-source ID is selected. `--knowledge-source-id <id>` can enable an
authorized private external RAG source alone or together with a codebase.
Source, private RAG, and reference-trace selections resolve an explicit `fast`
request to `full` so the lightweight runtime cannot silently drop capabilities.
`preview` and `register --dry-run` report the actual `ripgrep → git → node-walk`
enumeration backend, fidelity, completeness, and truncation reason. A bounded
preview truncation remains a successful command rather than masquerading as a
process failure. Portable packages do not bundle ripgrep and safely degrade in
that order when it is unavailable.

`selection` replaces only fields supplied explicitly: `--path-filter` replaces
`pathFilters`, while `--exclude-glob` replaces `excludeGlobs`. An omitted field
preserves its existing list; only a command containing both option families
replaces both lists. An effective change advances the selection revision,
invalidates the old active index, and may make the provider grant stale.
`authorize-selection` grants only the current path scope;
`authorize-extensions` grants only currently available new languages, and
neither turns provider-send on. `pending` must echo the exact current candidate
ID from `list` / `audit`. `delete` requires explicit `--yes`.

CLI `reindex` accepts only a codebase ID and has no `pathPrefix` option. Manage
path scope with `selection --path-filter`. Registration keeps `--commit` for
legacy callers, but it is caller-supplied compatibility metadata. Every index
derives the actual Git `HEAD`, worktree dirty state, and content fingerprint;
those `audit` fields are the authoritative index provenance.

Management-command exit codes are stable for automation: `0` success, `2`
invalid input/selection, `3` codebase not found, `4` busy, missing consent, or
pending CAS conflict, and `5` another management failure. `register`, `reindex`,
and `symbols` retain their legacy `0/1` behavior.
See [Code-Aware Analysis](../getting-started/code-aware-analysis.en.md).

## Trace Comparison

```bash
smp compare baseline.perfetto-trace comparison.perfetto-trace --query "Compare startup differences"
smp compare baseline.perfetto-trace comparison.perfetto-trace --query "Compare jank root causes" --format ndjson
```

`compare` passes the second trace as the reference trace and enables dual-trace
analysis tools in the AI runtime. CLI compare and frontend Raw Trace Compare
share the same comparison identity, evidence pack, report section, and session
snapshot rules; this is not a private CLI prompt. The shared comparison
contract requires metric matrices, phase/hotspot deltas, blocking and scheduling
differences, ruled-out system factors, evidence limits, and next steps instead
of only a duration delta. The shared deterministic SQL evidence covers package,
Perfetto's raw startup_type, duration delta, startup-window top slices, and
main-thread state distribution. Treat startup_type as a raw Perfetto field, not
a second classification; cold/warm conflicts must be called out as evidence
limits in the report body.

## Reports And History

```bash
smp list
smp list --json
smp list --format json
smp show <sessionId>
smp report <sessionId>
smp report <sessionId> --turn 1
smp report <sessionId> --open
smp report export <sessionId> --format html --out report.html
smp report export <sessionId> --turn 1 --format html --out turn-001.html
smp report export <sessionId> --format md --out report.md
smp report export <sessionId> --format json --out report.json
```

CLI files are stored under:

```text
~/.smartperfetto/
├── index.json
├── traces/
└── sessions/<sessionId>/
    ├── config.json
    ├── conclusion.md
    ├── report.html
    ├── source-use-decision.json
    ├── source-claim-bindings.json
    ├── ui-action-proposals.json
    ├── transcript.jsonl
    ├── stream.jsonl
    └── turns/
        ├── 001.md
        ├── 001.source-use-decision.json
        ├── 001.source-claim-bindings.json
        ├── 001.ui-action-proposals.json
        └── 001.html
```

The source sidecars exist only when the turn has canonical safe source
provenance. Latest files are replaced by later turns; a source-free turn clears
stale latest sidecars but preserves historical per-turn files. JSON, Markdown,
and HTML can retain authorized `provider_send` source quotations in the analysis
body and formal claims. The two source metadata sidecars contain only safe
decisions, relative `CodeRef` values and mechanism bindings, without absolute
roots, snippets, search queries or free-text binding reasons. Output projection
continues to protect credentials, private canaries and absolute roots.

`conclusion.md` and `turns/NNN.md` retain the body records. Separate
`analysis-evidence.json` and `turns/NNN.analysis-evidence.json` files bind display
data to the same session, turn and candidate body. Terminal output, `show` and
Markdown export show all claims, references, verification issues and source
bindings; JSON/NDJSON also carry structured details. A malformed or mismatched
bundle is reported as unavailable without borrowing verification from another
turn. These files are for display and do not issue evidence or rerun verification.

`ui-action-proposals.json` stores evidence links and UI proposal metadata for
reports and later turns only. The CLI does not automatically execute timeline
navigation, table opening, or evidence pinning.

## Android Capture

`smp capture` records Android system traces from a connected device. It follows
Perfetto's Android/Linux system-tracing model: use the device `perfetto` binary
on Android Q/API 29 and newer, and use a packaged or explicitly supplied
`tracebox` only for older devices or `--sideload`.

```bash
smp capture presets
smp capture suggest "debug startup jank" --app com.example.app --format json
smp capture suggest "investigate scrolling frame drops; do not record yet" --app com.example.app
smp capture suggest "Analyze Camera open-to-first-preview latency" --app com.example.camera
smp capture suggest "find the Java heap leak" --app com.example.app
smp capture config --preset startup --app com.example.app --duration 10 --out startup.pbtxt
smp capture config --preset camera --app com.example.camera --duration 20
smp capture config --preset cpu --app '*' --duration 30 --categories dalvikviktime my_custom_tag --out cpu-custom.pbtxt
smp capture config --preset power --app com.example.app --duration 60 --out power.pbtxt
smp capture config --preset memory-profile --app com.example.app --out memory-profile.pbtxt

smp capture android --preset startup --app com.example.app --duration 10 --out launch.perfetto-trace
smp capture android --preset scrolling --app com.example.app --duration 15 --serial <adbSerial> --out scroll.perfetto-trace
smp capture android --preset power --app com.example.app --duration 60 --out power.perfetto-trace
smp capture android --preset memory-profile --app com.example.app --duration 60 --out memory-profile.perfetto-trace
smp capture android --config startup.pbtxt --out launch.perfetto-trace
smp capture android --config template.pbtxt --duration 10 --categories my_custom_tag --out custom.perfetto-trace
smp capture android --preset overview --app com.example.app --duration 10 --kill-stale --out retry.perfetto-trace
smp capture android --preset game --app com.example.game --duration 20 --out game.perfetto-trace --analyze --query "Find launch and frame pacing issues" --mode fast
```

Available presets: `startup`, `scrolling`, `camera`, `anr`, `game`, `memory`,
`memory-profile`, `cpu`, `power`, `overview`, and `full`. Every system-wide preset
(all except `memory-profile`) enables `power/cpu_frequency` and
`power/cpu_frequency_limits`; the latter carries each CPU's frequency bounds and
separates "low frequency because the load is low" from "clamped". `cpu` and
`power` also enable `thermal/thermal_temperature` and `thermal/cdev_update` so a
clamp can be matched against thermal-zone temperature in the same window. Those
tracepoints depend on device and kernel support and are not exposed everywhere.
`power` additionally enables `android.power` battery
counters, power rails, suspend/wakeup ftrace, and `android.network_packets`.
`camera` collects Camera/HAL/vendor atrace candidates, Binder, scheduler,
FrameTimeline, and DMA-BUF or legacy ION events. These tracepoints are optional
and vary by Android release, kernel, and vendor implementation. Even with this
preset, a trace may lack portable Camera open, request/result, buffer, or
preview-presentation anchors. SmartPerfetto reports that evidence gap instead
of fabricating an open-to-first-frame number.

`memory-profile` profiles one app process, following Perfetto's Memscope
single-process recipe. It records `linux.process_stats` memory counters every
second, `android.packages_list` (which shows whether the app was profileable or
debuggable), `android.heapprofd` native heap samples (32 KiB sampling, a dump
every 5 s), `android.java_hprof` Java heap dumps, and a small `linux.ftrace`
buffer with `ftrace/print` plus the `dalvik`, `am`, and `wm` atrace categories.
It differs from the system-wide presets in several ways:

- `--app` must name one concrete package or process (for example
  `com.example.app` or `com.example.app:remote`); `--app '*'`, an empty value,
  and glob patterns are rejected by `capture config`, `capture android`, and the
  renderer itself.
- The device must run Android 11 (API 30) or later with its built-in `perfetto`:
  heapprofd needs API 29 and `java_hprof` needs API 30. `capture android` probes
  the device and fails before any device-side work on an older device or with
  `--sideload`, because tracebox does not provide the platform profiler daemons.
- On user builds the app must be profileable or debuggable; otherwise the
  profilers record nothing for it. Each Java heap dump pauses the app while the
  heap is written. Both caveats appear as preflight warnings.
- Start the app before capturing. Java heap dumps happen when the trace starts
  (the baseline) and then every `max(10 s, (duration - 10 s) / 2)`, so the
  default 60 s capture yields three dumps at about 0 s, 25 s, and 50 s. The
  duration must be at least 20 s so a second dump follows the baseline.
- The config uses four buffers instead of one scaled ring: process stats and
  packages list (RING, 64 KB per second of duration, 8-128 MB), heapprofd
  (RING, 128 MB), `java_hprof` (DISCARD, 256 MB), and ftrace (RING, 16 MB).
  DISCARD keeps the baseline dump intact; a late dump that no longer fits is
  truncated, and the heap-graph analysis reports it as incomplete. A buffer size
  override (`bufferSizeKb` in the config API) sets the `java_hprof` buffer and
  must be at least 256 MB. `--cuj` has no effect on this preset.
- The config omits `java_hprof` `smaps_config` (needs Android build
  ZP1A.260626.001 or newer) and `process_stats` `record_process_age`, both used
  by Memscope, because the device rejects config fields its perfetto does not
  know.

`smp capture suggest` proposes `memory-profile` for heap-dump, hprof, Java heap,
heap graph, and memory-leak requests when `--app` names a concrete package.
Without one it keeps the system-wide `memory` preset and says in the rationale
that heap dumps need `--app`.

`smp capture suggest` is side-effect free: it maps natural language to a
built-in preset and returns rationale, warnings, recommended commands, and a
textproto preview rendered by the same config renderer. It does not call an LLM,
ADB, or tracebox, and it does not record the device. Actual capture still
requires an explicit `smp capture android ...` command.
Use `--app '*'` when you intentionally want system-wide
atrace categories instead of app-scoped atrace tags. `--categories` injects
additional atrace tags into generated configs or an existing `ftrace_config`.
Generated configs scale the primary buffer with duration, roughly 8 MB/s clamped
between 64 MB and 512 MB. `--config <pbtxt>` keeps the old
`record_android_trace -c ... -o ...` workflow shape; plain configs pass through,
and templates may contain `{duration_ms}` and `{buffer_size_kb}` placeholders
that are rendered when `--duration` is provided.

Capture preflight checks warn when stale `perfetto` / `simpleperf` / `traced`
processes or SELinux `Enforcing` are detected. `--kill-stale` applies the stale
process cleanup before capture; it is opt-in because it kills tracing services
on the device.

Source checkout example:

```bash
npm --prefix backend run cli:dev -- capture android \
  --config ~/tools/perfetto_shell/perfetto.config \
  --out ~/tools/perfetto_shell/trace/dut-game-launch.ptrace
```

`--analyze` records the trace and immediately starts the normal CLI analysis
session. The captured trace path, target, serial, preset/config, tools, and
`--mode fast|full|auto` metadata are persisted in the session config so the
result can be resumed and audited.

Tool resolution is intentionally offline during capture. `adb` is resolved from
`ADB_PATH`, then an approved bundled slot
`prebuilts/android-platform-tools/<host>/adb`, then `PATH`. Android SDK
Platform-Tools binaries are not blindly redistributed. Sideload capture resolves
device-ABI `tracebox` from `prebuilts/perfetto-recording-tools/android-*/` or
`--tracebox`; missing tools produce explicit override guidance. macOS, Windows,
and Linux hosts can capture Android devices. Linux host system tracing is
reserved for a future `smp capture linux` target.

Pass `--serial` when multiple devices are connected.

## REPL

```bash
smp repl
smp repl --resume <sessionId>
```

REPL commands:

| Command | Purpose |
| --- | --- |
| `/load <trace>` | Load a trace and start analysis |
| `/ask <query>` | Ask against the current session |
| `/resume <sessionId>` | Switch to an existing session |
| `/report` | Print the latest report path |
| `/focus` | Show current session state |
| `/clear` | Clear the terminal |
| `/exit` | Exit |

## System investigation output

The CLI reports system investigation coverage separately from system evidence coverage, with Not checked for missing historical fields. Machine-readable conclusion records include `investigationAssurance` without changing the original conclusion or native completion. Each turn also saves `NNN.investigation-assessment.json` and `NNN.delivery-assurance.json` with dimension statuses and evidence references. The HTML report shows the same investigation scope. Restoring historical results does not automatically acquire missing evidence.

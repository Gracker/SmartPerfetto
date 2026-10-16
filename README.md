# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](docs/sponsor.en.md)

> AI-powered Android performance analysis built on [Perfetto](https://perfetto.dev/).

SmartPerfetto adds an AI analysis layer to Perfetto traces. Load a trace, ask a
natural-language question, and get an evidence-backed answer with SQL results,
Skill outputs, root-cause reasoning, and optimization suggestions.

**Bring your own device or team knowledge.** Add documents describing private
trace tags, trace passages and version differences from the AI Assistant context
control → "Manage…" → "Document knowledge bases", index them, then select them
per turn. The model can look up definitions and cite files and lines; below each
answer you can see retrieved passages and answer citations separately. This helps
reduce guesses about private names while SQL/Skills establish current-trace facts.
Matching text is sent to the AI service you authorize. See the
[Private Knowledge guide](docs/getting-started/private-knowledge.en.md).

The project is open source and in active development. The Web UI, CLI, backend
runtime, and Skill system are usable today, while public APIs and internal
contracts may still evolve.

<!-- android-performance-ecosystem:start -->
## Android performance ecosystem

The [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) brings its navigation Hub and seven core projects into an optional path from instrumentation and capture to analysis, system knowledge, and reproducible cases.

| Stage | Project | Purpose | Address |
| --- | --- | --- | --- |
| Navigate | [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) | Maintain the shared project map, handoff metadata, generated README navigation, and drift checks. | [GitHub](https://github.com/Gracker/android-performance-ecosystem) |
| Instrument | [TraceFix](https://github.com/Gracker/TraceFix) | Inject app-side android.os.Trace sections at build time so method work is visible at runtime. | [GitHub](https://github.com/Gracker/TraceFix) |
| Capture and measure | [Perfetto Tools](https://github.com/Gracker/perfetto-tools) | Capture repeatable Perfetto traces and collect FPS or Simpleperf measurements. | [GitHub](https://github.com/Gracker/perfetto-tools) |
| Analyze | [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | Investigate traces with an AI-assisted Web UI, CLI, reports, sessions, comparisons, and evidence workflow. | [GitHub](https://github.com/Gracker/SmartPerfetto) |
| Agent analysis | [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | Give agents a portable Perfetto analysis Skill for Android, Linux, and Chromium, with selected assets synchronized through pinned workflows. | [GitHub](https://github.com/Gracker/Perfetto-Skills) |
| Learn | [Android Performance Blog](https://github.com/Gracker/Gracker.github.io) | Teach Perfetto and Systrace analysis through articles, system explanations, and case studies. | [AndroidPerformance.com](https://www.androidperformance.com/) · [GitHub](https://github.com/Gracker/Gracker.github.io) |
| System knowledge | [Android Internal Wiki](https://github.com/Gracker/android-internals-wiki) | An alpha knowledge base for Android mechanisms from App to Framework, Native, and Kernel. | [GitHub](https://github.com/Gracker/android-internals-wiki) |
| Reproduce | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | Provide the Perfetto, Systrace, and related case files used by articles for hands-on reproduction. | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

Register the public Android Internals Wiki (or your own team documents) as a document knowledge base so analyses can search it on demand and cite its sources. See the [Android Internals Knowledge guide](docs/getting-started/android-internals-knowledge.en.md).

## What It Does

- Analyzes Android Perfetto traces for scrolling jank, startup, ANR,
  interaction latency, memory, game, and rendering-pipeline issues.
- Investigates continuous main-thread work during scrolling and window animations,
  including tasks between doFrame callbacks, their execution/wait time and source
  clues. FrameTimeline provides outcome evidence; missing frames do not hide tasks.
- Keeps Perfetto's timeline and SQL workflow, then adds an AI Assistant for
  evidence-backed conclusions, follow-up questions, comparisons, and reports.
  At the turn limit, it delivers a conclusion from collected evidence with remaining
  gaps. Follow-ups inherit authorized history in the same session, including after
  reopening the page or restarting the backend.
- Uses deterministic YAML Skills and Markdown strategies so factual evidence,
  model interpretation, and report provenance remain separate.
- Relates critical tasks to CPU frequency, system load, thread states, CPU
  placement and scheduling evidence when the question needs them. Scene-wide
  investigations start with the strategy's entry Skill when its trace and
  process prerequisites are satisfied; missing evidence remains explicit.
- Optionally selects registered local source per run, uses bounded on-demand
  lookup without requiring an index, and separates trace occurrence from
  `CodeRef` mechanism evidence in safe Web, report, CLI, snapshot, and API
  provenance. Choose a folder and **Add and use for analysis** to get started;
  see the [source analysis guide](docs/getting-started/code-aware-analysis.en.md)
  for excluded paths and optional indexing. Relevant snippets are sent to the configured
  AI service; source lookup adds analysis time. Results and quoted source can be
  retained in local history and exports; AI-service retention depends on its policy.
- Optionally selects your device or team document knowledge bases per turn to
  explain private tags and trace passages, searched on demand and cited; a
  knowledge base is background, never a substitute for current-trace evidence.
  See [Private Knowledge](docs/getting-started/private-knowledge.en.md) and
  [Android Internals Knowledge](docs/getting-started/android-internals-knowledge.en.md).
- Delivers first, verifies after: the Claude and OpenAI runtimes stream the
  answer as a draft while it is written. A finished answer remains readable
  while an eligible, budgeted no-tool review checks it. Stopping that review
  keeps the answer; full and forced stops have separate semantics.
- Opens a critical-path wait-chain drawer on a selected `thread_state`, and a
  flamegraph page for CPU call-stack hotspots, both with a rule-based fallback
  AI summary. See [Critical Path And Flamegraph](docs/getting-started/critical-path-and-flamegraph.en.md).
- Captures traces from a connected Android device with `smp capture`, from
  presets or your own config, optionally analyzing right after capture.
- Sends UI selections as identity and time bounds only; the backend re-queries
  descriptive facts and runs `/anr` or `/jank` through the same evidence and
  verification pipeline.
- Supports the browser UI, the `smp` CLI, and HTTP/SSE integration. See the
  [Feature Overview](docs/getting-started/features.en.md) for the complete scope.

## Quick Start

### 1. Choose A Distribution

- **Windows desktop**: download the `windows-x64` archive from the
  [latest release](https://github.com/Gracker/SmartPerfetto/releases/latest),
  extract it completely, and run `SmartPerfetto.exe`. Follow the
  [Windows Guide](docs/getting-started/windows.en.md).
- **macOS or Linux desktop**: use the matching portable release asset. The
  package includes Node.js, the backend, pre-built UI, and trace processor.
- **Docker**: clone the repository, then run:

  ```bash
  docker compose -f docker-compose.hub.yml up -d
  ```

- **Source checkout**: requires Node.js 24 LTS. Clone the repository, then run:

  ```bash
  ./start.sh
  ```

- **Terminal or automation**: install the standalone CLI with Node.js 24:

  ```bash
  npm install -g @gracker/smartperfetto
  smp doctor
  ```

If npm reports that dependency install scripts were blocked or skipped, review
those scripts and retry with approval limited to the required packages:

```bash
npm install -g @gracker/smartperfetto --allow-scripts=better-sqlite3,opencode-ai
```

`better-sqlite3` provides the native SQLite binding used by core CLI commands;
`opencode-ai` needs its install script when selecting the OpenCode runtime.
Package-publisher approvals do not approve scripts for your installation. See
[npm's install policy](https://docs.npmjs.com/cli/install/) and the
[CLI installation guide](docs/reference/cli.en.md#when-npm-blocks-install-scripts)
for project-local approval and doctor/query checks.

The complete prerequisites and distribution choices are in the
[Quick Start](docs/getting-started/quick-start.en.md).

### 2. Configure One AI Provider

After the Web UI starts, open **AI Assistant Settings → Providers**, add one
provider, save it, test it, and activate it. Local source runs may instead configure explicit provider credentials in
`backend/.env`. Claude Code login does not configure the SDK. Do not configure every
runtime for the first launch; choose one provider path and follow the
[Configuration Guide](docs/getting-started/configuration.en.md). Advanced
Qoder users can also route models through the documented BYOK policy while
keeping Qoder PAT or `qodercli` authentication separate. Saved providers also
refresh their model suggestions from supported provider catalogs with a bounded
cache; unsupported or unavailable catalogs keep the curated preset list.

Pi users can configure reasoning in model JSON; see the [Pi configuration](docs/getting-started/configuration.en.md#llm-configuration) for provider defaults, explicit off and supported effort mappings.

### 3. Run Your First Analysis

1. Open the launcher's printed `Open:` URL, or
   [http://localhost:10000](http://localhost:10000) for the default Docker or
   source setup.
2. Load a `.pftrace` or `.perfetto-trace` file.
3. Open the AI Assistant panel.
4. Ask a question such as `Analyze scrolling jank`, `Why is startup slow?`, or
   `Analyze the ANR in this trace`.

Server verification details are collapsed by default; expand them to read the full record. Verification warnings remain visible. Completed analyses are delivered normally, with verification concerns and coverage gaps labelled separately for users to assess against the evidence.
Web, CLI and exported reports retain each claim's evidence and verification
status. A malformed claim leaves other valid claims eligible for checking;
missing proof and a contradicted claim remain distinct outcomes.
Explicitly bound numeric displays are checked against captured evidence before semantic review, including unit conversion and rounding; model agreement cannot override a wrong display. Raw citations and propositions retain full precision. Correct formatting proves neither scope nor causality; older output retains the conservative rounding-warning path.
Final conclusions retain all material findings, supporting evidence and limitations within the requested scope, even when intermediate tables are hidden. Length alone does not justify dropping findings or claims.
Final answers prefer compact tables for comparable metrics, phase timings and trace differences, alongside explanations and evidence references. Single values and questions better answered in prose remain free-form.
HTML reports retain captured table columns, nested values and provenance. Metric tables show declared units and explicit warning labels; ordinary observations carry no health verdict. Save HTML uses a local browser download, and printing expands captured details. See [HTML analysis reports](docs/getting-started/features.en.md#5-html-analysis-reports) for historical report limits.

Each round shows its analysis process and steps above its final conclusion,
which stays before the next round's question.

For CLI use:

```bash
smp run trace.pftrace "Analyze scrolling jank"
```

Incomplete CLI runs show the termination reason and available diagnostics;
a report body can still fail evidence or declaration checks. See the
[CLI result guidance](docs/reference/cli.en.md#global-options).

## Documentation

- Start here: [Documentation Center](docs/README.en.md),
  [Quick Start](docs/getting-started/quick-start.en.md), and
  [Basic Usage](docs/getting-started/usage.en.md)
- Product setup: [Windows Guide](docs/getting-started/windows.en.md),
  [Configuration](docs/getting-started/configuration.en.md),
  [Application Updates](docs/getting-started/application-updates.en.md), and
  [Troubleshooting](docs/operations/troubleshooting.en.md)
- Integration: [CLI](docs/reference/cli.en.md),
  [HTTP/SSE API](docs/reference/api.en.md), and
  [MCP Tools](docs/reference/mcp-tools.en.md)
- Internals: [Architecture Overview](docs/architecture/overview.en.md),
  [Technical Architecture](docs/architecture/technical-architecture.en.md), and
  [Skill System](docs/reference/skill-system.en.md)

## Contributing And Support

GitHub Actions runs clean Linux build/contract checks on every PR/main push,
with Rust, macOS/Windows and Docker checks scoped to affected paths. Run the
complete `npm run verify:pr` locally before opening or landing a PR; full hosted
regression is available by manually running `backend-agent-regression-gate.yml`
with `full=true`. See [verification ownership](.claude/rules/testing.md#hosted-ci-and-local-verification).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use
[GitHub Issues](https://github.com/Gracker/SmartPerfetto/issues) for bugs and
feature requests, and the
[private advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new)
or `smartperfetto@gracker.dev` for security reports. Sponsorship and commercial
support details are in [docs/sponsor.en.md](docs/sponsor.en.md).

## License

[AGPL-3.0-or-later](LICENSE) for SmartPerfetto core code. The `perfetto/`
submodule remains under [Apache-2.0](https://github.com/google/perfetto/blob/main/LICENSE).
For commercial licensing without AGPL obligations, contact the maintainer on
WeChat: `553000664`.

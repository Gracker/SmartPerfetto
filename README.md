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
| System knowledge | [Android Internals Knowledge](docs/getting-started/android-internals-knowledge.en.md) | Use the signed bundled public Knowledge Pack, with an optional private `android-internals-wiki` checkout for approved local context. | [Guide](docs/getting-started/android-internals-knowledge.en.md) |
| Reproduce | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | Provide the Perfetto, Systrace, and related case files used by articles for hands-on reproduction. | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

## What It Does

- Analyzes Android Perfetto traces for scrolling jank, startup, ANR,
  interaction latency, memory, game, and rendering-pipeline issues.
- Keeps Perfetto's timeline and SQL workflow, then adds an AI Assistant for
  evidence-backed conclusions, follow-up questions, comparisons, and reports.
- Uses deterministic YAML Skills and Markdown strategies so factual evidence,
  model interpretation, and report provenance remain separate.
- Optionally selects registered local source per run, uses bounded on-demand
  lookup without requiring an index, and separates trace occurrence from
  `CodeRef` mechanism evidence in safe Web, report, CLI, snapshot, and API
  provenance.
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

The complete prerequisites and distribution choices are in the
[Quick Start](docs/getting-started/quick-start.en.md).

### 2. Configure One AI Provider

After the Web UI starts, open **AI Assistant Settings → Providers**, add one
provider, save it, test it, and activate it. Local source runs may instead use
an existing Claude Code login from the same terminal. Do not configure every
runtime for the first launch; choose one provider path and follow the
[Configuration Guide](docs/getting-started/configuration.en.md). Advanced
Qoder users can also route models through the documented BYOK policy while
keeping Qoder PAT or `qodercli` authentication separate.

### 3. Run Your First Analysis

1. Open the launcher's printed `Open:` URL, or
   [http://localhost:10000](http://localhost:10000) for the default Docker or
   source setup.
2. Load a `.pftrace` or `.perfetto-trace` file.
3. Open the AI Assistant panel.
4. Ask a question such as `Analyze scrolling jank`, `Why is startup slow?`, or
   `Analyze the ANR in this trace`.

For CLI use:

```bash
smp run trace.pftrace "Analyze scrolling jank"
```

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

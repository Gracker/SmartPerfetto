<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# SmartPerfetto CLI

[English](cli.en.md) | [中文](cli.md)

The CLI is the terminal entry point for SmartPerfetto analysis. It does not start the Perfetto frontend or the Express HTTP server. It runs local trace analysis through the same runtime selection, tools, Skills, report generation, and persistence pipeline used by the web experience.

## 1. Architecture

The `@gracker/smartperfetto` npm package exposes the CLI entrypoint. The CLI reuses the same core backend modules as the web server:

- `AgentAnalyzeSessionService.prepareSession()`
- Claude Agent SDK or OpenAI Agents SDK runtime selection
- Skill engine
- HTML report generation
- Session persistence
- Trace processor service

| Surface | Transport | Output |
|---|---|---|
| Web backend | Express routes + SSE | Browser panel and `/api/reports/` |
| CLI | Local process calls | Terminal renderer and `~/.smartperfetto/` files |

## 2. Install

```bash
# Requires Node.js 24 LTS
npm install -g @gracker/smartperfetto
```

The first analysis downloads the pinned `trace_processor_shell` if needed. If the download bucket is blocked, set `TRACE_PROCESSOR_PATH`, `TRACE_PROCESSOR_DOWNLOAD_BASE`, or `TRACE_PROCESSOR_DOWNLOAD_URL`.

## 3. Commands

```bash
smp -f trace.pftrace -p "Analyze scrolling jank"
smp resume <sessionId> --query "Why is RenderThread slow?"
smp list
smp show <sessionId>
smp report <sessionId> --open
smp rm <sessionId>
smp
```

`smartperfetto` remains available as the long command name. `smp` is the short alias.

## 4. REPL

| Command | Purpose |
|---|---|
| `/load <trace>` | Load a trace file |
| `/ask <query>` | Ask a question against the loaded trace |
| `/resume <sessionId>` | Resume an existing session |
| `/report` | Open or print the latest report |
| `/focus` | Show current focus/session state |
| `/clear` | Clear terminal display |
| `/exit` | Exit |

## 5. Storage

```text
~/.smartperfetto/
├── index.json
└── sessions/<sessionId>/
    ├── config.json
    ├── conclusion.md
    ├── report.html
    ├── transcript.jsonl
    ├── stream.jsonl
    └── turns/
```

The CLI session id remains stable across resume attempts. If SDK context cannot be restored, the CLI can fall back to a new backend/SDK session internally while continuing to write to the same local session folder.

## 6. Resume Semantics

| Level | Behavior |
|---|---|
| Level 1 | Reuse the persisted SDK session id and original trace id |
| Level 2 | Rebuild local trace processor state, then resume the persisted SDK context |
| Level 3 | Start a fresh SDK session and inject prior conclusion context as a preamble |

Level 3 preserves the user-facing CLI session folder but updates the internal SDK session id.

## 7. CI and Non-TTY Usage

```bash
smp analyze -f trace.pftrace -p "Analyze startup performance" --json
smp report <sessionId> --path
```

Do not rely on terminal-only rendering in CI. Prefer JSON or report-path output.

## 8. Known Limits

- The CLI still uses local trace_processor RPC ports `9100-9900`; "no HTTP server" means it does not expose the SmartPerfetto backend or Perfetto UI ports.
- Provider credentials follow the same runtime rules as the backend. See [Configuration Guide](../getting-started/configuration.en.md).
- Source checkout scripts are for maintainers debugging the package; normal users should install the npm package.

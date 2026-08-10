# SmartPerfetto Documentation Center

[English](README.en.md) | [中文](README.md)

<!-- i18n-headings: paired -->

This repository keeps only documentation that still defines the current user,
architecture, runtime, or maintainer contract. Start with the
[Quick Start](getting-started/quick-start.en.md). Git history, issues, and PRs
retain implementation history; completed plans, review reports, research dumps,
and agent evidence are not maintained as permanent documentation.

## Usage And Operations

- [Quick Start](getting-started/quick-start.en.md)
- [Windows Setup And Run](getting-started/windows.en.md)
- [Feature Overview](getting-started/features.en.md)
- [Basic Usage](getting-started/usage.en.md)
- [Configuration](getting-started/configuration.en.md)
- [Agent-Assisted GitHub Feedback](getting-started/agent-assisted-feedback.en.md)
- [Self-Evolution Usage And Acceptance](getting-started/self-evolution.en.md)
- [Code-Aware Analysis](getting-started/code-aware-analysis.en.md)
- [Multi-Trace Analysis Result Comparison](getting-started/multi-trace-result-comparison.en.md)
- [Android Internals Knowledge](getting-started/android-internals-knowledge.en.md)
- [Troubleshooting](operations/troubleshooting.en.md)

## Reference

- [CLI](reference/cli.en.md)
- [HTTP/SSE API](reference/api.en.md)
- [MCP Tools](reference/mcp-tools.en.md)
- [Skill System](reference/skill-system.en.md)
- [Platform Compatibility And Verification Boundaries](reference/platform-compatibility.en.md)
- [Release](reference/release.en.md)
- [Portable Packaging](reference/portable-packaging.en.md)
- [Windows Launcher](reference/windows-exe.en.md)
- Application updates: [product notice and update actions](../README.md#application-updates),
  [CLI](reference/cli.en.md#application-updates), [API](reference/api.en.md#application-updates)

## Core Architecture

- [Architecture Overview](architecture/overview.en.md): product entries, data flow, and output contract.
- [Technical Architecture](architecture/technical-architecture.en.md): component boundaries and change map.
- [Agent Runtime](architecture/agent-runtime.en.md): runtime, provider, and session semantics.
- [Dual Trace Workspace](architecture/dual-trace-workspace.en.md): dual-pane and comparison state machine.
- [Private Analysis Context](architecture/private-analysis-context.en.md): authorization, continuity, and deletion.
- [Self-Improving](architecture/self-improving-design.md): currently integrated and explicitly unavailable capabilities.
- Use the [Self-Evolution guide](getting-started/self-evolution.en.md) for the
  user entry point, permissions, persistence, and acceptance tests.
- Use [Agent-Assisted GitHub Feedback](getting-started/agent-assisted-feedback.en.md)
  when a regular user turns an analysis gap into an external report; it never
  enters Self-Evolution or GitHub automatically.
- [Data Contract](../backend/docs/DATA_CONTRACT_DESIGN.en.md): DataEnvelope, Query Review,
  Analysis Receipt, UI Actions, and cross-surface projections.

## Contribution And Governance

- [Contributing Guide](../CONTRIBUTING.md)
- [Agent Entry Rules](../AGENTS.md)
- [Product Surface Rules](../.claude/rules/product-surface.md)
- [Testing Rules](../.claude/rules/testing.md)
- [Security Policy](../SECURITY.md)
- [Sponsorship And Commercial Support](sponsor.en.md)

## Documentation Retention Policy

- Commit only documents required by current users, architecture, runtime, or maintenance workflows.
- Do not commit completed plans, RFC implementation logs, reviews, research dumps,
  presentation sources, or agent evidence. Merge durable conclusions into a core document.
- Strategies, prompt templates, Skill SOPs, test fixtures, licenses, and pre-built UI help
  happen to use Markdown but are runtime code or release assets, not ordinary docs.
- `npm run verify:docs` checks links, images, npm scripts, CLI coverage, release commands,
  and retired documentation topology. `npm run verify:i18n` checks bilingual product surfaces.

## Runtime-Read Content

`docs/rendering_pipelines/` is Android 17 teaching content synchronized from a pinned upstream
commit and copied into `backend/dist/rendering_pipelines/` during builds. Moving or changing it
requires synchronized pipeline catalog and Skill references plus:

```bash
npm run verify:rendering-pipelines
cd backend && npm run validate:skills
```

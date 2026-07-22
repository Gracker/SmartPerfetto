# SmartPerfetto MCP Tools Reference

[English](mcp-tools.en.md) | [中文](mcp-tools.md)

SmartPerfetto exposes trace data, Skills, knowledge lookup, code-aware lookup, and comparison capability to the active agent runtime through MCP-style tools. The current system is registry-driven, not a fixed-size tool list:

```text
Tool implementation
  -> backend/src/agentv3/claudeMcpServer.ts
  -> backend/src/agentv3/mcpToolRegistry.ts
  -> runtime-specific allowlist / function-tool adapter
  -> request-visible tool surface
```

`claudeMcpServer.ts` implements the tools. `mcpToolRegistry.ts` is the source of truth for descriptors, exposure levels, and allowlists. Claude runtime uses the in-process MCP server directly; OpenAI runtime reads the same registry and adapts descriptors into OpenAI Agents SDK function tools.

Do not hardcode the total tool count in code or docs. Treat the registry and tests as authoritative.

## Visibility Model

The request-visible tool surface is shaped by the analysis request:

| Scope | Enabled when | Typical tools |
|---|---|---|
| Quick / lightweight | fast or lightweight path | `execute_sql`, `invoke_skill`, `lookup_sql_schema`, optional `fetch_artifact` |
| Full analysis | full analysis path | data access, Skills, knowledge, baseline, memory, planning/hypothesis, and artifact tools |
| Code-aware | local codebase access is allowed | `list_codebases`, `lookup_app_source`, `lookup_kernel_source`, `resolve_symbol`, `propose_patch` |
| Comparison | request includes `referenceTraceId` | `execute_sql_on`, `compare_skill`, `get_comparison_context` |

Registry exposure levels distinguish public, internal, and permission-gated tools. They do not by themselves define the final user-visible set; runtime, mode, artifact store, codebase permission, comparison context, and allowlists all matter.

## Tool Lifecycle

```text
Agent wants a tool call
    │
    ├─ request constructs registry and allowlist
    ├─ runtime exposes request-visible tools
    ├─ full mode gates execute_sql / invoke_skill behind submit_plan
    ├─ tool runs SQL / Skill / lookup / comparison
    └─ structured result feeds SSE, report, snapshot, CLI artifact, or agent context
```

## Core Data Tools

| Tool | Purpose | Notes |
|---|---|---|
| `execute_sql` | Run Perfetto SQL on the current trace | Supports summary mode and artifact pagination/truncation |
| `invoke_skill` | Run a YAML Skill analysis pipeline | Preferred evidence path; returns DataEnvelope / artifacts |
| `list_skills` | List available Skills | Filterable by category; count comes from the file tree |
| `detect_architecture` | Detect rendering architecture for the trace | Guides strategy and pipeline analysis |
| `lookup_sql_schema` | Search Perfetto SQL schema / stdlib index | Available in quick and full paths |
| `query_perfetto_source` | Search Perfetto stdlib SQL source | Falls back to packaged indexes when source is absent |
| `list_stdlib_modules` | List Perfetto stdlib modules | Avoids putting the full module list in the prompt |

`execute_sql` and `invoke_skill` gather evidence; they are not the final report boundary. Final output still passes through result normalization, evidence/claim verification, report generation, snapshots, and frontend projection.

## Knowledge, Memory, And Baselines

| Tool | Purpose |
|---|---|
| `lookup_knowledge` | Load local performance knowledge, templates, or pipeline docs |
| `lookup_blog_knowledge` | Query blog or Android Internals background knowledge; `source=android_internals_pack` uses the signed built-in Pack, while `source=android_internals_wiki` uses a request-whitelisted private source id |
| `lookup_aosp_source` | Query AOSP-related source knowledge |
| `lookup_oem_sdk` | Query OEM SDK or vendor knowledge |
| `lookup_baseline` | Fetch historical baselines |
| `compare_baselines` | Compare baseline metrics |
| `recall_project_memory` | Retrieve project memory |
| `recall_similar_case` | Retrieve similar analysis cases |
| `recall_similar_result` | Retrieve similar analysis-result snapshots as `navigation_hint_only` output |
| `recall_patterns` | Retrieve patterns or anti-patterns, usually as internal analysis support |

Knowledge and memory support the investigation; they must not override current
trace evidence. The built-in `android_internals_pack` pins a signed version and
fingerprint. Private `android_internals_wiki` calls recheck scope, rights,
provider consent, and the active generation. The model can read budgeted,
redacted hits, while Claude, OpenAI, Pi, OpenCode, and Qoder SSE/log events retain only
versioned citations, hashes, lengths, licenses, attribution, and trust
sidecars. See [Android Internals Knowledge Pack And Private Knowledge](../getting-started/android-internals-knowledge.en.md).

## Planning, Hypothesis, And Artifact Tools

| Tool | Purpose |
|---|---|
| `submit_plan` | Submit the investigation plan and unlock gated evidence tools in full mode |
| `update_plan_phase` | Update phase progress and optionally inject next-phase reminders |
| `revise_plan` | Replace the plan when evidence changes the investigation |
| `submit_hypothesis` | Record a testable hypothesis |
| `resolve_hypothesis` | Mark a hypothesis confirmed, rejected, or unresolved |
| `flag_uncertainty` | Mark uncertainty or missing evidence explicitly |
| `write_analysis_note` | Persist session analysis notes when configured |
| `fetch_artifact` | Page through large SQL/Skill artifacts when an artifact store exists |
| `lookup_strategy_detail` | Read scene strategy details by detail ref returned from plan tools; informational fallback only and does not satisfy expectedCalls |

These tools enforce investigation discipline and reduce context size. Artifact summaries are not a reason to discard full DataEnvelope evidence from frontend, reports, CLI artifacts, or snapshots.

## Code-Aware Tools

| Tool | Purpose | Boundary |
|---|---|---|
| `list_codebases` | List authorized codebases | Requires codebase permission |
| `lookup_app_source` | Query app source | Must keep CodeRef filtering |
| `lookup_kernel_source` | Query kernel source | Must keep CodeRef filtering |
| `resolve_symbol` | Resolve trace symbols to source locations | Keeps source references traceable |
| `propose_patch` | Generate a patch proposal | Must label verified / sketch / unverified |

Code-aware output can appear in reports, exports, and snapshots; do not validate only the live chat view.

## Comparison Tools

| Tool | Purpose |
|---|---|
| `execute_sql_on` | Run SQL on the current or reference trace |
| `compare_skill` | Run a Skill on both traces and compare results |
| `get_comparison_context` | Fetch trace-pair metadata, left/right or top/bottom pane mapping, and comparison context |

Comparison tools are registered only when `referenceTraceId` and comparison context are available. Raw trace comparison and analysis-result comparison should reuse the shared evidence/report contract.

## Tool Priority

1. Confirm scene, time range, process identity, and rendering architecture.
2. Prefer matching Skills; use SQL for gaps or hypothesis validation.
3. Page large results through artifacts instead of filling agent context.
4. Tie claims to trace evidence, Skill output, claim verification, or explicit uncertainty.
5. Keep live chat readable while preserving audit evidence in reports, CLI artifacts, and snapshots.

## Maintenance Checklist

- Tool implementation or visibility changes: update `claudeMcpServer.ts`, `mcpToolRegistry.ts`, OpenAI adapter tests, and this page.
- Code-aware tool changes: check `docs/getting-started/code-aware-analysis*.md`.
- Comparison tool changes: check comparison docs, CLI docs, and report/snapshot contracts.
- Do not add a static total tool count; generate current inventory from the registry or source when needed.

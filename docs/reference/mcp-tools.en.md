# SmartPerfetto MCP Tools Reference

[English](mcp-tools.en.md) | [中文](mcp-tools.md)

SmartPerfetto exposes trace data and analysis workflows to the active agent runtime through MCP-style tools. The full tool surface has 20 tools grouped into data access, planning/hypothesis work, memory/pattern recall, and dual-trace comparison.

Lightweight mode exposes only three tools: `execute_sql`, `invoke_skill`, and `lookup_sql_schema`.

## Tool Call Lifecycle

```text
Agent wants a tool call
    │
    ├─ Was submit_plan called?
    │   ├─ No  -> execute_sql / invoke_skill are blocked in full mode
    │   └─ Yes -> all tools allowed by the current mode are available
    │
    └─ Runtime calls MCP tool -> shared registry handles request -> result returns
```

## Core Data Access Tools

| # | Tool | Purpose | Gate |
|---|---|---|---|
| 1 | `execute_sql` | Run raw Perfetto SQL against `trace_processor_shell` | Requires `submit_plan` in full mode |
| 2 | `invoke_skill` | Run a YAML Skill analysis pipeline | Requires `submit_plan` in full mode |
| 3 | `list_skills` | List available Skills, optionally filtered by category | None |
| 4 | `detect_architecture` | Detect rendering architecture for the current trace | None |
| 5 | `lookup_sql_schema` | Search Perfetto stdlib schema/index entries | None |
| 6 | `query_perfetto_source` | Search Perfetto stdlib SQL source | None |
| 7 | `list_stdlib_modules` | List known stdlib modules | None |
| 8 | `lookup_knowledge` | Fetch local knowledge, templates, or pipeline docs | None |

### `execute_sql`

Parameters:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sql` | string | Yes | Perfetto SQL query |
| `summary` | boolean | No | When true, returns aggregate stats and representative samples |

Normal result shape:

```typescript
{ success, columns, rows, totalRows, truncated, durationMs }
```

### `invoke_skill`

Parameters:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `skillId` | string | Yes | Skill id, such as `scrolling_analysis` |
| `params` | record | No | Skill parameters, such as `process_name`, `start_ts`, `end_ts` |

Default artifact result shape:

```typescript
{
  success,
  skillId,
  skillName,
  artifacts,
  diagnosticsArtifactId?,
  synthesizeArtifacts?,
  hint
}
```

## Planning and Hypothesis Tools

| # | Tool | Purpose |
|---|---|---|
| 9 | `submit_plan` | Submit the initial investigation plan and unlock gated evidence tools |
| 10 | `update_plan_phase` | Mark current plan phase progress |
| 11 | `revise_plan` | Replace the plan when evidence changes the investigation path |
| 12 | `submit_hypothesis` | Record a testable hypothesis |
| 13 | `resolve_hypothesis` | Mark a hypothesis as confirmed, rejected, or unresolved |
| 14 | `write_analysis_note` | Record durable analysis notes for the session |
| 15 | `fetch_artifact` | Page through large Skill or SQL artifacts |
| 16 | `flag_uncertainty` | Explicitly mark uncertainty and missing evidence |

## Memory and Pattern Tool

| # | Tool | Purpose |
|---|---|---|
| 17 | `recall_patterns` | Retrieve prior patterns and similar investigation notes |

Pattern recall should support the investigation; it should not override current trace evidence.

## Comparison Tools

These tools are enabled when a request includes `referenceTraceId`.

| # | Tool | Purpose |
|---|---|---|
| 18 | `execute_sql_on` | Run SQL on the primary trace or the reference trace |
| 19 | `compare_skill` | Run a Skill across primary/reference traces and compare results |
| 20 | `get_comparison_context` | Fetch trace pair metadata and comparison context |

## Tool Priority

1. Detect scene and architecture when relevant.
2. Prefer a matching Skill over hand-written SQL.
3. Use SQL for focused gaps or validation.
4. Fetch large artifacts instead of forcing huge outputs into the agent context.
5. Keep final claims tied to trace data, Skill output, or explicitly marked inference.

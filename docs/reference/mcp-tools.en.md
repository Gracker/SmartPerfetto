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
| Code-aware | local codebase access is allowed | `list_codebases`, index-free search/read, optional graph navigation, indexed lookup, and patch tools |
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
| `execute_sql` | Run Perfetto SQL on the current trace | Supports summary mode and artifact pagination/truncation. Summary results (explicit, or automatic above 50 rows when an artifact store exists) list `sampleRows` as `{rowIndex, values}` in interest order, where `rowIndex` is the row's zero-based index in the complete result, and carry `rowShape: "indexed_rows@1"`; smaller raw results, and any result without an artifact store, keep plain `rows` in result order from row 0 (at most the first 200) |
| `invoke_skill` | Run a YAML Skill analysis pipeline | Preferred evidence path; returns DataEnvelope / artifacts |
| `list_skills` | List available Skills | Filterable by category; count comes from the file tree |
| `detect_architecture` | Detect rendering architecture for the trace | Guides strategy and pipeline analysis |
| `analyze_wait_chain` | Break one thread's window into running / runnable / sleeping / uninterruptible time, longest waits, wake sources, and the recursed waker chain | Shares the critical-path engine; `wake_source_class` is a candidate label, not a root cause. The headline is `attributableMs` / `attributablePercentage` (other threads running, runnable or in uninterruptible wait); `blockingMs` is path coverage and includes `eventWaitMs`, other threads' interruptible sleeps where Perfetto ends the wake chain (`topWaits[].terminal: true`). Read `rootWait.context` (`in_slice` / `between_slices` / `no_slice_data`) with the `idle_wait` anomaly (the wait sat between slices with a low attributable share: idle, not slow) and `peer_event_wait` (the chain ends in another thread waiting for a network, timer or device event: that is the blocker); `longestAttributable` and `longestEventWait` name the longest attributable segment and the longest chain-end wait, and `anomalies[].id` carries the stable id. `available: false` carries `unavailableReason` (`task_state_running`, `no_waiting_time`, `no_critical_path_stack` when `sched_waking` is missing, or `wait_open_at_trace_end` when the selected wait never ended before the trace did). Placeholders a strict schema forces a model to fill (`""`, `"null"`, utid/tid/upid/pid 0, `main_thread: false`, a 0..0 window) count as absent; `thread_state_id` 0 is a valid row id. A `thread_state_id` that disagrees with the requested thread, process or window is dropped with a `thread_state_id_ignored_conflict` warning when a thread and a whole window are also given, and otherwise refused as `selector_conflict` (with `threadStateOwner`, `requestedThread` and `conflicts`). A thread with no thread_state row in the window is refused as `no_thread_state_in_window` (`action_required: choose_thread_with_sched_data`, with `processHasSchedData` and up to five candidate threads that have scheduling data). Every refusal carries `action_required` and does not count as a tool failure. Defaults come from the engine's `CRITICAL_PATH_DEFAULTS.agent` (200 displayed segments, recursion depth 1, child budget 16); `max_segments` / `recursion_depth` override them. The chain already follows each waker to its own waker; recursion re-runs the critical path inside the longest segments of other threads. Besides the segment table the tool stores a one-row summary (`summaryArtifactId` / `summaryEvidenceRefId`); the projection's headline numbers are read verbatim from that row (including `attributable_ns` / `event_wait_ns`) and `exactNs` gives their exact ns; the segment table carries a `path_role` column. `*_ns`, `start_ts`, `dur_ns` and `utid` carry native-producer semantics, so numeric claims citing them are deterministically verifiable; rounded `*_ms`, shares and counts carry none |
| `lookup_sql_schema` | Search Perfetto SQL schema / stdlib index | Available in quick and full paths |
| `query_perfetto_source` | Search Perfetto stdlib SQL source | Falls back to packaged indexes when source is absent |
| `list_stdlib_modules` | List Perfetto stdlib modules | Avoids putting the full module list in the prompt |

`execute_sql` and `invoke_skill` gather evidence; they are not the final report boundary. Final output still passes through result normalization, evidence/claim verification, report generation, snapshots, and frontend projection.

## Knowledge, Memory, And Baselines

| Tool | Purpose |
|---|---|
| `lookup_knowledge` | Load local performance knowledge, templates, or pipeline docs |
| `search_knowledge` | Search the selected document knowledge bases (`document_collection`); registered only when a selected source has rights, provider consent and an active index |
| `read_knowledge_section` | Read the section behind a `search_knowledge` hit by its issued `kref-` reference, in `part`s for a long section |
| `lookup_aosp_source` | Query AOSP-related source knowledge |
| `lookup_oem_sdk` | Query OEM SDK or vendor knowledge |
| `lookup_baseline` | Fetch historical baselines |
| `compare_baselines` | Compare baseline metrics |
| `recall_project_memory` | Retrieve project memory |
| `recall_similar_case` | Retrieve similar analysis cases |
| `recall_similar_result` | Retrieve similar analysis-result snapshots as `navigation_hint_only` output |
| `recall_patterns` | Retrieve patterns or anti-patterns, usually as internal analysis support |

Knowledge and memory support the investigation; they must not override current
trace evidence. The Android Internals Wiki no longer has a tool of its own:
register it as a document knowledge base and search it with the two tools
below. See [Using The Android Internals Wiki As A Knowledge Base](../getting-started/android-internals-knowledge.en.md).

The document knowledge tools are background, never trace evidence:
`evidenceEffect: background`, plan capability informational (they satisfy no
evidence phase), no DataEnvelope or evidence capture, and callable in an
`existing_only` turn. `search_knowledge(query, knowledge_base_id?, max_results≤10)`
returns `hits[]` with an issued `id` (`kref-` plus a random id, issued only for
hits actually delivered), `knowledgeBaseId`, `title`, `headingPath`,
`relativePath`, `lineRange` and `excerpt`; omitting `knowledge_base_id` searches
every selected collection. `read_knowledge_section(reference_id, part?)` returns
the whole section's `lineRange`, `part` / `partCount` and that part's text; a
part already delivered in the run returns `alreadyDelivered` with no text and no
charge. A reference resolves only in the run that issued it; an unissued id is a
policy refusal (`action_required: use_reference_id_from_search_knowledge`), and
a `kref-` reference is neither trace evidence nor a source reference in a
declaration. Each call rechecks the authorization context and the pinned index
generation before and after the read (`analysis_context_changed_restart_required`).
Text draws on the knowledge token pool (cut with `truncated` and `budgetExhausted` past it; a cut part is not completed later in the run); the
search and read counts and the part size are `knowledge` in
`source-depth-policy.yaml`. Delivered text is registered for echo protection, and titles, heading
paths and relative paths as whole values (so `kb:` citations too); SSE/log projections keep only success,
counts, `knowledgeBaseId`, the part position and a closed refusal action.

## Planning, Hypothesis, And Artifact Tools

| Tool | Purpose |
|---|---|
| `submit_plan` | Submit an investigation plan on demand; no evidence tool requires one, and once submitted its `expectedCalls` bind the run |
| `update_plan_phase` | Update phase progress and optionally inject next-phase reminders |
| `revise_plan` | Replace the plan when evidence changes the investigation |
| `submit_hypothesis` | Record a testable hypothesis |
| `resolve_hypothesis` | Mark a hypothesis confirmed, rejected, or unresolved |
| `flag_uncertainty` | Mark uncertainty or missing evidence explicitly |
| `write_analysis_note` | Persist session analysis notes when configured |
| `fetch_artifact` | Page through large SQL/Skill artifacts when an artifact store exists. `detail="rows"` returns `rows` as `{rowIndex, values}` with `rowIndex = offset + position` (artifact-wide) and `rowShape: "indexed_rows@1"`; `detail="full"` keeps the original structure |
| `lookup_strategy_detail` | Read the complete detail for a detail ref from the scene strategy catalog, from the run's pinned strategy registry; informational, does not satisfy expectedCalls |
| `read_session_history` | Read earlier turns of this session as typed history (paged by `turnId`, `offset` / `limit`, `textOffset` / `maxChars`); keeps native partial/unknown status, uncertainties, and declared locators, and returns source-derived history only under the same authorization fingerprint. Not evidence acquisition; available under `existing_only` |
| `propose_scene_timeline` | Scene reconstruction runs only (internal): submit a scene timeline candidate revision against a `baseRevision`; see [Scene Reconstruction](../architecture/scene-reconstruction.en.md) |

These tools enforce investigation discipline and reduce context size. Artifact summaries are not a reason to discard full DataEnvelope evidence from frontend, reports, CLI artifacts, or snapshots.

## Code-Aware Tools

| Tool | Purpose | Boundary |
|---|---|---|
| `list_codebases` | List authorized codebases | Requires codebase permission |
| `search_codebase` | Run a bounded text/symbol search in a registered live root | No SmartPerfetto index required; selected codebases and relative path prefixes only |
| `read_codebase_file` | Read a bounded line range inside a registered root | `metadata_only` returns no text; `provider_send` still requires dual consent and redaction |
| `find_codebase_files` | Find registered files by name, path substring, or glob | Returns relative paths only; reads no file and issues no source reference; available in `metadata_only` |
| `locate_trace_anchor` | Find the source of a name seen in the trace (slice, marker, thread, native frame) | Locate-only `search_hit` references ranked trace call site > definition > other, each with `matchedBy`; never proves absence |
| `query_code_graph` | Navigate related flows and symbols through an optional local graph | Metadata-only; offered only when a selected codebase has a GitNexus index |
| `inspect_code_symbol` | Inspect bounded relationships and locations for a candidate symbol | Metadata-only; relationships require bounded source verification; offered only with a GitNexus index |
| `lookup_app_source` | Query app source | Must keep CodeRef filtering; offered only when a selected codebase has an active index |
| `lookup_kernel_source` | Query kernel source | Must keep CodeRef filtering; offered only with an active index |
| `resolve_symbol` | Resolve trace symbols to source locations | Keeps source references traceable; offered only with an active index |
| `propose_patch` | Generate a patch proposal | Must label verified / sketch / unverified; offered only with an active index |

The run's MCP server decides each selected codebase's capabilities once (`search`, `read_body`, `index`, `graph`) and registers graph and index tools only when some selected codebase has the graph or an active index. The same facts, with the run's source depth and starting budget, reach the system prompt as the `source_authorization` data segment (`codebases[]` with `id`, `displayName`, `kind`, `pathScope` — `whole_root` or `registered_filters`, never the filters themselves — and `capabilities`). A call that names a codebase without the capability is refused before reaching any source: `unsupportedReason: codebase_index_unavailable | codebase_graph_unavailable`, `action_required: use_search_codebase`. Each run also pins every selected index's generation: the index tools (`lookup_app_source`, `lookup_kernel_source`, `lookup_aosp_source`, `lookup_oem_sdk`, `resolve_symbol`, `propose_patch`) check it before reading, after reading and right before returning, and refuse a rebuilt or retired index with `unsupportedReason: codebase_index_generation_changed`, `action_required: use_search_codebase`, never an empty result. The Android Internals Wiki lookup refuses a rebuilt Wiki with `knowledge_index_generation_changed`; a document knowledge base keeps serving its pinned generation while that file is retained, then returns `knowledge_index_unavailable`. Source use is recorded from actual calls only; there is no model-declared source-use decision tool.

All five index-free/graph-navigation tools require codebase permission and use codebases selected for the current request. `codebase_id` may be omitted only when exactly one codebase is selected; it is required when several are selected:

- `search_codebase`: required `query`; optional `codebase_id`, relative `path_prefix`, `file_glob` (`*`, `?`, whole-segment `**`; without `/` it matches a file name at any depth), `case_sensitive` (default smart case: case-sensitive only when the query has an upper-case letter), `context_lines` (0-5, default 2), and `max_results` (1-30, default 12).
- `read_codebase_file`: required relative `file_path`; optional `codebase_id`, `start_line` or `around_line` (centers the window; mutually exclusive), and bounded `max_lines`.
- `find_codebase_files`: required `pattern` (a file-name substring, a path substring containing `/`, or a glob); optional `codebase_id`, relative `path_prefix`, and `max_results` (1-50, default 20).
- `query_code_graph`: required `query`; optional `codebase_id` and bounded `max_results`.
- `inspect_code_symbol`: required `symbol`; optional `codebase_id`, relative `file_path`, and bounded `max_relations`.

A well-formed path or `path_prefix` that the selection policy does not admit (outside the registered filters, under an excluded directory, a non-source extension file path; in `provider_send`, outside the provider-send grant) returns a policy refusal: `success=false`, `unsupportedReason`, and an `action_required` token such as `locate_path_with_search_codebase`, `retry_search_without_path_prefix`, or `continue_without_this_path_prefix` (a prefix outside the grant). The refusal echoes neither the requested path nor the registered filters or root, and carries no backend or coverage fields, so it never supports a source-absence claim. A successful search reports `coverageScope` (`codebase`, or `path_prefix` when the prefix narrows the registered scope); only codebase-wide complete coverage can support absence. A `provider_send` search that withholds a match outside the grant reports `coverageComplete=false` with `searchIncompleteReason=provider_grant_scope`. Malformed paths and unreadable files remain tool failures.

A search collects every match its traversal reaches, ranks them deterministically (declarations of the name, trace-section call sites, whole-word and exact-case matches first; test/generated/build paths last; then path and line), and returns only top-ranked candidates re-read and verified through the path gate. Each result's `lineRange` includes `context_lines` of context, `matchLines` marks the matching lines, and adjacent matches in one file share a window. `moreResults` only means more matches exist than are shown (paging), not incomplete coverage; `traversal` (`complete`, `stopped_at_cap`, `timed_out`, `error`) says whether the traversal stopped early, and `coverageComplete` is true only for a complete traversal with no match withheld by the grant. On-demand search scans files up to 16 MiB (`scope.maxFileBytes`) and reads up to 4 MiB; a match in a file between the two returns its location with `bodyUnavailable: "file_too_large"`, and reading such a file returns `source_file_too_large`. Indexing keeps its 200 KiB limit.

Source budgets are per run and chosen by `sourceDepth` (`source-depth-policy.yaml`). Search-type calls (`search_codebase`, `find_codebase_files`, graph tools, `resolve_symbol`, and indexed lookups that reach a registered codebase) and `read_codebase_file` each have a count, spent when a call reaches the source (failures are not refunded). Tokens are charged for what is actually delivered: past the budget a search keeps its top-ranked results and a read its first lines (the rest is paging), and only when nothing fits is a `budget_exceeded` refusal returned; graph tools and `resolve_symbol` return metadata only and refuse a result past the budget whole, before issuing any reference. `locate_trace_anchor` spends one `locates` and runs at most a few bounded internal searches (`source-anchor-normalization.yaml`) that do not spend `searches`. Every source tool result carries `budget: {searchesLeft, readsLeft, locatesLeft, tokensLeft}`, and one read window is capped by the depth's line limit. Retrieved document knowledge has its own token pool; the built-in methodology templates `lookup_knowledge` returns are product prompt content and are not budgeted. `CodeLookupLedger` is the audit trail and patch authority only; it no longer takes part in budgets.

Every returned item carries its issued reference `id`, the same as `sourceReferences[].id` and the only id the model should cite (the internal `referenceId` is no longer delivered). A search hit is `lookupKind: search_hit` and only locates code; a read window (`body`) or an indexed chunk is body evidence, and a hit whose whole range a read window covers counts as read too. The source-use status follows the strongest finding and is no longer pinned by one incomplete search; run-level `coverageComplete` is monotone and decides negative source claims.

`locate_trace_anchor` takes `anchor`, `anchor_kind` (`slice`, `marker`, `thread`, `native_frame`), optional `process_name`, `codebase_id` and `max_results` (1-10, default 5). The YAML-driven normalization tries the literal name; a name with numbers by its longest literal piece, keeping lines whose literal reads the same with placeholders (Kotlin `${x}`, `%d`, concatenation); `#` segments as fallbacks; a 15-character thread name as a prefix of a longer one; a native frame's method (ranking declarations and the owning class's file first); and one hop from a constant definition to the lines that use it. A framework slice (`RV OnBindView`, `Choreographer#doFrame`, …) returns `framework: {implementation: "aosp", overrides}` and searches only the app methods that override its hook; one with none searches and spends nothing. Candidates carry `matchedBy` (`trace_call`, `constant_definition`, `thread_creation`, `method_declaration`, `framework_override`, `template`, `literal`) and point `matchLines` at the deciding lines; the traced package ranks its own modules first, and `ambiguous: true` means the best candidates tie across modules. Under `metadata_only` ranking uses the redacted line text internally and delivers none.

The model receives one body: `numberedText`, with real line numbers. The raw text stays internal for echo registration, accounting, and provenance. A read's `window.enclosingSymbol` is the nearest declaration at or above the window start (a heuristic); for a missing file, `candidates` lists up to five same-name files in scope (never outside the grant in `provider_send`). A thrown tool failure reaches every runtime as a path-free `source_*` code only; anything else becomes `source_tool_failed`.

A registered root that is still reachable immediately enables `search_codebase` / `read_codebase_file`; no active SmartPerfetto generation is required. `query_code_graph` / `inspect_code_symbol` only attempt to use a local GitNexus installation and index that the user already created. SmartPerfetto does not bundle, redistribute, install, require, or automatically index GitNexus; when no selected codebase has a `.gitnexus` index the graph tools are not offered. A missing GitNexus binary, or incompatible, timed-out, or failed graph access returns a structured unavailable result (`success=false` plus `unsupportedReason`); a stale index returns navigation metadata marked `freshness="stale"`. In either case, the AI/strategy continues by calling the existing index-free search/read tools instead of blocking analysis.

Index-free `search_codebase` / `read_codebase_file` and indexed lookup use the
same disclosure predicate: a relative path must be admitted by both the current
selection policy and the registration's consent grant. `.gitignore` controls
candidate discovery only; it is not authorization. Extensions introduced by a
later release require explicit renewed authorization and are never inherited
silently from an older consent.

Graph tools return only `codebaseId`, relative `CodeRef` values, sanitized process/symbol metadata, `graph.freshness`, and `graph.verificationRequired`. Registrations with `pathFilters` or `excludeGlobs` omit whole-repository process summaries whose path scope cannot be proven, while retaining authorized relative `CodeRef` values. Code-graph metadata is neither current-trace evidence nor verified source truth. Any relationship that affects a conclusion must be checked with bounded `read_codebase_file`; if the current permission mode blocks source reading, it must remain unverified. Absolute roots stay inside the backend trust boundary. When code-aware output reaches reports, exports, or snapshots, only safe names/IDs and relative `CodeRef` values may remain, never raw source. Do not validate only the live chat view.

Source conclusions use dual evidence: Trace/Skill/SQL proves occurrence in the
current trace, while a `CodeRef` explains a candidate implementation mechanism.
A `CodeRef` alone cannot raise occurrence or root-cause confidence. The model
declares only the bound reference IDs; the server computes the claim standing.
The strongest, `trace_linked`, requires a read body (body/indexed) plus verified
same-claim trace occurrence; `metadata_only` produces locate-only references.

GitNexus is an independent optional third-party tool. Its [official project](https://github.com/abhigyanpatwari/GitNexus) and [npm package](https://www.npmjs.com/package/gitnexus) currently declare the [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE) license. Users must review the upstream terms before use. This is not legal advice.

## Comparison Tools

| Tool | Purpose |
|---|---|
| `execute_sql_on` | Run SQL on the baseline or comparison trace; compatibility values remain current/reference. Its summary results nest the indexed `sampleRows` and `rowShape: "indexed_rows@1"` inside `summary` |
| `compare_skill` | Run a Skill on both traces and compare results |
| `get_comparison_context` | Fetch trace-pair metadata, left/right or top/bottom pane mapping, and comparison context |

Comparison tools are registered only when `referenceTraceId` and comparison context are available. Raw trace comparison and analysis-result comparison should reuse the shared evidence/report contract.

## Tool Priority

1. Confirm scene, time range, process identity, and rendering architecture.
2. Prefer matching Skills; use SQL for gaps or hypothesis validation.
3. Use an optional code graph for candidate navigation only after trace/Skill/SQL points to an implementation; never substitute graph relationships for trace evidence.
4. With selected source and a queryable anchor, narrow candidates with index-free `search_codebase`, then verify conclusion-bearing relationships with bounded `read_codebase_file` when consent permits; otherwise record a structured source-use stop decision first.
5. Page large results through artifacts instead of filling agent context.
6. Tie claims to trace evidence, Skill output, claim verification, or explicit uncertainty.
7. Keep live chat readable while preserving audit evidence in reports, CLI artifacts, and snapshots.

## Maintenance Checklist

- Tool implementation or visibility changes: update `claudeMcpServer.ts`, `mcpToolRegistry.ts`, OpenAI adapter tests, and this page.
- Code-aware tool changes: check `docs/getting-started/code-aware-analysis*.md`.
- Comparison tool changes: check comparison docs, CLI docs, and report/snapshot contracts.
- Do not add a static total tool count; generate current inventory from the registry or source when needed.

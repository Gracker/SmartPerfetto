# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis lets SmartPerfetto reference local source trees while analyzing a trace. It maps app frames, native frames, and kernel symbols to `CodeRef` metadata. Registration only makes a codebase selectable; it never attaches that codebase to a session automatically. The user must select it for the current analysis. A registered root that is still reachable works immediately with bounded `search_codebase` / `read_codebase_file`; no SmartPerfetto index is required first. Indexing is an optional accelerator for semantic/symbol lookup and patch workflows. Outputs preserve only `referenceId` or `chunkId`, relative paths, line ranges, and symbols. Raw source text is not persisted into sessions, reports, or exports.

## Enable It

1. Start the backend with `./start.sh`.
2. Open AI Assistant settings in Perfetto UI and select `Codebases`.
3. Prefer **Choose folder** when adding a codebase, then run preview. Display name is optional and defaults to the folder name.
4. Register it and start analysis immediately. SmartPerfetto reindexing is optional acceleration and still powers semantic/symbol lookup and patch workflows; it is independent of optional external code-graph acceleration.
5. Use code-aware mode in analysis, or pass `--code-aware metadata_only|provider_send` and `--codebase-id <id>` in the CLI.

CLI example:

```bash
cd backend
npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --dry-run

npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --exclude-glob '**/generated/**'

# Optional: build an index for semantic/symbol lookup and patch workflows
npm run cli:dev -- codebase reindex cb_xxx
npm run cli:dev -- codebase symbols MainActivity --codebase-id cb_xxx

npm run cli:dev -- run --format json \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  ../Trace/real/android-startup-heavy/trace.pftrace \
  "Find the startup bottleneck and map it to source code"
```

Registered codebases and knowledge sources are never exposed to a session automatically. The effective combinations are:

| Current selection | Effective behavior |
|---|---|
| No IDs | Normal trace-only path; `fast` can remain lightweight |
| `--codebase-id` only | Authorizes `metadata_only` by default; ordinary questions keep source dormant and preserve the requested Fast/Auto/Full mode |
| `--code-aware metadata_only` + codebase ID | Explicit source questions use metadata-only `CodeRef` values with at most 1 search, 2 reads, and 6 seconds |
| `--code-aware provider_send` + codebase ID | Explicit source questions may send filtered text after dual consent, under the same 1/2/6-second budget |
| `--code-aware off` + codebase ID | Invalid input; the source selection is rejected instead of silently ignored |
| `--knowledge-source-id` only | Uses the authorized private external RAG source and the full runtime |
| Codebase ID + knowledge source ID | External RAG still requires the full runtime; source activation remains query-driven |

A source codebase needs only a live registered root. Missing active generations or indexed chunks do not block analysis. External knowledge remains RAG-backed and still requires consent plus a completed index. If the registered source path is moved, unmounted, or deleted, Web/CLI returns `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE`; restore that path or register it again.

Selecting source no longer forces `--analysis-mode fast|auto` to `full`. Reference traces and private RAG remain full-runtime capabilities. `provider_send` requires two independent authorizations: `--send-to-provider` at codebase registration and `--code-aware provider_send` for the current run.

## When Source Is Used

Selecting source establishes authorization; it does not inject source into every run. Web, API, CLI, and all five production runtimes share one activation policy:

- Ordinary Fast/Auto/Full questions keep source dormant: no source tools are registered, no model turns are added, and repository size stays off the primary critical path.
- Explicit requests for source files, functions, implementation, or call paths expose only `list_codebases`, `search_codebase`, and `read_codebase_file`. The source budget is 1 search, 2 reads, and 6 seconds. Full still retains Trace, Skill, and SQL tools.
- Only an explicitly Full request for a deep or complete source review starts a detached deep-source supplement after the primary Full conclusion. The primary conclusion, HTML report, and analysis snapshot are already fixed; cancellation or failure never rewrites them. Web messages and CLI `source-supplement.json` persist the supplement separately.
- A source-activation transition resets provider/runtime context and replays only bounded, safe, non-source-derived text while preserving UI history.

Each run retains `SourceUseDecisionV1`:

| Field | Meaning |
|---|---|
| `status` | `pending` / `attempted` are in-progress states. Lookup may produce `located` / `corroborated`, or terminate as `not_needed`, `disallowed`, `no_queryable_anchor`, `ambiguous_candidates`, `not_found_complete`, `search_incomplete`, or `unverified` |
| `reasonCode` | Only a controlled structured code is retained; model-authored free-text reasons do not enter safe output |
| `selectedCodebaseIds` | Codebases explicitly selected for this request |
| `queriedCodebaseIds` | Codebases actually searched |
| `usedCodebaseIds` | Codebases that actually produced safe `CodeRef` values |
| `coverageComplete` / `incompleteReasons` | Distinguishes a complete no-match from time budgets, traversal errors, or other incomplete searches. Only a complete search can support a source-absence claim |

## Evidence Order And Optional Code Graphs

The default investigation order is:

1. Establish the performance symptom, time range, threads, slices, and symbols from the current trace, matching Skills, and Perfetto SQL. These are the primary evidence for performance claims.
2. If the backend finds a local GitNexus installation that the user already installed and that is currently usable, the AI may call `query_code_graph` / `inspect_code_symbol` to navigate candidate call relationships and symbols. The graph is optional navigation acceleration, not trace evidence or source truth.
3. Narrow the candidate to relative files and lines with index-free `search_codebase`, then verify the actual source with bounded `read_codebase_file` when current consent permits it. Any graph relationship that affects a conclusion must pass this check. If the permission mode blocks source reading, keep `verificationRequired` and do not promote the candidate to a verified claim.

Conclusions use dual-evidence semantics. Trace/Skill/SQL proves that an occurrence happened in this trace; a `CodeRef` explains a possible implementation mechanism. A `CodeRef` alone cannot increase occurrence or root-cause confidence. `SourceClaimBindingV1.mechanismStatus` is limited to `corroborated`, `compatible`, `ambiguous`, or `unverified`. `corroborated` requires both verified trace-occurrence evidence for the same claim and `provider_send` body/indexed source evidence. `metadata_only` is locate-only and cannot promote a mechanism to `corroborated`.

The `code_pinpoint` Skill can establish safer source candidates before lookup.
Its `hot_slices` step promotes only conservatively recognized app main-thread
trace labels to source-query hints; other slices remain generic anchors. Its
optional `native_symbols` step extracts function, module, and build-id values
from CPU-profile samples. Both narrow search and never replace current-trace
evidence or the later bounded source verification.

Automatic Web-conversation enrichment has a stricter tool surface: only
`list_codebases`, `search_codebase`, and `read_codebase_file` are exposed.
Graph, indexed lookup, Trace, shell, and patch tools are unavailable. An
ordinary dormant primary analysis receives no source tools, so repository size
cannot add model turns to the primary answer.

`query_code_graph` and `inspect_code_symbol` return metadata only: `codebaseId`, relative `CodeRef` values, sanitized process/symbol metadata, `graph.freshness`, and `graph.verificationRequired`. They never return raw source text or absolute roots. When a registration uses `pathFilters` or `excludeGlobs`, SmartPerfetto omits whole-repository process summaries whose path scope cannot be proven; authorized relative `CodeRef` values remain available. If GitNexus is missing, unavailable, incompatible, times out, or fails, the graph tool returns a structured unavailable result (`success=false` plus `unsupportedReason`). A stale index returns navigation metadata marked `freshness="stale"`. In either case, the AI/strategy continues through the existing `search_codebase` / `read_codebase_file` path, so registration, selection, and trace analysis remain available. SmartPerfetto does not install, bundle, redistribute, or automatically create or refresh a GitNexus index.

GitNexus is an independent optional third-party tool. Its [official project](https://github.com/abhigyanpatwari/GitNexus) and [npm package](https://www.npmjs.com/package/gitnexus) currently declare the [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE) license. Review the upstream terms and confirm that your intended use is permitted before enabling it, especially for commercial use. This is not legal advice.

## Supported Codebases

| kind | Use | Required metadata |
|---|---|---|
| `app_source` | App Java/Kotlin/R8 lookup | source folder; optional build ID and path scope |
| `aosp` | AOSP framework/native hot paths | source folder and `licenseTag`; optional build ID and path scope |
| `kernel_source` | kernel binder/scheduler/mm/io causes | source folder, `vendor`, and at least one `path-filter`; optional license tag |
| `oem_sdk` | OEM / chipset SDK material | source folder, `vendor`, and `licenseTag`; optional build ID and path scope |

Source enumeration uses a `ripgrep > git > node-walk` capability ladder and reports the actual backend, fidelity, and coverage in preview, CLI, and index audit results. `.git`, `.hg`, `.svn`, `.repo`, and credential/key files are hard exclusions. Noise such as `node_modules`, `build`, and `Pods` is considered only when a path filter explicitly selects it. AOSP preview reads bounded `.repo/manifest.xml` metadata for project/group scope buttons, while the `.repo` object store itself is never traversed as source. An absent manifest means no scope suggestions are available. Read, parse, or identity-check failures return `manifestUnavailableReason` without rejecting completed file enumeration; only codebase-root identity drift still blocks preview.

`.gitignore`, `.ignore`, and `.rgignore` affect enumeration recall; they are not provider authorization boundaries. Authorization is a dynamic path scope and always intersects the current selection policy with the frozen consent grant. Expanding path filters or relaxing exclude globs never expands provider consent automatically. When `providerGrantScopeCurrent=false`, the added scope remains metadata-only until the user explicitly chooses **Authorize current scope**. Languages added by upgrades—such as Dart, TypeScript, Swift, and Objective-C—can also be located in `metadata_only`, but existing registrations must explicitly authorize the new languages before their text can be sent. Authorizing new languages marks an existing active index for rebuild because that generation may not contain them.

Index coverage is modeled independently. Complete deterministic candidates can activate directly. When a complete index already exists, a deterministically truncated candidate becomes pending until the user accepts or rejects it, and the complete index remains active. Timed-out, traversal-error, or nondeterministic candidates never auto-activate. Indexing remains optional acceleration, so pending or failed indexing does not block bounded on-demand access to a live root.

Docker images install `ripgrep` and `git`. Portable packages do not bundle ripgrep: they report capability and use bounded `node-walk` with `backendFidelity=degraded` when rg/git are unavailable. A completed node walk is not mislabeled as an enumeration truncation; backend fidelity and coverage completeness are reported separately. Incomplete coverage must never be stated as proof that source does not exist.

You normally do not need to enter a commit. Each index generation reads Git
`HEAD` from the actual checkout and records dirty/untracked state separately. Non-Git folders
use a content fingerprint.
Legacy CLI/API callers may still pass `--commit` / `commitHash` at registration,
but it is caller-supplied compatibility metadata, not authoritative index
provenance. Every `reindex` derives `indexedRevision`, `indexedDirty`,
`commitProvenance`, and `contentFingerprint` from the actual checkout. CLI
`smp codebase reindex <id>` has no `pathPrefix` option; manage scope through
`smp codebase selection`. The HTTP reindex body retains a bounded `pathPrefix`
compatibility input.

Local source checkouts and portable apps running on loopback can ask the
backend to open the macOS, Windows, or Linux system folder picker. A selection
creates a single-use authorization bound to the current tenant, workspace, and
user for five minutes. It authorizes only that registration and its later
reindexes; it never expands the process-wide allowlist. The backend retains the
authorization source, but safe list/detail/audit responses expose neither it,
absolute paths, nor raw operational errors. Deleting the registration also
revokes that persistent authorization.
Docker, remote/shared
backends, headless sessions, and platforms without a supported picker retain
manual entry. In those cases, enter a path the backend can access and that is
authorized through `SMARTPERFETTO_CODEBASE_ROOTS`.

## Management And Session Lifecycle

The Web UI `Codebases` tab manages more than registration. It shows root
availability, selection/grant revisions, active-index coverage, pending
candidates, provider-grant mismatch, worktree state, and content provenance.
Users can completely replace path filters/exclude globs, enable or revoke
provider-send, authorize new languages or the current selection, accept or
reject the exact pending generation with CAS, reindex, inspect the safe audit,
and delete a registration with all indexed generations.

Any successful action that changes active authorization or available content
advances the frontend-only `authorizationEpoch`, retires the old backend Agent
session, and resets conversation state at the new security boundary. The epoch
is never sent to the backend. Rejecting an inactive pending candidate alone
does not change current authorization.

## Security Boundary

- `metadata_only`: the model can search on demand but receives only relative paths, line ranges, and `referenceId`, not source text.
- `provider_send`: bounded, redacted search/read text can be sent only when the codebase is selected for this run, registered with `sendToProvider` consent, and the relative path is admitted by both the current selection and consent grant. When selection/grant revisions differ, newly added scope stays metadata-only and the authorized intersection is never expanded implicitly.
- On-demand tools enforce registered path filters, exclude globs, file types, per-file size, result and line limits, and secret redaction. Absolute roots remain inside the backend trust boundary and never enter tool results, model context, reports, or exports.
- Code-graph results are always metadata-only. Reports, snapshots, and CLI artifacts may retain only safe names/IDs and relative `CodeRef` values, never raw source or a graph relationship presented as trace evidence.
- System-picker mutation requests require a loopback Host, socket, and Origin; the read-only capability probe may omit Origin. The picker is disabled for Docker, enterprise, or non-loopback listeners. Absolute roots and `rootAuthorization` are never returned by codebase list/detail/audit responses.
- Raw queries, intermediate reasoning, tool arguments, and retrieved text from private source/knowledge runs are not persisted to sessions, logs, reports, or exports. Claude local transcripts and OpenAI Responses storage are disabled, and cross-session pattern, verifier, and SQL-fix learning is neither read nor written. Final conclusions and deterministic trace evidence pass through one shared privacy projection; bounded in-process session context provides multi-turn continuity.
- Legacy RAG chunks keep their existing behavior; `app_source`, `kernel_source`, or `registryOrigin=codebase_registry` chunks without codebase metadata fail closed.
- Legacy `/api/rag/chunks/:id` and `/api/rag/search` return sanitized hash/length data for code-aware chunks, not source text.
- Web UI “Delete codebase” revokes retrieval and provider consent before removing every indexed generation in the current scope; interrupted deletion is safe to retry. Local deletion cannot recall content already sent to a provider.
- Patch proposals have three states: `verified`, `sketch`, and `unverified`. This change still requires an indexed lookup `chunkId`; on-demand `referenceId` values do not directly authorize a patch. `sketch` and `unverified` never expose a copyable diff.
- SSE, HTML reports, CLI JSON/Markdown/HTML, analysis-result snapshots, and report/snapshot APIs share one safe source-provenance projector. None retains absolute roots, snippets, search queries, or model-authored free-text reasons. The collapsible Web chat receipt is stricter: it keeps only mode, status/reason code, coverage, selected/queried/used IDs, and unique mechanism statuses, with no `CodeRef`. It can attach only to the current run's message and never backfills an older conclusion.

## Verification

Common checks:

```bash
npm --prefix backend run verify:codebase-aware
npm --prefix backend run verify:code-aware-semantic-delta
npm --prefix backend run test:report-contracts
```

The local full E2E uses:

- `Trace/real/android-startup-heavy/trace.pftrace`
- `Trace/real/android-startup-light/trace.pftrace`
- a local `HighPerformanceFriendsCircle` checkout

The E2E covers both paths:

- No codebase configured for the session: Light trace completes normally and the report has no `CodeRef` / code-aware section.
- HighPerformanceFriendsCircle configured for the session: Heavy/Light traces complete normally and reports/exports contain `CodeRef` entries such as relative `MainActivity.kt` and `LoadSimulator.kt` file paths with line ranges; reports must not contain the absolute root path or raw source text.

Override paths when needed:

```bash
SMARTPERFETTO_E2E_HEAVY_TRACE=/path/heavy.pftrace \
SMARTPERFETTO_E2E_LIGHT_TRACE=/path/light.pftrace \
SMARTPERFETTO_E2E_APP_REPO=/path/HighPerformanceFriendsCircle \
npm --prefix backend run verify:codebase-aware
```

`verify:code-aware-semantic-delta` writes the local deterministic result to
`backend/test-output/code-aware-semantic-delta/deterministic-summary.json`. It
uses the real `trace_processor_shell`, registration/audit routes, on-demand and
indexed handlers, and claim/source-binding verifiers for A0–A4: A0 no selected
source, A1 no-index `metadata_only`, A2 no-index `provider_send`, A3 indexed
`provider_send`, and A4 an intentionally wrong source. A1/A2 prove that an
index is not required; A4 must reject a `CodeRef` outside the selected
partition.

That local gate makes no provider call and is not model-quality acceptance.
With credentials configured, run the separate real-provider matrix:

```bash
node backend/scripts/run-deepseek-agent-e2e.cjs \
  --suite code-aware-semantic-delta \
  --runtime all \
  --repeat 5
```

Claude, OpenAI, Pi, OpenCode, and Qoder results are reported independently as
`PASSED`, `FAILED`, or `REAL PROVIDER NOT AVAILABLE`; missing credentials are
not a pass.

# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis lets SmartPerfetto inspect selected local source on demand and connect trace anchors to `CodeRef` locations. A live registered root supports bounded search and reading without an index. **Add and use for analysis** combines explicit provider consent with the current selection; **Add only** registers a selectable codebase without enabling it. Indexing is optional acceleration for semantic/symbol lookup and patch workflows. Analysis results and quoted source may be saved in local history, reports, and exports.

## Enable It

1. Start the backend with `./start.sh`.
2. Open AI Assistant settings in Perfetto UI and select `Codebases`.
3. Choose a folder and optionally add excluded paths. The name defaults to the folder name. Source kind, allowed access scope, and build metadata remain in advanced settings.
4. Choose **Add and use for analysis** to let the analysis model receive bounded, redacted snippets from this authorized scope. In metadata-only mode, **Add for locate-only analysis** preserves that mode. **Add only** changes neither the current selection nor provider body consent.
5. Start analysis without building an index. Indexing and audit controls remain in advanced settings. CLI users explicitly select `--code-aware metadata_only|provider_send` and `--codebase-id <id>`.

When source mode is off, Add and use selects only the new codebase. In provider-send mode it appends the new codebase; in metadata-only mode it preserves locate-only access. It never activates dormant old selections or silently upgrades existing metadata-only permissions.

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
| `--codebase-id` only | Authorizes `metadata_only` by default and preserves the requested Fast/Auto/Full mode |
| `--code-aware metadata_only` + codebase ID | The model may locate source on demand, receiving only `CodeRef` metadata |
| `--code-aware provider_send` + codebase ID | Bounded search and redacted text reads are available within the authorized scope; a grant that no longer matches the selection refuses the start (`ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE`) until it is granted again |
| `--code-aware off` + codebase ID | Treated as no source selection: the IDs are dropped and authorize no source access |
| `--knowledge-source-id` only | Uses the authorized private external RAG source and preserves the requested budget mode |
| Codebase ID + knowledge source ID | Uses the selected authorized source and knowledge contexts, each within its access boundary |

A source codebase needs only a live registered root. Missing active generations or indexed chunks do not block analysis. External knowledge remains RAG-backed and still requires consent plus a completed index. If the registered source path is moved, unmounted, deleted, or leaves the allowlist, Web/CLI returns `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE` with a fixed reason per codebase (such as `root_missing` or `outside_allowlist`); restore that path or register it again.

When you edit a codebase's selection, a provable narrowing narrows the send grant with it; any other change revokes the grant until you grant it again: `smp codebase authorize-content` shows the exact scope and a token, and `--confirm <token>` grants it (`authorizeContent: true` with `contentDisclosureToken` on the consent API). An actual consent or scope change restarts an ongoing conversation; repeating the same consent, editing an unselected codebase, or reindexing elsewhere does not interrupt it.

Analysis budget and evidence permission are independent: selecting source, reference traces, or private RAG does not automatically promote the requested `fast|auto` mode to `full`. `provider_send` requires two independent authorizations: `--send-to-provider` at codebase registration and `--code-aware provider_send` for the current run.

## When Source Is Used

Selection makes authorized source tools available to the current model. It does not inject the entire repository or infer authorization from keywords. Web, API, CLI, and all five production runtimes share this boundary:

- The model decides whether the question and trace anchors warrant lookup. Ask it to check the selected source when an implementation explanation is needed; quantitative questions can be answered from trace evidence alone.
- Calls respect the current run budget, path filters, provider consent, and bounded output capacity. The primary flow does not implicitly apply a fixed 1-search/2-read/6-second policy.
- No lookup means no claim of source use. Actual calls continue updating the execution ledger even after an earlier explicit not-needed decision.
- Source selection or authorization changes are checked against session identity and authorization fingerprints; invalid private context cannot be reused.
- The authorization fingerprint covers consent, selection scope, lifecycle and deletion, not the index generation: a reindex elsewhere neither interrupts a session or conversation nor hides history. Each run pins its selected indexes' generations; when an index is rebuilt mid-analysis, the index lookup tools refuse explicitly (`codebase_index_generation_changed`, use the index-free `search_codebase` instead) rather than reporting "no hits". A pinned generation whose stored chunks or file were lost refuses the same way. A document knowledge base keeps serving the run while its retained previous generation is still whole.

> **Upgrade note (one time)**: the authorization fingerprint moved to the `acf2` format. Fingerprints stored before the upgrade no longer equal new ones and are never rewritten: an existing session that selected source or knowledge starts over once on its next turn; a conversation from before the upgrade cannot be recovered (start a new one); source-derived history from before the upgrade stays stored locally but no longer enters the model context.

Each run retains `SourceUseDecisionV1`:

| Field | Meaning |
|---|---|
| `status` | Tracks pending, attempted, located, body-available, or incomplete lookup states; it is separate from mechanism verification |
| `reasonCode` | Controlled reason code; model-authored free-text reasons do not enter safe output |
| `selectedCodebaseIds` | Codebases explicitly selected for this request |
| `queriedCodebaseIds` | Codebases against which source tools actually ran |
| `usedCodebaseIds` | Codebases that produced safe `CodeRef` values, including locate-only references |
| `coverageComplete` / `incompleteReasons` | Search coverage; reading a requested window does not make search incomplete, and incomplete search cannot prove source absence |

The returned `sourceReferences[].id` can be used directly in `sourceClaimBindings[].sourceReferenceIds`. References must come from actual current-run outputs within the current selection. Model-invented references and ambiguous aliases are rejected. At reference capacity, tools report the limit rather than delivering references the verifier cannot accept. The Web receipt distinguishes located source, supplied snippets, and actual verification outcomes; a model's mechanism declaration is not a passed check.

The process view retains tool calls, outcome summaries, and model-provided analysis commentary; conclusions can quote source. Raw tool payloads are not dumped into chat or logs.

Source searches, reads, and additional model analysis make the workflow longer and increase analysis time. Relevant snippets are sent to the configured AI service, including internal company services. Retention depends on that service’s configuration and policy; SmartPerfetto cannot promise third-party zero retention.

A failed check concerns result reliability or completeness, such as missing evidence, mismatched source/Trace references, incomplete report coverage, or unfinished execution. Results remain readable with their specific reasons and quality status; this is not a privacy-review verdict.

## Evidence Order And Optional Code Graphs

The default investigation order is:

1. Establish the performance symptom, time range, threads, slices, and symbols from the current trace, matching Skills, and Perfetto SQL. These are the primary evidence for performance claims.
2. If the backend finds a local GitNexus installation that the user already installed and that is currently usable, the AI may call `query_code_graph` / `inspect_code_symbol` to navigate candidate call relationships and symbols. The graph is optional navigation acceleration, not trace evidence or source truth.
3. Narrow the candidate to relative files and lines with index-free `search_codebase` (ranked with declarations and trace call sites first, with context lines) or `find_codebase_files` by file name, then verify the actual source with bounded `read_codebase_file` when current consent permits it. Any graph relationship that affects a conclusion must pass this check. If the permission mode blocks source reading, keep `verificationRequired` and do not promote the candidate to a verified claim.

Conclusions use dual-evidence semantics. Trace/Skill/SQL proves that an occurrence happened in this trace; a `CodeRef` explains a possible implementation mechanism. A `CodeRef` alone cannot increase occurrence or root-cause confidence. The model only declares which source references and same-claim Trace evidence a claim is bound to; the server computes each source-dependent conclusion's standing from what this run actually returned: source explanation plus Trace evidence (a read body with verified same-claim Trace evidence), source explanation not linked to Trace, implementation not read (search hits or metadata only), unbound, and an invalid reference, which fails the answer. Every `path:L10-L20` location written in the answer is also matched against this run's returns. `metadata_only` is locate-only.

Source depth decides how much source a run may search and read: `locate` finds where the relevant code is, and `mechanism` reads enough implementation to explain the behavior. The default `auto` judges from the question (locating, or no source needed → `locate`; explaining an implementation → `mechanism`) and falls back to the analysis budget when it cannot tell; set it with the CLI's `--source-depth` or the API's `options.sourceDepth`. Metadata-only mode is capped at `locate`. Each run states its source depth and how it was decided in the analysis process; only `mechanism` offers the patch tool. Answers are semantically reviewed at either depth.

The `code_pinpoint` Skill can establish safer source candidates before lookup.
Its `hot_slices` step promotes only conservatively recognized app main-thread
trace labels to source-query hints; other slices remain generic anchors. Its
optional `native_symbols` step extracts function, module, and build-id values
from CPU-profile samples. Both narrow search and never replace current-trace
evidence or the later bounded source verification.

Indexing, code graphs, and on-demand reading are separate capabilities. Search and reading remain available without an index; trace anchors can locate source when graph navigation is unavailable. Only actually returned and verified references can support a mechanism binding.

`query_code_graph` and `inspect_code_symbol` return metadata only: `codebaseId`, relative `CodeRef` values, sanitized process/symbol metadata, `graph.freshness`, and `graph.verificationRequired`. They never return raw source text or absolute roots. When a registration uses `pathFilters` or `excludeGlobs`, SmartPerfetto omits whole-repository process summaries whose path scope cannot be proven; authorized relative `CodeRef` values remain available. If GitNexus is missing, unavailable, incompatible, times out, or fails, the graph tool returns a structured unavailable result (`success=false` plus `unsupportedReason`). A stale index returns navigation metadata marked `freshness="stale"`. In either case, the AI/strategy continues through the existing `search_codebase` / `read_codebase_file` path, so registration, selection, and trace analysis remain available. SmartPerfetto does not install, bundle, redistribute, or automatically create or refresh a GitNexus index.

GitNexus is an independent optional third-party tool. Its [official project](https://github.com/abhigyanpatwari/GitNexus) and [npm package](https://www.npmjs.com/package/gitnexus) currently declare the [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE) license. Review the upstream terms and confirm that your intended use is permitted before enabling it, especially for commercial use. This is not legal advice.

An optional-index capacity failure rolls back that indexing attempt and retains the previous index. The UI separates index state from freshly checked root availability. A moved, inaccessible, or disallowed root is never reported as readable. **Allowed source access scope** affects both indexing and on-demand reads; excluded paths also constrain provider disclosure.

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

- `metadata_only`: the model can search on demand but receives only relative paths, line ranges, and reference `id`s, not source text.
- `provider_send`: bounded, redacted search/read text can be sent only when the codebase is selected for this run, registered with `sendToProvider` consent, and the relative path is admitted by both the current selection and consent grant. When selection/grant revisions differ, newly added scope stays metadata-only and the authorized intersection is never expanded implicitly.
- On-demand tools enforce registered path filters, exclude globs, file types, per-file size, result and line limits, and credential redaction. Absolute roots remain inside the backend trust boundary and never enter tool results, model context, reports, or exports. Credential redaction reads each whole file in its own syntax and replaces credential values only (values given to credential-named keys, what credential getters return, `Bearer`/`Basic` credentials, known token prefixes, JWTs, PEM private keys, credential-named markup elements and attributes, and heuristically detected keyless random strings); keys, identifiers and every line break stay, so line numbers do not change. A name that ends only in `token` (a window, frame, lexer or model-stream token) has its value replaced only when the value looks like a credential. On-demand reads use these rules at once; an index built earlier keeps the older rule, which replaced whole assignments including the key, until it is rebuilt.
- Code-graph results are always metadata-only. Reports, snapshots, and CLI artifacts may retain relative `CodeRef` values and source quoted in the analysis, but must not present graph relationships as Trace evidence.
- System-picker mutation requests require a loopback Host, socket, and Origin; the read-only capability probe may omit Origin. The picker is disabled for Docker, enterprise, or non-loopback listeners. Absolute roots and `rootAuthorization` are never returned by codebase list/detail/audit responses.
- Raw queries, tool arguments, and complete retrieval payloads are not additionally written to logs. Provider transcripts and cross-session learning retain their separate restrictions. User-visible analysis results and source quotations may be saved in local history, reports, and snapshots. Private knowledge text retains its independent filtering policy.
- Legacy RAG chunks keep their existing behavior; `app_source`, `kernel_source`, or `registryOrigin=codebase_registry` chunks without codebase metadata fail closed.
- Legacy `/api/rag/chunks/:id` and `/api/rag/search` return sanitized hash/length data for code-aware chunks, not source text.
- Web UI “Delete codebase” revokes retrieval and provider consent before removing every indexed generation in the current scope; interrupted deletion is safe to retry. Local deletion cannot recall content already sent to a provider.
- Patch proposals have three states: `verified`, `sketch`, and `unverified`. This change still requires an indexed lookup `chunkId`; on-demand `referenceId` values do not directly authorize a patch. `sketch` and `unverified` never expose a copyable diff.
- SSE, HTML reports, CLI JSON/Markdown/HTML, analysis-result snapshots, and report/snapshot APIs share the owner-result projection, retaining source quotations and specific check failures. Logs and public artifacts use the strict projection. The collapsible Web receipt remains metadata-only: mode, status/reason code, coverage, selected/queried/used IDs, and mechanism status, without `CodeRef`, bound only to the current run.

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
- HighPerformanceFriendsCircle configured for the session: Heavy/Light traces complete normally and reports/exports contain `CodeRef` entries such as relative `MainActivity.kt` and `LoadSimulator.kt` file paths with line ranges; reports must not expose absolute roots. Owner results may retain quoted source; logs and public artifacts must still exclude raw source.

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

Use a single-scenario diagnostic to investigate a failure before repeating the
matrix. It does not replace five repetitions or certify uncovered recommendation
semantics:

```bash
node backend/scripts/run-deepseek-agent-e2e.cjs \
  --suite code-aware-semantic-delta --runtime openai-agents-sdk \
  --preflight --query-id explicit-source-location --condition A2
```

`A0` selects no source, `A2` registers only, and `A3` registers and indexes.
Diagnostics retain actual tool calls, source references, completion and
verification status; successful retrieval alone cannot pass delivery acceptance.
Prompts guide main-answer length; OpenAI requests omit an application output
cap by default, and Claude answer streams are not clipped at an accumulated
character threshold. Structured conclusion parsing and fallback display retain
all valid items, and saved history does not clip answer tails at a fixed character
count. An explicit `OPENAI_MAX_OUTPUT_TOKENS` must be a positive
integer. Provider limits still apply, and changing the budget does not change
acceptance criteria.

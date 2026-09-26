<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Changelog

All notable changes to SmartPerfetto are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commit prefixes follow [Conventional Commits](https://www.conventionalcommits.org/).
Detailed commit-level history is available via `git log`.

## [Unreleased]

### Removed
- `/api/perfetto-sql/*` now answers 410 in every deployment mode. It had no
  product caller; its fallback analyses interpolated the request package name
  into SQL unescaped, matching it as a prefix and as a substring of its last
  segment, and `/sql` ran caller-supplied SQL without a trace ownership check.
  Scene endpoints map to `POST /api/skills/execute/<skillId>` with the same
  `{traceId, packageName}` body (for example `/startup` to `startup_analysis`;
  in enterprise deployments that route is workspace-scoped too); the response
  names the successor. `/sql`, `/tables`, `/functions`, `/skills`, `/analyze`,
  `/input`, `/buffer-flow` and `/systemserver` have no direct successor. The
  unused `analyze_frame` legacy agent tool, which built the same kind of query,
  and the SQL knowledge-base code that only these paths read are gone too,
  including the `PERFETTO_PATH` setting.

### Fixed
- `scroll_session_analysis` counts frames of the target app only (issued
  process scope, else the exact package or its `name:*` subprocesses) instead
  of every main thread's `doFrame`.

## [1.14.0] - 2026-09-24

### Added
- CPU frequency limits are attributed to thermal, cooling-device and workload
  evidence: limit episodes are detected per cluster and matched against
  cooling-device state, thermal signals and the threads that ran during the
  episode, with a constructed thermal-limit trace case.
- Interruptible (S) waits are attributed by wake source. Android kernels emit
  `sched_blocked_reason` only for uninterruptible sleep, so socket, timer and
  hand-off waits were invisible; the waker and IRQ context of the wakeup row
  now classify them as network receive, timer/device, worker hand-off, binder
  reply or system service candidates. The new Skill
  `process_thread_wait_sources_in_range` covers every thread of a process.
- The wait-chain engine is available to the agent as the MCP tool
  `analyze_wait_chain`. Its segment and one-row summary tables carry
  native-producer semantics for exact ns values and `utid`, so a numeric
  claim citing them is proved or rejected by the deterministic verifier.
- The AI Assistant critical-path drawer renders every layer the engine
  returns (direct waker, semantic sources, the target's own states, the
  recursed chain, best case and maximum saving, affected frames, falsifiable
  hypotheses with copyable verification SQL). "Continue in the conversation"
  pre-fills the composer with an ids-and-numbers question for the current
  trace; it is never sent automatically.
- `/api/workspaces/:workspaceId/critical-path` serves the drawer in
  enterprise / OIDC deployments, where the global route answers 410. The
  response is declared once in a shared contract and generated into the
  frontend types.

### Changed
- Bounded first-turn questions keep trace-fact preflight (focus app,
  architecture, vendor, trace completeness); only memory-type prefetch is
  limited to scene-wide reads. `list_skills` describes the Skills most
  relevant to the query first, and scene classification uses each strategy's
  first keywords as lexical anchors.
- Final conclusions keep their comparison tables and evidence beyond the
  streamed previews, and the legacy quick/full prompt templates are removed
  in favour of the `knowledge-*` templates.
- The critical-path, comparison and flamegraph summaries share one isolated
  one-shot model call (AI capability gate, the caller's Provider Manager
  runtime, no tools or MCP servers, cancellation and deadline). The
  flamegraph summary has its own feature gate, `flamegraph_ai_summary`.
- Critical-path results carry stable ids for modules, anomalies,
  recommendations, warnings and reasons; text is rendered per request
  language in `presentationAnalysis`. `analysis` remains as the deprecated
  zh-CN rendering. Engine defaults are the single source for segment and
  recursion limits.
- Per-segment attribution (IO blocked-function families, wake sources,
  binder, monitor contention, GC, CPU competition and frequency) is shared
  SQL fragments used by both Skills and the critical-path engine.
- The static `assistant-critical-path.js` page is retired; the plugin owns
  the button. Static frontend assets are declared in
  `scripts/frontend-static-assets.json` and checked by
  `check:frontend-prebuild`.

### Fixed
- The critical-path engine reads the direct waker from the wakeup row, sums
  totals over the whole chain in ns (an external share can no longer exceed
  100%), stops when the caller disconnects or cancels, returns typed errors
  for invalid thread selectors, and attaches monitor contention to the lock
  owner's segment. The rendering-pipeline teaching flow reuses the engine's
  chain and waker.
- The flamegraph route validates its input before loading a trace and no
  longer hides trace-processor query errors.
- Scene reconstruction proposals accept the `planPhaseId` every evidence tool
  advertises, treat explicit nulls and blank identifiers as absent, and accept a
  numeric cell quoted as its exact decimal string. Changes commit in atomic
  groups, so one bad reference no longer discards the rest of a revision, and
  every failing reference is reported at once with its conflicting identifier,
  available columns or row count.
- Scene runs now pause evidence acquisition until a first revision is attempted
  and close acquisition before the budget limit, so the timeline is committed
  before a slow provider exhausts the run. Claude scene runs use the same
  progress-aware budget as OpenAI scene runs.
- A scene run that committed no timeline segment is reported as failed and no
  empty scene report is published; a run that retained a timeline states which
  revision survives. The story panel shows the reason.
- The final semantic review may use the unspent delivery reserve, and the
  OpenAI runtime streams its intent and semantic requests. A slow reasoning
  provider previously lost every review to fetch's default five-minute headers
  timeout. On OpenAI runs and Claude scene runs, a completed report may now
  spend its remaining run budget on the review, so a report that passes no
  longer fails its quality gate only because the review did not finish in
  the reserve.
- A well-framed conclusion declaration the parser rejected is repaired in the
  same single delivery turn on Claude, OpenCode and Qoder, where it previously
  left every claim unverified, and on Pi, where it replaces a full-answer
  correction. The body must stay unchanged and every declared claim must be
  kept. Repair diagnostics name each failing claim's position and schema
  field; OpenAI's continuation receives the same diagnostics.
- Finalized history, conversation descriptors, trace-processor lease
  acquisition and startup run recovery take the SQLite write lock before they
  read, so a commit from another process no longer fails the run with
  "database is locked".
- Summarized SQL results list the original row index of each sample row, and
  the Agent SSE verification script exits after writing its artifacts and
  treats a failed run's `error` event as terminal, as the AI panel does.

### Known issues
- With real providers, long startup reports are still frequently delivered as
  `partial` because the semantic review rejects undeclared assertions and
  body values that differ from their declarations. The answer is delivered
  with the failing checks named; treat it as unverified.

## [1.13.0] - 2026-09-21

### Added
- Evidence-linked scene reconstruction investigates user input, device state and
  application response through the selected Provider, with incremental timeline
  revisions, bounded evidence archives and consistent UI/report/history views.
- Explicit input, device-state and raw response-marker inventories retain exact
  timestamps, identities, missing observations and query coverage gaps.

### Changed
- The scene button starts investigation immediately through the shared analysis
  lifecycle, including Provider pinning, cancellation and replay safeguards.

### Fixed
- Missing input no longer becomes idle; touch movement and ACTION_SCROLL no
  longer imply application scrolling or a physical wheel. First state samples
  and OEM device-state numbers retain their observation limits.
- Time-boundary references, scene retries and asynchronous session cleanup are
  checked without treating a successful query as complete trace capture or a
  semantically verified story. Scene reconstruction remains explicitly partial
  when required observations or checks are unavailable.

## [1.12.1] - 2026-09-21

### Added
- Saved Providers can load a bounded, cached model catalog from their own
  OpenAI-compatible, Anthropic-compatible, or Ollama endpoint. Suggestions stay
  isolated by workspace and provider ID, keep curated presets and manual model
  entry, and exclude known embedding, reranking, media, moderation, and other
  non-analysis products.
- A weekly, read-only Provider Model Catalog workflow reports newly visible
  model candidates for every configured provider credential. It never edits
  `main`, and treats models hidden by an account, plan, region, or gateway as a
  visibility observation rather than retirement evidence.

### Changed
- The direct DeepSeek preset and runtime fallbacks now use the current
  `deepseek-flash` light-model ID alongside `deepseek-v4-pro`; gateway-specific
  model IDs remain unchanged.

### Fixed
- Large SQL/DataEnvelope results no longer duplicate complete tables through
  chat SSE, replay, statistics, charts, and redraws. Chat previews are bounded
  by row and byte budgets while reports, snapshots, evidence, and claim
  verification retain the complete result. Streaming Mermaid updates also
  coalesce obsolete renders instead of accumulating detached DOM work.
- Round 69 thermal, ANR, high-refresh presentation, and delivery-verification
  fixes now preserve unavailable evidence and corrected classifications instead
  of weakening detector or claim semantics.
- Startup wakeup-chain attribution, hypothesis re-resolution, and prompt budget
  handling retain methodology context without carrying superseded conclusions.
- Trace upload disk-precheck failures and server-verification details are
  actionable without expanding noisy diagnostic blocks by default.

## [1.12.0] - 2026-09-17

### Added
- Evidence conditions for investigation requirements: `condition: {kind: evidence}`
  resolves from the producer-bound evidence ledger instead of the answer text,
  so a scrolling conclusion cannot exclude the render/GPU/buffer mechanism
  without measuring it. The obligation attaches only when buffer stuffing
  actually dominates (`render.frame.buffer_stuffing.rate`,
  `render.buffer.dequeue.wait.duration`) and is satisfied only by a run that
  observed the producer/consumer boundary; an absent metric stays unknown
  rather than reading as cleared.
- `smp probe`: loads the strategy registry from the exact artifact a batch
  will run and prints `OK N` or the failure, so a dist parser meeting a new
  strategy schema fails the batch gate at startup instead of killing every
  session mid-run. `strategy_invalid_*` codes now carry the `#requirementId`
  and the source file.

### Fixed
- Switching a Trace from a conversation-mode answer to a fast or full analysis
  no longer fails with HTTP 409 "Trace processor lease backing identity
  conflicts with the registered Trace". The conversation run records its Trace
  as a metadata-only placeholder, and the first real registration now upgrades
  that placeholder in place; two real registrations that disagree still
  conflict.
- Claim verification states why a claim was not checked on every surface —
  CLI status line, HTML reports, persisted CLI evidence, and the AI Assistant
  panel — with closed-vocabulary cause codes (declaration issues, transport
  status and attempts) instead of silently stripping the detail. Relation
  proposal failures name the exact field a provider got wrong instead of a
  bare `invalid_relation_proposal`.
- The OpenAI runtime's semantic-review transport retries only transient
  provider failures (connection errors, 408/425/429/5xx). Deterministic 4xx
  and 200 error bodies no longer pay a doomed retry, and results report
  `httpStatus` and attempt counts for triage.

### Removed
- `phase_hints` no longer reaches any runtime path. The dead keyword matcher
  was removed and the strategy field is documented as authoring-only.

## [1.11.0] - 2026-09-16

### Added
- Evidence-backed final delivery: conclusion claims are checked against retained
  execution captures and one bounded, no-tool semantic review of the full answer.
  Web, CLI, HTML reports and snapshots show each claim's verification result,
  including failed and unchecked claims, while keeping the conclusion body intact.
- CLI session markers (`✓`, `~`, `!`, `✗`) and `deliveryVerdict` in JSON/NDJSON
  `complete` events. CLI turns persist their evidence bundle so exported reports
  keep claim verification.
- `AGENT_MAX_RUN_TIMEOUT_MS` / `OPENAI_MAX_RUN_TIMEOUT_MS`: the OpenAI runtime
  extends its initial deadline while tools return data or the provider is still
  producing output, and reserves one no-tool call to deliver a limited
  `partial` / `timeout` conclusion from returned data.

### Changed
- Startup analysis collects scheduling, blocking, CPU frequency and main-thread
  state evidence against explicit investigation requirements, and final reports
  keep exact values or mark rounded ones.
- All five runtimes share one conclusion declaration protocol, and MCP tool
  descriptions are loaded from strategy templates.
- Missing-credential errors, `smp doctor` and runtime health include setup
  guidance. The CLI Provider store stays separate from a source Web backend
  unless both use the same `SMARTPERFETTO_BACKEND_DATA_DIR`.

### Removed
- The Claude Agent SDK runtime no longer falls back to a local Claude Code login,
  and `ANTHROPIC_BASE_URL` alone no longer counts as configured, including for
  gateways that previously worked without a key. Analysis now stops early with
  setup guidance instead. To migrate, add a provider under
  **AI Assistant Settings → Providers**, or set `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` (plus `ANTHROPIC_BASE_URL` for a compatible gateway),
  Bedrock or Vertex configuration in `backend/.env`, `~/.smartperfetto/env` or
  the Docker env.

### Fixed
- Delivery diagnostics name semantic review failures (answer text that differs
  from its declared claim, undeclared assertions) instead of reporting an
  unclassified check failure.
- CLI source supplements rebuild the turn evidence fingerprint, so later report
  export no longer reports valid evidence as mismatched.
- Qoder provider connection tests accept a local `qodercli` login, matching the
  runtime.

### Known issues
- With real providers, long startup and scrolling reports are frequently
  delivered as `partial`: the semantic review rejects rounded values written
  without an approximation marker and assertions without a matching claim
  declaration. The answer is still delivered with the failing checks named;
  treat it as unverified.

## [1.10.0] - 2026-09-11

### Added
- Durable investigation checkpoints and conversation recovery across Web, CLI,
  reports, and snapshots, with parent-run lineage preserved for later turns.
- Continuous main-thread scheduling evidence for frame work, observed cadence,
  task attribution, CPU placement, preemption, and shared system context.

### Changed
- Authorized source analysis can use registered folders on demand without
  requiring an index, while keeping source-backed answers readable and their
  provenance attached through verification and persistence.
- Provider setup uses refreshed mainstream model catalogs and simpler forms,
  while preserving saved values and arbitrary manual model identifiers.
- Analysis runtimes share structured investigation requirements and evidence
  context across Claude, OpenAI, Pi, OpenCode, and Qoder paths.

### Fixed
- Register CLI analysis parents before archival so completed turns no longer
  fail with `analysis_history_parent_not_authorized`; preserve cited evidence in
  final CLI results.
- Preserve complete model conclusions, source references, native SQL evidence,
  and verification diagnostics across owner-facing output surfaces.
- Start portable frontend readiness timing only after backend health succeeds,
  and keep release/test gates portable across Windows, macOS, and Linux.

## [1.9.0] - 2026-09-08

### Added
- Explicit Auto, Fast, and Full analysis modes in the AI Assistant, with mode
  intent preserved across follow-up turns and native runtimes.
- Codebase management commands for source selection, consent, pending-index
  decisions, and lifecycle audits, with trace-bound source-use provenance in
  analysis reports.

### Changed
- Analysis runtimes share typed turn intent and evidence context. Plans and
  report expansion follow the request instead of fixed scene templates.
- Tool progress describes meaningful outcomes through a shared narration layer.
- Portable Skill exports preserve explicit process scopes and parameter bindings.

### Fixed
- Preserve original claims and evidence through verification, streaming,
  snapshots, reports, and CLI output; incomplete assessments remain visible.
- Keep process identity, trace side, source permissions, and query provenance
  attached across composite Skills and truncated tool results.
- Distinguish runtime failure by execution state and authorship, and preserve
  provider reasoning and literal analysis content.
- Repair CLI command contracts, UTF-8 trace filenames, writable portable upload
  paths, and missing test-suite registration.

## [1.8.4] - 2026-08-27

### Fixed
- npm packages now declare the exact SmartPerfetto GitHub repository metadata
  required for Sigstore provenance validation during Trusted Publishing.

## [1.8.3] - 2026-08-27

### Added
- Codebase selections that expand after registration can now be explicitly
  authorized from the AI Assistant with a confirmation that shows the current
  include and exclude scope.

### Changed
- npm releases now use a hash-bound GitHub Actions Trusted Publishing workflow
  with isolated OIDC credentials and an immutable public-release recovery path.

### Fixed
- Source enumeration and on-demand search now distinguish valid empty results,
  partial traversal failures, and complete results across ripgrep, Git, and Node
  backends without treating normal symlinks, sparse entries, deleted files, or
  uninitialized submodules as permanent reindex failures.
- Indexed code lookup now reapplies the current source selection and session
  provider consent, while optional AOSP manifest failures degrade with visible
  diagnostics instead of blocking an otherwise valid preview.

## [1.8.2] - 2026-08-26

### Fixed
- Source enumeration now preserves `time_budget` when a bounded `.gitmodules`
  metadata read reaches its real wall-clock deadline, while unsafe or malformed
  submodule declarations continue to report `traversal_error`.

## [1.8.1] - 2026-08-26

### Added
- Code-aware analysis can preview and register bounded app, AOSP/OEM, and
  kernel source trees, search or read selected files without a prebuilt index,
  and build optional indexed generations with explicit coverage metadata.
- The AI Assistant now exposes codebase scope suggestions, language-consent
  changes, active and pending generation status, downgrade confirmation,
  maintenance warnings, audit details, and accessible operation feedback.

### Changed
- Trace-corpus verification now binds executable SQL to source-pinned
  provenance, realistic constructed evidence, and semantic result assertions
  instead of treating registration or row-only execution as correctness.
- Local source selection, provider disclosure, Git/ripgrep/Node discovery, and
  generation activation now share canonical policy and consent contracts across
  CLI, API, MCP, reports, and the committed Perfetto frontend.

### Fixed
- Codebase reindex, candidate replacement, expiry, cleanup, deletion, and
  provider-consent changes are fenced against stale generations and concurrent
  requests without deleting active or in-flight source chunks.
- Metadata reads, Git provenance, subprocess output, directory traversal, and
  local RAG persistence now have bounded cross-platform deadlines and capacity;
  Windows path casing, open flags, and Trace CLI expectations are portable.

## [1.8.0] - 2026-08-25

### Added
- The AI Assistant can open a dual-Trace workspace before any Trace is loaded,
  upload or replace baseline and comparison files independently, hand the pair
  into the main Viewer, and restore the pair and layout after page reload.
- Analysis receipts and reports now carry versioned trace-processor capability
  attribution, canonical trace summaries, deterministic evidence-relation
  checks, and shared selection evidence across comparison consumers.
- Offline golden evaluation and production shadow-routing foundations now record
  accuracy experiments and escalation recommendations without silently changing
  the public `fast`, `full`, or `auto` provider budget.

### Changed
- Live raw-Trace comparison now supports any two distinct workspace traces,
  stable baseline/comparison roles, explicit swapping, pane-local upload state,
  and persisted local/API-key workspaces while retaining OIDC page-local Trace
  isolation.
- The bundled Perfetto UI, trace processor, SQL documentation/indexes, and
  global trace sanity contracts are synchronized to Perfetto v58.2.

### Fixed
- Invalid DataEnvelope, pipeline-detection, capability-manifest, and evidence
  inputs now fail closed, while correlation evidence remains explicitly below
  causal claims.
- Dual-Trace browser diagnostics now tolerate bounded cold-backend readiness
  delays without hiding authentication failures, and stale pane uploads cannot
  overwrite a reset workspace lifecycle.

## [1.7.0] - 2026-08-21

### Added
- Qoder runtime integration now supports bring-your-own-key provider and model
  routing while preserving Provider Manager pinning and runtime boundaries.

### Changed
- The six maintained real-trace fixtures now carry explicit
  `AGPL-3.0-or-later` licensing, owner-approved publication consent, and
  completed privacy and sanitization reviews.

### Fixed
- DeepSeek reasoning-model tool continuations now retain the required
  `reasoning_content` across OpenAI-compatible multi-turn requests.
- Pi final correction now receives semantic final-result quality failures,
  including comparison-identity defects, before producing its terminal report.

## [1.6.0] - 2026-08-14

### Added
- Page-scoped OIDC analysis connections now preserve explicit Trace, provider,
  and session isolation across navigation and reload. Thanks to @cipherTing
  for the original contribution in #239.
- The Pi runtime now uses provider-explicit `pi-agent-core` and `pi-ai`
  integration with aligned dependencies and a dedicated runtime gate.
- Windows portable installs can select a fixed, writable `D:` drive for user
  data and conservatively migrate an existing default `C:` data directory
  without merging, overwriting, or deleting the source.

### Changed
- Claude-compatible and OpenAI runtimes now apply configurable full-request
  and provider-idle deadlines, bounded external tool projections, answer
  fallbacks, and retained continuation history.
- The setup, update, Windows, portable packaging, troubleshooting, and platform
  compatibility guides now use a shorter quick-start path with dedicated
  bilingual application-update guidance.
- Runtime and development dependencies were refreshed while preserving the
  committed frontend, Node.js 24, and provider-pinning contracts.

### Fixed
- Timed-out or history-limited analysis retains genuine partial conclusions,
  evidence, reports, snapshots, and provenance while still finalizing terminal
  `analysis_completed` and `end` events.
- Claude stream cleanup and OpenAI provider close no longer leave completed or
  partial sessions waiting indefinitely after a terminal result.
- Windows DPAPI portable smoke preserves PowerShell paths and the host provider
  profile, and frontend refresh tests now honor required local build tools.

## [1.5.0] - 2026-08-10

### Added
- The AI Assistant now supports evidence-aware conversation sessions with
  trace, Provider, runtime, source, and RAG context boundaries that are pinned
  and revalidated across turns.
- Analysis results can propose working timeline navigation, table opening, and
  session-scoped evidence collection actions. Non-table insights retain a
  bounded provenance snapshot, while table results retain their structured
  rows and columns.
- Windows portable installs now have a documented user-data layout, legacy
  migration path, runtime health checks, and target-native release evidence.

### Changed
- OpenAI Agents, Pi, and OpenCode runtimes share stricter plan-completion,
  final-report, claim-verification, and real DeepSeek regression contracts.
- Code-aware analysis can use GitNexus graph navigation while keeping private
  source queries out of persisted browser and backend projections.
- Provider/runtime changes and Trace attachment changes establish explicit new
  conversation identities instead of silently reusing stale model sessions.

### Fixed
- Timeline point/range actions now focus the intended timestamp or interval,
  table actions reveal the referenced result, and collected evidence survives
  reload without duplicate or legacy workspace shadow writes.
- Conversation handoff evidence is intersected with authoritative backend
  evidence, and previous private queries remain redacted from later model
  output and durable UI storage.
- Provider pinning, external-issue retries, public HTTP address validation,
  portable data migration, Mermaid fallback rendering, and bounded report
  continuation now fail closed at their documented boundaries.

## [1.4.0] - 2026-08-03

### Added
- Enterprise OIDC now provides an off-by-default discovery/login/callback
  flow, CSRF-protected backend sessions, and user-bound personal workspaces
  without trusting caller-supplied tenant or workspace identity.
- The committed Perfetto browser frontend now includes Trace Doctor, unified
  Stack Samples/flamegraphs, raw multi-trace open/merge, Video Frames, Pixel
  input/CUJ views, experimental Memscope/OOM views, and newer local WASM input
  and query capabilities.
- Completed analysis results can now run source-run-pinned, no-tool Agent
  triage for external feedback. It classifies reportability, ownership, and
  useful contribution type, collects missing user context, and creates a
  deidentified GitHub draft without submitting it.
- A dedicated Agent-Assisted Analysis Feedback Issue Form, public-artifact
  sanitizer, private/security fail-closed routing, and focused backend/UI tests
  document and enforce the new feedback boundary.
- An off-by-default Self-Evolution control plane now covers immutable run
  attribution, reversible public/private feedback projections, fixed
  validation/holdout paired replay, reviewable proposals, qualification gates,
  content-addressed overlays, upgrade reconciliation, and explicit rollback.
- The AI Assistant Evolution settings page and scoped admin API expose
  proposal diffs, progress, overlay generations, persistence diagnostics, and
  reconciliation without configuring an external L2 judge.

### Changed
- Browser timeline/plugin queries now have an explicit local WASM engine
  boundary, while AI, Skills, CLI, and report evidence continue to use the
  independently pinned native `trace_processor_shell`.
- New RunManifests persist a non-secret provider snapshot hash. Historical
  feedback triage must match the source run's provider/runtime snapshot or use
  explicit deterministic fallback; it never switches silently to the current
  provider.
- Analysis runtimes now consume run-pinned effective registry snapshots so a
  newly published overlay affects only new runs. Apply/revert requires an
  accepted and still-qualified proposal plus writable external user data, and
  remains fail-closed otherwise.
- Feedback is an append-only scoped fact stream with rebuildable effective
  projections. Private feedback stays in a separate local path and never enters
  curation or contribution bundles.

### Fixed
- Claude-compatible runtimes can preserve an evidence-referenced final report
  after an explicit stream interruption or maximum-turn termination. Generic
  execution, authentication, quota, permission, and configuration errors remain
  failed instead of being promoted to partial success.
- OIDC callback identity, personal-workspace ownership, and request-scoped
  authorization now stay aligned across login and subsequent API calls.
- Cross-platform startup-contract tests normalize Windows script paths without
  weakening the actual launcher contract.

## [1.3.0] - 2026-07-28

### Added
- Code-aware analysis can select authorized local source directories through a
  native folder picker, with bounded path validation, registry persistence, and
  matching API and bilingual documentation.
- Dual-trace workspaces can open large stored traces through isolated backend
  trace-processor RPC sessions instead of copying the complete trace into each
  browser pane.

### Changed
- Large-trace startup timeouts now scale with trace size, while processor leases
  protect active viewers and a runtime supervisor reclaims abandoned isolated
  processors.
- The maintained Perfetto fork now carries all SmartPerfetto UI work on its
  `main` branch, and the committed frontend prebuild matches that merged source.
- Maintainer guidance now includes the repository-scoped GitNexus exploration,
  impact-analysis, debugging, refactoring, and CLI workflows.

### Fixed
- Dual-trace reloads preserve stored trace identity, and the backend WebSocket
  proxy now handles browser capability subprotocols and loopback origin
  normalization correctly.
- GitHub release asset downloads use the supported API media type.

## [1.2.8] - 2026-07-28

### Fixed
- Windows cross-platform governance now builds and injects the same pinned Go
  health and process helper used by the exact-archive release gate.
- GitHub release download tests now inject a descriptor-level process runner,
  preserving the production no-shell `gh api` contract without relying on
  Windows command-shim resolution.

## [1.2.7] - 2026-07-28

### Fixed
- Portable readiness checks now use explicit IPv4 loopback semantics from the
  launcher through target-native release gates, preventing `localhost`
  resolution or proxy behavior from masking a healthy backend as a connection
  refusal.
- The Windows exact-archive gate now uses the repository-owned fixed Go HTTP
  probe and native Toolhelp32 process snapshots with bounded, fail-closed
  parsing instead of PowerShell, CIM, or WMI.
- Hosted lifecycle verification accepts legitimate native descendants while
  still proving product parentage, helper isolation, graceful shutdown, port
  release, and the absence of surviving launcher processes.

## [1.2.4] - 2026-07-27

### Added
- Portable release promotion now consumes target-native smoke summaries that
  bind the final archive name, byte size, SHA-256, source commit, health probes,
  lifecycle receipt, and port-release result.
- The application can surface GitHub update availability, and the maintained
  platform-compatibility reference now separates declared, packaged, executed,
  signed, and published support.

### Changed
- Portable launchers now own their complete backend/frontend process tree,
  coordinate graceful shutdown through a runtime control file, drain active
  HTTP and SSE responses, and record a shutdown receipt before releasing ports.
- Portable Node.js 24 runtimes are pinned by archive and executable-content
  digests. macOS deployment compatibility is derived from every bundled Mach-O
  file instead of a manually declared target.
- Public promotion now requires a clean release commit, exact-archive smoke on
  Windows, macOS, and Linux, and Developer ID signing, notarization, stapling,
  and Gatekeeper acceptance for the final macOS zip.

### Fixed
- Supersedes the broken v1.2.3 macOS portable asset: startup now preflights the
  bundled Node runtime, reports actionable backend/frontend log paths, and no
  longer masks an immediate runtime crash as a generic readiness timeout.
- macOS packaging signs every nested Mach-O inside-out while preserving only
  the required runtime identifiers and entitlements; release verification
  rejects incomplete signatures, missing notarization receipts, and mismatched
  final archive bytes.
- Portable archive inspection rejects traversal, absolute paths, links,
  duplicate normalized entries, and extraction-budget violations before
  launch.
- Loopback listeners and health checks consistently use `127.0.0.1`, and
  shutdown now accounts for upgraded sockets, trace processors, child
  descendants, interrupted startup, and forced-exit fallbacks.
- GPT-5.6 Chat Completions requests use the supported output-token limit field.

## [1.2.1] - 2026-07-18

### Fixed
- Docker releases now distribute AMD64 and ARM64 builds across native,
  platform-isolated runners before assembling and signing the final OCI
  manifest, preventing the bundled AIW Knowledge Pack from exhausting a shared
  runner's disk.

## [1.2.0] - 2026-07-18

### Added
- SmartPerfetto now ships a signed, versioned Android Internals Knowledge Pack
  containing the projected body content of every AIW article, including draft,
  review, finalized, and deprecated workflow states.
- The CLI, backend startup worker, runtime health, and report pipeline can
  inspect, update, and attribute the Pack through a TUF-verified stable channel
  while retaining the bundled snapshot as an offline fallback.
- AI analysis can retrieve bounded Android internals background excerpts with
  provenance, redaction, privacy projection, and explicit separation from
  current-trace SQL/Skill evidence.

### Changed
- npm, Docker, source, and three-platform portable packages now carry the
  locked compressed Pack, its aggregate audit, licenses, trusted root, and
  channel configuration as runtime assets.
- Knowledge Pack references are projected into reports and session snapshots
  without exposing excerpt bodies through logs or streaming metadata.

## [1.1.1] - 2026-07-17

### Fixed
- Docker builds normalize the OpenCode runtime link so the packaged provider
  entry remains usable across image layers.

## [1.1.0] - 2026-07-17

### Added
- Smart Profile can now compose user-authorized source repositories and
  external RAG knowledge independently or together, with pinned generations,
  consent modes, provenance, and fail-closed authorization.
- Provider-neutral run specifications align OpenAI Agents SDK, Pi Agent Core,
  OpenCode, and Claude-compatible runtimes across analysis, comparison,
  evidence verification, reports, snapshots, CLI output, and frontend chat.
- Evidence-first Android 17 rendering, camera, managed-heap, GPU-compute,
  kernel-wait, startup, and scrolling knowledge is backed by an expanded,
  deterministic real/constructed trace corpus.
- Cross-platform contracts cover Linux, macOS, Windows, Docker, the npm CLI,
  portable launchers, and the public Perfetto Agent Skill projection.

### Changed
- Smart scene selection, presentation, recovery, and prompt methodology are
  registry/template-driven, with final conclusions kept separate from
  evidence, reports, snapshots, and readable chat projections.
- The Perfetto UI uses unified analysis context and trace workspaces, with the
  committed frontend prebuild regenerated from the matching submodule commit.
- Trace listing, processor queues, report caching, source ingestion, RAG
  accounting, and registry reads now use bounded, cursor-based, lease-aware,
  or aggregate paths suitable for larger deployments.
- Public `/health` exposes only liveness and version; authenticated runtime and
  provider diagnostics are served by `/api/runtime-health`.
- The public Perfetto-Skills export now classifies all 101 Strategy/registry
  sources explicitly, exporting portable behavior while keeping product-only
  orchestration behind the SmartPerfetto boundary.

### Fixed
- Private source/RAG context now preserves tenant, workspace, user, consent,
  license, and provider-send boundaries through persistence, replay, SSE,
  reports, and snapshots without leaking intermediate model content.
- Provider endpoints enforce exact-origin allowlists, DNS/IP pinning, redirect
  revalidation, deadlines, and credential reconfirmation after origin changes.
- Cross-process trace-processor cleanup and port allocation no longer terminate
  another live instance or claim a port already held by the operating system.
- Chinese/English source and RAG controls, dual-trace language inheritance,
  narrow layouts, keyboard focus, and ARIA semantics remain consistent across
  partial-capability and error states.
- Machine-readable CLI commands preserve parseable stdout, while bootstrap,
  health, lifecycle, and cleanup diagnostics are routed to stderr.

## [1.0.21] - 2026-05-25

### Added
- Smart Analysis Mode now starts with a scene-inventory preview for mixed-action
  traces, then lets users deep-dive all scenes or only startup, scrolling,
  click, navigation, device-state, or ANR ranges.
- Smart scene reconstruction now carries eligibility, confidence, context,
  verification, and report ids into the main AI chat so the frontend can render
  scoped analysis buttons before spending deep-dive tokens.
- Smart selected-scope E2E coverage now verifies startup and scrolling
  conclusions against the direct single-scene analysis path.

### Changed
- Smart deep dives reuse the dedicated scene strategies and full analysis mode
  for the selected scope, keeping Smart output close to explicit startup or
  scrolling analysis.
- Smart job evidence is projected into bounded report payloads, with omitted
  rows kept as out-of-band scene-job artifacts.
- The committed Perfetto UI prebuild was refreshed from the updated AI
  Assistant plugin bundle.

### Fixed
- Smart scrolling conclusions now preserve corrected deep-dive root causes when
  batch reason codes are superseded by stronger evidence such as shader
  pipeline or `postAndWait` signals.

### Added
- Fast / Full / Auto three-tier analysis mode routing via `options.analysisMode`
  (env-configurable per-turn timeouts, classifier fast-path via keyword rules).
- Scene reconstruction pipeline with independent `sceneStoryService`
  (JobRunner concurrency=3, Haiku-summarized `SceneReport`).
- State Timeline V1: four swim-lane track overlays (device/input/app/system).
- Trace comparison prototype: three conditional MCP tools, orthogonal
  comparison mode.
- Perfetto stdlib integration: 22 critical-preload tables, `list_stdlib_modules`
  MCP tool, `lookup_knowledge` for on-demand background knowledge.
- Deep root-cause analysis skills: `blocking_chain_analysis`,
  `binder_root_cause`, `startup_slow_reasons`, `frame_blocking_calls`.
- Android version diff analysis (system-behavior vs app-adaptation root causes).
- Scrolling jank taxonomy: 21 reason codes, 2 new skills.
- Trace data completeness: capability registry + session-init probing.

### Changed
- agentv3 is now the primary runtime (Claude Agent SDK orchestrator, 20 MCP tools).
- Six shell scripts under `scripts/`; typecheck + test:core covered by `/health`
  dashboard.

### Fixed
- `claudeRuntime.ts` SDK `query()` close-handle convention to prevent zombie
  trace_processor_shell subprocesses.
- Verifier tightened around shallow root causes (critical-severity findings
  must include a quantitative claim and ≥ 2 causal chains).

## [0.1.0] - 2025-12-14

### Added
- Initial public repository structure.
- Perfetto fork submodule (`perfetto/`) with custom UI plugin
  `com.smartperfetto.AIAssistant`.
- Backend Express service with SSE streaming, in-memory session management,
  and trace_processor_shell integration.
- YAML skill system (`backend/skills/`) with L1–L4 layered results and
  `DataEnvelope` v2.0 contract.
- Scene classifier (12 scenes: scrolling / startup / anr / pipeline / memory /
  game / teaching / interaction / touch-tracking / overview / scroll-response /
  general) driven by strategy front-matter.
- Strategy + template system under `backend/strategies/` (`*.strategy.md`,
  `*.template.md`) with hot reload in dev mode.
- HTML report generation and CSV / JSON export.
- AGPL v3.0 licensing throughout.

[Unreleased]: https://github.com/Gracker/SmartPerfetto/compare/v1.14.0...HEAD
[1.14.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.12.1...v1.13.0
[1.12.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.12.0...v1.12.1
[1.12.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.8.4...v1.9.0
[1.8.4]: https://github.com/Gracker/SmartPerfetto/compare/v1.8.3...v1.8.4
[1.8.3]: https://github.com/Gracker/SmartPerfetto/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/Gracker/SmartPerfetto/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.8...v1.3.0
[1.2.8]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.4...v1.2.7
[1.2.4]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.3...v1.2.4
[1.2.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.0.39...v1.1.0
[1.0.21]: https://github.com/Gracker/SmartPerfetto/compare/v1.0.20...v1.0.21
[0.1.0]: https://github.com/Gracker/SmartPerfetto/releases/tag/v0.1.0

<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Changelog

All notable changes to SmartPerfetto are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commit prefixes follow [Conventional Commits](https://www.conventionalcommits.org/).
Detailed commit-level history is available via `git log`.

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

[Unreleased]: https://github.com/Gracker/SmartPerfetto/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.8...v1.3.0
[1.2.4]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.3...v1.2.4
[1.2.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Gracker/SmartPerfetto/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Gracker/SmartPerfetto/compare/v1.0.39...v1.1.0
[1.0.21]: https://github.com/Gracker/SmartPerfetto/compare/v1.0.20...v1.0.21
[0.1.0]: https://github.com/Gracker/SmartPerfetto/releases/tag/v0.1.0

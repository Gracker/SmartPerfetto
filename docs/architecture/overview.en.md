# Architecture Overview

[English](overview.en.md) | [中文](overview.md)

<!-- i18n-headings: paired -->

SmartPerfetto adds an AI analysis layer on top of Perfetto UI. Perfetto remains responsible for trace loading, timeline exploration, and SQL fundamentals; the SmartPerfetto backend handles agent orchestration, Skill execution, report generation, and streaming output.

```text
Frontend: Perfetto UI @ :10000
  └─ com.smartperfetto.AIAssistant plugin
       ├─ trace upload / open trace
       ├─ AI panel / floating window
       ├─ Codebase Config Panel
       ├─ Self-Evolution control plane
       ├─ DataEnvelope tables and charts
       └─ SSE client

Backend: Express @ :3000
  ├─ /api/agent/v1/*          main agent analysis path
  ├─ /api/traces/*            trace upload and lifecycle
  ├─ /api/rag/*               RAG and codebase management
  ├─ /api/skills/*            Skill query and execution
  ├─ /api/admin/self-evolution managed loop and SSE
  ├─ /api/export/*            exports
  ├─ /api/reports/*           HTML reports
  └─ trace_processor_shell    HTTP RPC pool, 9100-9900

Standalone CLI: smp / smartperfetto
  └─ reuses the same backend runtime, Skills, SQL, sessions, reports, and comparison contract
```

## Product Entry Points And Release Forms

| Entry point | User form | Runtime boundary |
|---|---|---|
| Web UI | Docker, portable packages, source `./start.sh` | Calls the backend over HTTP/SSE and serves the committed `frontend/` prebuild |
| CLI | npm package `@gracker/smartperfetto` | Requires Node.js `>=24 <25`, does not start the Web UI, stores sessions/reports under `~/.smartperfetto/` |
| API/SSE | `/api/agent/v1/*` and related routes | Shared by the frontend and external integrations |
| Portable launcher | GitHub three-platform assets | Bundles Node.js 24, native deps, backend, `frontend/`, and `trace_processor_shell` |
| Docker | Docker Hub image | Linux container; does not read host Claude Code local auth |

Feature and bug designs must check Web UI, CLI, API, reports, Docker, portable
packages, runtime/provider behavior, pre-built content, and Node version
boundaries. The LLM/agent checklist is in
[`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md).

## Startup Lifecycle Boundary

Source entry points share `scripts/service-lifecycle.sh`. PID metadata is
written atomically and records the launch generation, OS process-start
identity, executable, working directory, and a diagnostic command snapshot.
Launchers stop only a process tree whose stable identity still matches the
current checkout; port conflicts are diagnosed by default and never resolved
through broad port or command-name kills. Backend and frontend are both
required: an early exit, readiness timeout, or unexpected runtime exit stops
the peer and returns non-zero. Docker uses `tini` for PID1 signal forwarding
and child reaping, while both the entrypoint and container health cover backend
and frontend readiness.

## Core Modules

| Module | Location | Responsibility |
|---|---|---|
| Perfetto UI plugin | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/` | Panel, SSE, result rendering, scene navigation, selection interaction |
| Express backend | `backend/src/index.ts` | Route registration, health checks, middleware, process cleanup |
| OIDC and request identity | `backend/src/routes/enterpriseAuthRoutes.ts`, `enterpriseSsoService.ts`, `middleware/auth.ts` | Login callback, session/CSRF, personal-workspace ownership, and request-scoped tenant/workspace/RBAC binding |
| Runtime contract and registry | `backend/src/agentRuntime/runtimeKinds.ts`, `runtimeDescriptors.ts`, `runtimeSelection.ts` | Defines the current production runtime set, capabilities, canonical loaders, and per-session selection |
| Runtime engines | `backend/src/agentRuntime/engines/{claude,openai,pi,opencode,qoder}/` | Canonical implementations behind shared orchestrator, result and safety contracts; Pi keeps classification and main reasoning request policies within each provider instance |
| Shared agent capabilities | `backend/src/agentv3/` | MCP server/registry, strategy injection, planning, verification, and memory; individual runtime files may remain as compatibility re-exports |
| OpenAI compatibility facades | `backend/src/agentOpenAI/` | Re-exports old import paths; the canonical OpenAI implementation lives under `agentRuntime/engines/openai/` |
| Assistant application | `backend/src/assistant/` | Session management, stream projection, result contracts |
| Skill engine | `backend/src/services/skillEngine/` | YAML Skill loading, parameter substitution, SQL execution, DataEnvelope output |
| Skills | `backend/skills/` | Atomic, composite, deep, and rendering-pipeline analysis |
| Strategies | `backend/strategies/` | Scene strategies, prompt templates, knowledge templates |
| Self-Evolution | `backend/src/services/selfEvolution/`, `backend/src/routes/selfEvolutionAdminRoutes.ts` | RunManifest, feedback projection, eval/replay, proposal gates, overlays, reconciliation, and the RBAC control plane |
| Agent external feedback | `backend/src/services/externalIssueReporting/`, `agentExternalIssueRoutes.ts`, AI Assistant plugin | Source-run signals, pinned-provider triage, strict validation, and deidentified GitHub drafts with no automatic submission |
| Code-aware analysis | `backend/src/services/codebase/`, `backend/src/services/rag/`, `backend/src/services/symbol/` | Local path registration, index-free on-demand search/read, optional source indexing, symbol resolution, private projection, and patch status verification |
| Document knowledge bases | `backend/src/services/knowledge/`, `externalKnowledgeSourceRegistry.ts` | Folder registration/preview, FTS5/BM25 generation indexing, `search_knowledge`/`read_knowledge_section`, `kb:` citations and `knowledge_use@1`, license/consent/scope, retired kinds, and private-content projection |
| Trace processor | `backend/src/services/traceProcessorService.ts` | Trace loading, RPC management, SQL query execution |
| Reports | `backend/src/services/htmlReportGenerator.ts` | HTML report generation |
| Result quality pipeline | `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts`, `finalSemanticAssessment.ts`, `evidence/`, `verifier/`, `analysisResultSnapshotPipeline.ts` | Original propositions, captures, finite proof and at most one semantic review, followed by shared projection/persistence |
| CLI | `backend/src/cli-user/` | `smp` / `smartperfetto` commands, session/history/report export |
| Comparison services | `backend/src/services/comparison*Service.ts` | Shared evidence/report contract for raw-trace and analysis-result comparison |

## Dual Trace Engine Boundary

Opening a trace in the Web UI creates two processing paths with different
responsibilities:

```text
Local timeline and Perfetto plugins
  browser -> WasmEngineProxy -> trace_processor.wasm committed under frontend/

AI, SQL, Skills, CLI, and report evidence
  browser background upload -> /api/traces/upload
    -> TraceProcessorService -> trace_processor_shell pinned by scripts/trace-processor-pin.env
```

The first path serves only in-browser timeline, track, and Perfetto plugin
queries. The second path is the authoritative execution surface for
SmartPerfetto AI evidence and automation contracts. The two engines may use
independently reviewed Perfetto pins; their current identities are declared by
the committed `frontend/` directory name and `scripts/trace-processor-pin.env`.
A table, module, input format, or SQL capability added to browser WASM must not
be claimed by Skills, Strategies, the CLI, or AI reports until the native pin
passes the five-platform prebuild, regression, and release gates.

## Web Assistant Surfaces And Identity Lifecycle

The two Web UI assistant surfaces share one authentication boundary but do not
share a trace prerequisite:

- `/assistant` hosts the Conversation-first `ConversationPage`. It supports
  ordinary multi-turn conversation without a loaded trace and becomes
  trace-aware only after the user attaches one.
- Authorized source and source actually used by the current run are separate
  states. Explicit selection exposes shared source tools to the primary run;
  the model decides whether the question and trace anchors warrant lookup.
  Registration and selection do not require indexing. Actual calls update the
  run ledger continuously. Model-visible references must pass capacity admission
  and remain bindable in the same run; a model declaration cannot establish use.
- With a loaded trace, `AIPanel`, the sidebar, and the floating window share the
  page- and trace-scoped `AnalysisBackendConnection`. A completed background
  upload creates only a connection candidate; AI analysis can use the backend
  only after the scoped lease's native processor reports ready.
- The Viewer always continues to use in-browser `trace_processor.wasm`. A page
  lease governs only AI-backend authorization, status, and lifetime; it neither
  installs a global HTTP RPC target nor converts the Viewer to a native trace
  processor. `/api/workspaces/:workspaceId/traces/leases/:leaseId/connection`
  returns coarse status only and never exposes ports, credentials, file paths,
  or cross-tenant details.

In OIDC mode, physical session, trace, lease, connection, run/receipt, and transient
connection state remain in page memory. The browser may retain a logical
conversationId locator bound to the exact tenant/user/workspace and backend URL.
Restore requires backend authorization before cached messages can become trusted
history. Persisted messages remove runtime bindings and raw private prompts;
source history additionally requires current authorization and its original exact
analysis-context fingerprint. Changing identity or workspace cannot restore
another scope's history. Logout, 401, cross-tab authority invalidation, identity/context
changes, and page disposal abort start/stream work, advance the runtime
generation, and clear page state so late results cannot write into a new
identity.

Local/API-key mode keeps its existing browser request and resume behavior: the
shared helper does not add cookie credentials unconditionally, and a non-OIDC
401 is not treated as OIDC authority loss. This integration adds no environment
variables or configuration keys; providers, runtimes, and endpoints continue
to come from the existing configuration sources.

## Turn Limits and Follow-ups

The five runtimes share acquisition budgets and closeout state. Budgets above one
reserve the last call for a tool-free conclusion from returned facts, remaining
gaps, and next steps. Cancellation, deadlines, revoked authority, and provider
errors do not trigger another summary. Delivery retains `incomplete/turn_limit`;
text delivery does not establish complete evidence. OpenCode stops after observing
the limit, records actual overshoot, and cannot add a summary after an overshoot.

Each user question starts a fresh physical model context. Within the same logical
session, owner, trace, provider, and source authorization checks precede a bounded
preview of recent conclusions, gaps, and evidence locators. `read_session_history`
pages older records without creating current-run verification witnesses. A single
database transaction persists the logical descriptor and full turn records, once
per run (a second terminal write is refused), so page reopening and backend
restart share one recovery path. The CLI reuses the
same typed history contract. See [Agent Runtime Architecture](agent-runtime.en.md).

## Main Analysis Data Flow

Jank investigation starts with continuous execution on the target process's main thread. `main_thread_frame_work` and the top-level work tables in `scrolling_analysis` share SQL fragments for observed doFrame phases, tasks and thread states, retaining source locators. FrameTimeline adds outcome evidence. Nested hotspots, ambiguous track attribution, unannotated execution and missing scheduling data remain distinct; missing data never means idle. Top-level work tables feed display, synthesis and artifacts so selecting a nested Skill's first payload cannot discard the task evidence.

Strategy frontmatter `investigation_requirements` is separate from report formatting. The shared typed-intent prompt builder reads these evidence obligations from the run's pinned strategy snapshot for investigation answers and reports. Bounded questions apply only relevant obligations; facts and acknowledgements gain no investigation recipe, and `existing_only` gains no retrieval authority. Older snapshots may omit the optional field; declared requirements participate in the fingerprint.

All runtimes use this pinned-context builder. Missing intent or registry fails explicitly, with no legacy quick/full template fallback. The final conclusion is the primary deliverable; budgets and intermediate table previews do not cap its findings, claims or prose. The input discipline budget is 16,000 estimated tokens, with identity and evidence obligations protected from trimming. Actual output or review capacity limits must remain explicit incomplete states.

In OIDC mode, the static entry point gates startup through `/api/auth/session`
and does not load the Perfetto bundle until the session is ready. After the
callback establishes the backend session, every browser request derives tenant,
user, and workspace authority from the session and database ownership. Frontend
context headers carry routing context but cannot change authorization. Personal
workspaces are unique per `(tenant, user)`, and tenant administrators receive
metadata-only visibility.

```text
1. User loads a trace
   UI -> WasmEngineProxy -> frontend/trace_processor.wasm (local timeline and plugins)
      -> background /api/traces/upload -> TraceProcessorService
         -> pinned trace_processor_shell (AI / SQL / Skills)

2. User starts analysis
   UI -> POST /api/agent/v1/analyze
      -> AgentAnalyzeSessionService.prepareSession()
      -> selected runtime analyze()
      -> native typed intent -> scope / evidence access / budget / deliverable
      -> eligible automatic prefetch or on-demand context
         -> shared TraceCompleteness probe when requested
         -> shadow capability_manifest@1 probe-time snapshot

3. Agent gathers evidence
   Runtime -> MCP tools
      -> execute_sql -> trace_processor_shell
      -> invoke_skill -> SkillExecutor -> SQL / DataEnvelope
      -> lookup_knowledge / lookup_sql_schema / fetch_artifact
      -> search_knowledge / read_knowledge_section (only when this turn selected a document knowledge base)
         -> per-turn selection + live registry consent/scope check -> pinned index generation
         -> FTS5/BM25 -> kref- references, kb: citations, separate token pool
      (knowledge is background, not current-trace evidence; the Android Internals Wiki joins as a document knowledge base)
      -> selected codebase + live authorization + on-demand source access
         -> per-codebase capabilities (search / read_body / index / graph) + run depth and budget -> source_authorization
         -> search_codebase / read_codebase_file / find_codebase_files (live root, no index required)
         -> query_code_graph / inspect_code_symbol (only when a selected codebase has a GitNexus index)
      -> resolve_symbol / lookup_app_source / lookup_kernel_source (only with an active index)
      -> lookup_aosp_source
         -> LookupResponseFilter -> CodeRef metadata
      -> propose_patch -> PatchProposer -> verified / sketch / unverified

4. Single product finalization
   exact runtime result + private context -> finalizeAnalysisResult
      -> canonical body + original claims + retained execution capture
      -> finite proof + at most one no-tool semantic review
      -> completion / report / claim / identity assessments
      -> SourceUseDecision + source-claim-binding verification
      -> QueryReviewV1 (review metadata, not standalone evidence)

5. Backend streams output
   SDK events -> runtime bridge -> privacy/narrative projection -> SSE
      -> frontend renders progress, tables, thoughts
   draftAnswerStreaming runtime (Claude/OpenAI) -> answer_token draft + answer_segment_reset
      -> owner projection + narrative projection + coalescing -> live only (never replayed or persisted), replaced by conclusion
   finalizeAnalysisResult dispatches the semantic review -> provisional conclusion (final body, verdict pending)
   no review required -> plain conclusion after finalization, before report/snapshot generation (no pending cue)
   stop after the provisional conclusion -> review-only (answered at once), run still commits `~`;
      second stop -> wait up to the review-stop watchdog, then abort; no commit in time ->
      read body stored as an unverified partial turn (not for private knowledge / revoked authority)

6. Finish and report
   finalized result -> analysis_completed -> canonical safe source/CodeRef/patch metadata
      -> AnalysisReceiptV2 (including runManifestId)
      -> HTML report + CLI artifacts + analysis-result snapshot
      -> /api/reports/:id
```

`capability_manifest@1` sits between shared completeness probing and Agent
evidence collection. It binds the trace bytes, the identity of the trace
processor that is actually running, and the capability states. The current
system prompt and visible chat intentionally ignore this shadow snapshot.
Before activation, Claude/OpenAI caches keyed only by `traceId` must be re-keyed
or invalidated by trace + running-processor identity so they cannot reuse
capabilities from an older processor. Source provenance is now routed through
one safe projector across initial/replayed SSE, HTML reports, CLI
JSON/Markdown/HTML, analysis-result snapshots, and report/snapshot APIs. Web
chat keeps only a current-run receipt without `CodeRef`.

CLI `smp run` / `smp ask` / `smp compare` reuse the same session, runtime,
Skill, report, and trace-processor path. The difference is local storage under
`~/.smartperfetto/` and terminal output as `text`, `json`, or `ndjson`.

External Wiki context and trace evidence remain separate data flows. Prose can
enter the active provider tool result only under an explicit request capability;
runtime bridges project it to chunk references, hashes, licenses, and attribution
before SSE, logs, reports, or snapshots. The claim verifier must not treat Wiki
background as a measurement from the current trace.

See [Private Analysis Context Architecture](private-analysis-context.en.md) for
source/external-knowledge selection, authorization fingerprints, non-resume
semantics, and deletion lifecycle. The boundary applies to regular analysis,
Smart Profile deep dives, Web UI, CLI, and every runtime currently registered
in `PRODUCTION_RUNTIME_KINDS`.

## Self-Evolution Control Loop

Self-Evolution is decoupled from online analysis. An analysis first seals an
immutable RunManifest. Feedback enters an append-only fact log and rebuildable
projection, and only effective public feedback is available to explicitly
started curation. A proposal must complete baseline/candidate validation and
holdout paired replay in the same pinned environment and receive human
acceptance before it can be explicitly applied.

Apply publishes a content-addressed overlay artifact and a new generation.
Existing runs retain their old snapshots; only new runs resolve the new
generation. Startup and upgrade reconcile before publication, quarantining
conflicts, drift, or validation failures. Explicit revert publishes another
generation without the overlay. This path is off by default, and apply also
requires external persistent storage. See the
[runtime contract](self-improving-design.md) and
[user acceptance guide](../getting-started/self-evolution.en.md).

## Agent-Assisted External Feedback Loop

M10 builds a deterministic opportunity from the persisted
`analysis_completed` event, matching RunManifest, and optional result snapshot.
A source-provider/runtime-pinned, no-tool triage runs only after user action.
Reference allowlists, confidence, Skill trust, byte limits, and public-artifact
sanitization validate Agent output before user answers can produce a
`notSubmitted` GitHub draft.

This path never reads the current `session.result`, calls the GitHub API, or
creates a Self-Evolution feedback event, proposal, or overlay. Private and
code-aware results cannot create public drafts, and security reports use a
private advisory. See
[Agent-Assisted GitHub Feedback](../getting-started/agent-assisted-feedback.en.md).

## Four-Layer Codebase Import Boundary

Codebase import has four boundaries that must not collapse: `PathSecurityGate` owns root/file identity and bounded safe reads; `SourceSelectionPolicy` provides one canonical IR for path scope, extensions, and exclusions; `SourceEnumerator` produces untrusted candidates through `ripgrep > git > node-walk` and reports coverage; `sourceDisclosure` intersects the live selection policy with the frozen consent grant at every source-text exit. On-demand reads and indexed lookups share that disclosure predicate, while active/pending index generations remain orthogonal to live-root availability. Registration only makes source selectable and never attaches it to a session.

Source use adds another orthogonal boundary. `SourceUseDecisionV1` records selected/queried/used IDs, status, and coverage. `SourceClaimBindingV1` binds only implementation mechanism to same-claim trace evidence. Trace/Skill/SQL proves occurrence and `CodeRef` proves mechanism; the latter cannot increase occurrence or root-cause confidence alone. Every registry-discovered scene inherits the default policy, with richer anchors for startup, scrolling, ANR, interaction, and scroll response.

## Runtime And Provider Boundaries

| Runtime | Providers | Key boundary |
|---|---|---|
| `claude-agent-sdk` | Anthropic, Bedrock, Vertex, Claude/Anthropic-compatible providers | All run modes require explicit provider/env credentials; Claude Code login does not establish SDK readiness |
| `openai-agents-sdk` | OpenAI, Ollama, OpenAI-compatible providers | Credentials and Responses/chat-completions protocol are validated by OpenAI runtime rules |
| `pi-agent-core` | Custom providers | Requires explicit Pi model JSON or equivalent env; does not read `.pi` project config, package extensions, shell tools, or file tools |
| `opencode` | Custom providers | Requires explicit OpenCode/OpenAI-compatible model config; uses an isolated OpenCode server and request-scoped MCP tools, not personal OpenCode login/project state |
| `qoder-agent-sdk` | Custom providers or explicit env | The Qoder SDK is an opt-in optional peer; it uses local Qoder CLI login or a PAT and isolates private-knowledge streams, sessions, and snapshots |

Provider Manager active profiles override `.env` fallback. Resume must preserve
the original provider/runtime/comparison identity and must not silently switch
because the active provider changed later.

## AI Output Contract

The final answer is not a single Markdown string. It is a set of related
artifacts with different consumers:

| Artifact | Consumer | Boundary |
|---|---|---|
| Visible chat conclusion | Frontend AI panel | Projects the canonical body and actual machine sidecars; separates runtime appendix without mechanically editing prose |
| HTML report | Browser, export, sharing | Keeps evidence, claim verification, identity resolution, and appendix detail |
| CLI artifacts | `smp run`, `smp ask`, `smp capture --analyze`, `smp report` | Persists turns, reports, claim verification, and identity files |
| Analysis-result snapshot | Multi-result comparison and later review | Stores conclusion contract, claim support, verification, and identity metadata |
| Query Review | AI panel, HTML report, artifact | Explains actual reads, filters, outputs, and limitations; it remains review metadata and cannot independently support a diagnosis |
| Analysis Receipt | AI panel, HTML report, CLI, snapshot | Binds run/session/trace/runtime and summarizes evidence counts, claim audit, quality gates, and actual outputs |
| Source Use Decision / Binding | AI panel receipt, HTML report, CLI, snapshot, API | Records selected/queried/used IDs, status/coverage, and trace-to-mechanism bindings; the Web projection retains no `CodeRef` |
| Terminal / delivery metadata | SSE, report, CLI, snapshot | Separately records native completion, intent, output origin, report assessment and delivery assurance; missing historical fields are not passes |

See the [Data Contract](../../backend/docs/DATA_CONTRACT_DESIGN.en.md) for the
field and projection rules. A surface may compact the display, but it must not
promote Query Review to evidence or project receipt `partial`/`not_applicable`
states as passed.

When fixing conclusion quality, identify the failing layer first: runtime
output, contract/gate, evidence/verification, report generation, snapshot, or
frontend projection. Do not make chat cleaner by deleting provenance required by
reports or snapshots.

Typed-intent budget, scope, deliverable and evidence access are independent;
valid declarations are not truth or authorization. `existing_only` prohibits
new acquisition, and `read_new` still respects request permissions. Planning and
source access are on demand. The finalizer preserves original propositions and
performs at most one no-tool semantic review under the original deadline, pinned
provider and owner/authorization checks, and sends it only when `✓` is still
reachable or an obligation needs it: a report, a selection, source access or
source declarations, an investigation requirement the evidence ledger does not
rule out, a claim that could still reach `✓` under a perfect review, or a
zero-claim pure acknowledgement. Every other answer records the not-checked
reason `not_required` and ends `~` (an accepted residual: a contradiction only
the review would find goes undetected; a finite-proof `unsupported` still
yields `!`). The finite proof catalog is defined in
source; general causality and unknown fields cannot be presented as proved.

Conversation may retain original captures within a logical session's exact
trace/authorization/owner scope while physical run/session IDs remain unique.
The model receives only a bounded artifact-locator catalog. Old cancellation,
callbacks and cleanup cannot affect a later turn. Historical reads only project
stored results; they neither rerun review nor restore original witnesses from a
snapshot. See [Agent Runtime Architecture](agent-runtime.en.md) for lifecycle details.

## Comparison Modes

| Mode | Entry | Data source | Contract |
|---|---|---|---|
| Raw Trace Compare | frontend baseline/comparison traces, CLI `smp compare` | live queries over any two raw traces in the same workspace | shared comparison identity, evidence pack, session snapshot, and report section; API compatibility roles remain current/reference |
| Analysis Result Compare | frontend multi-result comparison API | persisted completed-analysis snapshots | keeps workspace/RBAC/matrix behavior and reuses the shared report section |

For the Web UI dual trace workspace state machine, see
[Dual Trace Workspace Operation Model](dual-trace-workspace.en.md).

## Content Boundaries

| Content | Location | Runtime role |
|---|---|---|
| Strategy / prompt template | `backend/strategies/*.strategy.md`, `*.template.md` | Enters the system prompt and constrains agent behavior |
| YAML Skill | `backend/skills/**/*.skill.yaml` | Invoked through MCP `invoke_skill` for deterministic SQL analysis |
| Rendering pipeline catalog | `backend/skills/pipelines/index.yaml` | Pins the upstream commit and document hashes, and classifies detector entries as primary variants or supporting features |
| Rendering pipeline docs | `docs/rendering_pipelines/*.md` | Authoritative Android 17 teaching material synchronized from `Gracker/rendering_pipelines`; copied to `backend/dist/rendering_pipelines/` during builds |
| Normal docs | Other files under `docs/` | User and contributor documentation |

Do not hardcode prompt content in TypeScript. TypeScript should load, substitute, and structurally orchestrate prompts and Skills.
Do not hardcode MCP tool counts, Skill counts, or scene counts in code or
durable docs; those come from the tool registry, `backend/skills/` tree, and
strategy frontmatter.

Rendering-pipeline results preserve two identities: the synchronized teaching
documents define `rendering type`, while catalog entries are trace-detection
subpaths or features. Only entries marked `classification_role: variant` and
`primary_eligible: true` in the catalog may become the primary classification.
Run `npm run check:rendering-pipelines` to verify the upstream pin, hashes, and
all active references.

## Scene Reconstruction

Scene Reconstruction uses the current Provider and shared Agent investigation loop to revise a candidate timeline from this run's input, device-state and application-response evidence. The shared finalizer produces one revision for UI, reports and historical access. Scan coverage, capture completeness and narrative verification remain separate; unknown does not mean idle. See the [Scene Reconstruction Architecture Contract](scene-reconstruction.en.md).

## System investigation contract

`investigation-profiles.yaml` and scene Strategies declare investigation obligations, resolved and pinned to the turn through the registry fingerprint. Shared Skills or trusted equivalent SQL produce scoped original evidence; acquisition records and the final explanation are assessed separately. `investigationAssessment` travels through SSE, reports, snapshots and comparison summaries. `deliveryAssurance.investigation` and `investigationEvidence` remain independent of completion, report and claims.

Persisted declarations cannot create acquisition authority. Private projection or changes to the body, claims, identity, intent or evidence invalidate positive investigation assessments and clear stale references. Historical restoration does not acquire new evidence; legacy results remain unknown.

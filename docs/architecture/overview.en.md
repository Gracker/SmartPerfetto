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
| Runtime engines | `backend/src/agentRuntime/engines/{claude,openai,pi,opencode,qoder}/` | Canonical implementations of the five currently registered runtimes behind shared orchestrator, result, and safety contracts |
| Shared agent capabilities | `backend/src/agentv3/` | MCP server/registry, strategy injection, planning, verification, and memory; individual runtime files may remain as compatibility re-exports |
| OpenAI compatibility facades | `backend/src/agentOpenAI/` | Re-exports old import paths; the canonical OpenAI implementation lives under `agentRuntime/engines/openai/` |
| Assistant application | `backend/src/assistant/` | Session management, stream projection, result contracts |
| Skill engine | `backend/src/services/skillEngine/` | YAML Skill loading, parameter substitution, SQL execution, DataEnvelope output |
| Skills | `backend/skills/` | Atomic, composite, deep, and rendering-pipeline analysis |
| Strategies | `backend/strategies/` | Scene strategies, prompt templates, knowledge templates |
| Self-Evolution | `backend/src/services/selfEvolution/`, `backend/src/routes/selfEvolutionAdminRoutes.ts` | RunManifest, feedback projection, eval/replay, proposal gates, overlays, reconciliation, and the RBAC control plane |
| Agent external feedback | `backend/src/services/externalIssueReporting/`, `agentExternalIssueRoutes.ts`, AI Assistant plugin | Source-run signals, pinned-provider triage, strict validation, and deidentified GitHub drafts with no automatic submission |
| Code-aware analysis | `backend/src/services/codebase/`, `backend/src/services/rag/`, `backend/src/services/symbol/` | Local codebase registry, source ingestion, symbol resolution, lookup filtering, and patch status verification |
| External Android knowledge | `backend/src/services/androidInternalsWiki/`, `externalKnowledgeSourceRegistry.ts`, `ragStore.ts` | Full-corpus Wiki audit, version/fingerprint identity, generation indexing, license/consent/scope, and private-content projection |
| Trace processor | `backend/src/services/traceProcessorService.ts` | Trace loading, RPC management, SQL query execution |
| Reports | `backend/src/services/htmlReportGenerator.ts` | HTML report generation |
| Result quality pipeline | `backend/src/services/agentResultNormalizer.ts`, `finalReportContractGate.ts`, `evidence/`, `verifier/`, `analysisResultSnapshotPipeline.ts` | final report contract, evidence/claim verification, identity resolution, snapshots |
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

## Main Analysis Data Flow

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

3. Agent gathers evidence
   Runtime -> MCP tools
      -> execute_sql -> trace_processor_shell
      -> invoke_skill -> SkillExecutor -> SQL / DataEnvelope
      -> lookup_knowledge / lookup_sql_schema / fetch_artifact
      -> lookup_blog_knowledge(source=android_internals_pack)
         -> session-pinned signed Pack -> FTS5/BM25 -> redacted, budgeted background citations
      -> lookup_blog_knowledge(source=android_internals_wiki)
         -> request source allowlist + live registry consent/scope check
         -> active RAG generation -> bounded attributed background context
      (neither Android Internals source is current-trace evidence)
      -> resolve_symbol / lookup_app_source / lookup_aosp_source / lookup_kernel_source
         -> LookupResponseFilter -> CodeRef metadata
      -> propose_patch -> PatchProposer -> verified / sketch / unverified

4. Result normalization and quality artifacts
   raw runtime result -> agentResultNormalizer
      -> final_report_contract gate
      -> evidence contract / claim verification / identity resolutions
      -> QueryReviewV1 (review metadata, not standalone evidence)

5. Backend streams output
   SDK events -> runtime bridge -> StreamProjector -> SSE
      -> frontend renders progress, tables, thoughts, answer tokens

6. Finish and report
   conclusion -> analysis_completed -> sanitized CodeRef/patch metadata
      -> AnalysisReceiptV1
      -> HTML report + CLI artifacts + analysis-result snapshot
      -> /api/reports/:id
```

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

## Runtime And Provider Boundaries

| Runtime | Providers | Key boundary |
|---|---|---|
| `claude-agent-sdk` | Anthropic, Bedrock, Vertex, Claude/Anthropic-compatible providers, local Claude Code fallback | Local Claude login only applies to source runs; Docker, portable, and npm CLI need explicit provider/env configuration |
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
| Visible chat conclusion | Frontend AI panel | Readable, with low-value SQL/appendix/audit noise hidden |
| HTML report | Browser, export, sharing | Keeps evidence, claim verification, identity resolution, and appendix detail |
| CLI artifacts | `smp run`, `smp ask`, `smp capture --analyze`, `smp report` | Persists turns, reports, claim verification, and identity files |
| Analysis-result snapshot | Multi-result comparison and later review | Stores conclusion contract, claim support, verification, and identity metadata |
| Query Review | AI panel, HTML report, artifact | Explains actual reads, filters, outputs, and limitations; it remains review metadata and cannot independently support a diagnosis |
| Analysis Receipt | AI panel, HTML report, CLI, snapshot | Binds run/session/trace/runtime and summarizes evidence counts, claim audit, quality gates, and actual outputs |

See the [Data Contract](../../backend/docs/DATA_CONTRACT_DESIGN.en.md) for the
field and projection rules. A surface may compact the display, but it must not
promote Query Review to evidence or project receipt `partial`/`not_applicable`
states as passed.

When fixing conclusion quality, identify the failing layer first: runtime
output, contract/gate, evidence/verification, report generation, snapshot, or
frontend projection. Do not make chat cleaner by deleting provenance required by
reports or snapshots.

## Comparison Modes

| Mode | Entry | Data source | Contract |
|---|---|---|---|
| Raw Trace Compare | frontend reference trace, CLI `smp compare` | live current trace + reference trace queries | shared comparison identity, evidence pack, session snapshot, and report section |
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

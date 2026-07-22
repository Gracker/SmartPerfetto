# Architecture Overview

[English](overview.en.md) | [中文](overview.md)

SmartPerfetto adds an AI analysis layer on top of Perfetto UI. Perfetto remains responsible for trace loading, timeline exploration, and SQL fundamentals; the SmartPerfetto backend handles agent orchestration, Skill execution, report generation, and streaming output.

```text
Frontend: Perfetto UI @ :10000
  └─ com.smartperfetto.AIAssistant plugin
       ├─ trace upload / open trace
       ├─ AI panel / floating window
       ├─ Codebase Config Panel
       ├─ DataEnvelope tables and charts
       └─ SSE client

Backend: Express @ :3000
  ├─ /api/agent/v1/*          main agent analysis path
  ├─ /api/traces/*            trace upload and lifecycle
  ├─ /api/rag/*               RAG and codebase management
  ├─ /api/skills/*            Skill query and execution
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
| Runtime selector | `backend/src/agentRuntime/` | Chooses Claude Agent SDK, OpenAI Agents SDK, Pi Agent Core, OpenCode, or Qoder for each session |
| Claude runtime | `backend/src/agentv3/` | Claude Agent SDK orchestration, MCP server, strategy injection, verifier, memory |
| OpenAI runtime | `backend/src/agentOpenAI/` | OpenAI Agents SDK orchestration behind the same assistant contract |
| Third-party runtime adapters | `backend/src/agentRuntime/engines/pi/`, `backend/src/agentRuntime/engines/opencode/`, `backend/src/agentRuntime/engines/qoder/` | Custom third-party runtimes using the shared analysis contract, request-scoped tools, and runtime-specific safety boundaries |
| Assistant application | `backend/src/assistant/` | Session management, stream projection, result contracts |
| Skill engine | `backend/src/services/skillEngine/` | YAML Skill loading, parameter substitution, SQL execution, DataEnvelope output |
| Skills | `backend/skills/` | Atomic, composite, deep, and rendering-pipeline analysis |
| Strategies | `backend/strategies/` | Scene strategies, prompt templates, knowledge templates |
| Code-aware analysis | `backend/src/services/codebase/`, `backend/src/services/rag/`, `backend/src/services/symbol/` | Local codebase registry, source ingestion, symbol resolution, lookup filtering, and patch status verification |
| External Android knowledge | `backend/src/services/androidInternalsWiki/`, `externalKnowledgeSourceRegistry.ts`, `ragStore.ts` | Full-corpus Wiki audit, version/fingerprint identity, generation indexing, license/consent/scope, and private-content projection |
| Trace processor | `backend/src/services/traceProcessorService.ts` | Trace loading, RPC management, SQL query execution |
| Reports | `backend/src/services/htmlReportGenerator.ts` | HTML report generation |
| Result quality pipeline | `backend/src/services/agentResultNormalizer.ts`, `finalReportContractGate.ts`, `evidence/`, `verifier/`, `analysisResultSnapshotPipeline.ts` | final report contract, evidence/claim verification, identity resolution, snapshots |
| CLI | `backend/src/cli-user/` | `smp` / `smartperfetto` commands, session/history/report export |
| Comparison services | `backend/src/services/comparison*Service.ts` | Shared evidence/report contract for raw-trace and analysis-result comparison |

## Main Analysis Data Flow

```text
1. User loads a trace
   UI -> /api/traces/upload -> TraceProcessorService -> trace_processor_shell

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
Smart Profile deep dives, Web UI, CLI, and all four runtime adapters.

## Runtime And Provider Boundaries

| Runtime | Providers | Key boundary |
|---|---|---|
| `claude-agent-sdk` | Anthropic, Bedrock, Vertex, Claude/Anthropic-compatible providers, local Claude Code fallback | Local Claude login only applies to source runs; Docker, portable, and npm CLI need explicit provider/env configuration |
| `openai-agents-sdk` | OpenAI, Ollama, OpenAI-compatible providers | Credentials and Responses/chat-completions protocol are validated by OpenAI runtime rules |
| `pi-agent-core` | Custom providers | Requires explicit Pi model JSON or equivalent env; does not read `.pi` project config, package extensions, shell tools, or file tools |
| `opencode` | Custom providers | Requires explicit OpenCode/OpenAI-compatible model config; uses an isolated OpenCode server and request-scoped MCP tools, not personal OpenCode login/project state |

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

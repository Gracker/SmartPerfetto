# Agent Runtime Architecture

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

<!-- i18n-headings: paired -->

SmartPerfetto separates model SDK mechanics from Perfetto analysis capability.
The HTTP and CLI session layers depend on the shared `IOrchestrator` contract;
the concrete runtime is selected from the request provider, Provider Manager,
or environment.

| Runtime | SDK | Provider family | Notes |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic, Bedrock, Vertex, DeepSeek, Anthropic-compatible gateways | Default when env carries Claude credentials; requires explicit provider/env credentials and supports MCP server and configurable sub-agents under shared completion and verification contracts |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI, Ollama, OpenAI-compatible gateways | Native OpenAI runtime; adapts the same SmartPerfetto tools as function tools |
| `pi-agent-core` | Pi Agent Core | custom, GLM, DeepSeek, Kimi, Kimi Code, MiniMax | Optional public runtime; real model configurations reuse the shared SmartPerfetto prompt/tool/report pipeline, while fake-stream remains smoke-only; does not enable `.pi` discovery, package extensions, shell tools, or file tools |

The OpenCode and Qoder engines and their SDK dependencies are removed. The
`opencode` and `qoder-agent-sdk` labels remain readable wherever a record names
them (`RECORDED_PRODUCTION_RUNTIME_KINDS`) and execute on the effective runtime.

## Entry Points

HTTP analysis:

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> PiAgentCoreRuntime.analyze() | ClaudeRuntime.analyze() | OpenAIRuntime.analyze()
```

Resume and scene reconstruction use the same runtime factory:

```text
POST /api/agent/v1/resume
POST /api/agent/v1/scene-reconstruct
  -> createAgentOrchestrator()
```

The npm CLI is a standalone terminal product exposed as `smp` /
`smartperfetto`. It does not start the Web UI, but it reuses the same runtime,
MCP tools, Skills, reports, and session snapshots.

## Runtime Selection

Pi Agent Core (`pi-agent-core`) is the only selectable runtime (`SELECTABLE_RUNTIME_KINDS` in
`runtimeKinds.ts`). `runtimeSelection.ts` still reports the source by precedence: request/session
`providerId`, the Provider Manager active provider, a recorded runtime pin (session snapshot, CLI
session), `SMARTPERFETTO_AGENT_RUNTIME`, then the default; every source resolves to one effective
runtime (`effectiveAgentRuntimeKind` in `legacyRuntimeFallback.ts`).

- `SMARTPERFETTO_AGENT_RUNTIME` is deprecated: every value it once accepted (`claude-agent-sdk`,
  `openai-agents-sdk`, `pi-agent-core`, `opencode`, `qoder-agent-sdk`, the experimental kinds) maps
  to the effective runtime with one deprecation warning; unknown values such as a provider name like
  `deepseek` still fail closed. The `SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME` switches are retired and
  ignored.
- Runtime labels recorded in data (`RECORDED_RUNTIME_KINDS`, retired kinds included) are provenance:
  conversation descriptors, snapshots, run manifests, receipts, the external-issue pin, and
  Self-Evolution pins still parse; execution re-resolves them to the effective runtime. A
  Self-Evolution baseline pinned to a retired runtime reports `evaluation_baseline_runtime_retired`
  and needs a new baseline.
- Maintainer note: for this release the Claude Agent SDK and OpenAI Agents SDK engines stay reachable
  through an undocumented opt-in read only from the process environment,
  `SMARTPERFETTO_LEGACY_AGENT_RUNTIME=claude-agent-sdk|openai-agents-sdk`. It restores only the
  engine a provider record actually ran on; a record that ran on another engine stays on Pi, whose
  route keeps that record's own endpoint and credential, so a key never moves to another service.
  Provider env and `custom.envOverrides` can never carry it; recorded pins resolve through
  the same function; `smp doctor` and runtime health report it as active. It is removed with both
  engines in the next release.

Each analysis session pins its credential source: a specific Provider Manager profile, or the
explicit env/default fallback. Resuming a session does not re-read a later active provider; a
snapshot whose provider was deleted fails fast instead of falling back to another provider.

### Provider to Pi model mapping

`piProviderCatalog.ts` is the single mapping. It first decides which runtime a profile ran on before
the move (`previousProviderAgentRuntime` in `providerRuntimeMatrix.ts`: `apiSurface`, a retired
`agentRuntime` not yet saved back, a profile already on Pi, otherwise the type's former default), then
derives the Pi route from the env that runtime received (`resolvePiRouteFromLegacyEnv`). The API,
request origin (scheme, host, port, base path), model ID, and credential form therefore match the old
runtime:

| Previous runtime | Pi API | Origin | Credential |
|---|---|---|---|
| Claude (Anthropic or a compatible gateway) | `anthropic-messages` | `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com` | `ANTHROPIC_API_KEY` → `x-api-key`; `ANTHROPIC_AUTH_TOKEN` (a dual-surface provider's shared key) → an `Authorization: Bearer` request header, never written into the model JSON |
| Claude on Bedrock | `bedrock-converse-stream` | `ANTHROPIC_BEDROCK_BASE_URL`, default `bedrock-runtime.<region>.amazonaws.com` | bearer token, explicit keys, or the provider record's AWS profile (strict `fromIni({profile})` per request; the fingerprint binds profile+region) |
| Claude on Vertex | `anthropic-vertex` (anthropic-messages with an injected `AnthropicVertex` client) | `<region>-aiplatform.googleapis.com/v1` (`aiplatform.googleapis.com/v1` for `global`) | only the file named by `GOOGLE_APPLICATION_CREDENTIALS` |
| OpenAI Agents SDK | `openai-responses` or `openai-completions` (per `OPENAI_AGENTS_PROTOCOL`) | `OPENAI_BASE_URL`, default `https://api.openai.com/v1` | Bearer; a placeholder key for a local endpoint without one |
| OpenCode | `openai-completions` | its OpenAI-compatible fields or the model JSON's `baseURL` | Bearer |
| Qoder, or an OpenCode JSON without an endpoint | none (`SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE` names the reason) | — | — |
| Already on Pi (catalog type or explicit JSON) | unchanged (the frozen `PI_CATALOG_ROUTES` catalog reference or the user's JSON) | unchanged | unchanged |

When the provider runtime is created (`resolvePiRouteModel` in `piAgentCoreProvider.ts`), the installed
pi-ai catalog supplies the model if it serves this ID with this API on this host (only the route's base
URL replaces its own); otherwise the model is synthesized on the previous API with reasoning off, zero
cost, and limits from a same-host catalog entry, the template, or conservative defaults (context
128000; output 32000 for Anthropic/Bedrock/Vertex, 16384 for OpenAI), and an Anthropic-compatible
gateway receives no `eager_input_streaming`. The synthesized model is derived at env time and never
persisted; an explicit `piAgentCoreModelJson` remains the user's override.

Provider profiles migrate on read through `withMigratedAgentRuntime` in `retiredRuntime.ts` (next to
`withoutRetiredTuning`): a retired `agentRuntime` becomes `pi-agent-core`, dual-surface and custom types
record `apiSurface`, and fields only OpenCode or Qoder read are dropped. It is idempotent, and the next
normal save writes it back. A retired value written through the API or `POST /:id/runtime` logs a
warning and lands on Pi the same way. An untranslatable Qoder profile or endpoint-less OpenCode profile
keeps its label and fails explicitly.

### Continuity on recovery

A pin recorded under a retired runtime is compatible only when all of these hold
(`providerPinContinuity.ts`): the legacy hash recomputed from the current record under the recorded
runtime equals the recorded hash; the effective request origin is unchanged; the model ID is unchanged;
and `analysisContextFingerprint` is unchanged. A compatible pin is rebound to the new hash with a
continuity note (`runtimeMigration` on the conversation descriptor, a `retired_runtime_rebound` entry on
the session snapshot); anything else keeps the existing explicit outcome (409 or a continuity break).
The OpenCode and Qoder engines are removed; the frozen legacy-hash computation for pins they recorded
(`ProviderService.toEnvVars` and `providerSnapshot.ts`, no engine or SDK) stays for one release.

`modelExecutionProfile.ts` separates documented server capabilities, actual SDK expression capabilities and captured authored settings; `modelExecutionPolicy.ts` selects controls by call purpose. Matching uses the actual endpoint, exact model ID and protocol. Unknown gateways or unmodeled protocols remain unknown, and native configurations already validated by their SDK remain intact. Provider names, latency and model self-descriptions do not establish capabilities or authorize switching the pinned provider/model.

Main analysis and ordinary continuation preserve native settings. Classification and explicit output-only delivery select the minimum legal thinking setting only when both server and adapter support it. Known GLM 5.3 Flash requires enabled thinking and uses low; known DeepSeek Flash interfaces may disable it. Authored settings take precedence; a known illegal setting is a configuration error before dispatch, not a transient network failure. Unknown capability does not authorize guessed parameters.

Pi model JSON may explicitly set `thinkingLevel` (`off/minimal/low/medium/high/xhigh/max`); unsupported levels fail before dispatch. `thinkingLevelMap` preserves native mappings. Official GLM without an authored setting does not inherit disabled thinking solely from Pi Agent's off default; explicit off is rejected for known forced-thinking models. Missing temperature/tool/cost capabilities remain unknown; a separate light model does not inherit the primary model's capabilities or limits.

`model_execution_fingerprint@1` is separate from the existing provider snapshot and binds actual model/API, effective settings and known SDK/adapter facts. Unknown versions stay unknown. Internal `policyObservations` describe policy selection with `wireObservation: not_observed`; they are not actual dispatch or server execution facts. The maintainer command `test:pi-provider-runtime` verifies native wire contracts against local fake providers, not real-model accuracy or latency.

`OPENAI_ANALYSIS_REASONING_EFFORT` explicitly configures OpenAI runtime main analysis and ordinary continuation; omitting it preserves provider defaults. It does not override classification or timeout output-only closeout purpose policies. Validation uses the actual selected model, endpoint, protocol and installed SDK. Generic effort uses native SDK fields and never injects vendor `thinking` into unknown gateways. Recognized DeepSeek Chat maps `none` to disabled thinking; forced-thinking GLM rejects it. This adapter currently expresses `max` through passthrough only on recognized supported Chat interfaces; explicit `max` on unknown gateways or Responses is not yet supported by this adapter. The same isolated provider environment binds the setting into its snapshot; invalid values cannot enter public snapshots. Lower effort still needs real accuracy validation.

`server.outputTokens` records sourced output-parameter bounds and conditional
defaults only. Currently, official DeepSeek Chat with `deepseek-flash` or
`deepseek-v4-pro` documents `max_tokens` from 1 to 393216: defaults are 8192 without
thinking, 65536 with thinking, and 131072 at `max` effort. Input and generated
tokens remain subject to the total context limit. Other models, protocols and
gateways remain unknown. Documented defaults never fill an unset
`effective.maxOutputTokens` or automatically change requests, budgets or existing
provider snapshots. Explicit `OPENAI_MAX_OUTPUT_TOKENS` still follows the existing
SDK path. Actual requests, native terminal facts and usage require separate
observation; output count alone cannot establish truncation. See the
[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/).

Every runtime delivers the model's plain assistant answer (`assistant_text`):
there is no model-authored declaration sidecar, typed final submission or
final-document tool. `SMARTPERFETTO_FINAL_SUBMISSION` and
`SMARTPERFETTO_CONCLUSION_AUTHORING` are retired; a value left in the
environment logs one process-wide warning and is ignored, and never fails a
run. Historical manifests and receipts may still carry older mode labels or a
`declarationSyntax`; they are read unchanged. A declaration a model still writes
is stripped from the body at finalization and not stored.

Internal performance observations distinguish actual main, classification and
continuation dispatches, linking native termination, tool drain, candidate
selection and finalization; the final review is recorded as `not_required`.
Configuration commitments, applied request settings and explicitly reported
server model identity are separate facts. Missing facts
remain unknown. Normalized request JSON bytes and original wire-body size are
measured separately. Transport comparisons require common observer source, fixed
controls and per-sample quality gates, including complete tool-schema and prompt
costs. Incomplete or incomparable samples remain inconclusive.

## M10 Independent Feedback Triage

Agent-assisted GitHub feedback does not resume the main analysis session. New
RunManifests may persist `providerSnapshotHash` at completion. When the user
selects the feedback CTA, the backend resolves the persisted source run again
and requires the currently available provider snapshot to match that hash
exactly. It never reads a later active provider or falls back to another
runtime.

Claude/Anthropic-compatible source runs use a no-tool Claude SDK call for
triage. OpenAI/OpenAI-compatible source runs use a lightweight Chat
Completions call. Both receive only bounded public source context and do not
share the analysis SDK session. Pi Agent Core, runs recorded under the removed
Qoder runtime, legacy manifests, unavailable credentials, snapshot drift, or
invalid model output use an explicit deterministic fallback in V1 and are never presented as if the
same Agent reviewed the result. See
[Agent-Assisted GitHub Feedback](../getting-started/agent-assisted-feedback.en.md)
for the user-visible contract.

## Key Files

| File | Responsibility |
|---|---|
| `backend/src/agentRuntime/runtimeSelection.ts` | Runtime selection and the shared orchestrator factory |
| `backend/src/agentRuntime/runtimeKinds.ts` | Production runtime kinds and the current registered set |
| `backend/src/agentRuntime/runtimeDescriptors.ts` | Runtime descriptors, `EngineCapabilities`, and canonical loaders |
| `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | Claude Agent SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiRuntime.ts` | OpenAI Agents SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiToolAdapter.ts` | Shared MCP descriptors adapted to OpenAI function tools |
| `backend/src/agentRuntime/engines/pi/piAgentCoreRuntime.ts` | Pi Agent Core runtime adapter |
| `backend/src/agentRuntime/runtimeExecutionGuard.ts` | Runtime/session single-active execution, cancellation, and stale-settle isolation |
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | Shared typed intent, budget, scope and evidence-access policy for all native engines |
| `backend/src/agentRuntime/analysisFinalizationContext.ts`, `runtimeEvidenceContext.ts` | Private finalization context, original deadline, authorized capture reads and cross-turn leases |
| `backend/src/services/providerManager/modelExecutionProfile.ts`, `backend/src/agentRuntime/modelExecutionPolicy.ts` | Actual model/SDK capabilities, independent execution fingerprint and legal purpose controls |
| `backend/src/agentRuntime/runtimeTaskDeadline.ts` | Private per-turn admission identity and explicit work deadline; separate from cancellation and authorization |
| `backend/src/agentRuntime/runtimeCandidateAdmission.ts` | Maintainer-owned concurrency-candidate admission boundary |
| `backend/src/agentRuntime/runtimePerformance.ts` | Internal RunManifest phase, tool, and SQL queue/execution timing receipt |
| `backend/src/agentRuntime/runtimeActivity.ts`, `runtimePerformanceContext.ts` | Bounded invocation and capture activity, private run ownership, and late-callback isolation |
| `backend/src/agentRuntime/runtimeToolResultAudit.ts` | Internal RunManifest tool-result handoff receipt: text size each call handed to its runtime and whether audited fields sit verbatim in it |
| `backend/src/agentRuntime/runtimeToolConcurrency.ts` | Request-scoped fair read/write scheduling with an exclusive default |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto tool implementation and composition |
| `backend/src/agentv3/mcpToolRegistry.ts` | Tool descriptors, exposure levels, and allowlists |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | Canonical body (a stray model declaration is stripped) and the single product-owned asynchronous finalizer |
| `backend/src/services/finalResultQualityGate.ts`, `evidence/evidenceReadView.ts` | Delivery assurance (completion, comparison identity, source citations) and original execution-capture reads |
| `backend/src/services/providerManager/` | Provider configuration and runtime/protocol/env mapping |
| `backend/src/agentv3/sessionStateSnapshot.ts` | Shared snapshot: every runtime's provider pin, product state and its own `engineState` |
| `backend/src/services/externalIssueReporting/providerPin.ts` | M10 source-run provider snapshot validation |
| `backend/src/services/externalIssueReporting/triageRunner.ts` | M10 no-tool Agent triage and deterministic fallback |

`backend/src/agentOpenAI/` and individual files such as
`agentv3/claudeRuntime.ts` retain compatibility re-exports for old import paths.
MCP, strategy and planning remain canonical shared layers. The shared structured
delivery diagnostics (`agentRuntime/runtimeConclusionVerifier.ts`) are what
runtimes read through `agentRuntime/runtimeDraftDiagnostics.ts` only to choose a
same-run correction; the finalizer owns the terminal state.

## Tool Layer

SmartPerfetto analysis capability is registered through
`createClaudeMcpServer()` and described through `McpToolRegistry`: SQL
execution, Skill invocation, SQL schema lookup, planning/hypothesis tools,
artifacts, memory, code-aware lookup, baselines, and comparison tools.

`list_skills(metricId, offset)` discovers actual metric producers, inputs, identity selectors and scope limits from this run's pinned Skill definitions and SQL fragments. Discovery neither executes a tool nor issues evidence. Raw SQL column names or model prose cannot replace a private producer binding; an unknown metric returns no match rather than silently falling back to the whole catalog.

The registry holds SDK-neutral shared tool specs
(`agentRuntime/runtimeToolSpec.ts`, with MCP `CallToolResult` and
`ToolAnnotations` shapes). Claude runtime adapts them into its in-process MCP
server inside its own engine (`engines/claude/claudeSdkTools.ts`). OpenAI runtime
does not duplicate tool logic; it reads the same `McpToolRegistry` and adapts
tool descriptors into OpenAI Agents SDK function tools. Pi Agent Core uses
request-scoped native tools built from the same shared descriptors, the shared
system prompt, planning/hypothesis tools, and the same route-owned
finalization/report pipeline without turning SmartPerfetto
into a Pi coding-agent harness. Each engine uses its pinned provider's native no-tool
transport for the same typed intent and hands its result to the same
product-owned finalizer/report boundary. Every engine starts each turn in a
fresh native context; streaming, tool cadence and cost/timeout semantics still
differ.

The tool surface follows actual request scope, artifact-store availability,
codebase permission, `referenceTraceId`, comparison context and evidence access.
Budget mode neither grants permission nor silently removes authorized tools.
`existing_only` strictly prohibits new acquisition.

The SQL tools' `executionContext` is independent of model, budget and source
permission. Omitted or `working` uses the current workspace, including loaded
modules and temporary tables. `original_trace` explicitly requests restricted
native reads of this run's original Trace. It neither rewrites SQL nor injects
modules, and refusal never switches back to the workspace. Admission accepts
only single native-relation queries fully supported by the existing parser;
units and row identity still require the actual execution receipt.

Ordinary analysis, CLI and attached-Trace Conversation keep reading resources in
the same run lease through finalization; trace-less conversations start no
processor. Native readers are created lazily and reused per authorized Trace,
with separate current/reference identities. Context labels and Query Review
record execution rather than granting proof; missing historical labels remain
unknown. Missing source, capacity, authorization or current ownership causes an
explicit refusal; cancellation and revocation still end the original run.

## Concurrency, Observability, And Admission

Concurrency fails closed by default. A runtime/session permits only one active
analysis execution. Tools are exclusive unless a commutative read is explicitly
marked and admitted for the current request. Each trace processor instance
still has one SQL worker, so tool overlap cannot execute same-trace/processor SQL
concurrently; work on different processors/traces or admitted read-only
preparation may overlap. Processor creation and recovery are single-flight, and
a cancelled stale execution cannot overwrite newer session state.

The backend records real phase spans, first output, tool scheduler wait, and SQL
queue/execution timing in the internal `RunManifest.performance` field. This
`RuntimePerformance` receipt is not projected into public SSE. The public stream
also does not expose admission-grade model, provider snapshot, provider usage,
or performance fields. The receipt supports internal attribution and controlled
benchmarks; by itself it does not prove real-provider speed or accuracy.

Before every native Pi provider request, the first included, the
`prepareRequest` adapter records one bounded `investigationRequests` entry:
Agent-context message and tool counts with approximate characters
(`agentContext`, an estimate before provider conversion, distinct from the wire
bytes `modelRequests[].body` measures at fetch), investigation
requirement counts by `observed`, `not_observed`, `unknown_no_producer` and
`not_applicable`, and the turn and deadline budget. `modelCalls[].requestIndex`
joins each entry to its provider usage, cache reads included. The investigation
view reads only typed intent, the pinned contract, the producer ledger and the
run budget; it is created per run and released at finalization, and the adapter
returns no request update.

Contract progress is controlled by `SMARTPERFETTO_INVESTIGATION_PROGRESS` and is
off by default; when off, the Agent options, prompt and requests are exactly as
without the feature. When on, the first request's existing
`investigation_requirements` segment gives each requirement its run-start ledger
`acquisition` status (a status, not a nudge). Later decisions are made only at
turn boundaries (`prepareNextTurn`) and cached under the next request index;
`prepareRequest` only records. One progress message rides the request already
scheduled, never adding a provider request or extending the run, only when all
of these hold: an `answer_turn` request from the third on; `allowNewEvidence`
(never under `existing_only`, a correction or closeout); a readable ledger; a
`not_observed` requirement with at least one registered producer that
`invoke_skill` can reach in the request scope; an acquisition turn still left
afterwards. Each requirement is named at most
once, with at most 3 per message and 2 messages per run. The message is a
custom Agent role that `convertToLlm` renders as a `user` message
(`prompt-investigation-progress.template.md` plus bounded JSON: requirement id,
domain, description, condition as written, metrics and producer Skill ids),
never a mid-conversation `system` message. It states contract status only, no
obligation or conclusion, and never reaches narration, drafts, SSE, results,
reports, snapshots or conversation history. Its receipt records `decision:
progress` with only `progress.messages` and `requirementIds`.

The shared tool handoff also records bounded `activity`: attempts, dispatch into
the guarded pipeline, returns, refusals, exceptions, cancellations, and repeated
calls with exactly equal complete arguments. Arguments only participate in
run-local keyed hashes held in memory; receipts contain no arguments or hashes.
Incomplete observation is `partial/unavailable`, never an invented zero.
Dispatch into the guarded pipeline does not establish authorization. Adaptive
routing uses complete repeat counts only for shadow diagnostics, without stopping
investigation or extending its budget.

`captureActivity` counts issued capture registrations accepted by the evidence
store, deduplicating each witness within the observing run. Origins are current,
reused, or unknown. `rowSlots` includes unavailable tables and is not a count of
usable evidence. Eviction does not reduce cumulative registrations; the metric
does not cover every read or direct reuse path. It proves neither evidence use,
investigation coverage, nor semantic novelty. No capture observation remains
distinct from observing an empty table.

Conversation runs without a RunManifest use an independent private execution
scope and the same recorder. SDK callbacks retain their run binding even when
their transport loses the original async context. Conflicting ownership
suppresses observation throughout the callback without changing execution,
authorization, or fixed attribution. Closing the run freezes its receipt; late
callbacks cannot update a successor. Observation failure never changes the
analysis result, and activity counts determine neither delivery nor verification.

Tool results in SSE and session logs are cut to 2000 characters, so they cannot
show whether the model received a trailing hint such as `vendorOverride`. The
internal `RunManifest.toolResults` receipt answers that. It records what each
call handed to its runtime at the outermost shared tool boundary: after every
product wrapper, including pacing reminders, and before transport truncation.
Each entry holds the tool name, the call id when the adapter supplies one
(OpenAI, Pi), outcome, receipt facts (plan phase id presence only),
and the text size before adapter serialization. For each field in
`RUNTIME_TOOL_RESULT_AUDITED_FIELDS`, it also records whether the field's
serialized key and value appear verbatim in that text. No payload values are
copied. The receipt proves the handoff to the runtime adapter. Runtime-native
output caps are outside the product's view.

Performance branches are controlled by the strict maintainer-only
`SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` boundary and default to no admitted
candidates. The value may contain only a comma-separated, whitespace-free,
duplicate-free list from `task4` through `task7` (`task8` and `task9` were
retired with the OpenCode and Qoder engines and are unknown items). Whitespace, an unknown item, a
duplicate, or any malformed value invalidates the whole setting. It is not a
Provider Manager, UI, or provider env option, and benchmark artifacts never
activate it automatically:

| Candidate | Scope |
|---|---|
| `task4` | Reuse one quick-evidence/focus preflight across every runtime |
| `task5` | Use bounded fair overlap for explicitly commutative read tools across every runtime; all other tools remain exclusive |
| `task6` | Overlap independent Claude/OpenAI preflight DAG nodes |
| `task7` | Load independent Pi SDK/provider startup concurrently and enable quick parallel-batch scheduling; descriptor/tool gates still serialize exclusive work |

After `task5` is admitted, its safe-read policy is enabled by default.
`SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` is a rollback to exclusive
execution; it cannot bypass a missing `task5` admission. Cache single-flight,
execution isolation, cancellation cleanup, receipts, and deterministic repairs
are correctness/observability foundations and remain active independently of
performance-candidate admission.

Shipped defaults remain serial: genuine deterministic admission harnesses for
every adapter are `NOT CONFIGURED`, and bounded real-provider base/candidate
A/B has not run, so performance/accuracy admission is `INCONCLUSIVE`. Synthetic
scorer data validates scoring mechanics only and cannot enable a candidate.
When real-provider validation cannot run, record `NOT AVAILABLE` or
`NOT CONFIGURED` precisely. Unit, type, build, and deterministic gates are not substitutes
for real-provider evidence.

The Pi Agent Core real-model path reuses SmartPerfetto scene strategies, system
prompt assembly, SQL/Skill tools, planning/hypothesis tools, artifacts, and the
route-owned quality/finalization/report pipeline. It does not read `.pi`
project configuration, package extensions, shell tools, or file tools. `custom`
providers need explicit Pi model JSON or equivalent env. Without a model JSON,
Provider Manager gives GLM, DeepSeek, Kimi, Kimi Code and MiniMax a catalog
reference, `{catalog: {providers, id, baseUrl, defaultThinkingLevel:
'lowest_supported'}, apiKeyEnv}`: model capabilities come from the installed
pi-ai builtin catalog (no network refresh, nothing fabricated), the endpoint is
the provider's own, and the key goes only into Pi's key env. Without an authored
level, reasoning uses the lowest of off/minimal/low the model supports. New GLM
and DeepSeek templates default to Pi; saved providers and API records without a
runtime are not migrated. Snapshots pin the key env and installed pi-ai version. `SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` is
smoke/test-only and must stay labeled capability-limited.

## Source-Aware Runtime Parity

The production runtimes do not implement separate source policies. They
share the strategy-owned source-use prompt and actual `SourceUseDecisionV1`
state from the common MCP registry/handlers. Runtimes attach actual source-use
state for the product finalizer. Without a current-run accessor, model-authored
decisions/bindings cannot become executed facts. `pending` or `attempted` alone
does not force the whole run to fail; actual lookup, consent, reference and claim
failures retain their own contract outcomes.

Authorized source is accessed on demand. Fast/full does not insert a mandatory
lookup, fixed plan or extra source pass, and `existing_only` cannot use source or
RAG tools for new acquisition. Trace captures support referenced observations;
source evidence provides mechanism-analysis background, while `CodeRef` metadata
only locates code. `SourceUseDecision.status: corroborated` only audits an
authorized body lookup with references in this run. It does not prove a Trace
occurrence, mechanism or causal relationship.

New answers carry no model-authored claim or source binding. The shared
finalizer's `source_claim_verifier@2` runs a citation-only check: each source
location the answer writes is matched against the references this run issued.
Without source access, or with access but no written citation, source assurance
is `not_applicable` (public AOSP frames such as `Foo.java:N` are normal); all
matched is `passed`; any unmatched or ambiguous citation is an advisory
`coverage_incomplete`. This is a quality annotation, not a privacy control:
`sanitizeCodeAwareText` and the private projection still enforce privacy. No
check establishes a general mechanism, and a lookup-audit status cannot replace
evidence. Stored results keep their historical per-claim statuses
(`trace_linked`, `source_only` and similar) and render them unchanged.

One canonical safe projector carries the same decision and binding through
initial and replayed SSE, HTML reports, CLI JSON/Markdown/HTML,
analysis-result snapshots, and report/snapshot APIs. Web chat further reduces
it to a current-run receipt without `CodeRef`. No surface retains absolute
roots, snippets, search queries, or model-authored free-text binding reasons.

The deterministic runtime execution/finalization gate and A0–A4 semantic
gate prove the product contract, not real-provider model quality. Claude,
OpenAI, and Pi require separate repeated acceptance when
credentials are available. Unavailable authentication is reported as
`REAL PROVIDER NOT AVAILABLE` and cannot be replaced by unit tests or fixtures.

## Analysis Modes

| Mode | Behavior |
|---|---|
| `fast` | Fixed quick budget with the request's authorized tools and shared finalization |
| `full` | Fixed full budget without automatically requiring a report, plan or extra source lookup |
| `auto` | Shared typed-intent complexity recommendation; an explicit fallback when unavailable, without keyword guessing |

Typed intent separates task kind, scene, scope, complexity recommendation,
deliverable and evidence access. A scene must belong to the run's pinned registry.
Schema validation does not establish semantic correctness or widen permission.
`existing_only` reads retained evidence; `read_new` remains authorization-bound.
`RuntimeTurnPolicy.preflight` is three-valued and independent of budget: `none`
(`existing_only`) gathers nothing, `full` (resolved `scene_wide` read) adds
memory-type prefetch, and `trace_facts` — a bounded question, or an unavailable
classification — still detects focus app, architecture and trace
completeness. A Conversation without a mounted trace probes nothing and binds no
trace identity or evidence trace (`resolveRunTurnPolicy`,
`runtimeTraceAttachment.ts`, shared by every runtime). Vendor is not a preflight phase: `invoke_skill` resolves it only
for a Skill with vendor overrides, after that Skill's own queries, through the
shared cached `traceVendorResolver` (trace metadata only) with a bounded wait,
and attaches a `vendorOverride` hint; the rule is the same in every runtime. Focus detection scores candidate processes once over the
analysis window (foreground time, frames, launches, battery `top`, CPU),
excludes processes with no activity and reports `high`/`medium`/`ambiguous`
confidence. Every runtime resolves the effective package through
`focusAppTarget`: a user-named package is `user`, a high/medium inference is
`auto_detected`, and an ambiguous ranking sets no package, only candidates. Only
`user` packages and selections bind the analysis target; an inferred package is a
default Skill scope (reported as `appliedDefaultProcess`), never the expected
identity of the comparison gate, and the answer may switch to a candidate with
evidence when it says why. The completeness prober loads the defining stdlib
module before checking a stdlib view (capabilities declare `requiredModules`
statically, guarded by a test); a capability whose module or query failed carries
a `reasonCode` meaning unprobed, not missing. Planning is on
demand; completed phases require real successful evidence or an explicit valid
disposition. Unfinished exploration plans and hypotheses retain their state;
they neither trigger automatic continuation nor determine answer completeness alone.

**Scene entry evidence (product-owned).** Strategy frontmatter may declare
`entry_skill` (a Skill id plus closed parameter bindings: `focus_app`,
`user_target`, `trace_start`, `trace_end`, `selection_start`, `selection_end`).
For a resolved `scene_wide` `read_new` investigation of a mounted trace (no
comparison turn and no reference trace), every
runtime's preflight runs that Skill (`agentRuntime/sceneEntryEvidence.ts`)
before it builds the acquisition-capable MCP server. A package binding takes only
a user-named package or a high/medium focus app, and the Skill's own identity
gate (`prepareInvocation`) must report `verified`; an `ambiguous` gate puts only
its candidates into the prompt. It shares the core layer `agentv3/skillRunCore.ts`
with the model's `invoke_skill`, so the same parameters produce the same
evidenceRefId, artifact, capture and queryReview, yet it is not a model tool
call: it never enters RunManifest `toolResults`, the registry tool observer,
acquisition pacing, tool timing or plan tool-call records. Its guards run in
order: request scope, `canInvokeTool`, lease and deadline, the auth-only
`withRunAuthorizationOnly`, and the core's re-check after the Skill returns and
before anything is written; one attempt is capped at 20 s. Captures join the
investigation ledger through the product call id `scene-entry:<skill>:<hash>`
observed as started then completed or failed. The model reads the result in the
tier-2 `scene_evidence` segment, never dropped whole (at most 24 cells and 2 KiB;
summary cells go before key cells), and `RuntimePerformance` records a
`scene_evidence` phase and the closed `sceneEvidence` receipt.
`allowMemoryPrefetch` gates only the memory tier and has nothing to do with it.
String cells shortened upstream are not offered to the model as exact values;
artifact locators remain available for reading the original evidence.

Pi alone creates a per-run Skill result note memory and turns on the executor's
rule facts (`agentv3/skillResultSemanticNotes.ts`; an off value of
`SMARTPERFETTO_SKILL_RESULT_FACTS` disables both); the hidden fallback runtimes
have neither. Both `invoke_skill` return paths, `fetch_artifact` and the
`scene_evidence` segment carry producer `resultNotes` (column meaning,
`row_semantics`, an investigation metric's aggregation/coverage/denominator
declarations; each `skillId.stepId.column` once per run, at most 24 columns per
result) and the `facts` of fired diagnostic rules (`ruleId`, bound values with
the source column's unit, result locators, at most 2 KiB; never severity,
diagnosis or suggestion text). Over its bound `scene_evidence` drops summary
cells, then `resultNotes`, key cells and `facts`; an undelivered note stays owed
to a later result. `facts` are projected only from the diagnostics the run
already recorded, and a fact grants no evidence authority.

**Minimum evidence for the current selection.** A resolved `bounded_question`
`read_new` investigation also needs explicit `targetUse=current_selection`
before entering `selectedEvidenceFoundation.ts`. The UI sends `nativeTable: 'slice'`
only when the actual renderer's `rootTableName` is `slice`. The backend rereads
the native row and time window in the same trace and uses the original identity
gate to check exact UTID/UPID. An explicit user selector must be verified before
registering a capture. Optional profile `entry_acquisition` metadata names one
minimum metric and four exact parameter bindings. The product selects the unique
safe root producer from the pinned registry, without choosing by Skill name.
Missing or unknown target-use, old clients without the table hint, other selection
types or targets, existing-only turns and dual traces do not enable this path.

Every runtime completes this acquisition before generic focus, architecture
and completeness prefetch: the original response from the same processor issues
the native witness before identity preparation and the minimum metric run.
Prefetch module loading cannot invalidate that earlier immutable capture; an
already untrusted processor gains no eligibility. Early acquisition, later model
tools and finalization share the run's evidence store, executor and pinned
registry. Failed or unavailable acquisition is handled only once. A later
preflight failure preserves legally committed captures and their original
ownership while the overall run still ends with its actual failure state.

Native capture and metric execution have separate status axes; `captured` and
`committed` establish neither complete evidence nor a verified claim. A legal
native capture survives a later metric failure. All work shares at most 20 s of
acquisition within the original deadline; cancellation waits for started work to
settle and permits no further acquisition or commits. The prompt retains locators
and gaps within the same 24-cell/2-KiB budget. Skill results and producer units
remain the authority for values; the finalizer does not re-derive them.

Tool-result `modelEvidence` reports only backing-capture row availability, whether
any trusted column units exist, and whether a private registered metric binding
exists. An empty page does not mean an empty capture, and a binding does not mean
a metric was observed. Restored data cannot recreate authority or witnesses.

## Turn Budgets And Closeout

HTTP, CLI, conversation and direct runtime entry points share a private `RuntimeAdmission` identity. Budgets start when authorized work for the turn begins, including classification and preparation, and never restart on entering the native SDK. An explicit task cap and work-stop signal remain separate from user cancellation and authorization. Without an explicit cap, no new hard timer is added before configuration parsing; already-started preparation queries may drain. A timeout preserves an already completed candidate. The guard waits for actual native work, tools and cleanup before releasing ownership, and late results cannot affect a successor run.

Full mode defaults to 100 turns and quick mode to 50; the five-turn quick target
is advisory. A budget above one reserves one no-tool delivery call. Native
length/output_limit may use that reserved call within the original deadline to
complete its body, and a completed candidate with no answer body may use it for
an empty-body continuation. A completed candidate whose structured delivery
diagnostics report a recoverable gap may use it for one same-run correction. A
new candidate needs its own completed/stop receipt; failed, cancelled, unknown or
pending tool/deferred states cannot use this recovery. Failure retains the first
incomplete receipt, and an acknowledgement adds no call. Tools and duplicate
visible-body streaming stay disabled during this completion. No call completes or
repairs a declaration: answers carry none. At investigation exhaustion, closeout
uses the selected model, pinned provider, current authorization and original
deadline to explain the supported findings, missing evidence and useful
follow-up questions.

It cannot query again or certify completion: `partial`, `turn_limit` completion
and `max_turns` termination remain. No review call follows this closeout.

OpenAI's acquisition deadline may advance with actual progress without consuming
the reserved delivery and finalization budgets. An acquisition timeout with
returned data may use one no-tool closeout inside the delivery reserve, retaining
`partial/timeout` and adding no review call. A failed closeout retains the
original candidate. Cancellation, an expired
hard deadline, revoked authorization or an exhausted explicit cost budget cannot
start another call.
A one-turn configuration has no extra delivery allowance.

Before dispatch, closeout and continuation calls use
`services/runtimeCallStats.ts` to estimate duration from successful calls' p75
for the same provider origin, model, purpose and input-size bucket. Insufficient
samples use the current provider defaults (GLM 180 s, DeepSeek 120 s, others
90 s). A call that does not fit the time left is skipped and the body is
preserved. Report delivery and
continuation when the body is missing may still dispatch, bounded by the original
deadline. An estimate cannot extend the deadline or bypass cancellation,
authorization or cost limits. Server samples come from successful calls in sealed
RunManifests; CLI does not aggregate samples, uses defaults, and records
`stats_not_configured`. Admission decisions and actual durations are internal
performance receipts, neither proof nor public SSE.

## SSE Events

All runtimes emit the same SmartPerfetto streaming update categories to the
route layer:

| Event | Meaning |
|---|---|
| `progress` | Phase change |
| `thought` | Intermediate reasoning or phase guidance |
| `agent_task_dispatched` | Tool invocation started |
| `agent_response` | Tool result |
| `answer_token` | Final-answer token |
| `conclusion` | Finalized, owner-projected answer body, sent before report and snapshot generation |
| `analysis_completed` | Product-finalized terminal metadata and actual report outcome |
| `error` | Failure |

The product emits `analysis_completed` after finalization and report handling.
Native completion, delivery assurance and report generation retain separate
states; a successful chat projection cannot hide report failure. The current
backend emits no provisional answer, `provisional_answer`,
`review_stop_requested` or `final_review` progress.

## Final Result And Quality Artifacts

Each runtime returns its original `AnalysisResult` with a private finalization
context for the same run:

```text
exact runtime result + private RuntimeFinalizationContext
  -> product-owned finalizeAnalysisResult (once, no model call)
  -> canonical body (a stray model declaration is stripped, never stored)
  -> identity resolution from the run's own data envelopes / source citation check
  -> delivery assurance: completion / identity / source
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

Data accuracy comes from Skills and SQL. The answer is plain text written from
this run's tool and Skill results, guided by the shared tier-1 `answer_guidance`
prompt segment: stay in scope, judge "abnormal" only against a stated metric,
scope and threshold, check unit arithmetic, treat missing data as unknown, and
prefer the units and totals a Skill reports over values re-derived from raw rows.
The finalizer does not verify each number or sentence; a wrong value is fixed in
data acquisition (Skill, SQL or producer units).

A runtime records only native facts on its result and on the turn it adds to
the session (completion status, turn limit, timeout, provider failure,
cancellation, an empty body, a privacy replacement). It never applies the
quality gate, never marks a result `quality_gate_failed` and emits no draft
`degraded` update. The finalizer records a quality termination only for a missing
body or actual native delivery failure; the route and CLI annotate that turn.

New finalizations record `deliveryAssurance` as follows. `completion` (native
completion facts) and `identity` (dual-trace comparison identity) are checked.
`source` is the citation-only annotation described in
[Source-Aware Runtime Parity](#source-aware-runtime-parity). `claims`, `report`,
`investigation` and `investigationEvidence` are `not_applicable`: no checking
mechanism exists for them. The investigation evidence ledger is still recorded
for display only. New results carry no `claimVerificationResult` or
`claimSupport`, and the internal performance receipt records the final review as
`not_required`. Annotations never make a completed body partial or lower finding
confidence. The Web flow shows no verification-incomplete notice for these
runs; CLI prints `✓` when completion passes and `~` only when an assurance axis
failed or is `coverage_incomplete`.

The product takes the context from the exact result before copying it. The
context fixes the provider, original absolute deadline, trace identity and
evidence-read scope. The owner checks current-run identity, cancellation and
authorization across awaits; user cancellation or context disposal aborts
finalization's evidence reads. A privacy projection that alters checked inputs
downgrades `passed` to `not_checked` and keeps `not_applicable`.

`final_report_contract` remains strategy frontmatter in the pinned registry.
`runtimeConclusionVerifier` supplies structured delivery diagnostics without an additional
semantic LLM or misdiagnosis-word matching; runtimes use them only to choose a
same-run correction. Reports, CLI artifacts and snapshots keep provenance. Chat
projects the body and structured runtime appendix separately without
mechanically editing natural-language conclusions.

Conclusion presentation retains the complete body rather than removing sections
by headings. Web stores server delivery details separately with the candidate
identity; replacing a body clears stale details, and metadata backfill updates
only the current run's message with the same candidate. CLI display files bind
to the session, turn and body. Display data cannot issue witnesses, raise
assurance status or restore authority.

Historical results are read unchanged: stored declarations, claim verification
verdicts, numeric presentation outcomes and per-claim source citations still
render in reports, CLI artifacts and snapshots. An HTML report shows no claim
verification section when a result has none.

## Sessions And Resume

The route layer calls `orchestrator.takeSnapshot()` and restores with
`restoreFromSnapshot()`.

Each logical follow-up starts a fresh model context while retaining the logical
session and provider/runtime pin. Native SDK context is used within the current
investigation, without implicitly replaying older SDK sessions, `previousResponseId`
or opaque transcripts across questions.

`analysisHistory.ts` supplies bounded, typed history to classification and analysis:
the latest three questions and answers, the latest unfinished work, and an older-turn index.
It preserves partial/unknown status, termination, uncertainties and next steps.
The latest exchange and the most recent incomplete turn are independently protected:
older unfinished work cannot evict the newest answer. The default analysis preview
is bounded to 12,000 actual UTF-8 bytes including its template, classification to
6,000. Prose and navigation yield to identity, completion and open obligations.
Omission counts are recomputed from the final projection, distinguishing absent
detail from turns missing even an index entry. Tiny budgets first fall back to a
valid continuation index; if exact identities cannot fit, a safe budget error stops
dispatch instead of disguising nonempty history as empty or adding a model call.
`relatedTurnIds` supplies limited navigation only for exact full locators within
the same trace and authorization partition. Artifact names, identical questions,
and source paths alone imply no relationship or proof. `read_session_history`
pages the full questions, answers and declared locators of the product-bound
session. It accepts no owner/session selector and performs no new SQL acquisition.
`fetch_artifact` remains the reader for available raw table evidence.

Full history reuses `conversation_turns`. A Conversation descriptor and finalized
turn are saved in one transaction using `runtime_snapshots` and the history table.
Reopen/restart recovery validates tenant, workspace, current owner, trace, provider
pin and source permissions before hydrating a logical session. A crashed running
turn becomes interrupted, with no phantom execution. Write failure retains the
answer and reports recovery unavailable. Source-derived history requires an exact
match with its original authorization fingerprint; missing or changed scope is
not resent to the model. History and locators cannot restore current execution
witnesses or expand the current selection or proof scope.

Snapshots also carry final-result quality fields such as delivery assurance,
identity resolutions and, for historical results, conclusion contracts and claim
verification results, so resume, report export and analysis-result comparison
can reuse them.

Historical GET, report and snapshot replay only read/project stored state. They
do not run a new finalizer or evidence attestation; normal
access authorization still applies. Restored display rows cannot recreate
in-process execution witnesses.

A logical Conversation session retains in-memory artifacts/captures under the
exact trace pair, authorization fingerprint and tenant/workspace/user scope;
physical session/run IDs remain unique. Issued bindings travel through internal
options, cannot be forged by JSON, and cannot be replaced by a missing-binding
fallback to a cached facade. The model receives a bounded locator catalog for
retained artifact reads, without rows, coverage or proof authority. Each
finalization fixes its admitted capture set; release the lease and clean up the
physical session after it settles. Scope changes/disposal revoke the context,
events are isolated by their producer run, and old cancellation/cleanup cannot
affect the next turn.

`ConversationPendingContext` separately owns process-memory notes for the next
user turn. Status reads only observe run facts. Notes do not change the active
request, enter dynamic history, or automatically launch another turn. The next
turn freezes one effective query and consumes notes only after startup persistence
and a renewed authority check; classification, analysis and finalization use that
same request. A random queue epoch, exact run and bounded idempotent receipts
isolate retries and restarts. Noninterrupting client controls have independent
request ownership bound to the conversation's actual sources; current settings
cannot silently change an existing conversation.

`assistantWorkCatalogService.ts` projects existing sessions, runs, and artifacts
into a work overview; it owns no execution state machine. Owner filtering precedes
candidate grouping, attention filtering, and pagination. Injected live readers supply
only owner-bound run facts. Random IDs never establish ordering between same-millisecond
runs: missing consistent latest pointers remain unknown, and pagination anchors are
not run evidence. Shared `assistantWorkProjection.ts` separates lifecycle from result
availability without changing verification. Detail, download, and explicit-continuation
clients recheck owner/source authority at delivery, without waiting for the next redraw.

Raw trace comparison sessions must also persist `referenceTraceId`,
`comparisonSource`, and `comparisonReportSection`. A comparison session cannot
silently downgrade to single-trace mode or switch to a different reference
trace. Restore must read and write the provider/runtime identity with the
comparison identity.

## Platform Boundaries

- Source runs and the npm CLI require Node.js `>=24 <25`.
- Portable packages bundle Node.js 24, backend runtime files, committed
  `frontend/`, and the pinned trace processor.
- Typed-intent, answer-guidance and Conversation evidence-context
  templates are runtime assets. Changes require checking existing public Skill
  export, npm CLI and Docker/portable bundled paths so distribution does not omit
  templates available in source. Documentation cannot substitute for those gates.
- Docker does not read host Claude Code local auth; use Provider Manager or env
  provider configuration.
- Runtime/provider/session changes must be checked against Web UI, CLI, API,
  reports, Docker, and portable packages. See
  [`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md).

## Health Check

Authenticated `GET /api/runtime-health` exposes the selected runtime. Public
`GET /health` returns only liveness and version:

```json
{
  "aiEngine": {
    "runtime": "openai-agents-sdk",
    "providerMode": "openai_responses",
    "diagnostics": {
      "protocol": "responses",
      "model": "gpt-5.4-mini"
    }
  }
}
```

This distinguishes provider connectivity from the runtime that will actually
execute analysis.

## System investigation acquisition and delivery boundaries

Scene investigation obligations are pinned separately from report formatting. Ordinary answers and comparisons may also require system investigation. The shared tool observer and original execution captures provide trusted acquisition records; tool names, model prose and truncated summaries cannot establish that a dimension was checked. Observer failure preserves the tool outcome, and absent records remain unknown / not_checked.

Investigation obligations guide acquisition; the finalizer does not judge answer coverage against them. New finalizations record `investigation` and `investigationEvidence` assurance as `not_applicable`, and the acquisition ledger is kept for display only. Coverage gaps cannot rewrite the conclusion, start a new acquisition loop or alter native SDK completion. Historical snapshots remain historical records and do not reissue current-run evidence authority.

# Agent Runtime Architecture

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

<!-- i18n-headings: paired -->

SmartPerfetto separates model SDK mechanics from Perfetto analysis capability.
The HTTP and CLI session layers depend on the shared `IOrchestrator` contract;
the concrete runtime is selected from the request provider, Provider Manager,
or environment.

| Runtime | SDK | Provider family | Notes |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic, Bedrock, Vertex, DeepSeek, Anthropic-compatible gateways | Default runtime; requires explicit provider/env credentials and supports MCP server and configurable sub-agents under shared completion and verification contracts |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI, Ollama, OpenAI-compatible gateways | Native OpenAI runtime; adapts the same SmartPerfetto tools as function tools |
| `pi-agent-core` | Pi Agent Core | custom only | Optional public runtime; real model configurations reuse the shared SmartPerfetto prompt/tool/report pipeline, while fake-stream remains smoke-only; does not enable `.pi` discovery, package extensions, shell tools, or file tools |
| `opencode` | OpenCode server / SDK | custom only | Optional public runtime; uses explicit OpenAI-compatible or OpenCode model configuration, request-scoped SmartPerfetto MCP tools, and a hardened isolated OpenCode server; does not read local OpenCode login/project state or enable built-in file/shell/web/edit tools |
| `qoder-agent-sdk` | Qoder Agent SDK / `qodercli` | custom only or env | Optional public runtime; SDK is an opt-in optional peer, uses a local Qoder CLI login or PAT, exposes request-scoped SmartPerfetto MCP tools, and isolates private-knowledge streams/sessions/snapshots |

## Entry Points

HTTP analysis:

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> ClaudeRuntime.analyze() | OpenAIRuntime.analyze() | PiAgentCoreRuntime.analyze() | OpenCodeRuntime.analyze() | QoderRuntime.analyze()
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

Priority, highest first:

1. `providerId` from the request or session.
2. The Provider Manager active provider.
3. `SMARTPERFETTO_AGENT_RUNTIME`.
4. Default `claude-agent-sdk`.

`SMARTPERFETTO_AGENT_RUNTIME` only accepts `claude-agent-sdk`,
`openai-agents-sdk`, `pi-agent-core`, `opencode`, or `qoder-agent-sdk`. Provider names such as
`deepseek` or `openai` are not valid runtime values. Provider Manager active profiles
override env fallback, and a resumed session keeps the provider/runtime it was
created with.

Provider mapping:

| Provider type | Runtime | Protocol |
|---|---|---|
| `anthropic` / `bedrock` / `vertex` / `deepseek` | `claude-agent-sdk` | Claude/Anthropic |
| `openai` | `openai-agents-sdk` | OpenAI Responses |
| `ollama` | `openai-agents-sdk` | OpenAI-compatible Chat Completions |
| `custom` | selected by `connection.agentRuntime` or `connection.openaiProtocol` | explicit configuration; Pi Agent Core, OpenCode, and Qoder are custom-only |

Provider connection fields map to runtime-specific env:

| Fields | Runtime | Env |
|---|---|---|
| `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` | `claude-agent-sdk` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` |
| `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` | `openai-agents-sdk` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_AGENTS_PROTOCOL` |
| `piAgentCoreModulePath` / `piAgentCoreModelJson` / `piAgentCoreSystemPrompt` | `pi-agent-core` | `SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH` / `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` / `SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT` |
| `openCodeSdkModulePath` / `openCodeModelJson` / `openCodeSystemPrompt` plus OpenAI-compatible endpoint fields | `opencode` | `SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH` / `SMARTPERFETTO_OPENCODE_MODEL_JSON` / `SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT` plus `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` when model JSON is omitted |
| `qoderAccessToken` / `qoderCliPath` / `qoderModel` / `qoderSystemPrompt` | `qoder-agent-sdk` | `QODER_PERSONAL_ACCESS_TOKEN` / `QODERCLI_PATH` / `QODER_MODEL` / `SMARTPERFETTO_QODER_SYSTEM_PROMPT` |

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
share the analysis SDK session. Pi Agent Core, OpenCode, Qoder, legacy
manifests, unavailable credentials, snapshot drift, or invalid model output
use an explicit deterministic fallback in V1 and are never presented as if the
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
| `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts` | OpenCode server/runtime adapter and request-scoped MCP bridge |
| `backend/src/agentRuntime/engines/qoder/qoderRuntime.ts` | Qoder SDK adapter, stream projection, and session isolation |
| `backend/src/agentRuntime/runtimeExecutionGuard.ts` | Runtime/session single-active execution, cancellation, and stale-settle isolation |
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | Shared typed intent, budget, scope and evidence-access policy for all native engines |
| `backend/src/agentRuntime/analysisFinalizationContext.ts`, `runtimeEvidenceContext.ts` | Private finalization context, original deadline, authorized capture reads and cross-turn leases |
| `backend/src/agentRuntime/runtimeCandidateAdmission.ts` | Maintainer-owned concurrency-candidate admission boundary |
| `backend/src/agentRuntime/runtimePerformance.ts` | Internal RunManifest phase, tool, and SQL queue/execution timing receipt |
| `backend/src/agentRuntime/runtimeToolConcurrency.ts` | Request-scoped fair read/write scheduling with an exclusive default |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto tool implementation and composition |
| `backend/src/agentv3/mcpToolRegistry.ts` | Tool descriptors, exposure levels, and allowlists |
| `backend/src/services/agentResultNormalizer.ts` | Shared final result, client projection, and report-data boundary |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | Original-proposition canonical results and the single product-owned asynchronous finalizer |
| `backend/src/services/finalSemanticAssessment.ts`, `evidence/evidenceReadView.ts` | Bounded no-tool semantic review and original execution-capture reads |
| `backend/src/services/finalReportContractGate.ts` | Strategy-owned `final_report_contract` validation |
| `backend/src/services/providerManager/` | Provider configuration and runtime/protocol/env mapping |
| `backend/src/agentv3/sessionStateSnapshot.ts` | Shared snapshot for SDK and Pi/OpenCode/Qoder runtime state |
| `backend/src/services/externalIssueReporting/providerPin.ts` | M10 source-run provider snapshot validation |
| `backend/src/services/externalIssueReporting/triageRunner.ts` | M10 no-tool Agent triage and deterministic fallback |

`backend/src/agentOpenAI/` and individual files such as
`agentv3/claudeRuntime.ts` retain compatibility re-exports for old import paths.
MCP, strategy and planning remain canonical shared layers. The `claudeVerifier`
compatibility entry points to shared structured delivery diagnostics; the
finalizer owns content meaning and claim support.

## Tool Layer

SmartPerfetto analysis capability is registered through
`createClaudeMcpServer()` and described through `McpToolRegistry`: SQL
execution, Skill invocation, SQL schema lookup, planning/hypothesis tools,
artifacts, memory, code-aware lookup, baselines, and comparison tools.

Claude runtime exposes these tools as an in-process MCP server. OpenAI runtime
does not duplicate tool logic; it reads the same `McpToolRegistry` and adapts
tool descriptors into OpenAI Agents SDK function tools. Pi Agent Core uses
request-scoped native tools built from the same shared descriptors, the shared
system prompt, planning/hypothesis tools, and the same route-owned
finalization/claim-verification/report pipeline without turning SmartPerfetto
into a Pi coding-agent harness. OpenCode runs a hardened isolated server and
bridges request-scoped SmartPerfetto tools through a per-analysis MCP bridge;
its built-in project discovery, file, shell, web, and edit tools are disabled
or denied. Qoder uses the SDK's in-process MCP bridge with built-in SDK tools
disabled and projects every answer token through the shared private-output
guard before SSE emission. Each engine uses its pinned provider's native no-tool
transport for the same typed intent and hands its result to the same
product-owned finalizer/report boundary. SDK/server resume, streaming, tool
cadence and cost/timeout semantics still differ.

The tool surface follows actual request scope, artifact-store availability,
codebase permission, `referenceTraceId`, comparison context and evidence access.
Budget mode neither grants permission nor silently removes authorized tools.
`existing_only` strictly prohibits new acquisition.

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

Performance branches are controlled by the strict maintainer-only
`SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` boundary and default to no admitted
candidates. The value may contain only a comma-separated, whitespace-free,
duplicate-free list from `task4` through `task9`. Whitespace, an unknown item, a
duplicate, or any malformed value invalidates the whole setting. It is not a
Provider Manager, UI, or provider env option, and benchmark artifacts never
activate it automatically:

| Candidate | Scope |
|---|---|
| `task4` | Reuse one quick-evidence/focus preflight across all five runtimes |
| `task5` | Use bounded fair overlap for explicitly commutative read tools across all five runtimes; all other tools remain exclusive |
| `task6` | Overlap independent Claude/OpenAI preflight DAG nodes |
| `task7` | Load independent Pi SDK/provider startup concurrently and enable quick parallel-batch scheduling; descriptor/tool gates still serialize exclusive work |
| `task8` | Read OpenCode messages/status together and use adaptive polling |
| `task9` | Overlap Qoder Skill-registry and SDK startup |

After `task5` is admitted, its safe-read policy is enabled by default.
`SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` is a rollback to exclusive
execution; it cannot bypass a missing `task5` admission. Cache single-flight,
execution isolation, cancellation cleanup, receipts, and deterministic repairs
are correctness/observability foundations and remain active independently of
performance-candidate admission.

Shipped defaults remain serial: genuine deterministic admission harnesses for
all five adapters are `NOT CONFIGURED`, and bounded real-provider base/candidate
A/B has not run, so performance/accuracy admission is `INCONCLUSIVE`. Synthetic
scorer data validates scoring mechanics only and cannot enable a candidate.
When real-provider validation cannot run, record `NOT AVAILABLE` or
`NOT CONFIGURED` precisely. Qoder needs a PAT or local `qodercli` login in
addition to BYOK. Unit, type, build, and deterministic gates are not substitutes
for real-provider evidence.

The Pi Agent Core real-model path reuses SmartPerfetto scene strategies, system
prompt assembly, SQL/Skill tools, planning/hypothesis tools, artifacts, and the
route-owned quality/finalization/report pipeline. It does not read `.pi`
project configuration, package extensions, shell tools, or file tools. Provider
Manager only exposes it for `custom` providers with explicit Pi model JSON or
equivalent env configuration. `SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` is
smoke/test-only and must stay labeled capability-limited.

The OpenCode path is also custom-only. It can use `SMARTPERFETTO_OPENCODE_MODEL_JSON`
with `providerID` / `modelID` / `baseUrl` / `apiKey` fields, or fall back to
OpenAI-compatible `OPENAI_*` env/provider fields. SmartPerfetto does not reuse
the user's OpenCode CLI login, config, or project extensions; rollback is
switching the custom provider or `SMARTPERFETTO_AGENT_RUNTIME` back to
`claude-agent-sdk` / `openai-agents-sdk`.

The Qoder path is custom-only in Provider Manager and also supports an explicit
env selection. The SDK is not installed by default; users must review its terms
and opt in through `qoder:install -- --accept-terms` or an explicit module path.
The `resolveModel` BYOK policy combines `QODER_BYOK_API_KEY`,
`QODER_BYOK_PROVIDER`, `QODER_MODEL`, and optional base URL, style, and light
model values; partial configuration fails closed. BYOK changes the model
provider only and never replaces Qoder PAT or local `qodercli` authentication.
Provider Manager accepts the four BYOK values only through a Qoder custom
profile's `custom.envOverrides`; it cannot override the CLI, SDK module, or
worker path. The BYOK key reaches only the SDK `resolveModel` callback, not the
SDK subprocess environment, diagnostics, or plaintext snapshots. Provider,
base URL, and style remain non-secret snapshot inputs, while key changes update
the secret fingerprint used by provider pinning, resume, external issue, and
Self-Evolution proof boundaries. Public logical follow-ups use product history and a fresh model context. A run authorized for private codebase or external knowledge never resumes
or stores that opaque provider session, and its intermediate state is excluded
from durable snapshots.

## Source-Aware Runtime Parity

The five production runtimes do not implement separate source policies. They
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
occurrence, mechanism or causal relationship, and is a different field from a
claim binding's `mechanismStatus`.

The shared finalizer uses `semanticsPolicy: declared`. Even with matched Trace
references and source bodies, a model-declared `mechanismStatus: corroborated`
is downgraded to `compatible` with `source_binding_mechanism_unverified`.
This path has no native proof that establishes a general mechanism. Unknown
mechanisms remain unverified/partial; a lookup-audit status cannot replace proof.

One canonical safe projector carries the same decision and binding through
initial and replayed SSE, HTML reports, CLI JSON/Markdown/HTML,
analysis-result snapshots, and report/snapshot APIs. Web chat further reduces
it to a current-run receipt without `CodeRef`. No surface retains absolute
roots, snippets, search queries, or model-authored free-text binding reasons.

The deterministic five-runtime execution/finalization gate and A0–A4 semantic
gate prove the product contract, not real-provider model quality. Claude,
OpenAI, Pi, OpenCode, and Qoder require separate repeated acceptance when
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
classification — still detects focus app, architecture, vendor and trace
completeness. Focus detection scores candidate processes once over the
analysis window (foreground time, frames, launches, battery `top`, CPU),
excludes processes with no activity and reports `high`/`medium`/`ambiguous`
confidence. All five runtimes resolve the effective package through
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

## Turn Budgets And Closeout

Full mode defaults to 100 turns and quick mode to 50; the five-turn quick target
is advisory. A budget above one reserves one no-tool delivery call. Early normal
completion adds no call when it carries the required valid declaration, or when
typed intent is an acknowledgement. A completed non-acknowledgement candidate
without a declaration may use that reserved call so the same author can attach
the declaration to the complete native body. Acceptance requires an unchanged
visible body and a valid declaration; edited, truncated, failed or invalid replies
retain the original candidate. Tools and duplicate visible-body streaming stay
disabled during this completion. At investigation exhaustion, closeout uses the selected
model, pinned provider, current authorization and original deadline to explain
the supported findings, missing evidence and useful follow-up questions.
It cannot query again or certify completion: `partial`, `turn_limit` completion
and `max_turns` termination remain. No model semantic review follows this closeout;
deterministic evidence checks can still run.

A failed closeout or declaration completion retains the original candidate. Cancellation, timeout, revoked
authorization or an exhausted explicit cost budget cannot start another call.
A one-turn configuration has no extra delivery allowance. OpenCode stops acquisition
after observing native messages and can overshoot between observations. It records
actual turns and skips the summary when no allowance remains; this is not a strict
model-call cap.

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
| `conclusion` | SDK conclusion arrived |
| `analysis_completed` | Product-finalized terminal metadata and actual report outcome |
| `error` | Failure |

The product emits `analysis_completed` after finalization and report handling.
Native completion, evidence/claims and report coverage retain separate states;
a successful chat projection cannot hide report failure.

## Final Result And Quality Artifacts

Each runtime returns its original `AnalysisResult` with a private finalization
context for the same run:

```text
exact runtime result + private RuntimeFinalizationContext
  -> product-owned finalizeAnalysisResult (once)
  -> canonical body / original claim semantics
  -> retained execution capture / finite proof / at most one no-tool semantic review
  -> independent completion / claim / report / source / identity assessments
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

The product takes the context from the exact result before copying it. The
context fixes the provider, original absolute deadline, trace identity and
evidence-read scope. The owner checks current-run identity, cancellation and
authorization across awaits. Semantic review runs at most once, has no tools,
and uses the original absolute run deadline. Starting or rereading the review
does not reset or extend that budget. User cancellation or context disposal
aborts the review. A timeout records unavailable assurance while preserving the body
and native completion; review does not rewrite the body or reduce causal
propositions to numeric ones. Unknown review alone does not fail a focused answer;
full reports still require their report-assessment contract. The body, native completion and original claims
are independent inputs; valid JSON and model agreement alone are not proof.

The same context binds the frozen input selection to semantic review. Review
checks the answer against the question, intent and selected event or range;
an explicit request for another target or the whole trace takes precedence over
a persistent UI selection. Selection metadata is lookup context, not execution
evidence or proof of process identity. Missing legacy or pre-preparation context
remains distinct from explicit no selection; malformed selection is rejected. In paired traces,
workspace focus does not establish which trace supplied the selection, so its
origin remains unknown. A privacy projection that cannot preserve the admitted
selection exactly leaves review incomplete rather than silently changing scope.

Semantic review adds no application output-token cap. OpenAI sends only an
explicit `maxOutputTokens` captured for this run; Claude preserves the captured
SDK environment; Pi uses the pinned model's native SDK capability when no
explicit cap is supplied. Classifiers retain their separate small-protocol
budgets. Provider and SDK output limits still apply, as do complete-terminal-state
checks and the 64 KiB guard on the completed review JSON.
The shared OpenCode model configuration does not invent context/output capacity:
omitted capacity uses SDK defaults, unknown context does not trigger proactive
capacity-threshold compaction, and actual context overflow still uses native
reactive compaction. This does not promise equivalent long-session behavior to
a model with known capacity or add capacity fields to the model JSON interface.

`final_report_contract` remains strategy frontmatter in the pinned registry.
`claudeVerifier` supplies structured delivery diagnostics without an additional
semantic LLM or misdiagnosis-word matching. The finite catalog is authoritative
in `SUPPORTED_DETERMINISTIC_CLAIM_RULES`. Each rule proves only its explicitly
covered proposition. Missing original witnesses, trusted
units/field semantics or coverage retain candidate/unknown states. Equal values
or endpoints do not establish general causality. Complete claim status joins
captured evidence with semantic review of the current proposition. Reports, CLI
artifacts and snapshots keep provenance. Chat projects the body, machine
sidecars and structured runtime appendix separately without mechanically editing
natural-language conclusions.

Conclusion presentation retains the complete body rather than removing semantic
sections by headings such as “Evidence Index” or “Claim Verification”. Web stores
server verification details separately with the candidate identity; replacing a
body clears stale details, and metadata backfill updates only the current run's
message with the same candidate. CLI display files bind to the session, turn and
body. HTML reports list every claim, reference family and verification issue.
Source-table matching is labelled separately from proposition verification.
Display data cannot issue witnesses, raise verification status or restore authority.

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
The default analysis preview is bounded to 12,000 bytes, classification to 6,000;
answer detail yields to completeness and open questions. `read_session_history`
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

Snapshots also carry final-result quality fields such as conclusion contracts,
claim verification results, and identity resolutions so resume, report export,
and analysis-result comparison can reuse them.

Historical GET, report and snapshot replay only read/project stored state. They
do not run a new finalizer, semantic review or evidence attestation; normal
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

Raw trace comparison sessions must also persist `referenceTraceId`,
`comparisonSource`, and `comparisonReportSection`. A comparison session cannot
silently downgrade to single-trace mode or switch to a different reference
trace. Claude/OpenAI SDK session keys must be read and written with the
comparison identity, and Pi/OpenCode/Qoder runtime state must preserve the same
provider/runtime identity.

## Platform Boundaries

- Source runs and the npm CLI require Node.js `>=24 <25`.
- Portable packages bundle Node.js 24, backend runtime files, committed
  `frontend/`, and the pinned trace processor.
- Typed-intent, claim-schema, semantic-review and Conversation evidence-context
  templates are runtime assets. Changes require checking existing public Skill
  export, npm CLI and Docker/portable bundled paths so distribution does not omit
  templates available in source. Documentation cannot substitute for those gates.
- Docker does not read host Claude Code local auth; use Provider Manager or env
  provider configuration.
- Qoder is absent from default Docker/portable/npm installs until the optional
  SDK peer is explicitly installed after its terms are accepted.
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

Scene investigation obligations are pinned separately from report formatting. Ordinary answers and comparisons may also require system investigation. The shared tool observer and original execution captures provide trusted acquisition records; tool names, model declarations and truncated summaries cannot establish that a dimension was checked. Observer failure preserves the tool outcome, and absent records remain unknown / not_checked.

Investigation interpretation reuses the same bounded no-tool semantic assessment at the product boundary. Acquisition and content coverage are separate and bound to the body, contract, intent, registry and ledger fingerprints. Coverage gaps cannot rewrite the conclusion, start a new acquisition loop or alter native SDK completion. Historical snapshots remain historical records and do not reissue current-run evidence authority.

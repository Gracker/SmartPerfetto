# Backend Rules

## Runtime Selection

SmartPerfetto has five production agent runtimes behind the shared
`IOrchestrator` contract:

- `claude-agent-sdk`: default runtime for Claude Code, Anthropic direct,
  Bedrock, Vertex, and Anthropic-compatible providers.
- `openai-agents-sdk`: OpenAI Responses API and OpenAI-compatible Chat
  Completions providers.
- `pi-agent-core`: Pi Agent Core runtime, selected through custom Provider
  Manager profiles or explicit env/runtime pins.
- `opencode`: OpenCode SDK runtime, selected through custom Provider Manager
  profiles or explicit env/runtime pins.
- `qoder-agent-sdk`: opt-in Qoder Agent SDK runtime, selected through custom
  Provider Manager profiles or explicit env/runtime pins; local CLI auth is
  allowed only after the optional SDK is installed.

Runtime selection lives in `backend/src/agentRuntime/runtimeSelection.ts`.
Selection order is:

1. Explicit Provider Manager profile for the request.
2. Persisted session snapshot runtime/provider on recovery.
3. `SMARTPERFETTO_AGENT_RUNTIME` when no provider is pinned.
4. Default `claude-agent-sdk`.

Do not treat provider names such as DeepSeek or Qwen as runtime values. Valid
runtime values are `claude-agent-sdk`, `openai-agents-sdk`, `pi-agent-core`,
`opencode`, and `qoder-agent-sdk`.

## Primary Flow

Current backend analysis path:

```text
POST /api/agent/v1/analyze
  -> backend/src/routes/agentRoutes.ts
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> selected runtime engine
  -> shared MCP tools / Skill engine / trace_processor_shell
  -> result normalization / quality artifacts
  -> SSE projection + report generation + analysis-result snapshot
```

Key files:

| File | Purpose |
| --- | --- |
| `backend/src/index.ts` | Express bootstrap, route registration, health output |
| `backend/src/routes/agentRoutes.ts` | analyze endpoint, SSE stream, turns, response/cancel/focus |
| `backend/src/assistant/application/agentAnalyzeSessionService.ts` | session creation/reuse, provider pinning, persistence recovery |
| `backend/src/agentRuntime/runtimeSelection.ts` | runtime selection and orchestrator creation |
| `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | Claude Agent SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiRuntime.ts` | OpenAI Agents SDK orchestrator |
| `backend/src/agentRuntime/engines/pi/piAgentCoreRuntime.ts` | Pi Agent Core orchestrator |
| `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts` | OpenCode SDK orchestrator and bridge |
| `backend/src/agentRuntime/engines/qoder/qoderRuntime.ts` | Qoder Agent SDK orchestrator, private streaming projection, and session isolation |
| `backend/src/agentv3/claudeMcpServer.ts` | shared MCP tool implementations |
| `backend/src/agentv3/mcpToolRegistry.ts` | single registry for MCP tool exposure and allowed tool names |
| `backend/src/agentv3/planToolCallRecorder.ts` | provider-neutral tool-call evidence log for plan adherence |
| `backend/src/agentv3/planCompletionStatus.ts` | provider-neutral plan completion status |
| `backend/src/agentv3/claudeSystemPrompt.ts` | system prompt assembly for Claude path |
| `backend/src/agentv3/strategyLoader.ts` | loads `*.strategy.md` and `*.template.md` |
| `backend/src/agentv3/queryComplexityClassifier.ts` | fast/full/auto routing |
| `backend/src/agentv3/sceneClassifier.ts` | strategy-frontmatter-driven scene classifier |
| `backend/src/agentv3/claudeVerifier.ts` | verifier for full Claude analysis |
| `backend/src/agentv3/sessionStateSnapshot.ts` | persisted runtime state snapshot |
| `backend/src/services/agentResultNormalizer.ts` | normalizes final result and preserves report/client boundaries |
| `backend/src/services/finalReportContractGate.ts` | checks strategy `final_report_contract` completeness |
| `backend/src/services/evidence/evidenceContractBuilder.ts` | builds evidence and claim-support contract from DataEnvelope output |
| `backend/src/services/verifier/claimVerificationRunner.ts` | deterministic claim verification and identity-resolution collection |
| `backend/src/services/analysisResultSnapshotPipeline.ts` | persists completed-analysis snapshots for comparison/report reuse |
| `backend/src/services/providerManager/` | provider profiles, env isolation, runtime switching |
| `backend/src/services/traceProcessorService.ts` | trace loading and SQL RPC |
| `backend/src/services/skillEngine/` | YAML Skill loading/execution |

## AI Output Contract

Treat the final answer as a multi-surface contract, not one Markdown string:

```text
Runtime output
  -> AnalysisResult / conclusion contract
  -> evidence contract + claim verification + identity resolutions
  -> HTML report and CLI turn files
  -> analysis-result snapshot
  -> frontend SSE projection and visible chat conclusion
```

Keep these boundaries intact:

- Strategy frontmatter can declare `final_report_contract`; loaders and gates
  enforce required sections instead of relying only on prompt wording.
- Claims in the final result should be backed by Skill/SQL evidence, claim
  verification, or an explicit uncertainty marker.
- Chat projection may hide low-signal appendix details, raw SQL, snapshot IDs,
  or audit metadata, but reports, snapshots, and CLI artifacts must keep the
  provenance needed for later review and comparison.
- Do not patch only one surface when changing final-result shape. Check SSE
  payloads, HTML reports, CLI persistence/export, session snapshots, and
  generated frontend contracts.
- Tool narration is a two-sided contract in `backend/src/agentv3/toolNarration.ts`:
  `formatToolCallNarration` says what a call is for, `formatToolResultNarration`
  says what came back. Narrate from the **externally projected** result object
  (`projectToolResultForExternalSurface`) at the point the runtime still holds
  it — the `result` field on `agent_response` is byte-truncated for transport
  and can end mid-JSON. Several MCP tools wrap their JSON in guidance prose
  (skill notes prefix, reasoning nudge, active-phase reminder), so a structured
  consumer must extract the embedded JSON rather than parse the whole string.
  A registered tool with no narration case prints `调用工具 <name>`; a coverage
  test in `src/agentv3/__tests__/toolResultNarration.test.ts` enforces the set.
- `plan_phase_updated` is emitted from nine sites across five files. Build its
  payload with `planPhaseUpdatedContent(...)` so `origin` (`auto` vs `model`) is
  always present: the process view shows automatic transitions, which nothing
  else in the stream reports, and skips model-driven ones because the
  `update_plan_phase` dispatch line already narrates them. Never infer origin
  from the summary wording — those strings are localized. Its statuses are
  `in_progress`, `completed`, `pending`, and `skipped`; a two-case mapping
  renders an evidence rollback as progress.
- `SSE_EVENT_TYPES` in `types/dataContract.ts` is documentation, not
  enforcement. Events reach the wire whether or not they are listed, so an
  event with no frontend handler is silently discarded after being computed and
  transmitted — `plan_submitted`, `plan_phase_updated`, and `plan_revised` were
  in that state. When adding an event, wire a consumer or say why there is none.
- Result confidence comes from `estimateAnalysisConfidence` in
  `agentv3/analysisTermination.ts`, shared by every runtime. Four private
  copies once disagreed exactly where the number matters most — with no
  findings to average, Claude returned 0.30 while OpenAI returned 0.55 whenever
  the conclusion string was non-empty, so the same trace scored differently
  depending only on which runtime ran it. Confidence follows the findings' own
  confidences; never infer it from the presence of text.
- Structured facts must be read from a tool result **before**
  `summarizeExternalToolResult` truncates it. `planPhaseId` and `success` are
  appended after the result body, so they are the first casualties of the
  2000-char transport cap: a realistic 13.8 KB skill result loses both, which
  silently degrades plan phase attribution to semantic inference and leaves
  tool success unknown. Pass `resultFacts` from `readToolResultFacts(...)` at
  the runtime call site; `resultText` is a fallback, not a source of truth.
- `sqlUsesProcessNameFilter` decides both the raw-SQL identity warning and
  Skill identity admission, so it is an accuracy control, not a formatting
  nicety. Any change to it must be checked in both directions against real
  query shapes — it previously required whitespace before the operator, which
  let `p.name='com.foo'` scope a query to one process while reading as
  unscoped. Quick mode answers through model-written raw SQL, where that style
  is ordinary.

## MCP Tool Registration

`backend/src/agentv3/claudeMcpServer.ts` implements the tools, and
`backend/src/agentv3/mcpToolRegistry.ts` is the source of truth for registered
tool descriptors, exposure levels, and runtime allowlists. Do not duplicate a
fixed tool count in docs or code.

Tool visibility is request-shaped:

- Quick/lightweight analysis registers only core evidence tools, plus
  `list_skills` so `invoke_skill` is discoverable, and may include
  `fetch_artifact` when an artifact store exists. The quick `list_skills`
  projection is capped; the full catalog is full-mode only.
- Full analysis registers the data, knowledge, memory, planning/hypothesis,
  artifact, baseline, and optional code-aware tool families.
- Code-aware tools require codebase permission.
- Comparison tools are registered only when a `referenceTraceId` exists.
- External/public contracts should be derived from the registry view, not from
  an old static tool list.

## Runtime Concurrency Invariants

- `runtimeExecutionGuard.ts` owns runtime/session single-active execution.
  Cancellation may signal cleanup immediately, but ownership is retained until
  the outer execution settles; a stale token must never publish newer session
  state.
- `TraceProcessorSqlWorker` remains a single worker per processor key. Do not
  introduce same-trace SQL parallelism. Different processor keys may progress
  independently.
- Runtime tools are exclusive by default. Only registry-declared commutative
  reads may use `runtimeToolConcurrency.ts`, and only after `task5` admission.
  Keep the fair reader/writer ordering, request scope, cancellation, bounded
  parallelism, and re-entrancy rejection intact.
- `SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` is a maintainer-only fail-closed
  boundary for `task4` through `task9`. It is not Provider Manager/UI/provider
  configuration. Do not infer it from credentials, benchmark artifacts, or
  persisted sessions, and do not auto-activate candidates.
- `SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` is a rollback after `task5`
  admission. It must never bypass absent admission.
- Keep correctness and observability behavior outside the performance gates:
  processor/cache single-flight and failed-load retry, cancellation cleanup,
  runtime execution isolation, deterministic repairs, and internal receipts
  must work with no candidates admitted.

`RuntimePerformance` is internal RunManifest data. Record real phase spans,
first output, tool scheduling, and SQL queue/execution timing without exposing
raw SQL, processor identifiers, secrets, or unbounded provider content. Do not
add model, provider snapshot, usage, or performance fields to public SSE as an
incidental benchmark shortcut; any public contract expansion needs its own
privacy and compatibility review.

The candidate scopes are durable architecture boundaries: `task4` reuses quick
evidence; `task5` admits commutative reads; `task6` overlaps Claude/OpenAI
preflights; `task7` overlaps independent Pi startup and enables quick parallel
batch scheduling without bypassing descriptor/tool exclusivity; `task8`
uses OpenCode adaptive observation; and `task9` overlaps Qoder registry/SDK
startup. Shipped defaults remain serial until genuine five-adapter
deterministic admission and bounded real-provider A/B are available. Synthetic
scorer fixtures test scoring mechanics only.

## Self-Evolution Control Plane

- `backend/src/services/selfEvolution/` owns manifests, feedback isolation,
  evaluation corpus, proposal lifecycle, paired replay, overlay artifacts,
  generation publishing, reconciliation, contribution bundles, and rollback.
- `backend/src/routes/selfEvolutionAdminRoutes.ts` is the only HTTP control
  plane. Keep handlers thin and preserve separate
  `self_evolution:read|curate|export|apply|revert` permissions.
- Curation is explicit and public-feedback-only. Private feedback must never
  enter proposal evidence, contribution bundles, metrics detail, or an
  external judge.
- Online feedback statistics are hypothesis generation only. Apply eligibility
  requires the fixed validation + holdout baseline/candidate replay and human
  acceptance.
- `SELF_EVOLUTION_ENABLED` and `SELF_EVOLUTION_APPLY` default off. Apply/revert
  must fail closed unless effective apply is enabled and persistent user data
  outside the package is available.
- Keep operation streams scope-bound and bounded. Browser consumers require
  fetch-based SSE so Authorization and workspace headers remain attached.
- Contribution export creates a local deidentified artifact and never uploads,
  commits, opens a PR, or changes the TypeScript runtime.
- External L2 judge use requires a versioned rubric, sampled/disputed routing,
  and explicit per-use consent. Do not infer consent from Provider Manager or
  add an undocumented environment switch.

## Analysis Options Propagation

`agentRoutes.ts` passes options into `orchestrator.analyze(...)` through an
explicit whitelist. When adding a field to `AnalysisOptions`, update that
whitelist in the same change. Otherwise the HTTP body field is silently dropped
before it reaches either runtime.

Important whitelisted examples:

- `selectionContext`
- `analysisMode`
- `traceContext`
- `providerId`
- `referenceTraceId` / comparison context wiring

## Analysis Mode

`options.analysisMode` accepts `fast`, `full`, or `auto`.

- `fast`: quick mode, lightweight tool surface, no verifier/sub-agent path.
- `full`: full tool surface, plan/verifier path where supported.
- `auto`: minimal non-negotiable local rules (for example comparison mode),
  then shared semantic classifier fallback.

Keep scoped selection questions lightweight. A selected slice/range is a scope
signal, not an automatic quick/full decision.

## Provider and Session Invariants

- New sessions pin the effective provider/runtime at creation time.
- Existing live sessions keep their pinned provider unless an explicit
  `providerId` override changes it.
- Persisted sessions restore the provider/runtime snapshot before continuing.
- `providerId: null` means use env/default fallback and ignore Provider Manager.
- If a persisted snapshot references a deleted provider, fail with an explicit
  provider-not-found error instead of silently falling back.
- Comparison sessions include both current and reference trace context; do not
  register comparison-only tools when no reference trace exists.

## TypeScript Conventions

- Use TypeScript strict mode and existing local patterns.
- Prefer structured parsing, typed contracts, and existing services over ad hoc
  string handling.
- Keep route handlers thin when behavior belongs in application/services.
- For generated or mirrored contracts, update the source generator/template and
  regenerate instead of hand-editing outputs.

## Build Errors in Unfamiliar Files

Before fixing a build error, check whether the file is generated. Look for:

- `Generated`
- `Auto-generated`
- `generated/`
- `dist/`
- copied frontend bundles

If generated, fix the generator or source contract, then regenerate.

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

## MCP Tool Registration

`backend/src/agentv3/claudeMcpServer.ts` implements the tools, and
`backend/src/agentv3/mcpToolRegistry.ts` is the source of truth for registered
tool descriptors, exposure levels, and runtime allowlists. Do not duplicate a
fixed tool count in docs or code.

Tool visibility is request-shaped:

- Quick/lightweight analysis registers only core evidence tools and may include
  `fetch_artifact` when an artifact store exists.
- Full analysis registers the data, knowledge, memory, planning/hypothesis,
  artifact, baseline, and optional code-aware tool families.
- Code-aware tools require codebase permission.
- Comparison tools are registered only when a `referenceTraceId` exists.
- External/public contracts should be derived from the registry view, not from
  an old static tool list.

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

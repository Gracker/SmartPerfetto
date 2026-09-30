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
  -> selected runtime: typed turn intent + authorized, on-demand tools
  -> shared MCP / Skill / trace_processor_shell + raw execution capture
  -> exact runtime result + private finalization context
  -> product-owned finalizeAnalysisResult()
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
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | typed semantic intent and separate budget/evidence/delivery policy |
| `backend/src/agentRuntime/analysisFinalizationContext.ts` | private run-bound provider, deadline, evidence reader and terminal context |
| `backend/src/agentRuntime/runtimeEvidenceContext.ts` | issued in-memory evidence continuity with exact scope and run leases |
| `backend/src/agentRuntime/engines/claude/claudeVerifier.ts` | shared structured delivery diagnostics; no additional semantic LLM call |
| `backend/src/agentv3/sessionStateSnapshot.ts` | persisted runtime state snapshot |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | canonical body/claim extraction and the single asynchronous finalization boundary |
| `backend/src/services/finalSemanticAssessment.ts` | bounded no-tool semantic review of the current body and declarations |
| `backend/src/services/evidence/evidenceCapture.ts`, `evidenceReadView.ts` | original execution witnesses and bounded reads of retained captures |
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
  -> exact AnalysisResult + private RuntimeFinalizationContext
  -> canonical body / original typed claims / captured evidence
  -> finite proof + at most one no-tool semantic review
  -> HTML report and CLI turn files
  -> analysis-result snapshot
  -> frontend SSE projection and visible chat conclusion
```

Keep these boundaries intact:

- Strategy frontmatter can declare `final_report_contract`; loaders and gates
  enforce required sections instead of relying only on prompt wording.
- Claims in the final result should be backed by Skill/SQL evidence, claim
  verification, or an explicit uncertainty marker.
- A parsed turn intent or claim declaration is model input, not truth or
  authorization. Preserve the original proposition and its references; do not
  rewrite a causal claim into a simpler numeric claim to obtain a passing check.
- The product owner takes the private context from the exact runtime result
  before copying or projecting it and invokes `finalizeAnalysisResult` once.
  Finalization keeps the pinned provider, original absolute deadline and live
  owner/authorization checks. Its semantic review has no tools and cannot
  restart acquisition, extend the deadline, or rewrite the answer to repair
  style. Missing evidence/review remains explicit.
- The one semantic review is skipped only when `✓` is unreachable and no
  obligation needs it. That is an accepted residual, not a claim that the
  review could not matter: a contradiction only the review would find (`~` to
  `!`) then goes undetected, while a deterministic `unsupported` from finite
  proof still yields `!`. `finalizeAnalysisResult` decides after finite proof
  (`prepareClaimEvidence`, the draft `runClaimVerification` and
  `applySourceLocationProofs`) and before any semantic snapshot projection: it
  is required for a report deliverable, a present selection (a scope mismatch is
  an error), source access or any source field in the raw declaration, a
  resolved investigation requirement the ledger does not rule out
  (`investigationRequirementNeedsReview`), at least one declared claim for which
  the real `joinClaimVerification` against a hypothetical perfect review yields
  `passed` (never returned or persisted), or a zero-claim pure acknowledgement
  (`eligible`/`legacy_unchecked`, and not an evidence-rendered acknowledgement,
  whose claims are already `not_applicable`). Otherwise no review is sent: the
  assessment is `not_checked` / `not_required` bound to the candidate and the
  decision inputs, claim verification is `partial`, and the answer ends `~`,
  never `✓`. An ineligible declaration keeps `invalid_declarations`. The
  decision and its trigger names go to the internal
  `RunManifest.performance.finalReview`; Self-Evolution replay scores the
  runtime's own `claim_verifier@1` and never enters the finalizer.
- Deliver first, verify after. The semantic review cannot rewrite the body, so
  `finalizeAnalysisResult` hands the canonical body to `onProvisionalAnswer`
  once, in the tick the review is dispatched (never for scene runs, a review
  that is not sent, or an empty body). Each surface applies the projector it
  uses for its terminal answer: the Web route broadcasts a `conclusion`
  (`provisional: true, verification: 'pending'`) that private sessions keep out
  of the durable event store; conversations publish `provisional_answer`; the
  CLI prints the body through a separate callback, leaving ndjson unchanged.
  The Web route and the conversation drop the runtime's own `conclusion`; its
  `answer_token` reaches them only as the answer draft below. A surface returns
  `false` from the callback when it did not deliver, so the review-started line
  claims "answer readable" only when it is true. Verdicts and `!`/`~` come only
  from the finalized result.
- Stops follow one state machine, `services/reviewStopHandle.ts`
  (`ReviewStopHandle`: signal, `markDelivered()`, `requestStop()` →
  `review` | `full` | `noop`), used inside each existing single-active owner:
  the agent route's `HttpFinalizationRun`, the conversation service (the signal
  reaches the adapter as `reviewStopSignal` in the run input) and the CLI turn
  controller (`cli-user/services/turnInterrupt.ts`). Before a provisional
  answer (draft only, no candidate) a stop is the full cancel and nothing but
  the cancel marker is stored. After it, the first stop is review-only and is
  answered at once (`review_stop_requested`, even if the review already
  finished): the review resolves `not_checked` / `cancelled_by_user` and the
  run commits its normal `~` turn (report deliverables `!`). A second stop
  forces: it waits for that commit up to the watchdog, then aborts. The
  watchdog (`resolveReviewStopWatchdogMs`, `SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS`,
  default 15 s, floor 10 s above the SQLite busy timeout) starts only at a stop
  request, since "finalization settles in milliseconds" is an expectation, not
  a premise. If it elapses without a commit, the owner stores the provisional
  body as a partial turn (`buildReviewNotFinishedResult`: `partial`,
  `terminationReason: review_not_finished`, claim verification `not_checked`)
  through its normal commit path, with the run's own pins (source partition,
  owner projection), then aborts; excluded — plain cancel, body live-only —
  are private-knowledge runs, revoked authorization, and a run that lost its
  current owner or session. History preview and `read_session_history` show
  such a turn as incomplete. A run that lost currency (replaced session or
  run) never commits, whatever its outcome.
- One terminal write per run. The conversation service commits outcome,
  history and `onRunSettled` (descriptor + turn in one `.immediate()`
  transaction whose store refuses a turn already terminal) in one synchronous
  `commitRun`; the first writer wins and a run that is no longer current writes
  nothing. For a provisional-delivered run a finalized outcome that reaches the
  commit wins over a stop. Its cancel never blocks on a review; the start route
  and `steer` use `supersedeRun`, which waits at most one watchdog bound. The
  watchdog fallback is the one deliberate exception to "ownership is retained
  until the outer execution settles": its partial commit clears `activeRun`
  while the stuck finalization is still unwinding, so a new turn may start
  beside it. It applies only after the watchdog elapsed; the old run is then
  cancelled and no longer current, so its late result, callbacks, draft and
  cleanup are dropped by the per-run guards, and its runtime session, evidence
  binding and output guards are run-scoped and isolated from the successor. The
  agent route claims terminal ownership (`finalized` or `review_not_finished`)
  before generating report and snapshot and publishing `analysis_completed`,
  which keeps its report metadata; a force stop that finds the run committed
  answers `200` `status: completed` with `outcome: committed` (its normal turn)
  or `outcome: review_not_finished` (the fallback commit). CLI Ctrl-C: the first
  press after the printed text answer is review-only and the turn commits;
  before it, or the second press, the turn aborts through its signal and is not
  saved; a third press, or a turn not unwound within ~2 s, exits 130 (json and
  ndjson print no provisional answer, so their first press aborts); a review
  stop not committed within the watchdog becomes the abort; once the turn is
  committed (`markCommitted()`) Ctrl-C no longer belongs to it. One-shot commands listen to process SIGINT
  only while a turn runs; the REPL routes readline SIGINT to the running turn.
  Only the text renderer receives the provisional answer.
- When no review is sent there is no provisional answer and no review
  progress: the Web agent route broadcasts the finalized body as a plain
  `conclusion` (no `provisional`/`verification`, same owner projection and
  private live-only rule) right after finalization and before report/snapshot
  generation; the conversation publishes `run_completed`; the CLI prints the
  result as usual.
- Finite proof reads issued, immutable execution captures whose original values
  were retained before display or transport truncation. Units and field semantics
  need producer authority;
  display strings, inferred column names, Query Review and restored snapshots
  cannot supply it. The supported predicate catalog is
  `SUPPORTED_DETERMINISTIC_CLAIM_RULES`; general causality is not a finite proof.
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
- A timeline line earns its place only when it says something the tool dispatch
  line could not. Result narration reports an *outcome*, not a shape: a row or
  column count answers "how much came back" when the reader is asking "did that
  work out", so `execute_sql` and `fetch_artifact` speak only when the result is
  empty — the case that forces the model to change approach. Tools whose result
  restates their own dispatch (`invoke_skill`, `submit_plan`,
  `submit_hypothesis`, `list_skills`, …) emit nothing. The same rule trims the
  evidence line and the phase-transition line; full provenance stays in the
  report and the snapshot, which is where it is consulted.
- Native completion and output origin establish delivery state. Error words,
  XML/tool-call examples, answer length or missing headings cannot establish
  provider failure or authorize another report attempt. Unknown native status
  stays unknown; submitted plan/hypothesis obligations and bound report
  assessments are checked separately from evidence and prose semantics.
- Evidence counts must come from a monotone, run-scoped signal. The two
  tool-call logs are not one: they are plan-adherence records, capped and
  trimmed from the front, and `replayPrePlanToolCalls` drops pre-plan calls
  that match no phase and then clears the pre-plan log — so a run that executed
  one query before planning can end with both logs empty. Use
  `countDispatchedToolCalls`, which reads a counter incremented at dispatch and
  reset only by `resetPrePlanToolCallsForNewRun`.
- The detector is deliberately biased toward missing failures rather than
  inventing them. A provider that worked, then died, leaves evidence behind and
  will not be caught — the run wastes its retries as before. That is the
  acceptable direction: a false positive corrupts a legitimate analysis, a
  false negative only costs what today already costs.
- The OpenAI runtime makes at most one recovery call per run, inside the
  original turn budget and deadline, with tools disabled, from the complete
  current-run transcript and never from `previousResponseId`. Its reason is
  chosen in order: `output_limit`, then the declaration request
  (`missing_declaration` or `invalid_declaration`, a declaration-only repair of
  the unchanged body), then `invalid_protocol` (framing failures such as a
  duplicate marker) and `empty_body` as full-answer continuations. A recovery
  that changes the body, drops declared claims, stays invalid or fails restores
  the original candidate.
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
  confidences; never infer it from the presence of text. With no findings the
  number is a fixed baseline (Round 60 printed 35% for every conclusion), so
  user-facing text checks `analysisConfidenceIsGrounded` and shows the
  verified-claim count instead; do not repurpose the field as a verification
  ratio — case evolution and pattern memory still consume it as confidence.
- Claim verification separates "could not verify" from "contradicted". An
  ineligible declaration, and evidence the product could not read, stay
  `not_checked` with warnings; only reference errors, value mismatches, rejected
  propositions and semantic inconsistencies are errors that fail the gate (an
  unmarked display rounding and an undeclared assertion are warnings; see below). The
  unreadable classification is a positive list in `evidenceReadView.ts`
  (`evidence_not_retained` stays an error: it cannot tell eviction from a never
  issued identifier) and must come from an issued mark set by the builder
  (`markUnreadableEvidenceAnchor`), never from a copied reason string. The CLI
  marker comes from `deriveDeliveryVerdict`: `~` is a delivered but unverified
  answer (including `not_required`, whose uncontradicted claims external issue
  triage does not report as uncertain), `!` an unfinished run or a contradicted
  claim.
- Each runtime reserves one no-tool delivery call inside a turn budget above
  one. Admit closeout only after actual investigation exhaustion, under the
  original deadline, selected model, provider, authorization and explicit cost
  limit. A bounded tape contains returned data excerpts and missing/pending
  state, not a complete transcript or verification proof. The new candidate
  retains `partial` / `max_turns`; failed summaries restore the original.
  Count attempted calls and never the SDK's unexecuted cap+1 turn. Turn-limit
  results must not authorize an additional semantic model call in finalization.
  OpenCode's asynchronous observation can overshoot; record its actual count
  and skip a summary if the total allowance is already exhausted.
- `perTurnMs × maxTurns` is an initial deadline, not a wall. The OpenAI runtime
  uses `createProgressAwareRunDeadline`: each returned tool result moves the
  deadline by the slowest recent round, provider output (text, reasoning, tool
  arguments — never bookkeeping events) extends it one per-turn step at the
  deadline, and it never moves back or enters the delivery reserve fixed below
  `*_MAX_RUN_TIMEOUT_MS`. A timeout after returned data spends that reserve on
  the same bounded no-tool closeout as a turn cap, retaining `partial` /
  `timeout`; no returned data or a failed delivery restores the empty result.
  Finalization evidence reads are bounded by the deadline the run hands over,
  so a fixed finalization reserve inside the delivery reserve is never spent
  by the delivery call. When no delivery call ran, finalization funds its one
  no-tool semantic review from the unspent budget: a completed report with a
  usable declaration will make that review and may use everything up to hard
  (OpenAI runs and Claude scene runs), because the report
  quality gate fails whenever the review does not finish (a GLM review of a
  176 KB report outlasted the 600 s reserve with 1157 s still left); any other
  run gets at most the delivery reserve from now. Prefetch shares that
  deadline, so the extension is granted only when the review will run, and
  outer harness timeouts (evaluation replay, the SSE verifier default) can
  now end such a run before hard. A one-shot provider call must not wait for
  a whole non-streamed reply: its headers arrive only after generation, so a
  long reasoning phase hits fetch's default 300 s headers timeout (a GLM
  review first emitted answer text at 496 s) whatever the budget. The OpenAI
  intent and semantic requests therefore stream, leaving the run deadline in
  charge; a body idle timeout still applies. Like turn-limit results, a
  timeout result authorizes no semantic model call. `*_MAX_RUN_TIMEOUT_MS` is
  part of the provider snapshot fingerprint. Claude scene dispatch uses the
  same progress-aware budget (`CLAUDE_MAX_RUN_TIMEOUT_MS`), without a timeout
  delivery call; non-scene Claude runs, Pi, OpenCode and Qoder still use fixed
  budgets.
- The semantic review response degrades per item, never upward. Location ids
  are short (`L<line>.<digest prefix>`) but still resolved exactly per request.
  An item the parser cannot use becomes `unknown`; an `inconsistent` judgment
  keeps its issue even without a location; an unlocatable omission leaves body
  coverage incomplete. Only envelope, body-coverage, report and investigation
  rows still reject the whole response. In the E2E corpus one bad location used
  to discard 9 of 20 reviews outright. Finalization reports only review
  started/finished progress; no heartbeat (it would evict SSE replay entries).
- `analyze_wait_chain` headlines attributable time: other threads' work,
  runnable and uninterruptible segments. Perfetto ends a critical path at IRQ,
  swapper and io_wait wakes, so the external S/I segments it returns are chain
  leaves (`event_wait`). They are reported apart, never recursed into, and never
  read as idle on their own: idle needs the root wait between slices *and* low
  attributable time, while an in-slice chain ending in a peer's event wait is a
  `peer_event_wait` warning (a lock holder waiting on the network). Summing leaves
  as blocking once reported 95% "external critical path" for a thread idly
  waiting for input.
- A semantic `numeric_mismatch` whose located text shows the declared exact
  value rounded at its displayed precision (closed unit mapping, exact rational
  arithmetic, every same-family number in the span must agree) is recorded as
  the warning `semantic_numeric_display_rounding`: the claim stays unverified,
  never contradicted. An undeclared assertion (`semantic_undeclared_claim`) is
  likewise a warning that blocks passing and stays named in the claim line. Once
  the review stopped failing to parse, these two produced `!` on 7 of 8 E2E runs
  in which no value was actually contradicted (34 of 34 mismatches were faithful
  roundings). The review quotes the number itself; the location only selects
  it, and its whole line decides (ranges, signs, comparisons, units). A review
  that quotes the wrong, correct-looking number is its own error; the check
  cannot recover which value the claim meant.
- One invalid claim makes the whole declaration ineligible, which skips the
  semantic review and fails a report's quality gate. The shared native
  declaration completion therefore also repairs a well-framed rejected
  declaration (`repairInvalid`, all five runtimes) in the same single
  delivery turn: the model receives the sidecar-free body and the rejected
  declaration separately, with `claimDiagnostics` naming each failing claim's
  position and schema field (the first failing field per claim, at most 24
  entries, so the prompt asks for a declaration that passes the full
  protocol; a `semantics.numeric` failure adds the closed `subreason`
  `shape|operator|value|unit`). The repair is accepted only if the body is
  unchanged and it keeps every declared claim id and at least as many
  claims; for Pi it replaces the former full-answer correction of such a
  declaration, and for OpenAI its
  `invalid_protocol` continuation. Framing failures keep the existing
  full-answer path.
- Declaration wire forms are canonicalized, never interpreted. The prompt keeps
  teaching the full verbose declaration: in a same-window GLM A/B (9 questions ×
  2 per arm), asking for minified JSON and showing examples without the nested
  `schemaVersion` cut the sidecar by 12 % but produced 5 recoveries instead of 0
  (2 missing declarations) and 14 % fewer declared claims, so a lighter
  declaration is a parser tolerance, not a prompt instruction. The claim-semantics and relation-proposal `schemaVersion`
  (each with one supported value) may be omitted: the item validators accept
  the omission and the valid clone inserts it as the first key, so the
  declaration parser, the legacy JSON branch and every direct item parser
  agree. A `scope.timeRangeNs` bound of valid semantics may be a safe integer
  and is stored as its decimal string. A valid declaration's canonical contract
  and every `analysisDeliveryFingerprint` equal the verbose declaration's
  (`conclusionDeclarationCanonicalization.test.ts`); invalid semantics and
  proposals keep exactly what the model wrote. Protocol detection never reads
  a nested version; the root `schemaVersion`, the root arrays and claim
  `references` stay required.
- Scene runs pace acquisition at the shared registry, after scope and
  lifecycle guards, through `RuntimeAcquisitionPolicy`: a reminder, then a
  first-revision pause lifted by any segment-bearing attempt, and a monotone
  closing window sized from observed model rounds before the acquisition
  limit. Refusals use `action_required`; wording lives in
  `scene-pacing-*.template.md`. `propose_scene_timeline` strips the
  registry-published `planPhaseId`, commits in atomic change groups, emits
  `success`/`planPhaseId` receipts, and marks only actionable rejections as
  policy refusals. A scene run with no committed segment finalizes with
  `success: false` and no scene report; a committed timeline never upgrades a
  native failure.
- Structured facts must be read from a tool result **before**
  `summarizeExternalToolResult` truncates it. `planPhaseId` and `success` are
  appended after the result body, so they are the first casualties of the
  2000-char transport cap: a realistic 13.8 KB skill result loses both, which
  silently degrades plan phase attribution to semantic inference and leaves
  tool success unknown. Pass `resultFacts` from `readToolResultFacts(...)` at
  the runtime call site; `resultText` is a fallback, not a source of truth.
  The same cap hides whether the model ever received a trailing hint such as
  `vendorOverride`. `RunManifest.toolResults` (`runtimeToolResultAudit.ts`)
  answers that: `withRuntimeToolConcurrency`, the outermost shared tool
  boundary after every product wrapper including pacing reminders, records
  per call the tool, the call id when the adapter supplies one (OpenAI, Pi,
  OpenCode), outcome, receipt facts (plan phase id presence only), text size
  before adapter serialization, and for each field in
  `RUNTIME_TOOL_RESULT_AUDITED_FIELDS` whether its serialized key and value sit
  verbatim in that text. It copies no payload values; add a new model-steering
  payload field to that list. It proves the handoff to the runtime adapter,
  not what the provider tokenized: runtime-native caps are outside its view.
- Answer drafts are display-only and capability-gated. A runtime may stream
  answer text before finalization only under `agentRuntime/answerDraftStream.ts`:
  every `answer_token` carries `runId` + a monotone `attempt`, and an
  `answer_segment_reset` revokes shown text at every model response start,
  at a tool call after answer text in the same response, and before any
  continuation, recovery or retry. Only runtimes whose
  `EngineCapabilities.draftAnswerStreaming` is true (Claude, OpenAI) get drafts
  forwarded; Pi, OpenCode and Qoder text never reaches a draft surface. The
  OpenAI runtime streams visible `output_text` after the reasoning filter and
  owner projection (recovery attempts never stream); the Claude bridge resets
  at each main-agent `message_start` and at `tool_use` in answer mode, and only
  `parent_tool_use_id == null` messages can become answer text — sub-agent text
  is a `thought`, never draft or accumulated answer. Each surface creates one
  relay per run through `createAnswerDraftRelay`, which returns none for a
  runtime without the capability and for any private-knowledge or source-access
  session: there the owner projection redacts fragment by fragment, so a
  secret split across tokens could be shown before the whole body is
  redacted; those sessions see only the projected body at finalization. In the
  remaining sessions both the draft projection and the final projection are
  the identity. The relay applies the owner projection, then
  `AnalysisNarrativeStreamProjection`, then coalescing (200 ms / 256 visible
  characters); a reset drops the unflushed buffer, stale-attempt and
  foreign-run events are dropped, and a projection failure, a structurally
  suppressed token, or a throwing delivery (for example a revoked
  authorization on a timer flush) withdraws the draft; nothing escapes the
  relay. The agent route broadcasts drafts `liveOnly`: no SSE id, no ring
  buffer, no durable event store, and disposes the relay the first time the
  run loses currency. The conversation service publishes them as live-only
  `runtime_update` events with no `seqId` and no SSE `id:` line, outside the
  run's replay events, and stops once the provisional answer is out. The CLI never shows drafts. The runtime's
  `conclusion` stays dropped; the provisional or final conclusion replaces the
  draft. Whether pre-tool prose appears depends on the provider: DeepSeek and
  GLM emit none between tool calls.
- A policy refusal is not a tool malfunction. Around thirty MCP handlers answer
  a disallowed call with `{success: false, action_required: '<what to do
  instead>'}`; `isPolicyRefusalResult` recognises them by that field, which no
  genuinely broken tool supplies. Keep them out of aggregate failure-rate
  monitoring: the circuit breaker's remedy is to tell the model to simplify its
  scope, and in a real run one budget refusal plus two plan-phase refusals were
  enough to trip its 60%-of-5 threshold — the system manufacturing evidence
  that the model was failing, then shrinking its room because of it. The
  same-tool watchdog still counts them, because retrying a refused call is a
  loop worth interrupting.
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

- Quick/full shares the same request authorization and evidence-effect rules.
  Lightweight mode may compact result/catalog projections, but does not define
  a separate permission set or remove optional planning and authorized source
  tools merely because the budget is quick.
- `existing_only` denies acquisition tools at the shared handler/registry
  boundary while preserving allowed metadata and retained-artifact reads.
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
first output, tool scheduling, SQL queue/execution timing, one record per model
call (purpose `classification`/`answer_turn`/`declaration_repair`/
`continuation`/`review`, trigger, reported model, reasoning control, duration,
time to first output, body vs declaration characters, provider token counts)
and the finalizer's review decision, without exposing raw SQL, processor
identifiers, secrets, or unbounded provider content. Classification and the
review are recorded for every runtime through the shared transport wrappers;
per-response answer calls are recorded by the OpenAI runtime. The CLI, whose
manifest store is not durable, writes the sealed receipt to
`turns/NNN.runtime-performance.json` and the tool-result handoff receipt to
`turns/NNN.tool-results.json` (skill ids dropped for private runs). Do not
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
before it reaches a runtime. Private issued capabilities are internal options
sidecars, never fields accepted from request JSON.

Important whitelisted examples:

- `selectionContext`
- `analysisMode`
- `traceContext`
- `providerId`
- `referenceTraceId` / comparison context wiring

## Analysis Mode

`options.analysisMode` accepts `fast`, `full`, or `auto`.

- `fast` and `full` choose runtime budgets; neither selects a report, requires a
  plan, grants source access, or silently removes authorized capabilities.
- `auto` follows the shared typed intent's complexity recommendation. Every
  native engine uses its own pinned no-tool intent transport and the same
  registry validation. Unavailable classification uses the explicit fallback,
  not a keyword or deleted scene-classifier routing path.
- Scope, deliverable and evidence access are separate intent dimensions.
  `existing_only` strictly prohibits new evidence acquisition while allowing
  retained artifact reads. `read_new` still requires the request's existing
  authorization. `RuntimeTurnPolicy.preflight` has three levels, and budget is
  not one of its inputs: `none` under `existing_only` gathers nothing; `full`,
  for a resolved `scene_wide` read, also prefetches memory-type context
  (knowledge base, patterns, cases, SQL fix pairs); `trace_facts`, for a bounded
  question or an unavailable classification, still detects the focus app,
  architecture and trace completeness, because a narrow question is
  still asked about a trace the model has never seen. The device vendor is not
  a preflight step: `services/traceVendor/traceVendorResolver.ts` reads it from
  trace `metadata` (never slice names) only when an `invoke_skill` target has a
  vendor override, after that Skill's own queries. `allowAutomaticPrefetch`
  now means the memory tier only. Planning is on demand; an explicitly submitted
  plan remains binding.

Keep scoped selection questions lightweight. A selected slice/range is a scope
signal, not an automatic quick/full decision.

## Provider and Session Invariants

- Logical follow-ups use fresh physical model context. `analysisHistory.ts`
  supplies the single bounded history preview to classification and analysis;
  do not also inject old native SDK history, findings, notes, plans or working
  memory without their turn completeness and scope. Current-run context and
  an explicitly submitted current plan remain intact.
- `read_session_history` is a run-bound historical reader, not evidence acquisition.
  Preserve native partial/unknown status, uncertainties, next steps and complete
  declared locators; never infer same-turn identity from a reused turn index.
  Source-derived history requires its original nonempty authorization fingerprint
  to match the current permitted scope, including bound-reader and restart paths.
  Missing historical scope must not be filled using current authorization.
- Transactions on the shared SQLite files that read before they write run with
  `.immediate()`; `busy_timeout` cannot save a deferred upgrade once another
  process commits (see `openEnterpriseDb`).
- Conversation descriptor and finalized turn writes are atomic and single: the
  store refuses a second terminal write for the same run
  (`conversation_recovery_turn_already_terminal`). Recovery checks
  tenant/workspace/current owner before loading content, validates provider and
  source pins, and settles interrupted runs without recreating their execution.
  Save failure must be observable. Browser logical locators are unambiguous
  owner/backend-bound resource selectors, never authentication capabilities.

- New sessions pin the effective provider/runtime at creation time.
- Existing live sessions keep their pinned provider unless an explicit
  `providerId` override changes it.
- Persisted sessions restore the provider/runtime snapshot before continuing.
  When that snapshot's hash no longer matches the resolved provider (a model,
  base URL or key change), restore passes `withoutProviderBoundEngineState`:
  only the state kept for the old provider (SDK session ids, response history,
  opaque transcripts/directories) is dropped. Notes, plan, hypotheses, flags,
  artifacts and architecture do not depend on the provider and restore as they
  would without the change. No runtime carries native context across turns, so
  the model gets no "context was reset" notice; `continuityBreaks` is an audit
  record only. A live session whose hash changes is still revoked and replaced
  by a new clean session.
- `providerId: null` means use env/default fallback and ignore Provider Manager.
- If a persisted snapshot references a deleted provider, fail with an explicit
  provider-not-found error instead of silently falling back.
- Comparison sessions include both current and reference trace context; do not
  register comparison-only tools when no reference trace exists.
- Conversation keeps a product-owned, memory-only evidence context for the
  logical session and exact trace pair, authorization fingerprint and owner
  scope. Each physical runtime session/run stays unique. Issued bindings survive
  internal option spreads but cannot be recreated by JSON; a missing binding
  cannot fall back to a cached issued store facade.
- Release an evidence binding after finalization and clean up that physical
  session. Scope changes or product disposal revoke the evidence context. Old
  cancellation, callbacks and cleanup must not affect a successor. A bounded
  retained-artifact catalog supplies locators, not rows, coverage or proof.
- Historical report/snapshot reads project stored results without invoking a
  new finalizer or granting new evidence authority. Normal read authorization
  still applies; persisted captures cannot recreate private execution witnesses.

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

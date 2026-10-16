# Backend Rules

Read [Agent Runtime](../../docs/architecture/agent-runtime.md) for current module
ownership, runtime selection, finalization, sessions and concurrency. Read
[Private Analysis Context](../../docs/architecture/private-analysis-context.md)
for source/knowledge authorization, issued evidence and privacy projections.
Use those maintained references for implementation detail; retain these boundaries
when changing code.

## Runtime and Request Boundaries

- Discover runtimes/capabilities from `runtimeKinds.ts` and
  `runtimeDescriptors.ts`, providers separately. `runtimeSelection.ts` owns
  precedence: request profile, recovered session pins, env when unpinned,
  default runtime. New sessions pin the effective provider/runtime; recovery
  restores them, deleted providers fail explicitly, and `providerId: null`
  intentionally selects env/default. Never silently switch a pinned provider.
- Routes stay thin. `AnalysisOptions` additions must also reach the explicit
  `agentRoutes.ts` whitelist; issued private capabilities are internal sidecars,
  never request JSON fields. Generate mirrored frontend contracts.
- Budget (`fast/full/auto`), scope, deliverable, evidence access and source need
  are independent. Typed intent/registry validation owns auto selection, never
  query keywords. `existing_only` forbids acquisition; `read_new` cannot widen
  authorization. Planning/source lookup remain on demand; submitted obligations
  stay binding. Trace-less conversation has no trace preflight or fake identity.
- Shared MCP exposure comes from `mcpToolRegistry.ts` and actual request scope,
  capabilities, evidence effects and reference trace. Quick/full uses the same
  permissions. Comparison tools require a reference; code tools require source
  permission. Do not hardcode tool/scene counts or parallel permission lists.
- Preserve structured tool success/attribution before transport truncation.
  Narration uses projected results and reports an outcome rather than raw
  payloads; localized strings cannot determine authorship, state or phase.
  Policy refusals are not tool malfunctions; repeated refusals still count for
  loop detection. New SSE events need a consumer or an explicit rationale.

## Final Results and Evidence

- Runtime candidate, private finalization context, canonical body, original
  declarations/captures, finite proof, semantic review, reports, CLI artifacts,
  snapshots and live chat are separate surfaces. The product owner extracts
  context from the exact result and finalizes once. Native completion facts
  determine delivery; prose, length, headings or tool examples do not.
- The finalizer alone writes terminal quality state. Missing body or native
  lifecycle/completion faults may block delivery; claim/report/source/identity
  verification failures remain separate annotations, not automatic partial
  delivery or lower finding confidence. Preserve unverified versus contradicted
  and finding confidence versus verification coverage. Do not fabricate a pass.
- Semantic review runs at most once with no tools under the pinned provider,
  original deadline, current owner and authorization. It cannot rewrite the
  body, restart acquisition or extend budgets. A skipped review is explicitly
  unchecked, never equivalent to passed review; source access, report and live
  investigation obligations retain their review requirements.
- Finite proof reads issued immutable captures, original values and
  producer-authoritative units/semantics. Display strings, inferred column
  names, Query Review, model declarations, serialized receipts and restored
  snapshots grant no authority. Preserve the original proposition/references;
  generic causal claims cannot be reduced to numeric equalities to obtain proof.
- Numeric presentation is an untrusted display proposal. Its independent
  captured-cell arithmetic check preserves original values and verifies neither
  subject nor causality. Unchecked bindings, rounding warnings, malformed review
  items and missing coverage cannot become verified claims. Root declaration
  faults and per-entry faults keep their distinct eligibility/validity outcomes.
- Delivery/declaration recovery uses only the original run's remaining budget,
  deadline, provider and authorization. Declaration-only repair preserves body,
  valid entries and original identities; failure restores the accepted candidate.
  Closeout after exhaustion stays partial/max-turns and never authorizes an extra
  semantic call. Record attempted native calls, not an unexecuted SDK cap+1.
- Drafts are capability-gated, live-only and revocable by run/attempt. Reset on
  new response, retry, continuation or tool-after-answer; private projection
  alteration withdraws the draft. Stale events, failed timer projection and
  sub-agent prose cannot become the main answer. Provisional answers use the
  terminal surface's projector; verdicts come only from finalization.
- Stop before provisional delivery cancels fully; stop after it ends review,
  then a second stop forces. Preserve the shared watchdog, single terminal write,
  atomic conversation descriptor/turn commit and current-run checks. A watchdog
  fallback is allowed only in its admitted public/authorized/current-owner cases;
  superseded results, callbacks and cleanup never affect a successor.
- Historical report/snapshot reads project stored results without a new
  finalizer or recreated execution witness. Readability changes must preserve
  report/snapshot/CLI provenance and every affected output contract.

## Sessions, Privacy and Learning

- Every user turn starts fresh native model context; only authorized, typed,
  bounded product history crosses turns. Never persist/resume opaque SDK
  sessions, transcripts or runtime directories. Historical partial/unknown
  status remains explicit. Source history requires its original exact nonempty
  authorization fingerprint, never the current scope filled into an old record.
- Authorization fingerprints exclude index generations; tools fence the run's
  pinned generation separately. Pre-current-format authorization is never
  re-stamped. Conversation evidence context binds the exact trace pair, owner
  scope and authorization; issued bindings survive internal spreads, not JSON.
  Dispose them after finalization and revoke them on scope/product changes.
- Follow [codebase-aware](codebase-aware.md) for explicit selection/consent,
  per-model-dispatch checks, owner versus strict projection and patch authority.
  Budget or model autonomy grants neither access nor provider-send consent.
- Durable cross-session learning requires a run-bound proven-public grant and
  workspace partition. Private/unknown/replay runs write none; every run reads
  the same admitted memory. Unstamped entries cannot become learned authority.
  Curated cases require operator attestation bound to their current content;
  learned cases are retired and grant no provenance.
- Parse persisted JSON/YAML with `utils/storedData.ts`; errors/logs/responses
  must not quote parser input, native errors or causes. Preserve fail-closed
  versus absent/degraded semantics: `StoreUnreadableError` must remain distinct
  from missing/empty records in authorization reads.
  Shared SQLite read-before-write transactions use `.immediate()`.

## Concurrency and Self-Evolution

- `runtimeExecutionGuard.ts` keeps one active runtime per session until outer
  execution settles, except the explicit watchdog terminal fallback above.
  Same-processor SQL remains serialized by one `TraceProcessorSqlWorker`.
  Spawn long-lived processors only through the shared launcher/lifecycle policy;
  owner exit/orphan sweep must prevent leaked processes.
- Tools are exclusive by default. Only registry-declared commutative reads may
  use admitted bounded fair read/write scheduling. Maintainer candidate admission
  is fail-closed, never inferred from credentials, sessions, provider/UI settings
  or benchmark files; the rollback flag cannot admit a candidate. Correctness,
  single-flight/cache retry and cleanup remain active without performance gates.
- Performance/tool handoff receipts are internal, bounded and secret-free.
  Public SSE expansion requires separate privacy/compatibility review. Synthetic
  scoring and unit tests do not establish real-provider performance admission;
  follow [testing](testing.md#runtime-concurrency-and-latency-admission).
- `services/selfEvolution/` owns proposal/replay/overlay lifecycle; its admin
  routes keep separate read/curate/export/apply/revert RBAC and scope. Private
  feedback never enters public proposals, metrics details, bundles or a judge.
  Apply/revert default off and fail closed without enabled policy and persistent
  external user data. Online statistics only propose hypotheses; eligibility
  requires fixed validation + holdout paired replay and human acceptance.
- Contribution export is a local deidentified artifact, not upload/commit/PR.
  External judges require versioned rubric/routing and explicit per-use consent.
  Admin streams stay authenticated, scoped and bounded. Project reconciliation
  reports without rewriting stored content/hash. See
  [Self-Improving Design](../../docs/architecture/self-improving-design.md).

## Implementation and Verification

Use strict TypeScript, typed contracts and existing services; fix generators
rather than generated files. Follow [prompts](prompts.md) and [skills](skills.md)
for external assets, shared SQL structure/identity policies and producer metadata.
Choose affected tiers from [testing](testing.md); broad gates belong at acceptance
boundaries, not after each reversible edit.

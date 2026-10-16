# Codebase-Aware Analysis Rules

Read [Private Analysis Context](../../docs/architecture/private-analysis-context.md)
and [Code-Aware Analysis](../../docs/getting-started/code-aware-analysis.md)
before changing source/knowledge registration, access, symbols, patches or output.
They own the detailed request matrix, consent, continuity, references and lifecycle.

## Selection, Consent and Continuity

- Registration never selects source or grants provider-send consent. Every run
  uses explicit `effectiveAnalysisSelection`; off ignores hidden ids, ids without
  mode mean metadata-only, no ids means off, knowledge selection is independent.
  `metadata_only` sends no source body. Codebase provider-send requires current
  selection/language consent bound to the server-issued disclosure token through
  `authorizeContent`; legacy enable paths cannot bypass that disclosure.
- Consent narrowing/widening and selected-source lifecycle changes restart under
  a new authorization fingerprint. Identical submissions, unselected changes and
  index rebuilds do not. The fingerprint includes authorization/rights/license,
  never generation; old fingerprints are never re-stamped. Source-derived history
  reaches a later prompt only for the same creator under the exact original
  authorization. Missing scope is restricted, never inferred as public.
- Paths go through `PathSecurityGate` and source/knowledge root gates. Native
  picker and local CLI grants bind the registered owner/root/channel, never a
  shared allowlist or raw path supplied by a client. Recheck identity, permissions,
  path filters, extension/size bounds and symlink boundaries on reads.
- Recheck authorization before every interceptable model dispatch, before tool
  access and before delivery; a revoked source already in native context must
  not be sent again. Fence indexed reads against the run's pinned whole generation
  before/after reads and delivery. Incomplete/lost generations refuse, never
  silently return fewer hits. Deletion fences/tombstones every store side first;
  retries finish cleanup without restoring access.
- A live authorized root supports bounded on-demand search/read without an index.
  Depth/budgets come from shared policy and size access, never authorize it.
  Source use comes only from actual calls; incomplete search cannot prove absence.
  Document knowledge requires rights plus provider consent, uses selected
  generation-pinned background tools even under existing-only, and cannot become
  trace evidence. Retired knowledge kinds remain inaccessible, listed/deletable.

## Privacy and References

- Owner analysis may retain source/knowledge quotations in local history, reports,
  exports and snapshots under the owner projector with credentials/canaries
  withheld. Logs, telemetry, opaque provider transcripts and public artifacts use
  the strict projector that replaces private material whole. Management routes
  return metadata, not indexed source bodies or absolute roots.
- Redact whole files before windowing/chunking and after format conversion using
  the shared secret detector. Test both leaks and readable code plus the detector's
  performance tier. Heuristic redaction is not complete; consent, strict projection
  and registered-text echo guards are independent defenses. Fix audience at stream
  construction; synchronous scopes remain exception-safe.
- Private questions/history and drafts follow the private-context persistence
  rules. Never resume opaque native sessions; source-derived product history
  requires the exact original authorization fingerprint and creator.
  Private drafts withdraw at the first projection alteration; delayed credential
  recognition remains an owner-only live residual, never durable authority.
  Private runs read admitted workspace learning but cannot write it.
- Issue safe relative `CodeRef` metadata before delivering source, then admit it
  into the current-run ledger. Capacity exhaustion is explicit. A reference id
  locates source, not current trace occurrence or causality. Knowledge references
  are run-bound background context, not source/trace proof. Preserve Unicode and
  spaced relative paths consistently across readers, citations and outputs.
- `SourceUseDecisionV1` and knowledge-use receipts reflect actual current-run
  deliveries; missing recording is unknown, not zero. Source-claim verification
  is server-owned: invalid/out-of-selection bindings fail, while unbound,
  location-only, source-only and trace-linked remain short of proof. Every Trace
  reference belongs to the same claim. Models cannot declare mechanism proof.
- Parse native declarations before display replacement and keep exact originals
  in private finalization context bound to run, attempt and candidate by issued
  receipt. Never verify rewritten display values or recreate authority from JSON.
  Source/RAG metadata lacking registered codebase identity fails closed.
- Lookup handlers use the shared indexed/on-demand response filters and owner or
  strict projector on all SSE/replay/report/CLI/snapshot/API paths. Preserve native
  completion and verification state even when success is false. Source-tool
  narration uses safe actual outcomes; raw payloads stay outside chat.

## Patch Proposals

`propose_patch` requires prior successful indexed lookup in `CodeLookupLedger`.
Check selected owner/codebase and pinned active generation before reading bodies
or ledger context. On-demand reference ids grant no patch authority; missing,
collected or mixed-codebase context refuses without a path/diff. Target files
must lie within previously looked-up context. Run `git apply --check` in the
codebase root before returning a verified patch; sketch/unverified responses
expose no copyable unified diff. A proposal never applies a patch automatically.

## Verification

Use affected owner tiers from [testing](testing.md). For full source-contract work:

```bash
npm --prefix backend run verify:codebase-aware
npm --prefix backend run test:source-claim-contract
npm --prefix backend run test:report-contracts
npm --prefix backend run verify:code-aware-semantic-delta
```

The first gate needs local Heavy/Light traces and `HighPerformanceFriendsCircle`.
The semantic-delta gate prepares its fixture and proves deterministic no-source,
no-index, indexed, wrong-source rejection and binding/finalizer behavior. Real
provider parity needs separate authenticated runs; missing credentials remain
`REAL PROVIDER NOT AVAILABLE`. A deterministic result is not provider acceptance.

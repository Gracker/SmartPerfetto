# Codebase-Aware Analysis Rules

Use these rules before touching code-aware analysis, codebase registry, source ingestion, symbol resolution, patch proposal, or code-aware report/UI surfaces.

## Product Boundary

- Treat source code as user-owned local material. Do not persist raw source snippets in sessions, reports, exports, telemetry, access logs, or frontend storage.
- Registration makes a codebase selectable; it never attaches source to an analysis automatically. Every run must carry an explicit selection.
- LLM-visible output should prefer `CodeRef` metadata: `referenceId` or `chunkId`, relative `filePath`, `lineRange`, `symbol`, `codebaseId`, `buildId`, `vendor`.
- Raw excerpts are only for explicit user inspection through RBAC-protected endpoints. Frontend excerpt caches must remain in memory and clear on session switch, trace switch, panel unmount, permission revoke, codebase reindex, and codebase delete.
- `metadata_only` must never send source snippets to providers. `provider_send` still requires per-codebase `sendToProvider` consent.
- Trace/Skill/SQL proves occurrence in the current trace. `CodeRef` proves implementation mechanism and cannot raise occurrence or root-cause confidence alone. Mechanism status is `corroborated`, `compatible`, `ambiguous`, or `unverified`.

## Backend

- Register and preview paths through `PathSecurityGate`; never trust a client-supplied root directly.
- A live registered root is sufficient for bounded `search_codebase` and `read_codebase_file`; an active index is optional acceleration, not an analysis prerequisite.
- In full analysis, selected source plus a queryable trace anchor requires bounded lookup or a structured pre-lookup terminal decision. Quantitative-only questions may record `not_needed`; an incomplete search cannot support a source-absence claim.
- On-demand access must enforce the registered path filters, extension/size limits, provider consent, bounded results/line ranges, secret redaction, and the private-output projection. Never return an absolute root.
- Code-aware chunks must carry `codebaseId` and `registryOrigin='codebase_registry'`.
- `app_source`, `kernel_source`, or registry-origin chunks missing codebase metadata must fail closed with `invalid_codebase_metadata`.
- Indexed lookup handlers must pass through `LookupResponseFilter`; on-demand handlers must pass through `OnDemandSourceAccessService` and the same external-surface projection boundary before results leave the runtime.
- SSE/log/snapshot/report/export paths must use projected/sanitized payloads, not raw MCP tool results.
- `SourceUseDecisionV1` is actual current-run MCP state, not model-authored prose. It records selected/queried/used IDs, status, structured reason code, coverage, and safe references. `pending` or `attempted` cannot finish as success.
- `SourceClaimBindingV1` must bind only references returned by the current selected partition to verified trace evidence for the same claim. `corroborated` requires verified trace occurrence plus `provider_send` body/indexed evidence; `metadata_only` is locate-only.
- Initial/replayed SSE, HTML reports, CLI JSON/Markdown/HTML, analysis-result snapshots, and report/snapshot APIs must share the canonical safe projector. The Web receipt is stricter and retains no CodeRefs. Never retain roots, snippets, queries, or free-text binding reasons on these surfaces.
- Keep prompt content in `backend/strategies/` and Skills in `backend/skills/`; do not hardcode code-aware prompting in TypeScript.

## Patch Proposals

- `propose_patch` requires prior successful code lookup in `CodeLookupLedger`.
- On-demand `referenceId` records deliberately do not authorize `propose_patch`; patch targets remain tied to previously looked-up indexed `chunkId` context.
- Reject context from multiple codebases in Phase 1.
- Verify target files are inside previously looked-up context.
- Run `git apply --check` in the target codebase root before returning a `verified` patch.
- `sketch` and `unverified` responses must not expose copyable unified diff text.

## Verification

After backend changes:

```bash
cd backend
npm run typecheck
npm run validate:strategies
npm run validate:skills
npm run test:scene-trace-regression
```

After plugin UI changes:

```bash
./scripts/start-dev.sh
# Stop the dev server after browser verification.
(cd perfetto && tools/node ui/build.mjs)
./scripts/update-frontend.sh
```

Before landing:

```bash
npm run verify:pr
```

For full code-aware validation:

```bash
npm --prefix backend run verify:codebase-aware
npm --prefix backend run test:source-claim-contract
npm --prefix backend run test:report-contracts
npm --prefix backend run verify:code-aware-semantic-delta
```

This gate depends on local Heavy/Light traces plus a local
`HighPerformanceFriendsCircle` checkout. It verifies both no-codebase
trace-only behavior and configured-codebase reports/exports with source-level
`CodeRef` assertions.

`verify:code-aware-semantic-delta` is deterministic local evidence. It must
cover A0 no source, A1/A2 no-index access, A3 indexed access, A4 wrong-source
rejection, quantitative `not_needed`, source-binding strength, and the shared
runtime finalizer. Report real-provider acceptance separately; unavailable
credentials are `REAL PROVIDER NOT AVAILABLE`, not a pass.

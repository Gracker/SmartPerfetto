# Frontend Rules

The plugin lives in `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`.
Use [Agent Runtime](../../docs/architecture/agent-runtime.md) for wire/session
contracts, [Private Analysis Context](../../docs/architecture/private-analysis-context.md)
for audience projections and [product-surface](product-surface.md) for consumers.

## Source and Shipped Bundle

`./start.sh`, Docker and portable packages serve committed `frontend/`; normal
users do not build the Perfetto submodule. After plugin UI changes:

1. Run `./scripts/start-dev.sh` and verify the affected UI in the browser.
2. Run relevant Perfetto UI unit tests/typecheck.
3. Stop HMR, then run `(cd perfetto && tools/node ui/build.mjs)` to create the
   production JS/CSS (HMR does not emit them).
4. Run `./scripts/update-frontend.sh` and `npm run check:frontend-prebuild`.
5. Land source on `fork/main` before publishing the root gitlink and prebuild,
   following [git](git.md).

`scripts/frontend-static-assets.json` owns injected/retired static assets;
regeneration removes stale sibling `frontend/v*` directories. Fix source or the
asset registry, not generated output. Backend contract changes regenerate plugin
`generated/*.ts` through `npm --prefix backend run generate:frontend-types`.

## Streams and Session State

- Use workspace-scoped URLs and authenticated, bounded fetch-based SSE clients;
  keep Authorization/workspace headers and replay cursor semantics. A new event
  must have a consumer. Native EventSource cannot carry these required headers.
- Draft, provisional and final are states of the same answer message. Drafts
  require run/attempt identity, reject stale/foreign events, reset explicitly,
  stay live-only and are never stored. Sub-agent or process commentary is not
  answer text. Provisional delivery replaces the draft and shows verification
  pending; it does not release loading/stop/session ownership before terminal
  completion. Verdict events replace the same message and include report data.
- Errors, cancellation or stream end without a verdict mark delivered text
  unfinished; stored messages cannot remain pending. Conversation uses its
  deterministic run/message identity and persists only terminal results.
- Stop-and-redirect releases the composer only after matching terminal ownership.
  `review_stop_requested` is nonterminal: keep the stream attached; force-stop
  outcomes may commit a verdict or explicit review-not-finished partial result.
  Treat completed/committed outcomes accordingly. A late stop response is a no-op.
- Retry only bounded busy conflicts (`CANCELLATION_IN_PROGRESS`,
  `RUN_ALREADY_ACTIVE`); source/authorization 409s need their existing handling,
  never a retry loop. Context-changing mode/provider edits start a compatible
  fresh backend session and preserve provider/source pins.

## Process and Data Rendering

- Keep process steps structured to render phase groups; identify phase/origin by
  typed fields, never localized wording. Runs without phases render flat.
  Sort within each round: process before answer, then the next question. Keep
  answer text out of process narration; retain report/CLI/snapshot provenance.
- Keep transforms pure and DataEnvelope rendering schema-driven, using producer
  units/metadata. Prefer existing Perfetto conventions and copyable messages;
  avoid nested decorative cards, reduced data density and `transition: all`.
- Owner versus strict projection remains a backend contract; never expose raw
  tool payloads or reconstitute private content from transport fragments.

## Self-Evolution UI

Bind reads to saved backend/credentials and disable mutations while connection
edits are unsaved. Show requested versus effective flags and persistence failures.
Gate, accept/reject, export, apply and revert remain distinct human actions;
backend RBAC/state is authoritative. Preserve lifecycle/diff, reconciliation
identity and explicit external-judge consent. Read
[Self-Evolution](../../docs/getting-started/self-evolution.md) before changing it.

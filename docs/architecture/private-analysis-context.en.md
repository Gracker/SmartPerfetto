# Private Analysis Context Architecture

[English](private-analysis-context.en.md) | [中文](private-analysis-context.md)

SmartPerfetto treats trace evidence, user source code, and external knowledge as
three separate data domains. Source enters a runtime only when the request
selects it explicitly, scope/consent validates, and its registered root remains
available; it does not require an active index. External knowledge still
requires license, consent, and an active generation. Global RAG, persisted
sessions, and cross-session learning must not add either domain implicitly.

## Request Matrix

| Source selection | External RAG selection | Effective behavior |
|---|---|---|
| None | None | Normal trace / Smart Profile analysis with no private retrieval tools |
| Present | None | Exact `codebaseIds` and on-demand source tools; `metadata_only` exposes `CodeRef` only, while `provider_send` also requires registration-level consent |
| None | Present | Exact `knowledgeSourceIds` and active generations; external prose is background, never current-trace evidence |
| Present | Present | Both allowlists apply and validate independently, then share the private projection and report boundary |

Selecting source, external RAG, or a reference trace requires tools unavailable
in the lightweight runtime, so `fast` / `auto` resolves to `full`. Smart Profile
preview only inventories scenes. A deep dive must pass the source mode,
`codebaseIds`, `knowledgeSourceIds`, output language, and preview identity into
the real run unchanged instead of relying on implicit UI-global state.

## Authorization And Continuity

Before session creation, each run resolves registrations in the current scope
and builds a non-secret authorization fingerprint. It covers
tenant/workspace/user, source mode, sorted allowlists, active/index generations,
content fingerprints and revision provenance, and license/consent state. Tool
and run boundaries recompute it. Deletion, reindex, consent revocation, or scope
change therefore fails the old session closed and requires a fresh session.

Private analysis permits only bounded in-process multi-turn continuity; it does
not restore a persisted provider conversation. Raw queries, tool arguments,
retrieved prose, and intermediate reasoning do not enter logs, ordinary session
history, HTML reports, or snapshots. A private request also scrubs private
context snapshots left by an older version before refusing restoration. Final
conclusions, deterministic trace evidence, and bounded provenance pass through
the shared projection before chat, report, CLI artifact, and analysis-result
snapshot surfaces receive them.

## Registration And Deletion Lifecycle

On-demand search/read becomes available as soon as registration succeeds and
the root remains accessible. Indexing is an optional capability for
semantic/symbol lookup and patch flows, not an analysis prerequisite. A moved
or missing registered root fails closed.

Reindex is lease-fenced: it writes a unique staged generation, activates it only
after integrity checks, then removes old generations. Deletion uses the same
lease with a different order:

```text
active -> deleting tombstone -> remove all generations -> remove registration
```

`deleting` immediately revokes provider consent, disconnects the active
generation, and blocks retrieval, reauthorization, and reindex. If physical
cleanup fails, the tombstone remains and repeating DELETE resumes cleanup. This
avoids a partial state where the API reports failure but the old registration
remains usable. Registry, chunk, lease, and API operations validate the
tenant/workspace/user scope. DELETE returns idempotent success for unknown or
out-of-scope IDs so it does not disclose existence.

The Web UI partitions selection by backend URL and request scope and clears it
when credentials change. Unsaved URL/credential drafts in Settings cannot bind
the Codebases management surface, preventing mutation against a new backend
while IDs are saved into the old backend partition.

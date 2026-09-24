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

`fast` / `full` selects a budget independently from authorization for source,
external RAG, or a reference trace. It neither silently removes those capabilities
nor requires a full report. The five native runtimes use tools on demand under
typed scope and evidence-access constraints: `existing_only` prohibits new
acquisition, and `read_new` cannot widen authorization. Conversation shares these
on-demand capabilities without automatically starting another source-analysis
pass. Smart Profile
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
not restore a persisted provider conversation. Raw queries, tool arguments, and
complete retrieval payloads are not additionally written to logs or provider transcripts.
The separate owner projection retains analysis prose, source quotations, and specific
check diagnostics in local history, HTML reports, CLI artifacts, and result snapshots.
Logs and public artifacts retain strict projection; private knowledge, credentials,
authorization, and session revocation remain separate protections. Owner and strict
filter state and budgets are independent: source-echo capacity must not hide owner
results. Audience scopes contain synchronous projection only, and streaming objects
fix their audience when created so display policy cannot escape into log callbacks.

Progress retains model-provided commentary, tool calls, outcome summaries, and phase
status. Failed quality checks retain their prose and specific diagnostic reasons. Before transport truncation,
each runtime issues an in-process receipt from the externally projected tool
result. Shared narration uses its safe facts to describe returned locations,
authorized content, or failures. JSON and model prose cannot forge that receipt.
Source-use status comes from actual calls; mechanism status comes from admitted,
nonempty source bindings and verification, never a model-only strength upgrade.
Reports retain safe relative paths, line ranges, and reference identities for
selected sources.

Personal deployments also use the shared run lease lifecycle for analysis SQL.
When a verified local processor loses native provenance through viewer access
or SQL changes, a run can create a dedicated instance within the existing RAM
budget, retaining current/reference Trace identities. Ordinary HTTP analysis,
smart root runs and CLI keep the same instances through finalization and clean
up on completion, cancellation and late initialization. Stats, viewer attachment
and RPC aliases do not expose dedicated connections. External RPC and unknown
binaries cannot gain provenance through cloning; failed admission does not
silently fall back to the shared processor.

Loading a Trace sends only pure-read SQL (the metadata query stays inside the
direct-projection grammar), so a freshly loaded local-file Trace whose port was
never disclosed, including every CLI run, stays trusted and the run reuses the
shared processor instead of loading the Trace again. Several runs can therefore
share one instance until its first invalidation. Invalidation only downgrades
and advances the epoch: an execution issued before it and completed after it
gains no unit authority, and later runs isolate.

This does not derive units for arbitrary SQL. Bounded questions skip unrelated
prefetch under the actual runtime policy. Full-scene module loading can still
invalidate native provenance; subsequent Skills use their own execution capture
semantics, and raw SQL without authority remains unknown. Tools and module loads
do not each create another processor.

Answers without source dependencies do not need a passed source verdict. Only
the shared finalizer can issue `source: not_applicable`, using the current
captured MCP access scope, no actual source access (or an explicit `not_needed`
decision with an empty ledger), original source-free declarations, and complete
semantic review. Missing scope, failed searches, incomplete review, and malformed
source fields lost during projection do not establish non-applicability. The
source verifier retains `not_checked`; no passed verdict is fabricated.

Final declarations are parsed before display replacement. Original declarations
and verification cell values live only in the in-process finalization context;
public declarations and prose receive a separate safe projection. A private
receipt issued by the shared projector binds the original declaration to the
current run, attempt, display candidate, and claim fingerprints. Deterministic
verification compares original values, never a displayed `CodeRef` against a
raw Trace cell or two redactions as proof of original equality. Missing receipts,
changed candidates, or revoked authorization leave verification unchecked;
serialized results cannot recreate receipts. Protocol fields and enum values
are projected structurally, then text values are serialized safely so source
content or quoted paths cannot corrupt JSON.

Semantic review within the same run uses original text fields from the issued
declaration. Input permission binds the native declaration, display candidate,
and canonical projection; field path, owning declaration identity, and full
text must match. Only source echo replacement for display is bypassed. Private
queries, sensitive paths, canaries, revocation, and size checks still apply.
The review body remains the actual displayed body, never hidden original prose;
a declaration absent from that body cannot pass semantic review.

Finite evidence proof and semantic review remain separate. `captured.cell`
compares the originally declared string, boolean, or null against one captured
cell using strict equality; numbers retain the unit-aware `numeric.cell` rule.
`source.location` compares the declared reference, relative path, and line range
with the current source ledger. It proves only a returned location snapshot and
creates no Trace occurrence proof, behavior, call-chain, or causal evidence.
Source-location verdicts also bind the ledger and source-binding fingerprints;
changing either invalidates the previous verification.
An exact `semantics.source` does not require a duplicate `sourceClaimBindings`
entry. An explicit binding for that claim must still be unique and reference
the same location. Malformed entries anywhere in the binding array cannot be
filtered into an absent declaration. Omitting a binding does not pass the
mechanism verifier; location facts still require complete body semantic review.

Raw SQL units also require execution evidence. Only an owned processor whose
binary and documentation pins match, and which has not been exposed through
uncontrolled SQL/RPC or a disclosed native port, can issue field metadata for a
proven direct projection. Currently only formal `DURATION` columns provide ns;
aliases and `*` expansion must match the actual output and original schema.
Parsed scalar expressions retain their output positions, allowing other direct
columns to keep their lineage without assigning units to computed columns.
Aggregates, grouping and joins remain outside this row correspondence proof.
The queue checks
provenance before and after execution and binds units to the SQL and result with
an in-process receipt; JSON field metadata grants no authority. Invalidated
processors still execute queries, but recreating a name or identical DDL cannot
restore their native provenance.

When the formal schema has exactly one `ID` column and the query returns that
original column, the native execution receipt also retains its relation, row ID
and stable schema fingerprint. Preparing a duration reference preserves this
companion identity within the existing read budgets. A finite proof projects
only the rows containing its actual operands. JSON, display fields and generic
capture arguments cannot reissue this identity. Acceptance can match the same
Trace, relation, original ID and independently resolved schema fingerprint to
the actual event without another process query or clock inference. Missing IDs,
multiple formal IDs, computed IDs and unavailable provenance remain unknown.

A logical Conversation session may retain in-process artifacts and original
captures while every physical session/run ID remains unique. A privately issued
binding fixes the exact trace pair, authorization fingerprint and owner scope;
JSON, historical prose and snapshots cannot recreate that capability. The bounded
model catalog only locates retained artifacts and carries neither rows nor
verification authority. Authorization/scope changes and product disposal revoke
the context. Old cancellation, late callbacks and cleanup cannot affect a later
run. Each finalization read view fixes its admitted capture set.

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

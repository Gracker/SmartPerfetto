# Private Analysis Context Architecture

[English](private-analysis-context.en.md) | [中文](private-analysis-context.md)

SmartPerfetto treats trace evidence, user source code, and document knowledge
bases as three separate data domains. Source enters a runtime only when the
request selects it explicitly, scope/consent validates, and its registered root
remains available; it does not require an active index. A document knowledge
base is its own SQLite FTS document store (not RAG chunks): it is searchable
only when the request selects it, its rights are acknowledged, provider-send
consent is granted and it has an active generation; its license field is the
owner's own statement, not an admission condition. Public RAG corpora,
persisted sessions, and cross-session learning must not add either domain
implicitly.

## Request Matrix

| Source selection | Knowledge selection | Effective behavior |
|---|---|---|
| None | None | Normal trace / Smart Profile analysis with no private retrieval tools |
| Present | None | Exact `codebaseIds` and on-demand source tools; `metadata_only` exposes `CodeRef` only, while `provider_send` also requires registration-level consent |
| None | Present | Exact `knowledgeSourceIds`, read through `search_knowledge` / `read_knowledge_section` at each base's pinned generation; knowledge is background, never current-trace evidence |
| Present | Present | Both allowlists apply and validate independently, then share the private projection and report boundary |

The selection is resolved once, after session or conversation options are
merged (`effectiveAnalysisSelection`): an explicit `codeAwareMode: off` drops
`codebaseIds` (hidden ids authorize nothing and no longer return 400); ids
without a mode mean `metadata_only`; without ids the mode means nothing and is
`off`; knowledge sources are independent of the source mode. Authorization,
registry reads, the fingerprint, the memory partition, run options and session
persistence all consume that one result.

`fast` / `full` selects a budget independently from authorization for source,
knowledge bases, or a reference trace. It neither silently removes those capabilities
nor requires a full report. The five native runtimes use tools on demand under
typed scope and evidence-access constraints: `existing_only` prohibits new
acquisition, and `read_new` cannot widen authorization. Conversation shares these
on-demand capabilities without automatically starting another source-analysis
pass. Smart Profile
preview only inventories scenes. A deep dive must pass the source mode,
`codebaseIds`, `knowledgeSourceIds`, output language, and preview identity into
the real run unchanged instead of relying on implicit UI-global state.

## Consent Model

Knowledge and source consent differ because their units of authorization
differ. A document knowledge base has no path filters: the whole registered
folder is what a grant covers, so provider-send consent is a boolean, given at
registration or changed afterwards by the Web UI switch (which shows the
disclosure text before granting), `PATCH /api/rag/knowledge/:id/consent`, or
`smp knowledge consent <id> --enable|--disable`, all one registry operation. A
codebase has a path selection and languages that can change under a grant, so
sending its text takes a server-issued disclosure token: `authorizeContent`
grants exactly the scope the caller was shown and refuses once it changed. Both
share the explicit per-run selection, the authorization fingerprint, the
authorization check before every model request, and the owner and strict
projections.

## Authorization And Continuity

Before session creation, each run resolves registrations in the current scope
and builds a non-secret authorization fingerprint. It covers
tenant/workspace/user, the effective source mode, sorted allowlists, selection
scope and grant revisions, lifecycle, and license/consent state; it holds no
index generation (each index tool checks the generation its run pinned). Tool
and run boundaries recompute it, and so does every model request a runtime can
intercept, because a native loop resends earlier tool results with each request:
a change ends the run with `analysis_context_changed_restart_required` instead of
only refusing later reads. Deleting a selected source, an actual consent
or scope change, or a scope change therefore fails the old session closed and
requires a fresh session. Repeating the same consent, an equivalent selection,
or a change to an unselected source leaves it unchanged.

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
or SQL changes, a run can create a dedicated instance under the existing RAM
admission policy, retaining current/reference Trace identities. Ordinary HTTP analysis,
smart root runs, CLI and attached-Trace Conversation keep the same instances through finalization and clean
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

Omitted or `executionContext=working` retains existing workspace SQL semantics.
Identity resolution, Skills and probes can still invalidate that instance through
module loading. Skills then use their own execution-capture semantics; missing
raw-SQL unit authority remains unknown. A relation name alone cannot reroute a
query: a workspace may contain a different table with the same name.

Explicit `original_trace` selects a separate restricted native reader within the
run. Only single pinned-prelude relation queries fully recognized by the current
parser qualify; JOINs, subqueries, CTEs, workspace tables and INCLUDE are refused.
The original SQL runs once without rewriting, and its actual result is captured;
new authority is never attached to an old workspace result. Pre-dispatch refusal
creates no execution review, capture or artifact. Actual SQL errors and worker
exceptions without an actual result retain failed execution and unknown execution,
respectively. Cancellation or revocation is never recast as ordinary refusal.

This path requires an application-materialized Trace. Successful CLI copies and
completed HTTP upload renames issue private input grants bound to the service and
current registration. Only the first successful actual load, with matching file
identity and SHA checks, can issue a loaded-source pin. Ordinary path registration,
old instances and JSON recovery cannot backfill it. Children use the same input
under the application's immutable lifecycle and check its pin, binary/docs pins,
authorization, current owner and Trace pair before and after work. Absence of
private source context does not forbid an authorized Trace read; factory-fence
origin and these permissions are separate checks. Model fields, copied tokens and
serialization cannot grant this capability.

Each run lazily creates at most one private native reader per distinct Trace and
shares its initialization. Its namespace is separate, its port is private, and a
failed reader is neither restarted nor replaced within the run. Creation follows
strict instance-count admission and existing RAM policy; unknown RSS is no exact
free-memory guarantee. Missing capacity or provenance never falls back to the
workspace or causes repeated loads. Lease/late-initialization cleanup preserves
user Trace files; requesting release and observing native exit remain separate.
The source guarantee concerns application-controlled materialization, not malicious
same-UID changes to the application's private directory.

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

Experimental document submission preserves original tool arguments, `documentJson`,
the compiled body and the whole original canonical payload, including invalid
items. They remain in a current-run private submission and finalization context;
public tool events, logs and progress contain only pending/rejected summaries.
JSON, HTML and declaration examples in the body remain prose and are never scanned
back into declarations. The three original strings and the display body are bound
exactly; legitimate privacy replacements also require an issued exact-input
projection chain. Hashes alone grant no authority. Normal SDK cleanup preserves a
handed-off submission; product cancellation, revoked authorization or finalization
disposal revokes it. Persisted authorship cannot restore this capability.

V2 mixed-response companion text stays in the current run's private SDK context
and bounded temporary buffer. Retained arguments and companion text share a
1 MiB limit. Each component records any content lost to retention limits.
Issued final-submission material comes from the unique tool document. Internal
material observations retain fixed-field counts and statuses, with distinct
markers for null, unknown and unretained material. Cancellation and late events
remain bound to their run, attempt and request.

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
Source is not a finite proof. `source_claim_verifier@2` computes each
source-dependent claim's standing on the server (`invalid`, `unbound`,
`location_only`, `source_only`, `trace_linked`) and matches every source location
written in the body against this run's issued references. Only `invalid` (an
unissued or out-of-selection reference, or a Trace ID not belonging to that
claim) fails the answer; weaker standings stay unverified. A claim whose answer
cites it only at lines the run did not read stays `location_only`, whatever else
it read. Even `trace_linked` means only a read and cited body plus same-claim
Trace evidence: it proves no behavior,
call chain, or causality, and complete body semantic review still applies.
Malformed entries anywhere in the binding array cannot be filtered into an
absent declaration.

Raw SQL units require execution evidence from an owned processor with matching
binary/documentation pins and trusted native provenance. Direct `DURATION`
columns provide ns; aliases and star expansion must match actual output and the
formal schema. Existing quantity-expression rules also support selected duration
conversions, timestamp differences, MIN/MAX clipping in the native timestamp
scale, and count units. A computed representation unit does not establish a
native row, clock, subject or causality. Unsupported expressions remain unknown;
column names never determine units. The queue checks provenance before and after
execution and binds semantics to the SQL and actual result with an in-process
receipt. JSON metadata grants no authority. SQL/module changes and port exposure
only downgrade provenance; recreating a name or identical DDL cannot restore it.
Previously completed immutable captures remain readable.

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

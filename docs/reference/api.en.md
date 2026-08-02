# API Reference

[English](api.en.md) | [中文](api.md)

The default backend address is `http://localhost:3000`. Set
`SMARTPERFETTO_BACKEND_PORT` to use a different backend port. If
`SMARTPERFETTO_API_KEY` is set, protected APIs require:

```http
Authorization: Bearer <token>
```

`SMARTPERFETTO_API_KEY` is the deployment-operator credential. Enterprise
users should use durable API keys with explicit roles and scopes.

## OIDC Authentication

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/oidc/login` | Create signed state, nonce, and PKCE values, then redirect to the OIDC provider |
| `GET` | `/api/auth/oidc/callback` | Validate the callback, establish the HttpOnly session cookie, and redirect to the frontend |
| `GET` | `/api/auth/session` | Return login state, read-only user/tenant/workspace, roles/scopes, expiry, and the CSRF token |
| `POST` | `/api/auth/logout` | Validate CSRF for the cookie session, revoke it, and clear the cookie |

The OIDC session is the sole identity authority. Browser requests must use
`credentials: include`, and mutations also require `X-CSRF-Token`. Browser
tenant/workspace headers cannot override the session binding. Built-in personal
workspace mode has no workspace switch, and equal display names across users
do not share internal workspace IDs or data.

## Health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Public minimal liveness status and version |
| `GET` | `/api/runtime-health` | Authenticated `runtime:manage` diagnostics for runtime, model, and AI policy |
| `GET` | `/api/debug` | Authenticated `runtime:manage` development diagnostics and legacy API snapshot |

`/api/runtime-health` returns top-level `aiPolicy` and mirrors `aiEnabled` plus
`disabledReason` under `aiEngine` so the frontend and CLI can decide whether
model-backed analysis is allowed. When `aiPolicy.aiEnabled=false`, trace
upload/read, SQL, reports, Provider configuration/switching, and deterministic
Skills remain available; model analysis, resume, scene reconstruction start,
Provider tests, and LLM Skill steps return `403`:

```json
{
  "success": false,
  "code": "AI_DISABLED",
  "retryable": false,
  "feature": "agent_analyze",
  "aiPolicy": {
    "schemaVersion": 1,
    "aiEnabled": false,
    "source": "env"
  }
}
```

## Application Updates

Base path: `/api/application-update`. Both endpoints require authentication and
`runtime:manage`; application update state is independent from AI
runtime/provider health.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | Return cached status; an expired cache starts a non-blocking background check |
| `POST` | `/check` | Explicit check; requests within 30 seconds reuse cache and concurrent checks are coalesced |

The v1 response includes the current distribution, channel, version, commit,
target, and signing mode, plus the candidate release, source, check time,
stale/LKG state, and a backend-authored distribution-specific upgrade action.
The service calls only fixed HTTPS endpoints for SmartPerfetto on GitHub, the
npm registry, or Docker Hub; clients cannot supply a URL. With
`SMARTPERFETTO_UPDATE_CHECK=off`, it returns `disabled` without network access.

## Trace Management

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/traces/health` | Trace service health |
| `POST` | `/api/traces/upload` | Upload a trace file with field name `file` |
| `GET` | `/api/traces` | List known traces |
| `GET` | `/api/traces/stats` | Trace statistics |
| `POST` | `/api/traces/cleanup` | Cleanup trace data |
| `POST` | `/api/traces/register-rpc` | Register an external trace_processor RPC endpoint |
| `GET` | `/api/traces/:id` | Trace metadata |
| `DELETE` | `/api/traces/:id` | Delete a trace |
| `GET` | `/api/traces/:id/file` | Download a trace file |

Upload example:

```bash
curl -F "file=@trace.pftrace" http://localhost:3000/api/traces/upload
```

The list returns the newest 100 records by default. Use `limit=1..200` and the
opaque `nextCursor` from the previous response:

```http
GET /api/traces?limit=100&cursor=<nextCursor>
```

Clients must not parse or synthesize cursors. In `/api/traces/stats`,
`traces.metadataCount` is the total visible persisted trace count for the
workspace, while `traces.count` is the number active in the current process.

## Workspace-scoped APIs

New integrations should prefer workspace-scoped paths. When enterprise or
multiple workspaces are not enabled, the legacy global paths remain available
for local and compatibility flows.

| Base path | Purpose |
|---|---|
| `/api/workspaces/:workspaceId/traces` | Workspace-scoped trace upload, list, delete, and download |
| `/api/workspaces/:workspaceId/reports` | Workspace-scoped report read, export, and delete |
| `/api/workspaces/:workspaceId/agent` | Workspace-scoped agent analysis, SSE, turns, and feedback |
| `/api/workspaces/:workspaceId/providers` | Workspace-scoped Provider Manager profiles |
| `/api/workspaces/:workspaceId/analysis-results` | Analysis-result snapshot list, read, and update |
| `/api/workspaces/:workspaceId/windows` | Frontend window heartbeat and active-window state |
| `/api/workspaces/:workspaceId/comparisons` | Multi-result comparison create, read, stream, and export |
| `/api/workspaces/:workspaceId/trace-config` | Side-effect-free trace config proposals |
| `/api/workspaces/:workspaceId/skill-packs` | Local-directory Skill Pack preview, install, enable/disable, and remove |
| `/api/workspaces/:workspaceId/batch-traces` | Deterministic Skill batch over workspace trace sets, report export, snapshot promotion, and comparison bridge |

## Skill Pack API

Base path: `/api/workspaces/:workspaceId/skill-packs`

All endpoints require `runtime:manage`. The first release accepts only a local
directory selected by an admin. Remote URLs, auto-sync, and archive unpacking
are not supported. Install reruns preview, then copies only manifest-declared
Skill YAML, SQL fragments, and docs into
`backendDataPath('skill-packs', tenantId, workspaceId, packId, version)`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | List installed Skill Packs for the current workspace |
| `POST` | `/preview` | Validate a local directory and return manifest, Skill IDs, fragments, docs, and errors without writing managed storage |
| `POST` | `/install` | Rerun preview, copy declared assets, and write `skill_registry_entries` metadata |
| `PATCH` | `/:packId` | Send `{ "enabled": true | false }` to enable or disable an installed pack |
| `DELETE` | `/:packId` | Disable the pack and remove only its managed copy; built-in Skills are untouched |

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/skill-packs/preview \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{ "sourcePath": "/absolute/path/to/local-skill-pack" }'
```

Each `smartperfetto-skill-pack.json` asset must declare `kind`, `path`,
`sha256`, and `sizeBytes`. Allowed roots are `atomic/`, `composite/`, `deep/`,
`system/`, `comparison/`, `modules/`, `pipelines/`, `fragments/`, and `docs/`.
`strategies/`, `vendors/`, `custom/`, hidden files, symlinks, and executable
extensions are rejected. Skill IDs and SQL fragment keys cannot override
built-in content.

## Batch Trace API

Base path: `/api/workspaces/:workspaceId/batch-traces`

The first release executes a deterministic YAML Skill batch synchronously within
the request. Inputs must be existing `traceId` values in the current workspace;
uploading trace sets still goes through the workspace trace upload API. This API
does not call an LLM, execute raw batch SQL, create remote workers, provide a
browser UI, or automatically write analysis-result snapshots. Results enter
comparison only after explicit promotion.

Synchronous HTTP create accepts at most 20 traces by default, configurable with
`SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES`. A process can run at most 2
HTTP batch creates at once by default, configurable with
`SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS`; excess requests return
`429` with `batch_trace_api_busy`. Offline CLI batch trace count remains governed
by `SMARTPERFETTO_BATCH_TRACE_MAX_TRACES`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `POST` | `/` | `agent:run` | Create a batch run with `{ skillId, traceIds, params?, maxConcurrency? }` |
| `GET` | `/` | `report:read` | List batch runs for the current workspace |
| `GET` | `/:runId` | `report:read` | Read one batch run |
| `GET` | `/:runId/report/export` | `report:read` | Export an HTML batch report |
| `POST` | `/:runId/promote-snapshots` | `analysis_result:create` | Promote selected completed per-trace results into analysis-result snapshots |
| `POST` | `/:runId/comparisons` | `comparison:create` | Promote snapshots when needed, then create a normal analysis-result comparison |

Create example:

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/batch-traces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "skillId": "startup_analysis",
    "traceIds": ["trace-a", "trace-b"],
    "params": { "package": "com.example" },
    "maxConcurrency": 2
  }'
```

The response is `{ "success": true, "run": BatchTraceRunV1 }`. `run.perTrace`
preserves per-trace completion/failure state, diagnostics, metrics, and evidence
envelope IDs. `run.aggregate` preserves statistics, outlier ordinals, missing
metric limitations, and failed-trace limitations. Standard startup / scrolling
metrics are mapped to comparison metric keys; unmapped numeric values remain
batch-local metrics.

Promotion selects all completed traces by default, or accepts
`{ "ordinals": [0, 2] }`. Failed or unsupported per-trace results are never
promoted. The comparison bridge accepts
`{ "ordinals": [0, 1], "baselineSnapshotId": "...", "metricKeys": ["startup.total_ms"] }`;
when `ordinals` is omitted it uses all completed results. The comparison is
stored through the normal `/api/workspaces/:workspaceId/comparisons` product
path, not a private batch-only comparison format.

## Trace Config Proposal API

Base path: `/api/workspaces/:workspaceId/trace-config`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/proposals` | Generate a deterministic Android trace config proposal from natural language |

The endpoint requires `trace:write`, but it does not call an LLM, ADB, or
tracebox, and it does not record the device. `proposal.config.textproto` is
rendered by the same renderer used by `smp capture config`.

```bash
curl -X POST http://localhost:3000/api/workspaces/default-workspace/trace-config/proposals \
  -H "Content-Type: application/json" \
  -d '{
    "request": "debug startup first frame jank",
    "app": "com.example.app",
    "durationSeconds": 10,
    "categories": ["dalvikviktime"]
  }'
```

Example response:

```json
{
  "success": true,
  "proposal": {
    "schemaVersion": 1,
    "source": "deterministic",
    "target": "android",
    "preset": "startup",
    "confidence": "high",
    "command": {
      "config": ["smp", "capture", "config", "--preset", "startup"],
      "capture": ["smp", "capture", "android", "--preset", "startup"]
    }
  }
}
```

## Agent v1 Main Path

Base path: `/api/agent/v1`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/analyze` | Start analysis |
| `POST` | `/sessions/:sessionId/runs` | Start a new run in an existing session |
| `GET` | `/:sessionId/stream` | Subscribe to SSE |
| `GET` | `/runs/:runId/stream` | Subscribe to SSE by run id |
| `GET` | `/:sessionId/status` | Poll status |
| `GET` | `/:sessionId/turns` | Get multi-turn history |
| `GET` | `/:sessionId/turns/:turnId` | Get a single turn |
| `POST` | `/resume` | Resume an existing session |
| `POST` | `/:sessionId/respond` | Continue an awaiting-user session |
| `POST` | `/sessions/:sessionId/respond` | Session-scoped alias for `respond` |
| `POST` | `/:sessionId/cancel` | Cancel the exact `runId` |
| `POST` | `/:sessionId/interaction` | Record UI interaction |
| `GET` | `/:sessionId/focus` | Query focus state |
| `GET` | `/:sessionId/report` | Fetch generated report |
| `DELETE` | `/:sessionId` | Delete a session |
| `POST` | `/:sessionId/feedback` | Submit feedback into the self-improving path |
| `POST` | `/:sessionId/external-issue/opportunity` | Detect external-feedback signals from an exact persisted run |
| `POST` | `/:sessionId/external-issue/review` | Run source-pinned, no-tool Agent triage or return a safe fallback with a short-lived server attestation |
| `POST` | `/:sessionId/external-issue/draft` | Revalidate the provider pin, server review attestation, user answers, and sensitive-data confirmation, then create an unsubmitted GitHub draft |
| `POST` | `/scene-detect-quick` | Quick scene detection |
| `POST` | `/teaching/pipeline` | Rendering pipeline teaching |
| `GET` | `/sessions` | Session catalog |
| `GET` | `/logs` | Agent logs, gated by feature flag |

The workspace-scoped agent base is `/api/workspaces/:workspaceId/agent`, with
the same child paths as the table above. `/api/agent/v1` still exists and is
tracked by legacy telemetry with a migration target.

### Agent-Assisted External Issue

All three M10 POST routes require `agent:run`, and the session owner must match
the request context. Public requests pin one completed run:

```json
{
  "runId": "run-id",
  "runManifestId": "manifest-id",
  "resultSnapshotId": "optional-snapshot-id"
}
```

`opportunity` returns `external_issue_opportunity@1` with deterministic
signals. `review` runs only after explicit user action and returns
`external_issue_review@1`; Agent output may reference only claim, finding,
evidence, and Skill ids present in those signals. A source-provider snapshot
mismatch or unsupported runtime returns `source=deterministic_fallback`, whose
candidates can request verification but cannot claim an Agent recommended a
report.

`draft` additionally requires the full prior review, `candidateId`, at most two
`answers`, and `sensitiveDataReviewed=true`. It returns
`external_issue_draft@1`, `notSubmitted=true`, and an HTTPS browser URL. It
accepts no GitHub token and makes no GitHub API call.
`securitySensitive=true` returns `PRIVATE_SECURITY_ADVISORY_REQUIRED`.
Private/code-aware sources fail closed. See
[Agent-Assisted GitHub Feedback](../getting-started/agent-assisted-feedback.en.md)
for the user and privacy contract.

Start analysis:

```bash
curl -X POST http://localhost:3000/api/agent/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "trace-id",
    "query": "Analyze scrolling jank",
    "options": {
      "analysisMode": "auto"
    }
  }'
```

The response returns `sessionId`. Then subscribe:

```bash
curl -N http://localhost:3000/api/agent/v1/<sessionId>/stream
```

Cancellation must include the exact `runId` returned by `/analyze`. A missing,
unknown, or no-longer-active run cannot trigger a session-level runtime abort:

```bash
curl -X POST http://localhost:3000/api/agent/v1/<sessionId>/cancel \
  -H "Content-Type: application/json" \
  -d '{"runId":"<runId>"}'
```

The cancellation terminal may return before the runtime has fully settled. A
new run in the same session receives `409 CANCELLATION_IN_PROGRESS` until the
cancelled runtime exits, preventing old-run cleanup or continuity state from
affecting the replacement run.

The terminal `analysis_completed` event can include `analysisReceipt` and
`uiActionProposals`. `uiActionProposals` only
contains safe UI proposals derived from DataEnvelope evidence and column click
metadata, such as navigating to a time range, opening an evidence table, or
pinning evidence. Clients must execute them only after an explicit user click;
they are not automatic commands.

Dual-trace comparison requires `referenceTraceId`, and it must be different from `traceId`.

Smart analysis uses the same `/analyze` endpoint. The first request should usually run only the scene inventory:

```json
{
  "traceId": "trace-id",
  "query": "/smart",
  "options": {
    "analysisMode": "auto",
    "preset": "smart",
    "smartAction": "preview"
  }
}
```

When the preview completes, the `analysis_completed` payload includes `smartScenePreview.reportId` and the selectable scene ranges. Submit the selected scope with another `/analyze` request:

```json
{
  "traceId": "trace-id",
  "query": "/smart",
  "options": {
    "analysisMode": "auto",
    "preset": "smart",
    "smartAction": "analyze",
    "smartSelection": {
      "scope": "scene_types",
      "sceneTypes": ["scroll", "inertial_scroll"],
      "reportId": "scene-report-id"
    }
  }
}
```

`smartSelection.scope` accepts `all`, `scene_types`, and `scene_ids`. Smart analysis currently rejects `referenceTraceId` and existing-session continuation runs.

## Scene Reconstruction

Base path: `/api/agent/v1`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/scene-reconstruct/preview` | Check cache and estimate cost without starting heavy work |
| `GET` | `/scene-reconstruct/report/:reportId` | Fetch a persisted SceneReport |
| `POST` | `/scene-reconstruct` | Start scene reconstruction |
| `GET` | `/scene-reconstruct/:analysisId/stream` | Subscribe to scene reconstruction SSE |
| `GET` | `/scene-reconstruct/:analysisId/tracks` | Fetch tracks |
| `GET` | `/scene-reconstruct/:analysisId/status` | Poll status |
| `POST` | `/scene-reconstruct/:analysisId/deep-dive` | Deep-dive one scene |
| `POST` | `/scene-reconstruct/:analysisId/cancel` | Cancel |
| `DELETE` | `/scene-reconstruct/:analysisId` | Delete |

This capability is controlled by `FEATURE_AGENT_SCENE_RECONSTRUCT`.

## Skill API

Base path: `/api/skills`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List Skills |
| `GET` | `/:skillId` | Skill detail |
| `POST` | `/execute/:skillId` | Execute a Skill |
| `POST` | `/analyze` | Detect and run a Skill |
| `POST` | `/detect-intent` | Intent detection |
| `POST` | `/detect-vendor` | Vendor detection |

Admin path: `/api/admin`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/skills` | Admin Skill list |
| `POST` | `/skills` | Create a Skill |
| `PUT` | `/skills/:skillId` | Update a Skill |
| `DELETE` | `/skills/:skillId` | Delete a Skill |
| `POST` | `/skills/validate` | Validate a Skill |
| `POST` | `/skills/reload` | Reload Skills |
| `POST` | `/strategies/reload` | Reload strategies |
| `GET` | `/self-improve/metrics` | Self-improvement metrics |

## Self-Evolution Admin API

Base path: `/api/admin/self-evolution`

Every endpoint uses standard SmartPerfetto authentication and request scope.
Proposals, operations, overlays, and reconciliation results are isolated by
`tenantId + workspaceId`.

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| `GET` | `/overview` | `self_evolution:read` | Effective/requested config, persistence, proposal/overlay/operation counts, generation, reconciliation, and L2 status |
| `GET` | `/proposals` | `self_evolution:read` | List proposals in the current workspace |
| `GET` | `/proposals/:proposalId` | `self_evolution:read` | Proposal, latest gate attempt, and applied revisions |
| `POST` | `/operations/curation` | `self_evolution:curate` | Explicitly start one bounded curation run; returns `202 {operationId}` |
| `GET` | `/operations/:operationId/events` | `self_evolution:curate` | SSE replay plus live progress; closes after a terminal event |
| `POST` | `/proposals/:proposalId/gate` | `self_evolution:curate` | Run fixed validation + holdout paired evaluation |
| `POST` | `/proposals/:proposalId/accept` | `self_evolution:curate` | Human-accept a proposal that passed its gate |
| `POST` | `/proposals/:proposalId/reject` | `self_evolution:curate` | Human-reject a proposal |
| `POST` | `/proposals/:proposalId/export` | `self_evolution:export` | Create a local deidentified contribution bundle; never uploads |
| `POST` | `/proposals/:proposalId/apply` | `self_evolution:apply` | Apply an accepted proposal; body requires a unique `actionId` |
| `POST` | `/proposals/:proposalId/revert` | `self_evolution:revert` | Revert an applied proposal; body requires a unique `actionId` |
| `GET` | `/overlays` | `self_evolution:read` | Overlay registry entries for the current workspace |
| `GET` | `/reconciliation` | `self_evolution:read` | Latest upgrade reconciliation report |

The control plane is off by default. `SELF_EVOLUTION_ENABLED=true` is required
for curation/gate/accept/reject/export. Apply/revert additionally require
`SELF_EVOLUTION_APPLY=true` and a writable user data root outside the package.
Unsatisfied dependencies return `503` and stay fail-closed; operation capacity
returns `429`; state conflicts return `409`. Browser clients must consume SSE
with `fetch()` so Authorization and workspace headers remain attached.
Each tenant/workspace may run at most four curation operations concurrently
and retain 20 operations; one operation may run for at most five minutes.
Exhausting either scoped or process-wide capacity returns `429`.

In the default RBAC matrix, Analysts have only `self_evolution:read`;
Workspace Admins and Org Admins have curate/export/apply/revert. The deployment
operator bootstrap credential `SMARTPERFETTO_API_KEY` defaults to `org_admin`
with `*`; enterprise API keys, SSO, and other production identities continue
to resolve least-privilege roles and scopes from durable bindings. See
[Self-Evolution Usage And Acceptance](../getting-started/self-evolution.en.md)
for enablement, control-plane order, fail-closed cases, and restart acceptance.

## Provider Manager API

Legacy base path: `/api/v1/providers`. New integrations should prefer
`/api/workspaces/:workspaceId/providers`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List provider profiles |
| `GET` | `/templates` | Get built-in provider templates |
| `GET` | `/effective` | Get the effective provider/runtime |
| `GET` | `/:id` | Get one provider |
| `POST` | `/` | Create a provider |
| `PATCH` | `/:id` | Update a provider |
| `DELETE` | `/:id` | Delete a provider |
| `POST` | `/deactivate` | Deactivate the active provider and return to system default |
| `POST` | `/:id/activate` | Activate a provider |
| `POST` | `/:id/runtime` | Update runtime pinning |
| `POST` | `/:id/rotate-secret` | Rotate provider secret |
| `POST` | `/:id/test` | Test a provider; returns `AI_DISABLED` without provider network calls when AI is disabled |

AI disabled only blocks Provider connection tests. Provider profile list, create,
update, delete, activate, deactivate, runtime pinning, and secret rotation remain
configuration operations and continue to work.

## Codebase / RAG API

Base path: `/api/rag`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/stats` | RAG store stats |
| `GET` | `/chunks/:chunkId` | Read one chunk |
| `DELETE` | `/chunks/:chunkId` | Delete one chunk |
| `POST` | `/search` | Search code or knowledge chunks |
| `POST` | `/android-internals/preview` | Preview the allowed Wiki article inventory without prose |
| `GET` | `/android-internals/sources` | List external Wiki registrations in the current scope |
| `POST` | `/android-internals/sources` | Register a Wiki with separate rights and provider consent |
| `POST` | `/android-internals/sources/:id/reindex` | Stage and atomically activate an index generation |
| `GET` | `/android-internals/sources/:id/audit` | Return one metadata-only Skill disposition per article |
| `PATCH` | `/android-internals/sources/:id/consent` | Explicitly grant or revoke provider-send consent |
| `DELETE` | `/android-internals/sources/:id/index` | Deactivate and clear every chunk for the source |
| `GET` | `/codebases` | List registered codebases |
| `GET` | `/codebases/directory-picker` | Report whether the backend can open a local system folder picker |
| `POST` | `/codebases/directory-picker` | Open the local system picker and return a short-lived, scope-bound directory authorization |
| `POST` | `/codebases/preview` | Preview files accepted by the path security gate |
| `POST` | `/codebases/register` | Register a local codebase |
| `GET` | `/codebases/:id` | Codebase detail |
| `GET` | `/codebases/:id/symbols` | Resolve symbols |
| `GET` | `/codebases/:id/excerpt` | Read an indexed excerpt |
| `POST` | `/codebases/:id/reindex` | Reindex |
| `GET` | `/codebases/:id/audit` | Index audit |
| `PATCH` | `/codebases/:id/consent` | Explicitly grant or revoke provider-send consent |
| `DELETE` | `/codebases/:id` | Retire the registration and remove every staged, active, and superseded generation in the current scope |

Codebase deletion is a retryable two-phase lifecycle. Under the ingest lease,
the backend first marks the registration `deleting`, revokes provider consent,
and disconnects its active generation. It then removes every indexed chunk and
the registration. Concurrent reindex returns `409 CODEBASE_BUSY`. Interrupted
physical cleanup returns `500 CODEBASE_DELETE_INCOMPLETE`; the codebase is
already non-retrievable and cannot be reauthorized or reindexed, and repeating
the same `DELETE` resumes cleanup. An already deleted or out-of-scope ID returns
idempotent success without revealing another tenant/workspace/user registration.

Directory selection is enabled only for source/portable, non-enterprise,
loopback listeners receiving a loopback request. Picker, preview, and register
mutations also require a loopback Origin. A successful selection returns
a `directorySelectionId` valid for five minutes. Send it with the same
`rootPath` to `/codebases/preview` and `/codebases/register`. Preview does not
consume it. Register holds it exclusively while synchronously persisting the
registration, consumes it after success, and keeps the original expiry for a
retry if persistence fails. The
credential is bound to tenant/workspace/user and cannot authorize another
path. Docker, remote, or headless environments must use manual paths and
`SMARTPERFETTO_CODEBASE_ROOTS`. `GET /codebases` and
`GET /codebases/:id/audit` expose `rootAuthorization` as `native_picker` or
`configured_allowlist` without returning absolute paths; deleting the codebase
revokes the persistent authorization.

See [Android Internals External Knowledge](../getting-started/android-internals-knowledge.en.md)
for path allowlisting, the CC rights acknowledgement, revocable consent,
request-scoped `options.knowledgeSourceIds`, and Docker mounts. Private Wiki
chunks are completely absent from ordinary `/chunks/:id` and `/search` reads;
only the dedicated source/audit management endpoints return prose-free metadata
inside the current scope.

See [Private Analysis Context Architecture](../architecture/private-analysis-context.en.md)
for the source/RAG request matrix, authorization fingerprint, and private-output
boundary.

## Analysis Result Comparison API

Workspace base path: `/api/workspaces/:workspaceId/comparisons`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/` | Create an analysis-result comparison |
| `PATCH` | `/:comparisonId/baseline` | Update baseline |
| `GET` | `/:comparisonId/report/export` | Export comparison report |
| `GET` | `/:comparisonId` | Get comparison |
| `GET` | `/:comparisonId/stream` | Subscribe to comparison stream |

Analysis-result snapshot base path: `/api/workspaces/:workspaceId/analysis-results`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List snapshots |
| `GET` | `/:snapshotId` | Read a snapshot |
| `PATCH` | `/:snapshotId` | Update snapshot metadata |
| `POST` | `/:snapshotId/similarity` | Find similar historical snapshots, with optional case-library hints |

`POST /:snapshotId/similarity` accepts `{ "limit": 5, "includeCases": false }`.
`limit` must be between 1 and 20; `includeCases` defaults to `false`. The
response includes `signature`, `snapshotHints`, `caseHints`, merged `hints`,
and `count`. Every hint is a `SimilarityHintV1` with
`allowedUse: "navigation_hint_only"`; it is a navigation/review aid, not
diagnostic evidence or root-cause proof for the current trace. The endpoint
reuses the current workspace scope, `analysis_result:read`, and the snapshot
repository readability rules.

## Reports and Export

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/reports/:reportId` | Fetch report |
| `DELETE` | `/api/reports/:reportId` | Delete report |
| `POST` | `/api/export/result` | Export one result |
| `POST` | `/api/export/session` | Export session |
| `POST` | `/api/export/analysis` | Export analysis |
| `GET` | `/api/export/formats` | Supported formats |

## Legacy and Compatibility APIs

The following APIs still exist, but new integrations should prefer `/api/agent/v1/*`:

- `/api/traces/*`; prefer `/api/workspaces/:workspaceId/traces/*`
- `/api/reports/*`; prefer `/api/workspaces/:workspaceId/reports/*`
- `/api/agent/v1/*`; workspace products should prefer `/api/workspaces/:workspaceId/agent/*`
- `/api/v1/providers/*`; prefer `/api/workspaces/:workspaceId/providers/*`
- `/api/perfetto-sql/*`
- `/api/template-analysis/*`

Maintained auxiliary APIs include `/api/flamegraph/*`, `/api/critical-path/*`,
`/api/baselines/*`, `/api/memory/*`, `/api/cases/*`, `/api/ci/*`, `/api/tp/*`,
`/api/auth/*`, `/api/tenant/*`, and `/api/admin/runtime/*`. These are scoped to
specific product or admin surfaces; confirm the relevant feature/auth state
before integrating against them.

The legacy agent API base is rejected by `rejectLegacyAgentApi` to avoid new external use of deprecated paths. Legacy direct AI routes such as `/api/advanced-ai/*`, `/api/auto-analysis/*`, and `/api/agent/v1/llm/*` have been removed; use `/api/agent/v1/analyze`.

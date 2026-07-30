# Self-Evolution Usage And Acceptance

[English](self-evolution.en.md) | [中文](self-evolution.md)

<!-- i18n-headings: paired -->

Self-Evolution is a controlled improvement loop for maintainers and workspace
administrators. It turns effective public feedback into reviewable proposals,
compares a baseline and candidate in a fixed environment, and permits a minimal
overlay to affect later analyses only after qualification and human approval.
It does not train a model, commit code, create a pull request, push a remote, or
rewrite TypeScript automatically.

Regular analysis users do not need to enable it. Every dedicated switch is off
by default; when it is off, existing AI analysis, reports, CLI behavior, and
feedback entry points continue normally.

## Current Loop

```text
analysis run
  -> immutable RunManifest
  -> public/private feedback events and reversible projection
  -> explicit public-feedback curation
  -> one bounded proposal
  -> fixed validation + holdout paired replay
  -> human accept or reject
  -> optional local deidentified contribution bundle
  -> explicit apply
  -> immutable overlay + new generation
  -> new runs use a pinned snapshot
  -> startup/upgrade reconciliation or explicit revert
```

Important boundaries:

- A run pins its runtime, provider, model, configuration, tools,
  Skill/Strategy fingerprints, and overlay generation. A new generation never
  replaces the registry of an analysis already in progress.
- Feedback first enters an append-only fact log and then a rebuildable
  projection. Private feedback is stored in a separate local path and never
  enters curation or a contribution bundle.
- Online feedback creates a `hypothesis_only` proposal; it cannot replace fixed
  paired evaluation.
- A gate requires both validation and holdout and binds materialized treatment,
  environment proof, budgets, concurrency, and replay results to one input
  fingerprint. A failure on either side cannot qualify for apply.
- Overlays are immutable, content-addressed artifacts. Apply and revert require
  a unique `actionId`; retrying an action does not publish it twice.
- Startup and upgrade reconcile before publication. Orphans, base-fingerprint
  drift, parse/validation failure, and publication failure are quarantined and
  recorded in a reconciliation report.
- The external L2 judge is fixed at `not_configured`. There is no corresponding
  environment variable or external judge call; future integration still
  requires explicit consent for every use.

See the [Self-Improving Runtime Contract](../architecture/self-improving-design.md)
for the detailed data contracts, overlay operations, and legacy boundaries.

## Who Is Actually Affected

| User | Current impact |
|---|---|
| Regular analysis user | No default behavior change. A completed analysis still has thumbs up/down feedback; feedback can be corrected, and feedback from a private analysis stays in a private local path |
| Analyst | With `self_evolution:read`, can inspect status, proposals, overlays, and reconciliation, but cannot apply |
| Workspace/Org Admin | After a deployer enables the feature, can explicitly curate, gate, accept/reject, export, apply, and revert |
| Deployer | Chooses whether to enable the two switches and must provide writable external storage that survives upgrades before apply is available |
| Skill/Strategy maintainer | Can review a structured minimal delta and paired evidence; repository patches and contribution bundles remain local and never enter Git automatically |

This is not a promise that the system improves itself without supervision. The
direct benefit for regular users is safer feedback attribution and correction;
the direct benefit for administrators is an observable, rejectable, and
reversible control plane.

## Enablement And Permissions

Enable curation, gates, and proposal review only:

```bash
SELF_EVOLUTION_ENABLED=true
```

Also allow explicit apply and revert:

```bash
SELF_EVOLUTION_ENABLED=true
SELF_EVOLUTION_APPLY=true
SMARTPERFETTO_BACKEND_DATA_DIR=/absolute/persistent/path/outside/package
```

`SMARTPERFETTO_BACKEND_DATA_DIR` must be explicitly configured, writable, and
outside the application package. Docker also requires a real persistent mount.
When the probe fails, requested apply remains observable but effective apply is
disabled fail-closed; the API returns `503` and never falls back to temporary
storage inside the package.

Restart the backend after changing environment variables, then open
**AI Assistant Settings -> Evolution**. Local development without configured
authentication uses an administrator identity. Production should use an SSO or
API identity with explicit permissions:

| Permission | Capability |
|---|---|
| `self_evolution:read` | Overview, proposals, overlays, and reconciliation |
| `self_evolution:curate` | Curation, SSE, gate, and accept/reject |
| `self_evolution:export` | Create a local deidentified contribution bundle |
| `self_evolution:apply` | Apply an accepted proposal whose gate binding is still valid |
| `self_evolution:revert` | Revert an applied proposal |

`SMARTPERFETTO_API_KEY` is the deployment operator's bootstrap credential and
defaults to `org_admin` with `*`; it is not an ordinary end-user or enterprise
API key. Enterprise API keys, SSO, and other production identities should
resolve least-privilege roles and scopes from durable bindings. Fix that
identity's authorization when an operation returns `403`; do not disable RBAC.

## User Smoke Tests

### 1. Default-Off

1. Run `./start.sh` without any `SELF_EVOLUTION_*` variable.
2. Open `http://127.0.0.1:10000`.
3. Open **AI Assistant Settings -> Evolution**.
4. Confirm the panel says the feature is off and both requested/effective
   enablement are false.
5. Confirm L2 is not configured and there is no external consent or call.
6. Complete a normal trace analysis and verify chat, report, and thumbs
   feedback still work.

### 2. Curation Only

1. Set `SELF_EVOLUTION_ENABLED=true` and restart the backend.
2. Confirm the panel can refresh, inspect state, and start curation while
   apply/revert stay disabled.
3. Submit thumbs up or down on a public analysis result. This proves feedback
   capture only. One item may not satisfy curation eligibility, so “no
   proposal” is a valid result.
4. If enough effective public feedback already exists, start curation and
   observe SSE progress from queued/progress to completed or failed. A failure
   must report an explicit error instead of pretending to be a proposal.

### 3. Full Apply/Revert

Use only a disposable data directory and an administrator identity:

1. Set both switches and an external `SMARTPERFETTO_BACKEND_DATA_DIR`, restart,
   and confirm `persistence=available` plus effective apply.
2. For an existing proposal, run gate, inspect before/after and evidence,
   accept, and apply.
3. Record the generation and effective overlay count. An analysis already in
   progress must retain its old snapshot; only a new analysis uses the new
   generation.
4. Restart with the same data directory. Confirm the generation remains and
   the latest reconciliation did not silently discard or wrongly enable an
   overlay.
5. Revert and confirm a new generation is published. Start another analysis
   and verify its effective registry no longer contains the reverted overlay.
6. Optionally export and confirm it creates only a local deidentified artifact;
   Git status and the remote repository must remain unchanged.

### 4. Fail-Closed And Isolation

- Put the data directory inside the package and confirm apply/revert are
  disabled with `data_root_inside_package`.
- Run Docker without a persistent mount and confirm
  `docker_data_root_not_mounted`.
- Use an Analyst identity to confirm overview is readable while mutation
  operations return `403`.
- Submit feedback from a private-knowledge session and confirm curation does
  not read it.
- Change provider, model, configuration, or registry and confirm old evaluation
  proof is not reused as current apply qualification.

## Maintainer Automation

Run documentation and bilingual contracts from the repository root:

```bash
npm run verify:docs
npm run verify:i18n
```

Run focused Self-Evolution verification:

```bash
npm --prefix backend run test:self-evolution
npm --prefix backend run typecheck
npm --prefix backend run test:scene-trace-regression
```

Run the full landing gate:

```bash
npm run verify:pr
```

`test:self-evolution` covers configuration dependencies, persistence probing,
RunManifest, feedback migration/projection, eval corpus, paired replay, gates,
overlays, apply/revert, upgrade reconciliation, RBAC/scope, and the admin API.
It proves code contracts; it does not replace a real startup, browser,
persistence-restart, and permission test.

When the Self-Evolution UI source changes, also verify it in
`./scripts/start-dev.sh`, run the relevant Perfetto UI tests/typecheck, and run
`./scripts/update-frontend.sh` to refresh the committed prebuild. See the full
change matrix in the [testing rules](../../.claude/rules/testing.md).

## Acceptance And Cleanup

Acceptance means:

- normal analysis has no regression while Self-Evolution is off;
- no implicit apply occurs without the required switch, permission,
  persistence capability, and gate binding;
- apply/revert affects only new-run generations and remains recoverable and
  reconcilable after restart;
- private feedback, paths, credentials, and raw provider content do not enter
  public proposals or contribution bundles;
- the control plane, API, metrics, and persisted facts explain the same state.

After testing, stop services owned by the current checkout before deleting the
disposable test directory you explicitly created. Never delete a production
`SMARTPERFETTO_BACKEND_DATA_DIR`, and do not use `docker compose down -v` on a
volume that contains real data.

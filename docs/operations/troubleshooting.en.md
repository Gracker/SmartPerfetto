# Troubleshooting

[English](troubleshooting.en.md) | [中文](troubleshooting.md)

## Windows Portable Archive

Windows users should start with the complete
[Windows setup and run guide](../getting-started/windows.en.md). Do not copy Unix commands
from this page: run `.\SmartPerfetto.exe` from PowerShell in the extracted directory and
always use the actual `Open:` URL printed by the launcher.

Read the logs with:

```powershell
$dataDir = "D:\SmartPerfettoData" # Replace with the printed Data directory
Get-Content "$dataDir\logs\backend.log" -Tail 200
Get-Content "$dataDir\logs\frontend.log" -Tail 200
```

The current Windows archive is not Authenticode-signed. Verify the official Release and
SHA256 before handling a SmartScreen/Defender warning; do not disable Defender. A saved
Provider must also be tested and activated. An existing-destination migration error is
overwrite protection, so back up first instead of deleting the data directory immediately.

## AI Backend Not Connected

```bash
curl http://localhost:3000/health
```

If there is no response:

```bash
./start.sh
```

If only backend config changed or the watcher is stuck:

```bash
./scripts/restart-backend.sh
```

## No Data After Trace Upload

Common causes:

- The trace was not registered by the backend.
- The `trace_processor_shell` process exited.
- The queried Perfetto stdlib table does not exist in this trace.
- A Skill `stepId` does not match the YAML output.

Check:

```bash
curl http://localhost:3000/api/traces
curl http://localhost:3000/api/traces/stats
```

## trace_processor_shell Download Fails

If startup reports `trace_processor_shell not found` and then hangs on `commondatastorage.googleapis.com` or `Failed to connect`, the host network cannot reach Perfetto's Google artifact bucket. The Docker Hub image already includes the pinned `trace_processor_shell`:

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

Local scripts can also skip Google's download:

```bash
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

A mirror must keep the `<PERFETTO_ARTIFACT_VERSION>/<platform>/trace_processor_shell` layout, where `PERFETTO_ARTIFACT_VERSION` is a release tag or a full upstream commit SHA. Mirrored downloads are still checked against the SHA256 pinned in `scripts/trace-processor-pin.env`.

## Docker Startup Or AI Credentials

For Docker runs, check:

- The repository-root `.env` exists. Local source runs use `backend/.env`; Docker uses root `.env`.
- `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, is configured for Claude-compatible providers.
- Authenticated `/api/runtime-health` reports the expected `aiEngine.credentialSource`. If it is `provider-manager`, the active Provider Manager profile overrides `.env`. Public `/health` does not expose credential diagnostics.
- Docker has enough memory and disk.

Docker Hub and normal source-image builds consume committed `frontend/` and do
not require the `perfetto/` submodule. Only UI plugin development needs it.

Local troubleshooting is often easier with:

```bash
./start.sh
```

Return to Docker once the normal source path works; use
`./scripts/start-dev.sh` only when changing the Perfetto UI plugin.

## macOS Blocks trace_processor_shell

If macOS says `trace_processor_shell` is from an unidentified developer, the terminal only prints `killed`, or the script reports `--version smoke test failed`, open System Settings -> Privacy & Security -> Security, click Allow Anyway, rerun `./start.sh`, and choose Open if macOS asks again.

If you trust the binary source:

```bash
xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell
chmod +x /absolute/path/to/trace_processor_shell
```

## Port Conflicts

Default ports:

- Backend: `3000`
- Frontend: `10000`
- trace_processor RPC: `9100-9900`

Source launchers stop an old instance only when PID metadata proves it belongs
to the current checkout. If another process or checkout owns a configured
port, startup prints the `lsof` owner and exits non-zero instead of killing it.

First stop services recorded by this checkout:

```bash
./scripts/stop-dev.sh
```

Only after confirming every displayed port owner should stop, use:

```bash
./scripts/stop-dev.sh --force
```

`--force` is limited to the configured backend/frontend listening ports; it
does not use broad process-name cleanup for watchers or
`trace_processor_shell`.

## LLM Calls Are Slow or Failing

Slow, proxied, and local models usually need longer timeouts. The shared
`AGENT_*` caps also apply to Provider Manager profiles; runtime-specific values
override only the direct env provider:

```bash
AGENT_FULL_REQUEST_TIMEOUT_MS=1800000
AGENT_STREAM_IDLE_TIMEOUT_MS=600000
CLAUDE_FULL_PER_TURN_MS=120000
CLAUDE_QUICK_PER_TURN_MS=80000
CLAUDE_CLASSIFIER_TIMEOUT_MS=60000
OPENAI_FULL_PER_TURN_MS=120000
OPENAI_QUICK_PER_TURN_MS=80000
OPENAI_CLASSIFIER_TIMEOUT_MS=60000
```

See the [Configuration Guide](../getting-started/configuration.en.md#budgets-and-timeouts)
for each variable's meaning and default.

If fast mode fails on a heavy question, use full mode:

```json
{
  "options": {
    "analysisMode": "full"
  }
}
```

## The Answer Remains After A Stop, Or "Stopping" Persists

- When the answer is shown and being verified, the first **Stop** ends only
  the verification: the answer is saved as usual and its verification reads as
  stopped by the user (unverified). The button then reads **Force stop**.
- A second press, **Force stop**, waits up to
  `SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS` (default 15 s) for the turn to be
  saved. If it still is not, the answer you read is saved as a turn whose
  verification did not finish (`terminationReason: review_not_finished`, shown
  as unfinished); a turn that used source or knowledge, or whose authorization
  was revoked, keeps no body.
- A stop before any answer appears is a full cancel that keeps only the cancel
  marker.
- A new question sent right after a stop may get 409
  `CANCELLATION_IN_PROGRESS` or `RUN_ALREADY_ACTIVE`: the previous run is still
  settling. The UI waits a bounded time before sending; API callers retry
  shortly.
- For CLI Ctrl-C rules see [Basic Usage](../getting-started/usage.en.md#ui-analysis-flow).

## Source Analysis Is Refused Or Ends Midway

Starting an analysis answers 409 with `codebases[]` naming a fixed reason code
for each codebase (never a path):

| `code` | Meaning and fix |
|---|---|
| `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE` | The registered root was moved, unmounted, deleted, made unreadable, or removed from the allowlist (`root_missing`, `outside_allowlist`, …); restore the path or register again |
| `ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED` | `Send text` was chosen for a codebase without a source-text grant; use **Allow source text** under **Settings → Codebases**, or switch the turn to `Locate only` |
| `ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE` | The source-text grant no longer matches the current scope (the scope changed); allow source text again and confirm |
| `FEATURE_DISABLED` | The backend sets `SMARTPERFETTO_CODE_AWARE=off` and accepts no source selection |

An authorization change during a run (revoking source text, changing a
selected codebase's scope, or deleting it) ends the run with
`analysis_context_changed_restart_required`; start the analysis again, and in
conversation mode start a new conversation.

## Model Analysis Is Disabled

`code: "AI_DISABLED"` (`retryable: false`) means the deployment sets
`SMARTPERFETTO_AI_ENABLED=false` or an unparseable value (treated as disabled).
Authenticated `/api/runtime-health` (`aiPolicy`) and `smp doctor` show why.
Trace reads, SQL, reports, and deterministic Skills still work; see the
[Configuration Guide](../getting-started/configuration.en.md#temporarily-disable-model-backed-analysis).

## Critical Path Or Flamegraph Answers 410

In enterprise mode (`SMARTPERFETTO_ENTERPRISE=true` or OIDC enabled), the
non-workspace `/api/critical-path/*` and `/api/flamegraph/*` answer 410
`ENTERPRISE_WORKSPACE_ROUTE_REQUIRED`. The critical-path drawer uses the
workspace route and is unaffected; the flamegraph page is unavailable in that
mode. See [Critical Path And Flamegraph](../getting-started/critical-path-and-flamegraph.en.md).

## 401 or Authentication Failure

If `SMARTPERFETTO_API_KEY` is set, requests need:

```http
Authorization: Bearer <token>
```

Local development does not require a bearer token when the variable is unset.

## A Knowledge Base Cannot Be Selected Or Is Retired

- Only a document knowledge base with a rights acknowledgement, provider
  consent, and an active index can be selected. Check its state with
  `smp knowledge list --format json`; if it has no index, run
  `smp knowledge reindex <id>`.
- An analysis refused with `ANALYSIS_CONTEXT_SOURCE_RETIRED` selected a source
  registered through the legacy Wiki connector. Delete that entry ("Manage…" in
  the UI or `smp knowledge remove <id> --yes`) and register the Wiki's `src/`
  as a document knowledge base; see
  [Using The Android Internals Wiki As A Knowledge Base](../getting-started/android-internals-knowledge.en.md).
- The built-in Knowledge Pack is removed. Previously downloaded Pack versions
  stay under `knowledge-packs/android-internals/` in the backend data directory,
  are no longer used, and can be deleted by hand.

## SSE Disconnects

SSE disconnects usually come from browser refresh, network interruption, or request timeout. The backend supports `Last-Event-ID` / `lastEventId` replay ring buffer, and the frontend tries to recover missing events.

If the session already completed, reconnecting
`/api/agent/v1/:sessionId/stream` attempts to replay the result and terminal
events.

## Scene Reconstruction Is Disabled

`/api/agent/v1/scene-reconstruct/*` is feature-flagged. A response containing
`code: "FEATURE_DISABLED"` means `FEATURE_AGENT_SCENE_RECONSTRUCT` is disabled
in this environment.

## Self-Evolution Is Unavailable Or Has No Proposal

Open **AI Assistant Settings -> Evolution** and distinguish requested config,
effective config, permissions, and persistence:

- The panel says off by default: the deployment does not set
  `SELF_EVOLUTION_ENABLED=true`. Existing feedback or a provider never enables
  it automatically.
- Curation works but apply/revert is off: also set
  `SELF_EVOLUTION_APPLY=true` and restart the backend.
- The API returns `503`: inspect the persistence reason.
  `external_data_dir_not_configured` means
  `SMARTPERFETTO_BACKEND_DATA_DIR` was not explicitly configured;
  `data_root_inside_package` means it is still inside the package; and
  `docker_data_root_not_mounted` means the Docker path is not a persistent
  mount.
- The API returns `403`: the identity lacks the corresponding
  `self_evolution:*` permission. Analysts are read-only; inspect the durable
  roles/scopes binding for enterprise API keys, SSO, and other production
  identities. The deployment operator's `SMARTPERFETTO_API_KEY` is the
  exception: it is a bootstrap credential with `org_admin` and `*` by default
  and must not be distributed to end users.
- Curation completes without a proposal: only effective public feedback enters
  curation. One item or private feedback does not guarantee a proposal; this is
  not a runtime failure.
- A gate becomes inconclusive/pending: provider, model, config, registry, case
  split, budget, or materialized treatment changed. Old proof cannot be reused;
  run the gate again in a fixed environment.
- A new analysis does not use an applied overlay: inspect generation, overlay
  validation/activation, and reconciliation. An existing run pins its old
  snapshot; only a new run resolves the new generation.

The external L2 judge should currently report
`not_configured / explicit_external_judge_consent_required`. That means no
external call is made; it is not a provider configuration failure. See
[Self-Evolution Usage And Acceptance](../getting-started/self-evolution.en.md)
for the full workflow and acceptance matrix.

## Agent-Assisted GitHub Feedback Is Unavailable

First confirm that the source message received `analysis_completed`. M10 reads
the persisted completion event, RunManifest, and optional result snapshot. It
does not inspect an in-flight chat object.

- "No feedback needed" means deterministic detection found no evidence/claim
  gate, Skill, scene-confidence, identity, or report-output signal. You may
  still use the GitHub Issue Form manually.
- A private/code-aware source is fail-closed. Do not bypass this by disabling
  redaction or copying private output. Route security findings to a private
  advisory.
- A legacy run may lack a provider pin, or the active provider snapshot may
  have changed. M10 never switches that old run to the current provider. Run a
  new analysis to create a complete pin.
- An Agent fallback means that the source runtime does not yet support
  independent triage, the pinned credential is unavailable, or model output
  failed strict JSON/evidence validation. The conservative deterministic
  guidance remains usable, but is not labeled as an Agent result.
- "Create GitHub draft" stays disabled until every required question is
  answered and the sensitive-data review is checked. A security-sensitive
  candidate can only route to the private-advisory path.
- No Issue exists after opening GitHub until the user submits it. SmartPerfetto
  holds no GitHub token, calls no GitHub API, and never clicks submit.

See [Agent-Assisted GitHub Feedback](../getting-started/agent-assisted-feedback.en.md)
for the complete states, fields, and manual acceptance steps.

## Skill Validation Fails

```bash
cd backend
npm run validate:skills
```

Common causes include YAML indentation errors, duplicate step `id`, missing `doc_path` targets, `display.columns` mismatches, and `${param|default}` typos.

## Strategy Validation Fails

```bash
cd backend
npm run validate:strategies
```

Common causes include invalid YAML frontmatter, scene names that do not match runtime enums, malformed `phase_hints`, and missing prompt template variables.

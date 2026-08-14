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

Mirrored downloads are still checked against the SHA256 pinned in `scripts/trace-processor-pin.env`.

## Docker AI Credentials

For Docker runs, check:

- The repository-root `.env` exists. Local source runs use `backend/.env`; Docker uses root `.env`.
- `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, is configured for Claude-compatible providers.
- Authenticated `/api/runtime-health` reports the expected `aiEngine.credentialSource`. If it is `provider-manager`, the active Provider Manager profile overrides `.env`. Public `/health` does not expose credential diagnostics.
- Docker has enough memory and disk.

Docker Hub and normal source-image builds consume committed `frontend/` and do
not require the `perfetto/` submodule. Only UI plugin development needs it.

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

```bash
CLAUDE_FULL_PER_TURN_MS=120000
CLAUDE_QUICK_PER_TURN_MS=80000
CLAUDE_VERIFIER_TIMEOUT_MS=120000
CLAUDE_CLASSIFIER_TIMEOUT_MS=60000
```

If fast mode fails on a heavy question, use full mode:

```json
{
  "options": {
    "analysisMode": "full"
  }
}
```

## 401 or Authentication Failure

If `SMARTPERFETTO_API_KEY` is set, requests need:

```http
Authorization: Bearer <token>
```

Local development does not require a bearer token when the variable is unset.

## Knowledge Pack Status Or Update Fails

Use JSON status to distinguish bundled, active, and signed-channel state:

```bash
smp knowledge-pack status --format json
smp knowledge-pack update --check --format json
```

- If the metadata channel is temporarily unreachable, a verified,
  non-revoked bundled/active Pack remains an offline fallback.
- Do not bypass signature, version, hash, license, or revocation failures by
  editing the active pointer. Fix mirror URLs, network access, or system time,
  then retry.
- `SMARTPERFETTO_AIW_PACK_PIN` can pin only an installed, non-revoked version.
- The Pack is background knowledge. A Pack citation without current-trace
  evidence does not prove trace analysis succeeded.

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

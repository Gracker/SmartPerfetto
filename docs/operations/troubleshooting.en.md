# Troubleshooting

[English](troubleshooting.en.md) | [中文](troubleshooting.md)

## AI Backend Not Connected

```bash
curl http://localhost:3000/health
```

If there is no response:

```bash
./scripts/start-dev.sh
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

Clean trace processors:

```bash
pkill -f trace_processor_shell
```

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

## SSE Disconnects

SSE disconnects usually come from browser refresh, network interruption, or request timeout. The backend supports `Last-Event-ID` / `lastEventId` replay ring buffer, and the frontend tries to recover missing events.

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

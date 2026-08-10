# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis lets SmartPerfetto reference local source trees while analyzing a trace. It maps app frames, native frames, and kernel symbols to `CodeRef` metadata. A registered root that is still reachable becomes selectable immediately and enables `search_codebase` / `read_codebase_file`; no SmartPerfetto index is required first. Outputs preserve only `referenceId` or `chunkId`, relative paths, line ranges, and symbols. Raw source text is not persisted into sessions, reports, or exports.

## Enable It

1. Start the backend with `./start.sh`.
2. Open AI Assistant settings in Perfetto UI and select `Codebases`.
3. Prefer **Choose folder** when adding a codebase, then run preview. Display name is optional and defaults to the folder name.
4. Register it and start analysis immediately. SmartPerfetto reindexing is optional acceleration and still powers semantic/symbol lookup and patch workflows; it is independent of optional external code-graph acceleration.
5. Use code-aware mode in analysis, or pass `--code-aware metadata_only|provider_send` and `--codebase-id <id>` in the CLI.

CLI example:

```bash
cd backend
npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --dry-run

npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/

# Optional: build an index for semantic/symbol lookup and patch workflows
npm run cli:dev -- codebase reindex cb_xxx
npm run cli:dev -- codebase symbols MainActivity --codebase-id cb_xxx

npm run cli:dev -- run --format json \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  ../Trace/real/android-startup-heavy/trace.pftrace \
  "Find the startup bottleneck and map it to source code"
```

Registered codebases and knowledge sources are never exposed to a session automatically. The effective combinations are:

| Current selection | Effective behavior |
|---|---|
| No IDs | Normal trace-only path; `fast` can remain lightweight |
| `--codebase-id` only | Defaults to `metadata_only` and uses the full analysis runtime |
| `--code-aware metadata_only` + codebase ID | Uses `CodeRef` metadata only, with the full runtime |
| `--code-aware provider_send` + codebase ID | Sends filtered snippets only after dual consent, with the full runtime |
| `--code-aware off` + codebase ID | Invalid input; the source selection is rejected instead of silently ignored |
| `--knowledge-source-id` only | Uses the authorized private external RAG source and the full runtime |
| Codebase ID + knowledge source ID | Uses source and external RAG together under the same privacy projection and full runtime |

A source codebase needs only a live registered root. Missing active generations or indexed chunks do not block analysis. External knowledge remains RAG-backed and still requires consent plus a completed index. If the registered source path is moved, unmounted, or deleted, Web/CLI returns `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE`; restore that path or register it again.

“Full runtime” means that an explicit `--analysis-mode fast` is resolved to `full` whenever source, private RAG, or a reference trace is selected, so capabilities are not silently dropped by a lightweight path. `provider_send` requires two independent authorizations: `--send-to-provider` at codebase registration and `--code-aware provider_send` for the current run.

## Evidence Order And Optional Code Graphs

The default investigation order is:

1. Establish the performance symptom, time range, threads, slices, and symbols from the current trace, matching Skills, and Perfetto SQL. These are the primary evidence for performance claims.
2. If the backend finds a local GitNexus installation that the user already installed and that is currently usable, the AI may call `query_code_graph` / `inspect_code_symbol` to navigate candidate call relationships and symbols. The graph is optional navigation acceleration, not trace evidence or source truth.
3. Narrow the candidate to relative files and lines with index-free `search_codebase`, then verify the actual source with bounded `read_codebase_file` when current consent permits it. Any graph relationship that affects a conclusion must pass this check. If the permission mode blocks source reading, keep `verificationRequired` and do not promote the candidate to a verified claim.

`query_code_graph` and `inspect_code_symbol` return metadata only: `codebaseId`, relative `CodeRef` values, sanitized process/symbol metadata, `graph.freshness`, and `graph.verificationRequired`. They never return raw source text or absolute roots. When a registration uses `pathFilters` or `excludeGlobs`, SmartPerfetto omits whole-repository process summaries whose path scope cannot be proven; authorized relative `CodeRef` values remain available. If GitNexus is missing, unavailable, incompatible, times out, or fails, the graph tool returns a structured unavailable result (`success=false` plus `unsupportedReason`). A stale index returns navigation metadata marked `freshness="stale"`. In either case, the AI/strategy continues through the existing `search_codebase` / `read_codebase_file` path, so registration, selection, and trace analysis remain available. SmartPerfetto does not install, bundle, redistribute, or automatically create or refresh a GitNexus index.

GitNexus is an independent optional third-party tool. Its [official project](https://github.com/abhigyanpatwari/GitNexus) and [npm package](https://www.npmjs.com/package/gitnexus) currently declare the [PolyForm Noncommercial 1.0.0](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE) license. Review the upstream terms and confirm that your intended use is permitted before enabling it, especially for commercial use. This is not legal advice.

## Supported Codebases

| kind | Use | Required metadata |
|---|---|---|
| `app_source` | App Java/Kotlin/R8 lookup | source folder; optional build ID and path scope |
| `aosp` | AOSP framework/native hot paths | source folder and `licenseTag`; optional build ID and path scope |
| `kernel_source` | kernel binder/scheduler/mm/io causes | source folder, `vendor`, and `path-filter` (CLI reindex can use `pathPrefix`); optional license tag |
| `oem_sdk` | OEM / chipset SDK material | source folder, `vendor`, and `licenseTag`; optional build ID and path scope |

Do not enter a commit manually. Each index generation reads Git `HEAD` from the
actual checkout and records dirty/untracked state separately. Non-Git folders
use a content fingerprint.

Local source checkouts and portable apps running on loopback can ask the
backend to open the macOS, Windows, or Linux system folder picker. A selection
creates a single-use authorization bound to the current tenant, workspace, and
user for five minutes. It authorizes only that registration and its later
reindexes; it never expands the process-wide allowlist. List and audit metadata
show whether path authorization came from the system picker or the configured
allowlist; deleting the registration also revokes that persistent authorization.
Docker, remote/shared
backends, headless sessions, and platforms without a supported picker retain
manual entry. In those cases, enter a path the backend can access and that is
authorized through `SMARTPERFETTO_CODEBASE_ROOTS`.

## Security Boundary

- `metadata_only`: the model can search on demand but receives only relative paths, line ranges, and `referenceId`, not source text.
- `provider_send`: bounded, redacted search/read text can be sent only for codebases registered with `sendToProvider` consent.
- On-demand tools enforce registered path filters, exclude globs, file types, per-file size, result and line limits, and secret redaction. Absolute roots remain inside the backend trust boundary and never enter tool results, model context, reports, or exports.
- Code-graph results are always metadata-only. Reports, snapshots, and CLI artifacts may retain only safe names/IDs and relative `CodeRef` values, never raw source or a graph relationship presented as trace evidence.
- System-picker mutation requests require a loopback Host, socket, and Origin; the read-only capability probe may omit Origin. The picker is disabled for Docker, enterprise, or non-loopback listeners. Absolute roots are never returned by codebase list/detail responses.
- Raw queries, intermediate reasoning, tool arguments, and retrieved text from private source/knowledge runs are not persisted to sessions, logs, reports, or exports. Claude local transcripts and OpenAI Responses storage are disabled, and cross-session pattern, verifier, and SQL-fix learning is neither read nor written. Final conclusions and deterministic trace evidence pass through one shared privacy projection; bounded in-process session context provides multi-turn continuity.
- Legacy RAG chunks keep their existing behavior; `app_source`, `kernel_source`, or `registryOrigin=codebase_registry` chunks without codebase metadata fail closed.
- Legacy `/api/rag/chunks/:id` and `/api/rag/search` return sanitized hash/length data for code-aware chunks, not source text.
- Web UI “Delete codebase” revokes retrieval and provider consent before removing every indexed generation in the current scope; interrupted deletion is safe to retry. Local deletion cannot recall content already sent to a provider.
- Patch proposals have three states: `verified`, `sketch`, and `unverified`. This change still requires an indexed lookup `chunkId`; on-demand `referenceId` values do not directly authorize a patch. `sketch` and `unverified` never expose a copyable diff.

## Verification

Common checks:

```bash
cd backend
npm run verify:codebase-aware
```

The local full E2E uses:

- `Trace/real/android-startup-heavy/trace.pftrace`
- `Trace/real/android-startup-light/trace.pftrace`
- `/Users/chris/Code/HighPerformanceFriendsCircle`

The E2E covers both paths:

- No codebase configured for the session: Light trace completes normally and the report has no `CodeRef` / code-aware section.
- HighPerformanceFriendsCircle configured for the session: Heavy/Light traces complete normally and reports/exports contain `CodeRef` entries such as relative `MainActivity.kt` and `LoadSimulator.kt` file paths with line ranges; reports must not contain the absolute root path or raw source text.

Override paths when needed:

```bash
SMARTPERFETTO_E2E_HEAVY_TRACE=/path/heavy.pftrace \
SMARTPERFETTO_E2E_LIGHT_TRACE=/path/light.pftrace \
SMARTPERFETTO_E2E_APP_REPO=/path/HighPerformanceFriendsCircle \
npm --prefix backend run verify:codebase-aware
```

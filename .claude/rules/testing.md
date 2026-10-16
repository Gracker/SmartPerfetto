# Testing Rules

## Proportionate Verification

During development, run the affected owning tier. For combined fast root/backend
checks use `npm run verify:dev`; it expands the existing two `verify:ci` scripts,
not the full suite or target/native/provider acceptance. Before opening or
landing a PR, run root `npm run verify:pr`. Public releases also require their
exact-artifact gates in [release](release.md).

Use repository-defined runnable commands. Missing entrypoints are
`NOT CONFIGURED`; missing prerequisites are `NOT AVAILABLE`. Reuse passing
checks while covered files, dependencies, configuration and environment remain
unchanged; rerun for changed evidence, failures, unresolved risk or a required
acceptance boundary. Review/simplify only the task-owned diff before final
checks; preserve unrelated work and inspect `git diff --check`.

Tests should establish observable behavior or maintained regression contracts,
not repeat literals/layout. Removing a case requires preserving its unique
assertions or proving the feature retired. Share expensive suite fixtures/results
only when trace, inputs, options and lifecycle are identical; parameter changes,
mutation/cancellation and replay behavior need independent execution. Do not
hide missing data, accept success and failure alike, or loosen assertions for speed.

## Default PR Gate

```bash
npm run verify:pr
```

Root/backend `package.json` define its current selection and dependencies:
governance, docs/i18n/runtime assets, quality, Rust, Skill/Strategy validation,
typecheck/build, CLI packaging, every registered test tier and Trace/SQL
regression. Read those scripts rather than duplicating their full chain here.

## Hosted CI and Local Verification

| Boundary | Selection | Evidence |
| --- | --- | --- |
| Development | Affected owner tier; `npm run verify:dev` for combined fast checks | Local functional/type/build/privacy checks, not full acceptance |
| PR/main Actions | Root and backend `verify:ci` | Clean hosted install/build plus essential lifecycle/auth/privacy/output contracts |
| Relevant hosted paths | Rust, macOS/Windows native contracts, Docker smoke | OS/container boundaries a local macOS run cannot establish |
| Pre-PR/landing | Root `verify:pr` plus applicable surface checks | Complete local deterministic regression |
| Hosted full reproduction | `backend-agent-regression-gate.yml`, `full=true` | Full backend and Trace corpus plus all environment jobs |
| Feature acceptance | Applicable browser, real-provider and performance gates below | Actual rendering/model/target-workload evidence |
| Public release | npm, version-tag Docker and exact-archive native smoke | Exact published bytes, independently per surface |

Hosted scopes come from `scripts/ci-change-scope.cjs` and
`.github/ci-scopes.json`: PR test merge diff, push `before..HEAD`, both sides of
renames, all environments for manual/first push, missing history fails closed.
Keep a stable `always()` aggregate gate without workflow PR path filters; reject
failed/cancelled jobs and skipped mandatory jobs. Superseded automatic runs may
cancel; manual runs remain independent. Native jobs need not repeat Linux
checks. Docker nightly/manual uses fast checks; version tags retain full backend
`verify:pr`. Workflow edits/local runs are not hosted passing evidence.

CI subsets select existing owned suites, not extra local owners. Credential-filter
functional cases remain in `test:ci-privacy`; pathological-input performance
belongs to `test:secret-patterns:performance` in the architecture/full chain.
After changing gate/scope wiring, compare before/after suite selection and fixture
preparation, then run registration and both fast scripts via `verify:dev`.

## Test Ownership and Registration

Every backend suite must be reachable from root `verify:pr`, preferably through
one `test:*` owner in backend `test:gate`. Focused scripts alone do not establish
default coverage; helpers/fixtures cannot live where Jest matches them as suites.
After adding/moving/deleting suites or wiring:

```bash
npm run check:test-registration
```

Keep its baseline empty; accepted debt needs explicit justification. Run affected
owning tiers and preserve preparation/execution dependencies. Jest/ts-jest does
not typecheck; backend `npm run typecheck` covers source/tests, build emits source.
Trace evals belong to `test:analysis-accuracy`, which materializes the corpus.
`describeWithTrace` fails unknown/missing fixtures; assert actual expected results.

## Production Reachability

After removing a caller, module or export, run owning tests plus:

```bash
npm run check:orphaned-modules
npm run check:unused-exports
```

Tests do not make unused code production-reachable. Register retained tool
entrypoints; test-only exports may use `@internal` but cannot rescue dead modules.
Baselines are explicit accepted debt, never acceptance. Keep `knip.json` aligned;
`test:unit-sweep` owns only suites without a more specific owner.

## Verification by Change Type

Commands below are from root unless a backend prefix is shown. Combine only
applicable rows; full `verify:pr` covers deterministic owner tiers at landing.

| Change | Development/surface verification |
| --- | --- |
| Non-runtime docs/rules | `git diff --check`, `npm run verify:docs`; `verify:i18n` for bilingual structure; relevant governance contracts for rule/adapter changes |
| Command/path/runtime-read docs | Above plus smallest smoke of the changed command/path |
| Test registration/preparation | Registration checker, before/after selection/dependencies, affected owner tier; SQL gate only when its contracts/wiring change |
| Build/types | Backend `typecheck` plus relevant tests |
| CRUD outside runtime | Service's owning tests |
| MCP/memory/report/provider/session/runtime | Backend `test:scene-trace-regression` plus affected owner tests |
| HTML report/layout/controls | Owning report tests plus `npm run test:e2e:reports` (pinned UI Playwright + installed Chrome; narrow layouts, all templates, CSP downloads, offline/print; `output/playwright/html-reports/`) |
| Raw SQL capture units/native provenance | Backend `test:raw-sql-provenance` plus affected parser/worker/RPC/capture tests |
| Skill YAML | Backend `validate:skills` and scene trace regression; SQL-bearing changes also `trace:sql-regression` |
| Strategy/templates | Backend `validate:strategies` and scene trace regression; relevant authenticated E2E for behavior |
| Trace corpus/coverage/generator | `npm run trace:regression` (tooling, generated build, SQL execution) |
| SQL regression/preparation wiring | Backend `trace:sql-regression` |
| Frontend generated contracts | Backend `generate:frontend-types` plus contract tests |
| AI plugin UI | [frontend](frontend.md): dev browser, affected Perfetto UI tests/typecheck, production build, refresh/check prebuild |
| Self-Evolution | Backend `test:self-evolution`, typecheck, scene regression; UI row if panel changes |
| Agent external issue flow | Backend `test:external-issue-reporting`, typecheck, strategy/scene gates; UI row; prove private/security fail-closed and no GitHub write |
| Processor pin/upstream/UI prebuild | [perfetto-sync](perfetto-sync.md): prebuild, CLI, scene, SQL/Skill validation if affected, submodule anchor |
| Code-aware source/knowledge/references | [codebase-aware](codebase-aware.md#verification): codebase-aware, source-claim, report-contract and semantic-delta tiers; UI row if affected |
| npm CLI assets/bin/engine/package | Backend `cli:pack-check`, `cli:e2e`; public registry isolated smoke in [release](release.md) |
| Portable lifecycle/paths/assets/signing | Portable static/launcher/package gates below; matching-OS exact final archives additionally required for public release |

## Portable Packaging Verification

For portable packaging, release scripts, version synchronization,
trace-processor handling or bundled runtime changes, run the relevant source
checks below. Documentation-only changes need the affected command/flag smoke
and governance checks; do not rebuild, sign or upload archives when their inputs
and behavior are unchanged.

```bash
for script in scripts/package-portable.sh scripts/release-portable.sh scripts/package-windows-exe.sh scripts/release-windows-exe.sh; do
  bash -n "$script" || exit
done
shellcheck -x scripts/package-portable.sh scripts/release-portable.sh scripts/package-windows-exe.sh scripts/release-windows-exe.sh
for script in scripts/sync-version.cjs scripts/verify-portable-package.cjs scripts/verify-windows-package.cjs scripts/smoke-portable-archive.cjs; do
  node --check "$script" || exit
done
npm run version:sync -- --check
GO111MODULE=off go test ./scripts/portable-launcher
GO111MODULE=off GOOS=windows GOARCH=amd64 go build -o /tmp/smartperfetto-launcher.exe ./scripts/portable-launcher
GO111MODULE=off GOOS=darwin GOARCH=arm64 go build -o /tmp/SmartPerfetto-macos ./scripts/portable-launcher
GO111MODULE=off GOOS=linux GOARCH=amd64 go build -o /tmp/SmartPerfetto-linux ./scripts/portable-launcher
```

Changes to archive layout, packaged assets, native compatibility or signing
add package construction and final archive verification. Public releases
always require the complete three-target set and the exact native gate below:

```bash
npm run package:portable
node scripts/verify-portable-package.cjs \
  --asset "dist/portable/smartperfetto-v<version>-windows-x64.zip" \
  --target windows-x64 \
  --version "<version>" \
  --commit "$(git rev-parse HEAD)" \
  --require-clean
node scripts/verify-portable-package.cjs \
  --asset "dist/portable/smartperfetto-v<version>-macos-arm64.zip" \
  --target macos-arm64 \
  --version "<version>" \
  --commit "$(git rev-parse HEAD)" \
  --require-clean
node scripts/verify-portable-package.cjs \
  --asset "dist/portable/smartperfetto-v<version>-linux-x64.tar.gz" \
  --target linux-x64 \
  --version "<version>" \
  --commit "$(git rev-parse HEAD)" \
  --require-clean
```

For a clean public release, the package manifest must contain
`gitDirty: false` and `gitCommit` equal to the release target commit. If testing
the release script without uploading, use a fake `gh` shim or a draft release;
do not rely on `--allow-dirty` for public release validation.
Manifest schema v3 records the pinned `traceProcessor.sourceSha256` separately
from the post-signing packaged `traceProcessor.sha256`; the verifier must bind
the latter to the binary extracted from the exact archive.
The bundled Node runtime version, archive filename, archive SHA-256, and final
executable-content digest must exactly match `scripts/node-runtime-pin.env`.
For macOS, the digest normalizes only code-signature-dependent Mach-O fields
so Developer ID re-signing cannot hide changed executable content. Packaging
must not resolve a moving `latest-v24.x` input.

Cross-compilation, archive verification, and static signature checks do not
prove target-platform startup. During code/PR work, report those results as
contract/package verification. For a public portable release, additionally
apply the exact-asset runtime gate below.

## Exact Portable Archive Runtime Gate

Build once from the exact clean release commit. On Windows, macOS, and Linux,
extract the final archive that will be uploaded into a fresh temporary
directory and test those exact bytes. macOS must use the zip recreated after
notarization and stapling. Do not rebuild an archive after it passes this gate.

Run this command once per target on the matching OS/architecture:

```bash
node scripts/smoke-portable-archive.cjs \
  --asset "<final-archive>" \
  --target "<windows-x64|macos-arm64|linux-x64>" \
  --version "<version>" \
  --commit "<release-commit>" \
  --public-release \
  --output-dir "dist/portable/smoke-evidence/<target>"
```

The command must reject host/target mismatches. Its static phase must reject
absolute paths, traversal, cross-platform name collisions, symlinks, hard
links, non-regular extracted entries, AppleDouble/macOS metadata entries, and
any archive-tool diagnostics before trusting package contents. A Linux
`tar.gz` built on macOS must therefore be free of PAX xattr records as observed
by target-native GNU tar listing and extraction, not merely clean in its
pre-archive staging tree. The verifier must enforce pre-extraction archive
byte/entry/expanded-size/ratio budgets and listing/extraction deadlines.
`--output-dir` must be a fresh path; never overwrite earlier smoke evidence.
For local pre-commit runtime validation only, `--allow-dirty` may omit the
clean-tree requirement. It must be incompatible with `--public-release`, and
its evidence must never be accepted for promotion.

Each target smoke must:

1. Re-verify manifest version, `gitCommit`, `gitDirty: false`, target, and
   bundled Node.js 24 from the extracted archive. Scan every packaged ELF or
   Mach-O and require its GLIBC/minimum-system version to fit the manifest and
   Info.plist declaration.
2. Start the bundled launcher with isolated data/log directories and
   non-conflicting ports.
3. Poll backend and frontend health through explicit
   `http://127.0.0.1:<port>/health`; do not use `localhost` as release evidence.
   The smoke probe must bypass environment proxies through a target-supported
   standard library HTTP client fixed to IPv4 loopback. Windows uses the
   repository-owned Go gate helper built from the immutable gate commit
   by the native job with the workflow-pinned Go toolchain. It is a separate
   gate process, not a release asset. Its `net/http` probe must disable proxies,
   redirects, compression, DNS fallback, and non-loopback dial targets; accept
   only the validated URL and bounded timeout as arguments; and enforce strict
   response-byte and wall-clock limits. The Node gate must validate that the
   configured probe path is an absolute regular non-symlink `.exe`, pass a
   sanitized environment, and terminate the process on cancellation or a hard
   deadline. If direct child termination does not settle, invoke trusted
   `System32\taskkill.exe /T /F` and fail within a second bounded deadline
   unless process closure is confirmed. The same helper must use the native
   Toolhelp32 process snapshot API for descendant evidence; it must not invoke
   PowerShell, CIM, WMI, or release-archive code. Snapshot output must be
   bounded and canonical, include the helper's own PID as a completeness
   sentinel, and fail closed on empty, malformed, duplicate, partial, timed
   out, or non-zero helper results. The Windows native job must test, build,
   and execute the real fixed helper health and process contracts before
   testing the archive.
   macOS and Linux use Node's HTTP client with a private keep-alive agent per
   attempt and destroy the agent, request, response, and socket on every
   terminal path. All clients must enforce strict URL, response-byte,
   process-output, and wall-clock budgets, and cancel and settle the peer
   probe before launcher shutdown after any readiness failure. Record the
   target-required client identifier in schema-v2 evidence and reject evidence
   produced by another client. Do not maintain a release-only HTTP parser that
   diverges from the launcher, browsers, and normal clients.
4. Execute the bundled Node.js, Claude, and OpenCode version commands when
   present, then run a minimal packaged `trace_processor_shell` operation.
5. Use the launcher-supported shutdown control, require a zero/successful and
   non-escalated shutdown receipt with platform containment
   (`windows-job-object` or `service-process-groups`), and verify child
   processes and listening ports are gone. Keep process-tree traversal in the
   Node gate; the Windows helper emits only a strict full PID/PPID snapshot so
   its own gate process cannot be mistaken for a launcher descendant.
6. Preserve launcher/backend/frontend logs on failure.
7. Atomically write a schema-v2 `smoke-summary.json` that binds the target-native host,
   lifecycle receipt, and exact archive name, size, and SHA-256. Public release
   promotion must re-hash the same archive and reject stale or edited evidence.

For hosted smoke, the fixed gate checkout owns and executes the smoke client
and evidence verifier. The immutable draft metadata and downloaded archive
provide the release identity and product bytes; the native job must not create
or execute a release checkout. Preserve the gate SHA and release commit as
separate trust roots throughout planning, native execution, collection,
attestation, and promotion.

For the final macOS archive, also require:

```bash
codesign --verify --deep --strict --verbose=2 SmartPerfetto.app
xcrun stapler validate SmartPerfetto.app
spctl --assess --type execute -vv SmartPerfetto.app
xcrun notarytool info <submission-id> \
  --keychain-profile "$SMARTPERFETTO_MACOS_NOTARY_PROFILE"
```

The notarization result must be `Accepted` and preserved as the minimal
`NOTARIZATION-RECEIPT.json` in the exact final archive, the ticket must be
stapled, Gatekeeper must report `Notarized Developer ID`, and the extracted app
must actually reach both health endpoints. The package verifier must
independently check every Mach-O signature and required Node/Claude JIT
entitlements; signing must not depend on file extension or executable mode.

Use native or hosted target runners when local machines are unavailable. If a
required runner cannot execute the exact archive, keep the GitHub release as a
draft. Publishing with a known gap requires explicit user acceptance and must
name the untested target; static verification is not a substitute.

The hosted entry point is
`.github/workflows/portable-exact-archive-smoke.yml`. Dispatch it only from the
default branch and pass the numeric draft release ID. Its gate checkout is
fixed to the dispatch SHA. The plan separately binds the draft's full target
SHA (or the peeled tag commit once the tag exists), which must be an ancestor
of the gate; the native job does not check out that commit. A fixed-gate
download job fetches each target by immutable asset ID with native binary I/O,
verifies size and digest, then re-fetches and re-binds the release. It
preserves those opaque bytes as a short-lived Actions artifact; only then does
the native smoke job restore and execute them. The smoke matrix must override
default skipped-needs propagation:
one target's failed download may fail that target, but must not suppress native
smoke and diagnostic evidence for targets whose exact asset artifacts exist.
GitHub currently requires `contents: write` for its Actions token to read a
draft release and download draft assets. That grant must remain job-local to
the prepare, download, and collect jobs; checkout must use
`persist-credentials: false`, and `GH_TOKEN` is scoped only to trusted
fixed-gate REST GET/download steps. The native smoke job must have at most
`contents: read` and must never share a job with a write-capable repository
token. A fresh collect job must fetch the unchanged draft before downloading
target evidence, then use the fixed gate commit—without passing it a token—to
validate each public smoke summary, release/asset identity, runner/run
provenance, and prepared workflow context before changing the context to
`verified`. The tested release code must never receive the write credential.

`selection=windows-linux` and single-target selections produce partial
diagnostic evidence and are never promotion evidence. Only a successful
`selection=all` run can set `publicReleaseEligible: true`; it must include the
signed, notarized, stapled macOS final zip. Per-target artifacts keep separate
target roots, and the collect job preserves both failures and a combined
attestation. The combined artifact exposes normalized
`promotion-evidence/<target>/smoke-summary.json` and
`workflow-context.json` only for targets whose release ID, asset ID, summary
digest, runner host, gate SHA, and run identity all match. Hosted promotion
must pass that downloaded `promotion-evidence/`, the sibling
`portable-smoke-attestation.json`, and the producing run ID to
`release:portable`. The promotion verifier re-fetches repository metadata, the
completed Actions run, and the uniquely named combined artifact. It must bind
the repository ID and default branch to GitHub's response, require the run gate
SHA to equal the clean promotion checkout, verify GitHub's artifact SHA-256
against the downloaded zip, and byte-compare the local evidence with the
digest-verified artifact.

For changes to this gate, run at minimum:

```bash
node --check scripts/portable-release-smoke-workflow.cjs
node --check scripts/download-portable-release-asset.cjs
node --check scripts/verify-portable-smoke-attestation.cjs
node --check scripts/smoke-portable-archive.cjs
GO111MODULE=off go test ./scripts/portable-health-probe
GO111MODULE=off GOOS=windows GOARCH=amd64 go build -trimpath \
  -ldflags="-s -w" -o /tmp/smartperfetto-windows-gate-helper.exe \
  ./scripts/portable-health-probe
node --test scripts/__tests__/portable-release-smoke-workflow.test.mjs \
  scripts/__tests__/smoke-portable-archive.test.mjs \
  scripts/__tests__/verify-portable-smoke-evidence.test.mjs \
  scripts/__tests__/release-portable.test.mjs
bash -n scripts/release-portable.sh
shellcheck scripts/release-portable.sh
```

## Canonical Scene and Trace Regression

Backend `test:scene-trace-regression` uses canonical startup, standard/customer
scrolling and separate Flutter TextureView/SurfaceView cases through
`Trace/catalog.json`; do not reintroduce retired flat fixture paths. Backend
`trace:sql-regression` materializes committed overlays without the Perfetto
source tree and runs production SQL, branch/probe and exact-UPID contracts.
Missing/skipped SQL or unbound admitted exact units fail. Full generator/tooling
acceptance uses root `trace:regression`. Inventory assignment, definition-only,
expected-empty, execution-only and positive semantic coverage stay distinct;
see [skills](skills.md) for exact process bindings and shared walkers.

## Test Process and Data Isolation

Use `backend/tests/helpers/loopbackServer.ts` for owned Supertest servers. Await
IPv4 listener readiness and pass the server, never an unbound Express app that
Supertest implicitly listens on. Stop owned streams/sessions, close listeners
and stores, then restore env and delete owned temporary data. Set path overrides
before imports that capture paths; never clear the default user database. Keep
fixture data if cleanup cannot confirm released connections. Preserve explicit
native TCP/WebSocket cleanup and assert response identity/port release.

## Runtime Concurrency And Latency Admission

Concurrency changes must prove the serial default and each explicitly admitted
branch. Run the focused default-off/admitted-on gate from `backend/`:

```bash
npm run test:runtime-registry
npx jest --runInBand --forceExit \
  src/scripts/__tests__/runQuickAgentE2eWrapper.test.ts \
  src/agentRuntime/__tests__/runtimeCandidateAdmission.test.ts \
  src/agentRuntime/__tests__/runtimeToolConcurrency.test.ts \
  src/agentRuntime/__tests__/runtimeToolConcurrencyAdapters.test.ts \
  src/agentv3/__tests__/claudeRuntimeRuntimeSnapshots.test.ts \
  src/agentOpenAI/__tests__/openAiRuntime.test.ts \
  src/agentRuntime/__tests__/piAgentCoreRuntime.test.ts \
  src/agentRuntime/__tests__/openCodeRuntime.test.ts \
  src/agentRuntime/engines/qoder/__tests__/qoderRuntime.test.ts \
  src/scripts/__tests__/benchmarkAgentRuntimeLatency.test.ts
npx jest --runInBand --forceExit \
  src/services/__tests__/traceProcessorLeaseProcessorRouting.test.ts \
  src/services/__tests__/traceProcessorSqlWorker.test.ts \
  src/services/__tests__/workingTraceProcessor.enterpriseIsolation.test.ts
npm run typecheck
npm run build
```

These suites must cover absent/invalid admission, admitted behavior,
cancellation/late settle, cache failure retry, same-processor SQL serialization,
tool fallback receipts, and all five adapter projections. Also run
`npm run test:analysis-accuracy`; before a PR use the normal `npm run verify:pr`
gate rather than substituting this focused list.

`SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` admits only `task4` through `task9`
and defaults to none. Unknown, duplicate, whitespace-bearing, empty, or malformed
values must fail closed as a whole. `SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false`
may roll admitted `task5` back to exclusive execution but must not activate it.
Keep tools exclusive by default and same-trace/processor SQL on one worker.

For an admissible real benchmark, a reviewed lifecycle controller must provide
two distinct loopback targets, separate fresh data roots/sessions, target
identity/config/source hashes, pair reset receipts, cold/warm ordering, a
candidate fingerprint, and an output nonce. The output path must be new and
inside the Git-ignored `backend/test-output/runtime-concurrency/` tree:

```bash
npm run benchmark:agent-latency -- \
  --base-url http://127.0.0.1:10000 \
  --candidate-url http://127.0.0.1:10001 \
  --runtime openai-agents-sdk \
  --candidate task6 \
  --candidate-config-fingerprint <lowercase-hex-fingerprint> \
  --output-run-nonce <lowercase-hex-nonce> \
  --output-dir test-output/runtime-concurrency/<fresh-run> \
  --lifecycle-receipt /absolute/path/to/lifecycle-receipt.json
```

Omitting `--candidate`, its fingerprint, nonce, and lifecycle receipt is an
availability diagnostic only. It makes no target calls, produces no admission,
and exits non-successfully for admission. A run without the verified lifecycle
receipt remains serial/inconclusive. Targets must be explicit `http` loopback
origins with ports; redirects, credentials, remote hosts, reused output, and
symlinked output paths fail closed.

Admission requires no semantic/evidence/identity/quality-gate regression plus
either at least 15% median total improvement or at least 30% improvement in the
candidate's mapped target phase. A latency regression is material only when it
is both greater than 5% and greater than 250 ms. Real measurement uses three
paired repetitions and treats p95 as inconclusive; deterministic p95 requires
30 genuine-adapter repetitions. Synthetic scorer fixtures are non-admissible.

The internal `RunManifest.performance` receipt is not public SSE. Current SSE
does not provide admission-grade model, provider snapshot, usage, or performance
fields, so bounded real-provider admission remains `INCONCLUSIVE` until a
reviewed harness supplies them. Record missing real credentials/runtime as
`NOT AVAILABLE` or missing harness/configuration as `NOT CONFIGURED`; never
equate deterministic gates with authenticated E2E. Qoder BYOK also requires a
PAT or locally authenticated `qodercli`.

## Agent SSE E2E

Run applicable authenticated E2E for startup/scrolling/Flutter/strategy/verifier/
MCP/scene-critical changes. Backend scripts define the maintained selections:
`verify:e2e:glm-startup`, `verify:e2e:glm-scrolling`,
`verify:e2e:glm-flagship`, `verify:e2e:glm-flagship:strict`,
`verify:e2e:glm-external-issue`, and full `verify:e2e:glm`.
Use `backend/scripts/run-glm-agent-e2e.cjs` with ignored credentials; it selects
the subscribed GLM Coding Plan and explicit provider/model pins, never DeepSeek
or generic OpenAI-key fallback. Pin the Coding Plan endpoint/catalog; native
reasoning/output limits stay unchanged unless explicitly configured. Keep keys
out of command logs and public artifacts. Normal selected runtimes execute
sequentially; separate authenticated runs use at most two concurrent runtimes.
Qoder additionally needs PAT/local CLI authentication; BYOK does not replace it.

Observation timeout must cover the real native deadline/finalization; extending
observation changes neither budget nor acceptance. Runtime/provider/scene lists,
model pin defaults and implementation ownership live in
[Agent Runtime](../../docs/architecture/agent-runtime.md).

Flagship expectations come from `backend/tests/e2e/flagship/*.expectation.json`
and independent trace oracles, not model output. Preserve original startup
classification even when a Skill offers a corrected category. Value, delivery
and proof are separate check groups: value/delivery failure is FAILED; only
missing proof is INCONCLUSIVE; strict PASSED requires all groups and hard flags.
No judged report/unsettled verification is undelivered. Non-strict diagnostic
success, readable output and honest verification annotations are not strict
proof. Lifecycle/authorization/privacy failures still fail their own gates.

Delta baselines bind suite/runtime/trace/query/expectations/provider/model/gate/
processor/stdlib fingerprints (only commit may differ), refuse invalid comparisons
and record staleness. A delta proves regression status, never current acceptance.
Inspect output JSON, session logs, terminal/error events and evidence-supported
conclusion; `answerTokenCount` is streamed chunks, not provider usage/cost. Missing
cross-runtime model/token/cost receipts are `NOT CONFIGURED`; functional matrix
passes are not accuracy/latency/token benchmarks.

For custom scene/Flutter/fast/full reproduction use the existing
`verifyAgentSseScrolling.ts` with an explicit catalog trace, query, mode and
fresh output. Flutter rendering pipelines need separate runs. Stop-semantics
verification starts no backend: run `verify:e2e:stop-semantics` against a
separately isolated real-provider backend and retain pass/legal-race/not-exercised/
fail outcomes. External-issue E2E creates its signal through the production
feedback API in isolated user data, pins the source run, and never writes GitHub;
verify the explicit per-message browser opportunity separately.

## Code-Aware Semantic Delta

Backend `verify:code-aware-semantic-delta` prepares the real-processor fixture
and exercises production registration/audit, A0 no source, A1/A2 on-demand,
A3 indexed, A4 wrong-source and source bindings. Source-result attachment and
output provenance remain owned by `test:source-claim-contract` and
`test:report-contracts`; all three are default-chain reachable without duplicates.
Its deterministic artifact is not provider acceptance. With available credentials,
run the separate repeated matrix:

```bash
node backend/scripts/run-glm-agent-e2e.cjs --suite code-aware-semantic-delta --runtime all-glm --repeat 5
```

Report runtime outcomes separately; Claude/Qoder need separate authenticated
runs. Missing auth remains `REAL PROVIDER NOT AVAILABLE`, never a fixture pass.

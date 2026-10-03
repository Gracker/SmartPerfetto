# Testing Rules

## Proportionate Verification

- Choose the smallest applicable tier below and complete its required checks.
  Use commands defined by this repository's rules, scripts, or documentation
  that the current environment can execute. Record missing entrypoints as
  `NOT CONFIGURED` and unavailable prerequisites as `NOT AVAILABLE`.
- Do not add tests for reversible, low-impact changes merely to restate the
  implementation. Add or update tests when they protect an observable behavior,
  regression boundary, or maintained contract; an existing contract test must
  still match an intentionally changed contract.
- After applicable checks pass, repeat or broaden them only for new changes,
  failures, unresolved doubts, or a required PR/release gate. Reuse evidence only
  when the relevant files, dependencies, configuration, and execution environment
  are unchanged. The PR and exact-archive release gates below still apply.
- Before committing code, simplify only task-owned changes without changing
  behavior: use an available `/simplify`, then a project-defined executable
  simplification script, then `code-simplifier` on PATH. If none is available,
  perform a manual simplification review plus `git diff --check`; record the
  unavailable tool without treating it as a blocker.
- Preserve evidence needed for acceptance. Remove only disposable temporary
  files created by this task; do not clean unrelated work or shared caches.

## Default PR Gate

Before opening or landing a PR, run from the repository root:

```bash
npm run verify:pr
```

This runs root quality checks, Rust checks, backend Skill/Strategy validation,
typecheck, build, CLI package checks, core, architecture, Self-Evolution, and
external issue-reporting tests, trace-processor availability, the constructed
Trace SQL regression, and the 6-trace scene regression gate.

## New Test Files Must Be Registered

`test:core`, `test:architecture`, and `test:self-evolution` enumerate their
targets; new subsystems may use a directory-scoped gate such as
`test:external-issue-reporting`. An unregistered suite never runs in
`verify:pr`.

Jest does not type-check: `tsconfig.json` sets `isolatedModules`, so ts-jest
transpiles each file on its own. `npm run typecheck` checks `src/` and
`tests/`, test files included, as one program through
`tsconfig.typecheck.json`; the build `tsconfig.json` still excludes tests from
emit. Per-file type checking inside ts-jest cost most of the `verify:pr` wall
clock, because every suite rebuilt a language service over the imports it
shared with every other suite. `isolatedModules` also makes `tsc` reject code
that per-file transpilation cannot compile, such as re-exporting a type
without `export type`.

When adding a test file, register it in the matching `test:*` script in the same
change, and make sure that script is reachable from `test:gate`. For a new
subsystem, add a directory-scoped `test:<subsystem>` script and wire it into
`test:gate` rather than listing files one by one. During development, verify
registration from the repository root:

```bash
npm run check:test-registration
```

Then run the owning `test:*` entrypoint for the new or changed suite. Keep the
full `npm run verify:pr` gate before opening or landing a PR; reuse its passing
result only under the unchanged-evidence conditions above.

A suite that is green locally but absent from `test:gate` remains unguarded by
the project gate and cannot satisfy integration acceptance.

Asking people to remember this did not work: when the rule was first written,
237 of 573 backend suites — 41% — were unreachable from any `test:*`/`verify:*`
script, and six of them were failing while `verify:pr` stayed green. One had
rotted outright: a member added to `RagSourceKind` left a fixture in
`sparkContracts.test.ts` type-broken, invisible because the file is both
unregistered and excluded from typecheck.

`npm run check:test-registration` now answers the question mechanically, and
`test:governance` runs it first in `verify:pr`. It lists every suite Jest runs
(`.test.ts`, `.spec.ts`, `.eval.ts`, `_unittest.ts`) under both `backend/src/`
and `backend/tests/`, and counts a suite as reachable only when a Jest command
of a script that root `npm run verify:pr` runs (following `npm run`,
`npm --prefix backend run`, `cd backend && …` and `npm test`) names it or a
directory above it. A `test:*` script outside that chain (`test:unit`,
`test:integration`, `test:skill-eval`) does not count. All suites are
reachable and `scripts/test-registration-baseline.json` is empty, so the
check is zero-tolerance: any new suite the gate cannot reach fails it.

Evals that load a constructed or real trace live in `test:analysis-accuracy`,
which materializes the corpus first. `getTestTracePath` resolves a case id or
alias to the trace it is analyzed on: a real case's committed trace, or a
constructed case's materialized base plus overlay (its committed file is only
the overlay). `describeWithTrace` fails a suite whose case does not resolve or
whose trace is not on disk: seven evals once named a retired fixture and
skipped forever while the gate stayed green. Assert what the fixture carries
instead of returning early when data is missing, and do not accept both a
step's success and its failure; either form passes without checking anything.

Keep it that way. The baseline exists so the check could be introduced without
a 237-file bang; it is not a parking space. `--update-baseline` records
deliberately accepted debt and must be justified in the commit that does it —
a baselined suite is still untested, and the file records what is unguarded
rather than blessing it.

## Dead Code Must Not Keep A Green Suite

`check:test-registration` asks which suites the gate cannot run.
`check:orphaned-modules` asks the mirror question: which modules no live module
imports while a registered suite may still test them. Both failures look
the same from `verify:pr` — everything green — and the second is worse, because
a passing suite reads as proof the behaviour works.

```bash
npm run check:orphaned-modules
```

`phaseHintMatcher.ts` sat in that state with 17 passing tests after the commit
that replaced prescribed plans removed its only call site. The strategy field it
served kept accepting authored `critical_tools`, and Self-Evolution kept
proposing patches to it, with no effect on any analysis.

The check matches a module by its own source path, never by basename: the test
path was itself registered in `package.json`, so a basename match would have
cleared the very module that was dead. Entrypoints are the modules a
`backend/package.json` script or bin, or tooling under `backend/scripts/`,
names by path (a `dist/<path>.js` command names `src/<path>.ts`) and modules
that tooling imports; imports from
`backend/tests/` count as tests, and a sibling naming `<stem>.js` counts as
importing the worker it loads. Re-export shims are never reported, but only a
live shim keeps its target alive.

Location makes nothing an entrypoint. A maintainer script under `src/scripts/`
or a `*Cli.ts` is live only while a `package.json` script or build tooling
runs it, so register a tool you keep (CI and docs invoke it through that
script) and delete one you do not. Unregistered scripts used to count by path, and two January ad hoc
scripts kept the whole `agent/experts/crossDomain` tree reachable for eight
months after the runtime stopped using it. Data or fixtures only a suite reads
belong under `backend/tests/`, not in `src/`. `knip.json` follows the same
rule: its backend production entries (`!`) are these entrypoints, listed by
path rather than by directory, and `check:unused-exports` fails when the two
drift apart.

Orphaned means not reachable from an entrypoint: imported only by tests, by
nothing, or only by other orphans (including cycles). An importer count cannot
see the last shape, because a dead root keeps its whole subtree looking alive.
Counting importers and skipping untested files missed 52 modules, among them
the legacy executor/strategy orchestrator under `agent/core`, which a
2026-09-26 fix still patched before it was deleted.

Reachability is per module, not per export. A module stays reachable while any
live module imports it for one symbol, and a barrel keeps every re-exported
module reachable whether or not anything uses the symbol: `agent/index.ts` once
kept the legacy domain agents, decision trees, experts and pipeline executor
alive while its importers used six symbols. Keep a barrel to what its importers
use. The orphan check sees none of the dead exports this leaves inside a live
module; the export-level gate does:

```bash
npm run check:unused-exports
```

It resolves symbols with knip in production mode, so an export only tests
import is unused, and a same-named local elsewhere cannot hide it. Text search
could not tell them apart: `rg -w` let `createHypothesisId` and `isStringArray`
survive a sweep. A use inside the declaring file counts, so a test seam into
live code passes; one that production never touches can be tagged
`/** @internal */`. Exports of entrypoints themselves are not checked, since
build tooling may read them as text. Run it again after deleting an orphan
root: the exports it alone consumed surface only then, as `skillExecutor`'s
module-expert extractors did once `agent/experts/crossDomain` went.

`scripts/orphaned-modules-baseline.json` and
`scripts/unused-exports-baseline.json` record the modules and exports already
in this state. They are accepted debt, not blessed: each is behaviour the
product does not run, and any suite over it vouches for nothing. Shrink a list
by restoring the call site or deleting the code with its suite;
`--update-baseline` grows it only with a justification in the same commit.

Suites that no focused tier owns live in `test:unit-sweep` (about 40s).
Prefer the tier that matches the change; the sweep is the home for everything
else. Directory-scoped patterns are also supported by the check, but note two
costs before reaching for one: a directory pattern re-runs suites already owned
by another tier (the same suites cost five minutes that way rather than
about 40 seconds), and Jest's `testMatch` treats every `.ts` under `__tests__/` as a
suite, so a fixture such as `sourceFinalizationFixture.ts` fails with "must
contain at least one test".

## Verification by Change Type

| Change type | Required verification |
| --- | --- |
| Docs-only, not runtime-read | `git diff --check` |
| Removing a call site, an export or a module | `npm run check:orphaned-modules`, `npm run check:unused-exports`, plus the owning `test:*` tier |
| Docs that define commands, release/package workflow, or runtime-read paths | `git diff --check` plus the smallest command/path smoke that proves the doc did not drift |
| Build/type fix | `cd backend && npm run typecheck` plus affected tests |
| Contract/type-only change | `cd backend && npx tsc --noEmit` plus relevant contract tests |
| CRUD-only service, no agent/runtime path | That service's `__tests__/<name>.test.ts` |
| MCP, memory, report, provider, session, or agent runtime | `cd backend && npm run test:scene-trace-regression` |
| Raw SQL capture units or native processor provenance | `npm --prefix backend run test:raw-sql-provenance` plus affected parser, worker lifecycle, RPC and capture tests; this gate ensures the pinned binary and materializes the Trace fixture |
| Skill YAML | `cd backend && npm run validate:skills` plus scene trace regression |
| Strategy/template Markdown | `cd backend && npm run validate:strategies` plus scene trace regression |
| Trace corpus, Skill/Strategy coverage, or generator | `npm run trace:regression`; it includes `npm run trace:tooling:test` plus generated-corpus build and SQL execution |
| SQL-bearing Skill or default backend gate wiring | `cd backend && npm run trace:sql-regression`; `npm run verify:pr` includes this gate |
| Frontend generated types | `cd backend && npm run generate:frontend-types` plus relevant tests |
| AI plugin UI | Browser verification in `start-dev.sh`, relevant `perfetto/ui` tests/typecheck, then `./scripts/update-frontend.sh` |
| Self-Evolution control plane | `npm --prefix backend run test:self-evolution`, `npm --prefix backend run typecheck`, and scene trace regression; add the AI plugin UI gate when the panel changes. That script covers RBAC/scope isolation, disabled and dependency fail-closed cases, and fixed validation + holdout replay selection. It is wired into `test:gate`, so `npm run verify:pr` runs it too |
| Agent-assisted external issue reporting | `npm --prefix backend run test:external-issue-reporting`, `npm --prefix backend run typecheck`, strategy validation, scene trace regression, AI plugin typecheck/unit tests, browser verification in `start-dev.sh`, and `./scripts/update-frontend.sh`; verify private/security fail-closed and that no GitHub write occurs |
| Perfetto upstream sync, trace processor pin, SQL/stdlib index, or committed UI prebuild | Follow `.claude/rules/perfetto-sync.md`; normally `git diff --check`, `npm run check:frontend-prebuild`, `npm --prefix backend run cli:e2e`, scene trace regression, submodule remote reachability, and Skill/Strategy validation when those files changed |
| Code-aware analysis, codebase registry, source ingestion, symbol resolution, source-use decisions/bindings, or CodeRef report/export | `npm --prefix backend run verify:codebase-aware`, `npm --prefix backend run test:source-claim-contract`, `npm --prefix backend run test:report-contracts`, `npm --prefix backend run verify:code-aware-semantic-delta`, plus `npm run verify:pr` before landing |
| npm CLI package/release | `npm --prefix backend run cli:pack-check` plus isolated install smoke |
| Portable-impacting code or packaging | Focused launcher/packaging tests, shell and Node syntax/static checks, launcher cross-compile, full package build, package manifest verification, and `npm run verify:pr` before landing; exact-archive target-OS runtime smoke is additionally required for a public release |

## npm CLI Release Verification

When changing CLI packaging, bin entrypoints, CLI runtime assets, Node engine
rules, or npm release docs, run:

```bash
npm --prefix backend run cli:pack-check
```

For a public npm release, additionally verify the published package from an
empty temp directory:

```bash
npm install @gracker/smartperfetto@<version>
./node_modules/.bin/smp --version
./node_modules/.bin/smartperfetto --help
./node_modules/.bin/smp doctor --format json
```

## Portable Packaging Verification

When changing portable packaging, release scripts, version synchronization,
trace-processor handling, bundled runtime assets, or docs that define
the release process, run:

```bash
bash -n scripts/package-portable.sh scripts/release-portable.sh scripts/package-windows-exe.sh scripts/release-windows-exe.sh
shellcheck -x scripts/package-portable.sh scripts/release-portable.sh scripts/package-windows-exe.sh scripts/release-windows-exe.sh
node --check scripts/sync-version.cjs scripts/verify-portable-package.cjs scripts/verify-windows-package.cjs scripts/smoke-portable-archive.cjs
npm run version:sync -- --check
GO111MODULE=off go test ./scripts/portable-launcher
GO111MODULE=off GOOS=windows GOARCH=amd64 go build -o /tmp/smartperfetto-launcher.exe ./scripts/portable-launcher
GO111MODULE=off GOOS=darwin GOARCH=arm64 go build -o /tmp/SmartPerfetto-macos ./scripts/portable-launcher
GO111MODULE=off GOOS=linux GOARCH=amd64 go build -o /tmp/SmartPerfetto-linux ./scripts/portable-launcher
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

## Canonical Scene Regression

Run:

```bash
cd backend
npm run test:scene-trace-regression
```

The regression uses 6 canonical traces:

| Scene | Trace |
| --- | --- |
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scrolling | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scrolling | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

The aliases above resolve through `Trace/catalog.json`; maintained source must not add paths to the retired flat fixture directory. The default backend gate runs `trace:sql-regression`, which materializes committed overlays without the Perfetto source submodule and executes every discovered Skill SQL contract through the production path, explicit read-only/context probes, or isolated state-changing branch probes. Skipped or unavailable SQL fails the gate. Full generator/release verification is `npm run trace:regression`. It runs the registered Trace tooling tests before generated-corpus build and SQL execution. Its report keeps source-column-backed positive semantic coverage, expected-empty negative coverage, deferred prerequisites, execution-only composition, and definition-only contracts separate; inventory assignment alone is not an execution or semantic pass.

## Focused Unit Tests

Useful focused suites:

```bash
cd backend
npx jest src/agentRuntime/__tests__/runtimeSelection.test.ts
npx jest src/agentOpenAI/__tests__/openAiConfig.test.ts src/agentOpenAI/__tests__/openAiRuntime.test.ts src/agentOpenAI/__tests__/openAiToolAdapter.test.ts
npx jest src/assistant/application/__tests__/agentAnalyzeSessionService.test.ts
npx jest src/services/__tests__/canonicalAnalysisResult.test.ts src/services/__tests__/finalResultQualityGate.test.ts
npx jest src/services/verifier/__tests__/claimVerificationRunner.test.ts src/services/__tests__/analysisResultSnapshotStore.test.ts
npx jest src/cli-user/services/__tests__/cliAnalyzeService.runTurn.test.ts src/cli-user/services/__tests__/cliAnalyzeService.test.ts
npx jest src/services/providerManager/__tests__/providerService.test.ts src/services/providerManager/__tests__/providerRoutes.test.ts
npm run test:runtime-resilience
```

Use the result-quality suites when changing final report contract enforcement,
result canonicalization, evidence/claim verification, identity resolution,
analysis-result snapshots, CLI turn persistence, or visible-vs-report
projection behavior.

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

Run Agent SSE e2e when changing startup, scrolling, Flutter, strategy prompt,
verifier, MCP tools, or scene-critical Skills.

Startup:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../Trace/real/android-startup-heavy/trace.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

Deepseek-backed OpenAI runtime startup final-report gate:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek-startup
```

Qoder DeepSeek BYOK startup gate (requires both the DeepSeek provider key and
Qoder PAT or local `qodercli` login; BYOK does not replace Qoder auth):

```bash
cd backend
npm run qoder:install -- --accept-terms
DEEPSEEK_API_KEY=... QODER_PERSONAL_ACCESS_TOKEN=... \
  npm run verify:e2e:qoder-deepseek-startup
```

When Qoder auth is unavailable, record this real-provider gate as unavailable;
do not treat unit/type/build/PR checks as an authenticated Qoder E2E result.

Agent SSE E2E runs that exercise the OpenAI runtime should use Deepseek by
default, not GLM. The canonical wrapper is
`backend/scripts/run-deepseek-agent-e2e.cjs`; it loads `backend/.env`, prefers
`DEEPSEEK_API_KEY` over `OPENAI_API_KEY`, passes `--provider-id env` so the
verification request ignores active Provider Manager profiles, and pins:

- `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`
- `OPENAI_BASE_URL=https://api.deepseek.com/v1`
- `OPENAI_AGENTS_PROTOCOL=chat_completions`
- `OPENAI_MODEL=deepseek-v4-pro`
- `OPENAI_LIGHT_MODEL=deepseek-flash`
- No implicit OpenAI main-answer output cap; an explicit
  `OPENAI_MAX_OUTPUT_TOKENS` must be a positive safe integer. Prompt guidance
  controls normal answer length; provider limits remain authoritative.

Keep API keys out of committed files. Pass `DEEPSEEK_API_KEY` or
`OPENAI_API_KEY` through the shell environment or a local untracked env file
only. `npm run verify:e2e:openai-startup` is a compatibility alias for the
Deepseek startup gate.

Scrolling:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek-scrolling
```

M10 Agent-assisted external issue triage:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek-external-issue
```

This suite requires a persisted source-run provider snapshot, an actionable
deterministic signal, a validated live-Agent review, and either an unsubmitted
GitHub draft or an Agent decision that intentionally blocks public drafting.
The verifier creates that deterministic signal inside its isolated user-data
root by posting a negative conclusion rating through the production feedback
API before requesting the opportunity; it does not inject a synthetic signal
or write to GitHub.
Also verify in browser that a durable public thumbs-down refreshes the same
message into an explicit Agent-triage opportunity without invoking the Agent
or opening GitHub automatically. It never calls the GitHub API.

Complete real-provider matrix:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek
```

For CI-backed real-provider validation, use the manual GitHub Actions workflow
`Agent Deepseek E2E`. It requires the repository secret `DEEPSEEK_API_KEY` and
accepts `suite=all|startup|scrolling|external-issue|context`; keep it manual
because it consumes provider quota and secrets.

`npm --prefix backend run verify:e2e:stop-semantics -- --base-url http://127.0.0.1:<port>`
checks drafts, the provisional answer, review-only/full/forced stops and the
stored history and replay on both the agent route and the conversation API;
each check is `pass`, `legal_race`, `not_exercised` or `fail`. It starts
nothing: run it against a separately started isolated backend (own ports and
data/log/upload dirs) with a real provider.

Flutter TextureView and SurfaceView must be verified separately because their
rendering pipelines differ:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../Trace/real/flutter-scroll-texture-view/trace.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-textureview.json \
  --keep-session

npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../Trace/real/flutter-scroll-surface-view/trace.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-surfaceview.json \
  --keep-session
```

Fast/full mode:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode fast \
  --trace ../Trace/real/android-scroll-customer/trace.pftrace \
  --query "这个 trace 的应用包名和主要进程是什么？" \
  --output test-output/e2e-fast.json

npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode full \
  --trace ../Trace/real/android-scroll-customer/trace.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-full.json
```

After e2e runs, inspect:

- `backend/test-output/e2e-*.json`
- `backend/logs/sessions/session_*.jsonl`
- SSE terminal event counts and error events
- Whether the final conclusion is supported by Skill/SQL evidence

`answerTokenCount` counts streamed SSE answer chunks, not provider tokens. The
current cross-runtime E2E artifact does not provide a common provider-reported
input/output/cache/reasoning-token, TTFT, or cost receipt. Treat mode/model cost
comparison as `NOT CONFIGURED` until those fields and the actual selected model
are recorded; a 21/21 functional matrix is not an accuracy or token benchmark.
For the Claude runtime alone, `npm --prefix backend run metrics:session-baseline --
--stage <label> --since-mins <n> --out <path>` aggregates the per-session
metrics it writes under `backend/logs/metrics/` (turns, tool calls, input and
cache-read tokens, reported cost) so two builds can be compared on the same
queries; other runtimes write no such file.

## Code-Aware Semantic Delta

The registered deterministic gate is:

```bash
npm --prefix backend run verify:code-aware-semantic-delta
```

It materializes the constructed source-analysis trace, runs the real trace
processor, exercises production registration/audit, on-demand and indexed
handlers, and verifies A0–A4 plus source-claim bindings. Its default artifact is
`backend/test-output/code-aware-semantic-delta/deterministic-summary.json`.
This is local deterministic evidence, not provider acceptance.

With credentials safely available, run the separate repeated provider matrix:

```bash
node backend/scripts/run-deepseek-agent-e2e.cjs \
  --suite code-aware-semantic-delta \
  --runtime all \
  --repeat 5
```

Report Claude, OpenAI, Pi, OpenCode, and Qoder independently. Missing auth must
remain `REAL PROVIDER NOT AVAILABLE`; never replace it with a unit, fixture, or
deterministic five-runtime execution result.

## Eval Fixtures

Every skill-eval trace is a Trace corpus case: committed under `Trace/real/`, or
materialized from a committed overlay by `npm run trace:materialize`. There is
no optional fixture. `describeWithTrace(...)` fails, rather than skips, a suite
whose case is unknown or whose trace is missing; add a constructed case through
`Trace/tools` when an eval needs data no case carries.

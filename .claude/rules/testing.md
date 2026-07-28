# Testing Rules

## Default PR Gate

Before opening or landing a PR, run from the repository root:

```bash
npm run verify:pr
```

This runs root quality checks, Rust checks, backend Skill/Strategy validation,
typecheck, build, CLI package checks, core and architecture tests,
trace-processor availability, the constructed Trace SQL regression, and the
6-trace scene regression gate.

## Verification by Change Type

| Change type | Required verification |
| --- | --- |
| Docs-only, not runtime-read | `git diff --check` |
| Docs that define commands, release/package workflow, or runtime-read paths | `git diff --check` plus the smallest command/path smoke that proves the doc did not drift |
| Build/type fix | `cd backend && npm run typecheck` plus affected tests |
| Contract/type-only change | `cd backend && npx tsc --noEmit` plus relevant contract tests |
| CRUD-only service, no agent/runtime path | That service's `__tests__/<name>.test.ts` |
| MCP, memory, report, provider, session, or agent runtime | `cd backend && npm run test:scene-trace-regression` |
| Skill YAML | `cd backend && npm run validate:skills` plus scene trace regression |
| Strategy/template Markdown | `cd backend && npm run validate:strategies` plus scene trace regression |
| Trace corpus, Skill/Strategy coverage, or generator | `npm run trace:regression`; also run the focused Node corpus tests for tooling changes |
| SQL-bearing Skill or default backend gate wiring | `cd backend && npm run trace:sql-regression`; `npm run verify:pr` includes this gate |
| Frontend generated types | `cd backend && npm run generate:frontend-types` plus relevant tests |
| AI plugin UI | Browser verification in `start-dev.sh`, relevant `perfetto/ui` tests/typecheck, then `./scripts/update-frontend.sh` |
| Perfetto upstream sync, trace processor pin, SQL/stdlib index, or committed UI prebuild | Follow `.claude/rules/perfetto-sync.md`; normally `git diff --check`, `npm run check:frontend-prebuild`, `npm --prefix backend run cli:e2e`, scene trace regression, submodule remote reachability, and Skill/Strategy validation when those files changed |
| Code-aware analysis, codebase registry, source ingestion, symbol resolution, or CodeRef report/export | `npm --prefix backend run verify:codebase-aware` plus `npm run verify:pr` before landing |
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
   The smoke probe must bypass environment proxies through a one-shot standard
   library HTTP client fixed to IPv4 loopback, with no connection pooling and
   `Connection: close`. Enforce strict URL, header, response-byte, and
   wall-clock budgets, destroy request/response sockets on every terminal path,
   and cancel and settle the peer probe before launcher shutdown after any
   readiness failure. Do not maintain a release-only HTTP parser that diverges
   from the launcher and normal clients.
4. Execute the bundled Node.js, Claude, and OpenCode version commands when
   present, then run a minimal packaged `trace_processor_shell` operation.
5. Use the launcher-supported shutdown control, require a zero/successful and
   non-escalated shutdown receipt with platform containment
   (`windows-job-object` or `service-process-groups`), and verify child
   processes and listening ports are gone.
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
node --test scripts/__tests__/portable-release-smoke-workflow.test.mjs \
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

The aliases above resolve through `Trace/catalog.json`; maintained source must not add paths to the retired flat fixture directory. The default backend gate runs `trace:sql-regression`, which materializes committed overlays without the Perfetto source submodule and executes every discovered Skill SQL contract through the production path, explicit read-only/context probes, or isolated state-changing branch probes. Skipped or unavailable SQL fails the gate. Full generator/release verification is `npm run trace:regression`. Its report keeps SQL execution coverage separate from assertion-backed semantic coverage and definition-only contracts; inventory assignment alone is not an execution or semantic pass.

## Focused Unit Tests

Useful focused suites:

```bash
cd backend
npx jest src/agentRuntime/__tests__/runtimeSelection.test.ts
npx jest src/agentOpenAI/__tests__/openAiConfig.test.ts src/agentOpenAI/__tests__/openAiRuntime.test.ts src/agentOpenAI/__tests__/openAiToolAdapter.test.ts
npx jest src/assistant/application/__tests__/agentAnalyzeSessionService.test.ts
npx jest src/services/__tests__/agentResultNormalizer.test.ts src/services/__tests__/finalResultQualityGate.test.ts
npx jest src/services/verifier/__tests__/claimVerificationRunner.test.ts src/services/__tests__/analysisResultSnapshotStore.test.ts
npx jest src/cli-user/services/__tests__/cliAnalyzeService.runTurn.test.ts src/cli-user/services/__tests__/cliAnalyzeService.test.ts
npx jest src/services/providerManager/__tests__/providerService.test.ts src/services/providerManager/__tests__/providerRoutes.test.ts
npx jest src/agentv3/__tests__/queryComplexityClassifier.followup.test.ts
```

Use the result-quality suites when changing final report contract enforcement,
agent result normalization, evidence/claim verification, identity resolution,
analysis-result snapshots, CLI turn persistence, or visible-vs-report
projection behavior.

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

Agent SSE E2E runs that exercise the OpenAI runtime should use Deepseek by
default, not GLM. The canonical wrapper is
`backend/scripts/run-deepseek-agent-e2e.cjs`; it loads `backend/.env`, prefers
`DEEPSEEK_API_KEY` over `OPENAI_API_KEY`, passes `--provider-id env` so the
verification request ignores active Provider Manager profiles, and pins:

- `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`
- `OPENAI_BASE_URL=https://api.deepseek.com/v1`
- `OPENAI_AGENTS_PROTOCOL=chat_completions`
- `OPENAI_MODEL=deepseek-v4-pro`
- `OPENAI_LIGHT_MODEL=deepseek-v4-flash`
- `OPENAI_MAX_OUTPUT_TOKENS=8192`

Keep API keys out of committed files. Pass `DEEPSEEK_API_KEY` or
`OPENAI_API_KEY` through the shell environment or a local untracked env file
only. `npm run verify:e2e:openai-startup` is a compatibility alias for the
Deepseek startup gate.

Scrolling:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek-scrolling
```

Startup plus scrolling:

```bash
cd backend
OPENAI_API_KEY=... npm run verify:e2e:deepseek
```

For CI-backed real-provider validation, use the manual GitHub Actions workflow
`Agent Deepseek E2E`. It requires the repository secret `DEEPSEEK_API_KEY` and
accepts `suite=all|startup|scrolling|context`; keep it manual because it consumes
provider quota and secrets.

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

## Fixture Skip Behavior

Some historical skill-eval fixtures are intentionally not included in the
repository. Suites that load optional traces should use `describeWithTrace(...)`
so missing fixture files skip cleanly. The PR gate does not depend on those
historical fixtures; it depends on `test:core` and `test:scene-trace-regression`.

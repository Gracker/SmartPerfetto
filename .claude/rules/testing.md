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
| Portable packaging/release | Shell syntax/static checks, Node script syntax checks, launcher cross-compile, full package build, and package manifest verification |

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
node --check scripts/sync-version.cjs scripts/verify-portable-package.cjs scripts/verify-windows-package.cjs
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
  --commit "$(git rev-parse HEAD)"
```

For a clean public release, the package manifest must contain
`gitDirty: false` and `gitCommit` equal to the release target commit. If testing
the release script without uploading, use a fake `gh` shim or a draft release;
do not rely on `--allow-dirty` for public release validation.

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

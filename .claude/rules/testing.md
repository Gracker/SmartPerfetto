# Testing Rules

## Default PR Gate

Before opening or landing a PR, run from the repository root:

```bash
npm run verify:pr
```

This runs root quality checks, Rust checks, backend Skill/Strategy validation,
typecheck, build, CLI package checks, core tests, trace-processor availability,
and the 6-trace scene regression gate.

## Verification by Change Type

| Change type | Required verification |
| --- | --- |
| Docs-only, not runtime-read | `git diff --check` |
| Build/type fix | `cd backend && npm run typecheck` plus affected tests |
| Contract/type-only change | `cd backend && npx tsc --noEmit` plus relevant contract tests |
| CRUD-only service, no agent/runtime path | That service's `__tests__/<name>.test.ts` |
| MCP, memory, report, provider, session, or agent runtime | `cd backend && npm run test:scene-trace-regression` |
| Skill YAML | `cd backend && npm run validate:skills` plus scene trace regression |
| Strategy/template Markdown | `cd backend && npm run validate:strategies` plus scene trace regression |
| Frontend generated types | `cd backend && npm run generate:frontend-types` plus relevant tests |
| AI plugin UI | Browser verification in `start-dev.sh`, relevant `perfetto/ui` tests/typecheck, then `./scripts/update-frontend.sh` |
| Windows EXE packaging/release | Shell syntax/static checks, Node script syntax checks, full package build, and package manifest verification |

## Windows EXE Packaging Verification

When changing Windows EXE packaging, release scripts, version synchronization,
Windows trace-processor handling, bundled runtime assets, or docs that define
the release process, run:

```bash
bash -n scripts/package-windows-exe.sh scripts/release-windows-exe.sh
shellcheck -x scripts/package-windows-exe.sh scripts/release-windows-exe.sh
node --check scripts/sync-version.cjs scripts/verify-windows-package.cjs
npm run version:sync -- --check
npm run package:windows-exe
node scripts/verify-windows-package.cjs \
  --zip "dist/windows-exe/smartperfetto-v<version>-windows-x64.zip" \
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

## Focused Unit Tests

Useful focused suites:

```bash
cd backend
npx jest src/agentRuntime/__tests__/runtimeSelection.test.ts
npx jest src/agentOpenAI/__tests__/openAiConfig.test.ts src/agentOpenAI/__tests__/openAiRuntime.test.ts src/agentOpenAI/__tests__/openAiToolAdapter.test.ts
npx jest src/assistant/application/__tests__/agentAnalyzeSessionService.test.ts
npx jest src/services/providerManager/__tests__/providerService.test.ts src/services/providerManager/__tests__/providerRoutes.test.ts
npx jest src/agentv3/__tests__/queryComplexityClassifier.followup.test.ts
```

## Agent SSE E2E

Run Agent SSE e2e when changing startup, scrolling, Flutter, strategy prompt,
verifier, MCP tools, or scene-critical Skills.

Startup:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/lacunh_heavy.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

Scrolling:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-scrolling.json \
  --keep-session
```

Flutter TextureView and SurfaceView must be verified separately because their
rendering pipelines differ:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/Scroll-Flutter-327-TextureView.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-textureview.json \
  --keep-session

npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-surfaceview.json \
  --keep-session
```

Fast/full mode:

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode fast \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "这个 trace 的应用包名和主要进程是什么？" \
  --output test-output/e2e-fast.json

npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode full \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
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

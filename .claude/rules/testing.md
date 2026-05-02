# Testing Rules

## Mandatory post-change regression

After EVERY code change, run:
```bash
cd backend && npm run test:scene-trace-regression
```

## Canonical test traces

These 6 traces in `test-traces/` must all pass (2 launch + 4 scroll):

| Scene | Trace File |
|-------|-----------|
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scrolling | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scrolling | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## End-to-end Agent analysis verification (mandatory for startup/scrolling changes)

After **significant** changes to startup or scrolling analysis code (strategy files, verifier logic, system prompt, skill YAML, MCP tools), run a full Agent e2e analysis and review the logs/results:

**Startup (strategy/skill/verifier changes affecting startup):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/lacunh_heavy.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

**Scrolling (strategy/skill/verifier changes affecting scrolling):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/scroll-demo-customer-scroll.pftrace" \
  --query "分析滑动性能" \
  --output test-output/e2e-scrolling.json \
  --keep-session
```

After the test completes:
1. Read the output JSON (`test-output/e2e-*.json`) — check SSE event counts, error events, terminal event
2. Read session logs (`logs/sessions/session_*.jsonl`) — check Agent reasoning quality, phase transitions
3. Verify the conclusion covers all mandatory checks from the strategy (e.g., for startup: Phase 2.6/2.7, JIT, class loading)
4. Report a brief summary to the user

**Flutter (changes to Flutter detection, flutter_scrolling_analysis skill, pipeline skills, or arch-flutter template):**

TextureView（双出图）和 SurfaceView（单出图）的渲染管线完全不同，必须分别验证。

```bash
# Flutter TextureView — 双出图：1.ui → 1.raster → JNISurfaceTexture → RenderThread(updateTexImage + composite)
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/Scroll-Flutter-327-TextureView.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-textureview.json \
  --keep-session

# Flutter SurfaceView — 单出图：1.ui → 1.raster → BufferQueue → SurfaceFlinger
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace" \
  --query "分析 Flutter 滑动性能" \
  --output test-output/e2e-flutter-surfaceview.json \
  --keep-session
```

After the test completes, additionally verify:
1. Agent correctly detects Flutter architecture type (TextureView vs SurfaceView Impeller/Skia)
2. Agent invokes `flutter_scrolling_analysis` (not standard `scrolling_analysis`)
3. For TextureView: identifies dual-pipeline (1.ui + RenderThread updateTexImage) as jank source
4. For SurfaceView: identifies 1.ui/1.raster thread as jank source (not RenderThread)

This is separate from the basic regression test — regression tests verify skills produce data; e2e tests verify the Agent reasons correctly over that data.

## Fast / Full Mode E2E

`verifyAgentSseScrolling.ts` accepts `--mode fast|full|auto` to override `options.analysisMode` and asserts the backend honored it via `fastModeHonored` / `fullModeHonored` checks.

**Fast mode (10-turn lightweight, ~$0.05-0.25/query):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode fast \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "这个 trace 的应用包名和主要进程是什么？" \
  --output test-output/e2e-fast.json
# Assertion: fastModeHonored=true (planSubmittedCount === 0 && architectureDetectedCount === 0)
```

**Full mode (override deterministic hard rule):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode full \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-full.json
# Assertion: fullModeHonored=true, planSubmittedCount > 0
```

**Classifier unit tests (keyword pre-filter + hard rules + priority):**
```bash
cd backend && npx jest src/agentv3/__tests__/queryComplexityClassifier.followup.test.ts
# 27 cases covering DRILL_DOWN_KEYWORDS / CONFIRM_KEYWORDS + each hard rule branch
```

**Known fast-mode limitation**: Heavy queries like `分析启动性能` / `分析滑动性能` can exhaust the 10-turn budget when Claude calls `invoke_skill` and spends turns parsing ~200 KB skill JSON. Steer heavy queries to `--mode full`, or use targeted factual queries (包名 / 启动类型 / 帧率数值) with `--mode fast`.

## Other test commands

```bash
cd backend && npm test                     # All tests (~8 min)
npm test -- --testPathPatterns="__tests__" # Unit tests only (~2 min)
npm test -- tests/skill-eval               # Skill evals only (~5 min)
npm run validate:strategies                # Validate strategy YAML frontmatter
npm run validate:skills                    # Validate skill contracts
```

> Jest 30+ renamed `--testPathPattern` → `--testPathPatterns` (plural). The
> singular form silently fails; if you copy older invocations, switch flag.

## Skill-eval fixture skip behavior

Skill-eval suites (`tests/skill-eval/*.eval.ts`) wrap their top-level
`describe(...)` calls in `describeWithTrace(suiteName, traceName, fn)` (defined
in `tests/skill-eval/runner.ts`). The wrapper:

- runs the suite when `<repo-root>/test-traces/<traceName>` exists
- otherwise marks the suite skipped with `[skipped: missing trace fixture <name>]`

Why: some large `.pftrace` fixtures (`app_aosp_scrolling_heavy_jank.pftrace`,
`app_aosp_scrolling_light.pftrace`) were intentionally removed in commit
`52feac55` and have no in-repo replacement. The wrapper keeps `npm test` clean
on workstations without these fixtures while still exercising the suite when
they're available. **The PR gate (`verify:pr`) does NOT depend on skill-eval —
only `test:core` + `scene-trace-regression`.**

When adding a new top-level `describe(...)` block to an `.eval.ts` file, wrap
it with `describeWithTrace` if the suite calls `loadTrace`. Hoist the
`TRACE_FILE` constant to module scope so the wrapper can reach it.

`app_start_heavy.pftrace` was renamed to `lacunh_heavy.pftrace` in the same
commit — use the new name in any new tests.

## Agent finding verification

~30% of agent findings are false positives. Before implementing fixes from agent reviews:
1. Require code snippet evidence
2. Cross-check with at least 2 sources
3. Run trace regression to confirm

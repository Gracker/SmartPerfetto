# Testing Rules

## Mandatory post-change regression

After EVERY code change, run:
```bash
cd backend && npm run test:scene-trace-regression
```

## Canonical test traces

These 6 traces in `test-traces/` must all pass:

| Scene | Trace File |
|-------|-----------|
| Heavy scrolling jank | `app_aosp_scrolling_heavy_jank.pftrace` |
| Light scrolling | `app_aosp_scrolling_light.pftrace` |
| Standard scrolling | `app_scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| App startup | `app_start_heavy.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## End-to-end Agent analysis verification (mandatory for startup/scrolling changes)

After **significant** changes to startup or scrolling analysis code (strategy files, verifier logic, system prompt, skill YAML, MCP tools), run a full Agent e2e analysis and review the logs/results:

**Startup (strategy/skill/verifier changes affecting startup):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/app_start_heavy.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

**Scrolling (strategy/skill/verifier changes affecting scrolling):**
```bash
cd backend && npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace "../test-traces/Xiaomi17Pro-scrolling-aosp-customscroller-heavy_mixed.ptrace" \
  --query "分析滑动性能" \
  --output test-output/e2e-scrolling.json \
  --keep-session
```

After the test completes:
1. Read the output JSON (`test-output/e2e-*.json`) — check SSE event counts, error events, terminal event
2. Read session logs (`logs/sessions/session_*.jsonl`) — check Agent reasoning quality, phase transitions
3. Verify the conclusion covers all mandatory checks from the strategy (e.g., for startup: Phase 2.6/2.7, JIT, class loading)
4. Report a brief summary to the user

This is separate from the basic regression test — regression tests verify skills produce data; e2e tests verify the Agent reasons correctly over that data.

## Other test commands

```bash
cd backend && npm test                    # All tests (~8 min)
npm test -- --testPathPattern="__tests__" # Unit tests only (~2 min)
npm test -- tests/skill-eval              # Skill evals only (~5 min)
npm run validate:strategies               # Validate strategy YAML frontmatter
npm run validate:skills                   # Validate skill contracts
```

## Agent finding verification

~30% of agent findings are false positives. Before implementing fixes from agent reviews:
1. Require code snippet evidence
2. Cross-check with at least 2 sources
3. Run trace regression to confirm

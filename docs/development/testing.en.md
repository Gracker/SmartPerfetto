# Testing and Verification

[English](testing.en.md) | [中文](testing.md)

SmartPerfetto's default collaboration standard is: run the same entry point before opening a PR that CI also runs.

```bash
# Repository root. Install root and backend dependencies first:
# npm ci
# cd backend && npm ci
npm run verify:pr
```

`verify:pr` runs root quality checks, backend Skill/Strategy validation, typecheck, build, CLI package checks, core unit tests, and the 6 canonical trace regression gate. It automatically downloads the pinned `trace_processor_shell` prebuilt when missing.

## Core Commands

| Scenario | Command |
|---|---|
| TypeScript build | `cd backend && npm run build` |
| Typecheck | `cd backend && npm run typecheck` |
| Core unit tests | `cd backend && npm run test:core` |
| Scene trace regression | `cd backend && npm run test:scene-trace-regression` |
| Skill validation | `cd backend && npm run validate:skills` |
| Strategy validation | `cd backend && npm run validate:strategies` |
| Default gate | `cd backend && npm run test:gate` |
| Full pre-PR entry | `npm run verify:pr` |

## Change Type Matrix

| Change | Required verification |
|---|---|
| Before PR | `npm run verify:pr` |
| Contract / type-only | `cd backend && npx tsc --noEmit` plus relevant tests |
| CRUD-only service, file IO only and no agent path | That service's `__tests__/<name>.test.ts` |
| TypeScript touching MCP / memory / report / agent runtime | `npm run test:scene-trace-regression` |
| Build/type fix | `npm run typecheck` plus the regression for the touched category |
| Skill YAML | `npm run validate:skills` plus regression |
| Strategy/template Markdown | `npm run validate:strategies` plus regression |
| Frontend generated types | `npm run generate:frontend-types` plus relevant frontend tests |
| Rendering pipeline docs that affect Skill `doc_path` | `npm run validate:skills` plus regression |

## Canonical Traces

`test:scene-trace-regression` uses 6 canonical traces:

| Scene | Trace |
|---|---|
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scrolling | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scrolling | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## E2E Agent Verification

When changes affect startup, scrolling, Flutter, system prompts, verifier, MCP tools, or key Skills, Skill regression alone is not enough. Run Agent SSE verification with `backend/src/scripts/verifyAgentSseScrolling.ts`.

## Docs-Only Changes

Normal explanatory docs do not always need full regression. If docs are read at runtime, or if the change also touches `.ts`, `.yaml`, or `backend/strategies/*.md`, follow the matrix above.

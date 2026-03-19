# Backend Rules

## TypeScript conventions

- Strict typing, follow existing patterns in the codebase
- Use TypeScript idioms throughout

## agentv3 (Primary Runtime)

Entry: `agentAnalyzeSessionService.ts` → `isClaudeCodeEnabled()` → `ClaudeRuntime` (default)

Key components:
| File | Purpose |
|------|---------|
| claudeRuntime.ts | Main orchestrator — `IOrchestrator`, wraps `sdkQuery()` |
| claudeMcpServer.ts | 18 MCP tools for trace data access (8 core + 10 conditional) |
| claudeSystemPrompt.ts | Dynamic system prompt — scene-specific strategy injection |
| strategyLoader.ts | Load `*.strategy.md` and `*.template.md` — parse frontmatter + variable substitution |
| claudeSseBridge.ts | SDK stream → SSE events bridge |
| sceneClassifier.ts | Keyword scene classification (scrolling/startup/anr/general, <1ms) |
| claudeVerifier.ts | 4-layer verification (heuristic + plan + hypothesis + scene + LLM) |
| artifactStore.ts | Skill result reference storage — 3-level fetch (summary/rows/full) |
| sqlSummarizer.ts | SQL result summarization — ~85% token savings with `summary=true` |

## agentv2 (Deprecated Fallback)

Activated only when `AI_SERVICE=deepseek`. Do not invest in agentv2 code unless explicitly asked.

## Shared components (`agent/`)

- `agent/detectors/` — Architecture detection (Standard/Flutter/Compose/WebView)
- `agent/context/` — Multi-turn context, entity tracking
- `agent/core/` — Entity capture, conclusion generation, `IOrchestrator` interface

## Build error in unfamiliar file

Check if auto-generated before editing. Look for `// Generated`, `/* Auto-generated */`, or paths containing `generated`, `build`, `dist`. Fix the generator/template instead.

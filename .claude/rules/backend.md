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
| claudeMcpServer.ts | 20 MCP tools for trace data access (9 always-on + 11 conditional) |
| claudeSystemPrompt.ts | Dynamic system prompt — scene-specific strategy injection |
| strategyLoader.ts | Load `*.strategy.md` and `*.template.md` — parse frontmatter (incl. `phase_hints`) + variable substitution |
| queryComplexityClassifier.ts | Query complexity routing — hard rules (7 deterministic scenes) + Haiku fallback |
| claudeSseBridge.ts | SDK stream → SSE events bridge |
| sceneClassifier.ts | Keyword scene classification (12 scenes from strategy frontmatter, <1ms) |
| claudeVerifier.ts | 4-layer verification (heuristic + plan + hypothesis + scene + LLM) |
| artifactStore.ts | Skill result reference storage — 3-level fetch (summary/rows/full) |
| sqlSummarizer.ts | SQL result summarization — ~85% token savings with `summary=true` |
| analysisPatternMemory.ts | Long-term pattern matching, negative pattern learning |
| agentMetrics.ts | Agent performance metrics tracking |
| claudeAgentDefinitions.ts | SDK agent tool definitions, tool descriptions with examples |
| claudeFindingExtractor.ts | Extract structured findings from Claude responses |
| claudeConfig.ts | Claude Agent SDK configuration |
| focusAppDetector.ts | Detect focus application from trace |
| sessionStateSnapshot.ts | Session state persistence |
| types.ts | TypeScript types (SqlSchemaIndex, ClaudeAnalysisContext, planning types) |

## agentv2 (Deprecated Fallback)

Activated only when `AI_SERVICE=deepseek`. Do not invest in agentv2 code unless explicitly asked.

## Shared components (`agent/`)

- `agent/detectors/` — Architecture detection (Standard/Flutter/Compose/WebView)
- `agent/context/` — Multi-turn context, entity tracking
- `agent/core/` — Entity capture, conclusion generation, `IOrchestrator` interface

## Build error in unfamiliar file

Check if auto-generated before editing. Look for `// Generated`, `/* Auto-generated */`, or paths containing `generated`, `build`, `dist`. Fix the generator/template instead.

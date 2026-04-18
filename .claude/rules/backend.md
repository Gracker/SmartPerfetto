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
| queryComplexityClassifier.ts | Query complexity routing — keyword pre-filter (drill-down / short-confirm) + hard rules (7 deterministic scenes) + Haiku fallback |
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

## Analysis Mode Routing (claudeRuntime.analyze)

`AnalysisOptions.analysisMode: 'fast' | 'full' | 'auto'` (default `auto`).
- Explicit `fast` / `full` bypasses `classifyQueryComplexity` entirely (no Haiku latency, overrides deterministic hard rules).
- `auto` runs `applyKeywordRules` → `applyHardRules` → Haiku fallback.
- Metrics: `SessionMetrics.analysisMode` + `classifierSource` (`'user_explicit' | 'hard_rule' | 'ai'`).
- Fast path: `analyzeQuick()` — 5 turns, 3 lightweight MCP tools, no verifier/sub-agents. Full path: 30 turns, 20 tools, verifier + optional sub-agents.

Per-turn timeouts are env-configurable — raise for slower non-Anthropic LLMs:
- `CLAUDE_FULL_PER_TURN_MS` (default 60000)
- `CLAUDE_QUICK_PER_TURN_MS` (default 40000)
- `CLAUDE_VERIFIER_TIMEOUT_MS` (default 60000)
- `CLAUDE_CLASSIFIER_TIMEOUT_MS` (default 30000)

## ⚠️ AnalysisOptions propagation (`agentRoutes.ts`)

`agentRoutes.ts:~2229` calls `orchestrator.analyze(..., options)` with an **explicit whitelist**, not `...options` spread:

```ts
return session.orchestrator.analyze(query, sessionId, traceId, {
  traceProcessorService: options.traceProcessorService,
  packageName: options.packageName,
  // ... whitelisted fields only
});
```

**When you add a field to `AnalysisOptions`, you MUST add it to this whitelist.** Otherwise the HTTP body field silently never reaches the runtime (root cause of an early fast-mode regression: `analysisMode` was in `AnalysisOptions` but missing from the whitelist → quick path never triggered).

## Shared components (`agent/`)

- `agent/detectors/` — Architecture detection (Standard/Flutter/Compose/WebView)
- `agent/context/` — Multi-turn context, entity tracking
- `agent/core/` — Entity capture, conclusion generation, `IOrchestrator` interface

## Build error in unfamiliar file

Check if auto-generated before editing. Look for `// Generated`, `/* Auto-generated */`, or paths containing `generated`, `build`, `dist`. Fix the generator/template instead.

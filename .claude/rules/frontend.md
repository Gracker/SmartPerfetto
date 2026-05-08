# Frontend Rules

## Plugin location

`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`

Key files:
- `ai_panel.ts` — Main UI panel
- `sql_result_table.ts` — Data table (schema-driven from DataEnvelope)
- `ai_service.ts` — Backend communication
- `chart_visualizer.ts` — Chart visualization
- `mermaid_renderer.ts` — Mermaid diagram rendering (lazy-load, CSP compliant)
- `navigation_bookmark_bar.ts` — Navigation bookmarks
- `scene_navigation_bar.ts` — Scene-level navigation
- `session_manager.ts` — localStorage session persistence
- `sse_event_handlers.ts` — SSE event dispatch (pure functions)
- `assistant_api_v1.ts` — Agent API v1 client
- `assistant_command_bus.ts` — Command bus for cross-component communication
- `intervention_panel.ts` — User intervention UI
- `scene_reconstruction.ts` — Scene reconstruction display
- `settings_modal.ts` — Settings UI
- `track_overlay.ts` — Track overlay rendering
- `auto_pin_utils.ts` — Auto-pin utility functions
- `data_formatter.ts` — Data formatting utilities
- `conclusion_contract_aliases.ts` — Conclusion contract type aliases
- `types.ts` — AIPanelState (incl. `analysisMode: 'fast' | 'full' | 'auto'`), Message, AISession, StreamingFlowState
- `index.ts` — Plugin entry point

Subdirectories:
- `generated/` — Auto-generated types from backend (`data_contract.types.ts`, `frame_analysis.types.ts`, `jank_frame_detail.types.ts`) — do NOT edit manually, use `npm run generate:frontend-types`
- `renderers/` — Data formatters (`formatters.ts`)

## Mermaid chart support

- Lazy-load from same-origin `assets/mermaid.min.js` (CSP compliant)
- Base64 encoded chart source in `data-mermaid-b64` attribute
- Error handling + source code collapse display

## Analysis Mode Chip

`ai_panel.ts::renderAnalysisModeChips()` renders a segmented control above the input wrapper:
`[⚡ 快速] [🔍 完整] [🤖 智能]`

- `AIPanelState.analysisMode` is sticky via `localStorage['ai-analysis-mode']` (default `'auto'`).
- `onAnalysisModeChange()` clears `agentSessionId` on mid-session mode switch so the backend opens a fresh SDK session (avoids 10-turn quick vs 60-turn full context mix) and appends a system message toast.
- Fast chip is **disabled** under comparison mode (`state.referenceTraceId` set): `buildQuickSystemPrompt` does not accept `selectionContext` and the lightweight MCP registration skips comparison tools.
- Request body: `options.analysisMode` is sent with every `POST /api/agent/v1/analyze`.

## Perfetto submodule

This is a forked Google project. See `rules/git.md` for push rules.

## Prebuilt frontend contract

- Pure users, `./start.sh`, Docker Hub, and source Docker builds all serve the committed pre-built UI from the root `frontend/` directory.
- Docker users must not need the Perfetto submodule, frontend dev dependencies, or `build.js --watch`; `Dockerfile` must copy `frontend/` into `/app/perfetto/out/ui/ui`.
- After any change under `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`, run and commit `./scripts/update-frontend.sh` after browser verification.
- `scripts/update-frontend.sh` must preserve SmartPerfetto static assistant assets in `frontend/index.html`: `assistant-flamegraph.css`, `assistant-flamegraph.js`, and `assistant-critical-path.js`.
- The same script must remove stale sibling `frontend/v*` directories. Do not leave old prebuilt version directories for a later manual cleanup.

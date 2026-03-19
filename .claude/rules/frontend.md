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
- `types.ts` — AIPanelState, Message, AISession, StreamingFlowState
- `index.ts` — Plugin entry point

## Mermaid chart support

- Lazy-load from same-origin `assets/mermaid.min.js` (CSP compliant)
- Base64 encoded chart source in `data-mermaid-b64` attribute
- Error handling + source code collapse display

## Perfetto submodule

This is a forked Google project. See `rules/git.md` for push rules.

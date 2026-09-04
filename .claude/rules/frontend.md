# Frontend Rules

## Plugin Location

SmartPerfetto's Perfetto UI plugin lives at:

```text
perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
```

Key files:

- `index.ts`: plugin registration.
- `ai_panel.ts`: main AI assistant panel.
- `ai_sidebar_panel.ts`: sidebar integration.
- `ai_floating_window.ts`, `ai_floating_state.ts`: floating assistant window.
- `assistant_api_v1.ts`: backend Agent API URL boundary.
- `agent_sse_transport.ts`: authenticated Agent SSE URL/header/replay cursor.
- `conversation_client.ts`: lightweight conversation API and stream client.
- `sse_event_handlers.ts`: SSE event handling.
- `session_manager.ts`: localStorage session persistence.
- `assistant_command_bus.ts`: cross-component command bus.
- `provider_panel.ts`, `provider_form.ts`, `provider_switcher.ts`: provider UI.
- `self_evolution_api.ts`, `self_evolution_panel.ts`: scoped Self-Evolution
  admin client and control-plane UI.
- `comparison_state_manager.ts`: reference trace comparison state.
- `critical_path_extension.ts`: selected-slice critical path UI extension.
- `ai_area_selection_tab.ts`: area/range selection workflow.
- `sql_result_table.ts`: DataEnvelope table rendering.
- `chart_visualizer.ts`: chart rendering.
- `mermaid_renderer.ts`: same-origin Mermaid rendering.
- `navigation_bookmark_bar.ts`, `scene_navigation_bar.ts`, `track_overlay.ts`,
  `ai_timeline_notes.ts`: timeline/navigation helpers.
- `generated/`: generated frontend types from backend contracts. Do not edit
  manually.
- `renderers/`: DataEnvelope formatters.

## User and Docker Contract

There are two frontend modes:

- `./start.sh`: default user path. Serves the committed pre-built `frontend/`
  bundle and does not require the `perfetto/` submodule.
- `./scripts/start-dev.sh`: UI development path. Builds the Perfetto UI
  submodule from source and hot-reloads plugin changes.

Docker Hub images and source Docker builds also consume the committed
`frontend/` bundle. They must not require contributors or users to build the
Perfetto submodule.

## Updating Prebuilt Frontend

After any change under `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`:

1. Run `./scripts/start-dev.sh`.
2. Verify the UI change in the browser at `http://localhost:10000`.
3. Run relevant Perfetto UI tests/typecheck for the touched code.
4. Stop `./scripts/start-dev.sh`. Its HMR server intentionally does not emit
   the production `frontend_bundle.js` and `frontend.css` artifacts.
5. Run `(cd perfetto && tools/node ui/build.mjs)` to produce the standalone
   production bundle.
6. Run `./scripts/update-frontend.sh`.
7. Commit the plugin source, `frontend/index.html`, the active `frontend/v*`
   bundle, and any SmartPerfetto static assistant assets that changed.

`scripts/update-frontend.sh` is the supported way to refresh `frontend/`. It
must preserve:

- `assistant-flamegraph.css`
- `assistant-flamegraph.js`
- `assistant-critical-path.js`

It also removes stale sibling `frontend/v*` directories. Do not leave old
prebuilt version directories for a later manual cleanup.

## Generated Types

Do not manually edit:

```text
perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/*.ts
```

Regenerate from backend contracts with:

```bash
cd backend
npm run generate:frontend-types
```

## SSE and Session Semantics

The plugin talks to `/api/agent/v1/*`.

- `conclusion` is near terminal: show the answer as soon as it arrives.
- `analysis_completed` is terminal: report generation has finished and report
  metadata is available.
- Mode/provider changes that alter SDK context must start a fresh backend agent
  session instead of reusing a session with incompatible turn budgets or
  provider state.
- The Self-Evolution admin stream is under
  `/api/admin/self-evolution/operations/:operationId/events`. Consume it with
  `fetch()` plus a bounded incremental parser, not native `EventSource`, because
  backend Authorization and workspace headers are mandatory.

## Analysis Process View

The `streaming_flow` message is the analysis process view (`### 🧭 分析过程`).
It renders below the answer within a round — see `message_order.ts` — so the
answer stays next to the question and the process reads as reference below it.

- Keep steps structured (`StreamingFlowState.conversationSteps`) all the way to
  render. Pre-formatting each step into a string destroys the phase grouping
  before the renderer can use it, and the retained-step cap then leaves steps
  indented under a header that was trimmed away.
- Plan phase boundaries are identified by `sourceEventType === 'plan_phase_updated'`,
  never by matching the localized wording. Runs without boundaries must render
  a flat list: private-knowledge runs suppress `plan_phase_updated`, and quick
  mode has no plan at all.
- Do not mirror answer text into the process view. The answer streams in its
  own bubble; snapshots there printed the same text twice once the process view
  moved below the answer. Start and completion markers are fine.
- The stop control has two forms: plain stop, and stop-and-redirect, which
  focuses the composer only after the backend confirms the matching `runId`
  reached a terminal state. Cancellation can still be waiting on run identity,
  and a failed stop restores the SSE stream, so focusing earlier would invite
  input against a live run.

## Run Conflicts

`POST /analyze` and `POST /sessions/:id/runs` answer 409 for two unrelated
situations, and only the code separates them. `analysis_run_conflict.ts` owns
that distinction.

- `CANCELLATION_IN_PROGRESS` and `RUN_ALREADY_ACTIVE` mean the session is busy,
  not that the request is wrong. A cancelled run keeps session ownership until
  its outer execution settles, so the cancel endpoint reports `cancelled`
  roughly 2.4s before a new run is accepted — exactly the window a user types
  into after stop-and-redirect. Wait it out with a bound, then surface the
  original response.
- Every other 409 keeps its existing handling. Retrying a code-aware context
  conflict would loop against a backend that will keep refusing.

## Self-Evolution UI

- Bind the panel to the saved backend URL and credential. If connection edits
  are unsaved, keep reads on the saved backend and disable mutations.
- Render requested/effective flags, persistence failure reason, proposal
  lifecycle/diff, overlay state, reconciliation identity, and the explicit
  external-judge consent status. Do not imply that a requested flag is
  effective.
- Gate, accept/reject, contribution export, apply, and revert remain distinct
  human actions. Disable impossible actions for the known lifecycle state, but
  treat backend RBAC/state checks as authoritative.
- Keep dynamic counts tabular, dense lists separated by dividers, and action
  hit areas at least 40px. Avoid nested decorative cards and `transition: all`.

## UI Implementation Conventions

- Follow existing Perfetto UI plugin style and TypeScript patterns.
- Keep SSE event transforms pure when possible; test them with focused unit
  tests.
- Keep DataEnvelope rendering schema-driven; do not special-case rows in the
  panel when the backend contract can describe them.
- Avoid card-on-card composition and decorative UI that reduces timeline/data
  density.
- Keep conversation messages copyable.

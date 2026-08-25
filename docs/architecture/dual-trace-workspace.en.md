# Dual Trace Workspace Operation Model

[English](dual-trace-workspace.en.md) | [中文](dual-trace-workspace.md)

This document defines the Web UI operation model for Raw Trace Compare. It
extends the comparison-mode section in [Architecture Overview](overview.en.md)
and focuses on user operations, AI Panel context, frontend/backend coordination,
and edge cases. Analysis Result Compare still uses the workspace comparison API
and is out of scope here.

## Product Principles

- The default remains single-window. Opening a normal trace shows one Perfetto
  timeline and the AI Panel.
- The no-trace AI Assistant page also exposes a `Dual Trace` entry. It opens two
  empty panes so the user can upload one new local trace into each side.
- The AI Panel header provides a direct `Open Dual View` button. It immediately
  uses the current page trace as the initial baseline in the left/top pane and
  opens an empty comparison pane; no separate picker step is required first.
- Both physical panes have a trace selector. Left/top is always the baseline
  and right/bottom is always the comparison; both can choose any trace from the
  current workspace.
- Empty panes expose `Upload trace`; populated panes expose `Replace`. Upload
  progress and errors are pane-local and may run concurrently. Both controls
  lock while a run is active or cancellation is pending.
- History options use `filename` as the primary label. Upload time and file size
  are secondary metadata; trace ids remain identity keys rather than the main
  user-facing label.
- The page trace is retained as `pageTrace` only for the initial default and
  host lifecycle. It is not required to remain in the pair, so arbitrary
  history-versus-history pairs are supported. Compatibility roles
  `current/reference` mean baseline/comparison.
- Choosing the trace already shown on the other side or clicking `Swap`
  atomically reverses baseline/comparison without a duplicate intermediate state.
- Layout changes, maximize/minimize, and AI Panel hide/show only change visual
  state. They do not destroy or reload existing iframes.
- The dual workspace header owns a persistent `AI Assistant` button. It is the
  in-workspace control for collapsing or restoring the conversation panel while
  retaining the workspace controller, iframe identities, run, and SSE owner.
- While analysis is running or waiting for confirmed cancellation,
  `baseline + comparison + agent session/run` is one locked execution identity.
  Selectors, new-pair creation, comparison exit, session/New Chat, provider,
  workspace, backend URL, and backend access-token changes cannot replace it.
  Layout, splitter, maximize/minimize, AI Panel hide/show, and reopening the
  visual workspace for the same pair remain available. Only explicit Stop
  enters the backend cancellation protocol.
- Collapsing the AI Panel is visual-only and retains the same Panel and SSE
  owner. Even before `/analyze` returns a session id, reopening still exposes
  Stop for that request. Pop Out/Dock operations that would change the Panel's
  mount owner are deferred until the run reaches a terminal state.
- Explicitly exiting the dual view, unloading the current trace, or switching
  workspace destroys the dual-view iframes. Exiting only the visual workspace
  may preserve its pair and AI comparison context; `Exit comparison`
  additionally clears the pair, context, and comparison agent session.
- Dual workspace iframes do not own new AI sessions and do not re-upload traces.
  They are complete Perfetto timeline views only.
- Local/API-key mode persists the pair, layout, split, and open state within the
  current backend/workspace scope. Reload and a normal backend restart restore
  the workspace while the backend retains its traces and completed analysis
  records. An unfinished run restores as interrupted, never as still running.

## State Machine

| State | UI | Backend comparison capability | Entered by | Leaves by |
| --- | --- | --- | --- | --- |
| Dual workspace empty | Two empty panes, each with upload | No trace tools | Click `Dual Trace` on the no-trace AI Assistant page | Upload first trace, explicitly exit, or switch workspace |
| Single trace | One timeline + AI Panel | Single-trace tools | Normal trace open, exit comparison, workspace switch, new trace reset | Click `Open Dual View` |
| Dual workspace draft | One timeline plus one upload/select empty pane | Still single-trace tools | Upload the first trace, or click `Open Dual View` on a normal trace | Upload/select a second trace, explicitly exit, or switch trace/workspace |
| Dual workspace paired | Two complete timelines with arbitrary workspace selectors | `traceId/referenceTraceId` bind baseline/comparison and comparison tools are available | Select a distinct trace in the second selector | Explicitly exit dual view, exit comparison, or switch trace/workspace |
| Comparison context | One timeline + comparison bar | `referenceTraceId` and comparison tools remain available | Explicitly exit a paired dual view | Reopen dual view, exit comparison, or switch trace/workspace |
| Pane minimized | One live iframe + one minimized rail | Both traces remain analyzable; minimized pane is `context_only` | Pane minimize button | Restore rail, reset, maximize another pane, exit |
| Pane maximized | One iframe fills the workspace | Maximized pane is `live`; other pane is `context_only` | Pane maximize button | Restore, reset, exit |

## Loading Flow

### 1. Open Dual View With No Trace

1. The user clicks `Dual Trace` on the no-trace AI Assistant page.
2. Conversation Page creates a workspace controller with no `pageTrace` and
   immediately renders two empty panes.
3. The user chooses one local file for each side. Each pane independently uses
   the existing backend uploader, then binds the returned workspace trace to
   that side. Both uploads may run concurrently.
4. The first success enters draft; the second distinct trace enters paired.
   A failure stays local to its pane and does not clear the successful side.
5. Once paired, the parent page opens the baseline in the main Viewer through
   `smartperfettoWorkspaceTraceId`. The Viewer restores the same persisted
   controller, both iframes, and the AI comparison context.

OIDC retains page-local trace ownership and cannot reopen arbitrary uploads via
a backend workspace file URL, so the no-trace entry is disabled with an explicit
explanation. This flow is limited to local/API-key mode.

### 2. Normal Trace Load

1. The user opens a trace in Perfetto UI.
2. The frontend uploads/registers it through `/api/traces/upload` or an existing
   HTTP RPC target.
3. Once `backendTraceId` is ready, the AI Panel becomes analyzable.
4. `referenceTraceId = null` and the dual workspace is not open yet.

If the current backend trace is not ready, the comparison entry should not open
a partial workspace.

### 3. Open Directly From a Normal Trace

1. The user clicks `Open Dual View` in the AI Panel header.
2. The frontend requires only a ready current `backendTraceId`; a
   `referenceTraceId` is not required yet.
3. The trace-scoped workspace controller immediately opens
   `ai-trace-pair-workspace`. The first pane shows the page trace as the initial
   baseline, and the second pane shows a `Select a comparison trace` empty state.
4. The frontend concurrently loads the current workspace's full trace catalog
   and merges it with the page trace as a deduplicated candidate set.
5. Each history option uses `filename` as its label. Localized upload time and
   file size are appended only when same-name records need disambiguation.
   Records with the same filename remain distinct by id.

At this point the dual-view shell is usable, but AI requests remain single-trace
until the user selects history: no `referenceTraceId` is sent and comparison
tools are not enabled.

### 4. Select or Upload a Trace in Either Pane

1. Both pane selectors list the page trace and every available history trace.
2. The first (left/top) selector updates the baseline; the second (right/bottom)
   selector updates the comparison.
3. Choosing the trace already displayed on the other side atomically swaps the
   pair; the explicit `Swap` button performs the same transition.
4. A complete pair stores `tracePairBaselineBackendTraceId` for the baseline
   and retains `referenceTraceId/referenceTraceName` for API/session compatibility.
5. The two selections must be distinct, but `history A + history B` is valid.
6. An empty side may upload directly, and a populated side may upload a
   replacement. Success follows the same selection and session-retirement rules.

Changing one side reloads only that iframe. Swapping reverses
`traceId/referenceTraceId` and delta direction. Any pair identity or direction
change retires an incompatible Agent continuation.

### 5. Iframe Loading

Once the workspace is open, each pane with a selected trace creates a
same-origin iframe with:

- `hideSidebar=true`
- `mode=embedded`
- `smartperfettoDualTrace=true`
- `smartperfettoPane=current|reference`
- `url=/api/workspaces/:workspaceId/traces/:traceId/file`

`load_trace.ts` sees `smartperfettoDualTrace=true` and skips AI backend upload.
Each iframe uses Perfetto UI's own WASM engine to load a complete timeline. The
empty comparison pane has no iframe until the user selects a second trace.

The main AI Panel remains the only conversation entry.

## Workspace Operations

| Operation | Entry | State change | AI context effect |
| --- | --- | --- | --- |
| Upload/replace trace | Pane upload control | Updates only the target pane; progress/errors are independent; success adds the trace to the catalog and selects that side | Comparison tools remain disabled until paired; pair identity changes reset incompatible session state |
| Select a trace for a pane | Either pane selector | First updates baseline, second updates comparison; choosing the opposite trace swaps | `primarySide/referenceSide` map first/second; any pair identity change resets incompatible comparison session state |
| Swap baseline/comparison | Workspace toolbar | Atomically reverses the two trace identities while retaining layout | Reverses `traceId/referenceTraceId` and delta direction; resets incompatible session state |
| Horizontal/vertical layout | Workspace toolbar | `tracePairLayout = horizontal|vertical`, clears maximized, retains both iframe nodes | `primarySide/referenceSide` map to left/right or top/bottom |
| Drag splitter | Middle separator | Updates `tracePairSplitPercent`, clamped to 18-82 | `splitPercent` enters `tracePairContext` |
| Maximize pane | Pane toolbar | `tracePairMaximizedTraceSide = current|reference`, clears minimized, keeps iframe mounted | Maximized pane is `live`; the other is `context_only` |
| Minimize pane | Pane toolbar | `tracePairMinimizedTraceSides = {side}`, clears maximized, keeps iframe mounted | Minimized pane is `context_only`; the other is `live` |
| Restore minimized pane | Minimized rail | Removes side from minimized set and reuses the same iframe | Pane becomes `live` |
| Open pane in new tab | Pane toolbar | No current-state change | Auxiliary viewing only |
| Hide/show AI Panel | AI Panel entry | Toggles only the conversation surface; dual host, controller, and iframes remain | No change |
| Exit dual view | Workspace header | Closes the visual workspace, destroys its iframes, and clears max/min | Existing comparison context remains; workspaceOpen becomes false |
| Exit comparison | Comparison bar | With no active run, clears pair, agent session, and workspace state; disabled while running | Future requests become single-trace |

The dual host belongs to the page-trace lifecycle and is a sibling of the AI
Panel's Right/Bottom/floating/hidden surface. Layout, maximize/minimize, and AI
Panel hide/show reuse the same semantic iframe nodes and `src` values. Only
explicit dual-view exit, page-trace unload, or workspace switch destroys them;
reopening creates them again. A new baseline or comparison trace reloads only
the corresponding side.

## AI Panel Context Contract

When `referenceTraceId` exists, the frontend sends `tracePairContext` with the
analysis request:

```json
{
  "traceId": "baseline-trace-id",
  "referenceTraceId": "comparison-trace-id",
  "options": {
    "tracePairContext": {
      "schemaVersion": 1,
      "layout": "horizontal",
      "primarySide": "left",
      "referenceSide": "right",
      "activeSide": "right",
      "workspaceOpen": true,
      "splitPercent": 50,
      "panes": [
        {
          "side": "left",
          "traceSide": "current",
          "traceId": "baseline-trace-id",
          "traceName": "baseline.perfetto-trace",
          "active": false,
          "visualState": "live"
        },
        {
          "side": "right",
          "traceSide": "reference",
          "traceId": "comparison-trace-id",
          "traceName": "comparison.perfetto-trace",
          "active": true,
          "visualState": "live"
        }
      ],
      "aliases": {
        "left": "current",
        "right": "reference",
        "top": "current",
        "bottom": "reference",
        "baseline": "current",
        "comparison": "reference",
        "current": "current",
        "reference": "reference"
      }
    }
  }
}
```

Rules:

- Top-level `traceId` is the baseline selected in the first pane;
  `referenceTraceId` is the comparison selected in the second pane. Either may
  be a historical trace.
- `current` and `reference` are API/tool compatibility roles for
  baseline/comparison. `primarySide/referenceSide`, pane sides, and aliases map
  stably to first/second.
- Selecting the trace already displayed on the other side must atomically swap
  identities without constructing a duplicate pair.
- Swapping or changing either trace changes direction or identity and must drop
  incompatible prior comparison session state.
- `activeSide` comes from the latest hovered/focused pane. When the workspace is
  closed, current is active by default.
- `visualState=live` means the pane is visible. `context_only` means the trace
  is still analyzable but not currently visible.
- Backend normalization drops illegal sides/layouts, duplicate minimized sides,
  and clamps split to 18-82.

## Frontend/Backend Coordination

| Layer | Responsibility |
| --- | --- |
| No-trace Conversation Page | Provides the zero-start workspace, owns both pane uploads, and hands the complete pair to the main Viewer |
| Perfetto UI main page | Opens the page trace, restores the persisted pair, and owns the controller, upload handler, and host independently of whether the AI Panel is mounted |
| AI Panel | Provides the direct dual-view entry, loads the workspace catalog, builds `tracePairContext`, and sends baseline `traceId` plus comparison `referenceTraceId` |
| Pane controls | Display page/history traces by filename, upload or replace the target side, and maintain stable baseline/comparison selection plus atomic swapping |
| Dual workspace iframe | Loads a full Perfetto timeline from a workspace trace file URL; visual-only changes keep its node and `src`, and it never owns a comparison session |
| `load_trace.ts` | Detects `smartperfettoDualTrace=true` and skips backend AI upload; preserves workspace trace launch arguments during the main Viewer handoff |
| Workspace persistence | Stores open state, pair, layout, and split by backend URL/workspace; restores only in local/API-key mode |
| Backend analyze route | Normalizes `tracePairContext` and passes `referenceTraceId` to the runtime |
| MCP registry | Exposes comparison tools only when `referenceTraceId` exists |
| Agent runtime | Uses shared comparison methodology and resolves baseline/comparison or left/right/top/bottom; tools retain current/reference compatibility roles |
| Report/snapshot | Keeps the raw trace comparison evidence/report/session snapshot contract aligned with CLI `smp compare` |

## Edge Cases

- Current trace not ready: the normal trace-page entry cannot use it as an
  initial baseline. The no-trace page remains a valid separate entry and builds
  backend trace identities through pane uploads.
- No comparison trace: still open either initial-baseline-plus-empty or two
  empty panes. Empty panes offer upload; selectors still reject self-comparison.
- Reload or backend restart: local/API-key mode restores the last open state,
  pair, layout, and split for the same backend/workspace. Existing backend
  storage remains authoritative for trace files and completed sessions/reports/
  snapshots. Active connection state is not persisted as resumable; an
  unfinished run appears in its recorded interrupted/failed terminal state.
- Either pair trace cannot be read: the affected iframe shows the Perfetto
  load failure; backend SQL/Skill calls report the actual trace-service error.
- User opens a new trace: destroy dual-view iframes, reset to Single trace,
  clear pair/workspace state, and create or restore the new trace's session.
- Workspace switch: destroy dual-view iframes and clear catalog, pair,
  workspace state, and agent session; URLs must use the new workspace path.
- Dual view exited: its iframes are destroyed, but `referenceTraceId` remains,
  so future questions are still dual-trace comparison with
  `workspaceOpen=false`. Reopening recreates the iframes for the same pair.
- Comparison exited: `referenceTraceId` is cleared; future requests no longer
  register comparison tools or send `tracePairContext`.
- Pane minimized/maximized or layout changed: hidden panes are still analyzable
  and should be described as context-only, not missing. These visual changes
  preserve both iframe DOM nodes and `src` values.
- AI Panel hidden/shown or repositioned: Right/Bottom/floating/hidden AI Panel
  state neither unmounts the dual view nor reloads its iframes, and does not
  change baseline/comparison semantics.
- Pane selector changes: first updates baseline and second updates comparison.
  Choosing the opposite trace or `Swap` atomically reverses the pair; arbitrary
  `history A versus history B` pairs are supported.
- Multi-turn sessions: entering comparison drops incompatible single-trace agent
  state; exiting comparison drops comparison agent state. Provider/runtime
  pinning still follows normal session rules.

## Completion Criteria

Dual Trace Workspace changes are complete only when current evidence proves:

- Normal trace open defaults to a single timeline.
- The no-trace AI Assistant page opens two empty panes and can upload two new
  local traces concurrently into the requested sides.
- A populated pane can independently replace its trace. One-side failure does
  not affect the other side, and upload/replace locks during run/stop pending.
- Clicking `Open Dual View` in the AI Panel header immediately displays the
  initial-baseline-plus-empty-comparison shell without a prior history selection.
- Both pane selectors work; any two distinct workspace traces can form a pair,
  and choosing the opposite trace atomically swaps the two sides.
- History options lead with filename and use time/size as secondary metadata;
  distinct ids with the same filename remain separately selectable.
- Selecting a comparison displays two complete timelines; the page trace is
  not required to remain in the pair.
- Horizontal/vertical layout, dragging, minimize/maximize, and AI Panel
  hide/show do not replace or reload existing iframes.
- During analysis, selectors and every session-identity mutation stay locked,
  while layout operations, AI Panel hide/show, and visual reopening of the same
  pair neither stop nor replace the active run.
- Settings, workspace, backend URL/access token, and Provider writes stay
  locked during a run. Pre-session hide/show retains the same Stop owner, and
  collapsing an established SSE does not reconnect it.
- Explicit dual-view exit, trace unload, and workspace switch destroy the
  iframes; exit comparison additionally clears reference and comparison session.
- Dual workspace iframes do not create extra backend trace uploads.
- Dual workspace iframes retain only the timeline and parent redraw bridge; they
  do not register an AI Panel, status entry, or independent session owner.
- A completed zero-start pair hands off to the main Viewer without changing the
  baseline, comparison, layout, or AI context.
- Reload and normal backend restart restore the last local/API-key pair and
  layout; unfinished runs are explicitly interrupted instead of fake-resumed.
- Stop carries the exact `runId` from the current receipt. A replacement run in
  the same session waits until the cancelled runtime has fully settled, so
  late cleanup from the old run cannot terminate or contaminate the new run.
- `tracePairContext` remains correct for arbitrary baseline/comparison pairs,
  explicit swaps, dual view open/exited, vertical/horizontal, and max/min states.
- Backend normalization and system prompt handling are stable for invalid or
  missing fields.
- The committed `frontend/` prebuild has been refreshed for `./start.sh`.

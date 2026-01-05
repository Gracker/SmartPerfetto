# SmartPerfetto Development Guide for AI Agents

This document provides essential context for developing SmartPerfetto, explaining the project structure, frontend-backend relationship, and key architectural decisions.

## Project Overview

**SmartPerfetto** is an AI-driven Perfetto analysis platform that helps developers analyze Android performance data through natural language queries.

```
SmartPerfetto
├── Frontend: Perfetto UI (TypeScript + Mithril.js) @ localhost:10000
├── Backend:  Node.js/Express API @ localhost:3000
└── Shared:   trace_processor (HTTP RPC) @ localhost:9100-9900
```

### Key Architecture Principles

1. **HTTP RPC Shared Architecture**: Frontend and backend share the same trace_processor instance via HTTP RPC
2. **YAML-Driven Skill Engine V2**: Analysis logic is defined in YAML files, not hardcoded
3. **Layered Result Organization**: Results are organized into layers (L1/L2/L4) for progressive disclosure
4. **stepId-Based Data Keys**: Backend uses YAML `id:` field as key; frontend must match exactly

## Quick Reference: Where to Make Changes

| Change Type | Frontend Location | Backend Location |
|-------------|-------------------|------------------|
| **Add new analysis** | `perfetto/ui/src/components/skill/` | `backend/skills/v2/composite/` |
| **Modify result display** | `perfetto/ui/src/components/skill/l*.ts` | `backend/src/services/skillEngine/skillExecutorV2.ts` |
| **Fix data key mismatch** | `perfetto/ui/src/components/skill/` | N/A (frontend must match backend stepId) |
| **Add new Skill** | N/A | `backend/skills/v2/composite/*.skill.yaml` |
| **Modify Skill logic** | N/A | `backend/skills/v2/**/*.skill.yaml` |
| **HTTP RPC endpoints** | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/` | `backend/src/routes/` |

## Frontend-Backend Data Flow

### Critical: stepId Matching

The most common source of bugs is **data key mismatch** between frontend and backend.

**Backend (YAML):**
```yaml
steps:
  - id: frame_performance_summary  # <-- This becomes the data key
    sql: "SELECT ..."
```

**Frontend (TypeScript):**
```typescript
// MUST use exact stepId value
const data = result.data.frame_performance_summary?.data;
//     ^^^^^^^^^^^^^^^^^^^^^^^^ matches YAML id:
```

**Example Bug Pattern:**
```typescript
// ❌ WRONG - uses different key
const data = result.data.performance_summary;

// ✅ CORRECT - matches YAML id:
const data = result.data.frame_performance_summary;
```

### Result Organization by Layers

Results from composite Skills are organized into layers based on the `display.level` field in YAML:

| Layer | Purpose | YAML `display.level` | Frontend Component |
|-------|---------|---------------------|-------------------|
| **L1** | Global summary | `summary` | `l1_overview_card.ts` |
| **L2** | Session list | `detail` (session-level) | `l2_session_list.ts` |
| ~~L3~~ | ~~(Removed)~~ | ~~(Was: `detail`)~~ | ~~(Deprecated)~~ |
| **L4** | Frame analysis | `key` (frame-level) | `l4_frame_analysis.ts` |

### Layer 4 Data Structure

L4 data is special - it's organized by session and frame:

```typescript
// Backend organizes L4 data as:
L4Data: {
  [sessionId: string]: {
    [frameId: string]: {
      stepId: string,
      data: {
        diagnosis_summary: string,
        full_analysis: {
          quadrants: { main_thread: { q1, q2, q3, q4 } },
          binder_calls: Array<any>,
          cpu_frequency: { big_avg_mhz, little_avg_mhz }
        }
      },
      display: { title: string }
    }
  }
}

// Frontend access pattern:
const frameData = L4Data[`session_${sessionId}`][`frame_${frameId}`];
const diagnosis = frameData.data.diagnosis_summary;
const quadrants = frameData.data.full_analysis.quadrants;
```

## Frontend Components (Mithril.js)

### Component Location

All skill-related components are in:
```
perfetto/ui/src/components/skill/
├── layered_result_view.ts      # Main layer manager
├── l1_overview_card.ts          # L1: Global summary
├── l2_session_list.ts           # L2: Session list (includes L4 frames)
├── l3_session_detail.ts         # (Deprecated - no longer used)
└── l4_frame_analysis.ts         # L4: Frame details
```

### Mithril.js Basics

SmartPerfetto uses Mithril.js (not React/Vue). Key patterns:

```typescript
// Component class
export class L2SessionList implements m.ClassComponent<L2SessionListAttrs> {
  view(vnode: m.Vnode<L2SessionListAttrs>) {
    const {data, expandedSessions, onToggleSession} = vnode.attrs;

    // Return VDOM tree
    return m('div.l2-session-list', [
      m('h3', 'Title'),
      m('ul', data.map(item => m('li', item.name)))
    ]);
  }
}

// Event handlers
m('button', {
  onclick: () => onToggleSession(id)  // No binding needed
}, 'Click me')

// Conditional rendering
isExpanded ? m('div.details', [...]) : null

// List rendering
data.map((item: any) => m('div.item', {key: item.id}, [
  m('span', item.name),
  m('button', {onclick: () => handleClick(item.id)}, 'Delete')
]))
```

### Rebuilding Frontend

After modifying frontend code:

```bash
cd perfetto/ui
npm run dev        # Dev mode (auto-rebuild)
# OR
node build.js      # Production build
```

Then reload Perfetto UI at http://localhost:10000

## Backend Services

### Skill Engine V2 Execution Flow

```
User Request (AI chat or API)
    ↓
PerfettoAnalysisOrchestrator
    ↓
SkillAnalysisAdapterV2 (intent detection)
    ↓
SkillExecutorV2 (YAML execution)
    ├─→ executeStep() for each step
    ├─→ substituteVars() (template variables)
    ├─→ execute SQL queries
    └─→ organizeByLayer() (result organization)
    ↓
LayeredResult {
  layers: { L1, L2, L4 },
  defaultExpanded: ['L1', 'L2']
}
```

### Skill File Structure

```yaml
# backend/skills/v2/composite/scrolling_analysis.skill.yaml
name: scrolling_analysis
version: "2.0"
type: composite

inputs:
  - name: trace_id
    type: string
    required: true

steps:
  - id: detect_refresh_rate          # <-- Becomes data key
    type: atomic
    sql: "SELECT ..."
    display:
      level: summary                 # --> L1 layer

  - id: find_scroll_sessions         # <-- Becomes data key
    type: iterator
    source: scroll_sessions
    item_skill: scroll_session_analysis
    display:
      level: detail                  # --> L2 layer
```

### SQL Template Syntax

**Variables in SQL:**
```sql
-- Use ${variable} syntax
SELECT * FROM slice
WHERE ts >= ${start_ts}
  AND ts < ${end_ts}
  AND name GLOB '${package}*'
```

**Conditions (NOT SQL):**
```yaml
# Condition field uses JavaScript (no ${...} wrapper)
condition: "performance_summary.data[0]?.jank_rate > 10"
#          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#          Raw JavaScript, NOT template syntax
```

## Common Tasks

### Adding a New Display Field

1. **Backend (YAML):** Add field to SQL SELECT
2. **Frontend (TS):** Access via `data.{stepId}.data[0].{fieldName}`

```yaml
# Backend
steps:
  - id: frame_performance_summary
    sql: |
      SELECT
        COUNT(*) as total_frames,
        SUM(is_janky) as janky_frames,
        AVG(dur_ms) as avg_dur_ms      # <-- New field
      FROM frames
```

```typescript
// Frontend
const avgDurMs = data.frame_performance_summary?.data?.[0]?.avg_dur_ms;
```

### Creating a New Skill

1. Create YAML file in `backend/skills/v2/composite/`
2. Define `triggers.keywords` for intent detection
3. Use `type: composite` with multiple steps
4. Set `display.level` to organize results into layers

```yaml
name: my_analysis
version: "1.0"
type: composite

meta:
  display_name: "My Analysis"
  description: "Analyzes X performance"
  tags: [custom, analysis]

triggers:
  keywords: [analyze X, X performance, X issue]

steps:
  - id: get_x_data
    type: atomic
    sql: "SELECT ..."
    display:
      level: summary
```

### Debugging Data Flow

**Backend logging:**
```typescript
console.log('[SkillExecutorV2] Result:', JSON.stringify(result, null, 2));
```

**Frontend logging:**
```typescript
// In component view() method
console.log('[L2SessionList] Data:', {
  sessions: data.find_scroll_sessions?.data,
  jank: data.session_jank_analysis?.data
});
```

**Check browser console for:**
- `[L4FrameAnalysis] Received data:` - Shows data structure reaching L4 component
- `[L2SessionList] First frame data:` - Shows frame data being passed to L4

## Important Files Reference

### Backend Core Files

| File | Purpose |
|------|---------|
| `skillExecutorV2.ts` | Main Skill execution engine |
| `skillAnalysisAdapterV2.ts` | API adapter, intent detection |
| `skillLoaderV2.ts` | YAML Skill loader |
| `perfettoAnalysisOrchestrator.ts` | AI analysis orchestration |
| `workingTraceProcessor.ts` | TraceProcessor process management |
| `portPool.ts` | Port allocation (9100-9900) |

### Frontend Core Files

| File | Purpose |
|------|---------|
| `layered_result_view.ts` | Main layer manager |
| `ai_panel.ts` | AI assistant panel |
| `plugin.ts` | Plugin entry point |
| `commands.ts` | Slash command handlers |

## HTTP RPC Details

### Port Allocation

Each trace gets a unique port from 9100-9900:

```bash
# Check allocated ports
curl http://localhost:3000/api/traces/stats

# Response
{
  "stats": {
    "portPool": {
      "total": 800,
      "allocated": 1,
      "allocations": [
        {"port": 9100, "traceId": "abc-123"}
      ]
    }
  }
}
```

### CORS Configuration

Frontend connects to backend trace_processor via CORS:

```typescript
// Frontend (ai_panel.ts)
const rpcUrl = `http://127.0.0.1:${port}`;

// Backend adds CORS headers to trace_processor responses
```

## Development Workflow

### 1. Make Changes

**Frontend:**
```bash
cd perfetto/ui
# Edit component files
npm run dev    # Auto-rebuilds
```

**Backend:**
```bash
cd backend
# Edit YAML files or TypeScript
npm run dev    # Auto-restarts
```

### 2. Test Changes

1. Open Perfetto UI: http://localhost:10000
2. Load a test trace: `./test-traces/app_aosp_scrolling_heavy_jank.pftrace`
3. Click "上传 Trace" button
4. Ask AI: "请分析这段 Trace 的滑动性能"
5. Check browser console for errors

### 3. Verify Data Flow

**Check browser console:**
```
[L2SessionList] Sessions: Array(2)
[L4FrameAnalysis] Received data: {diagnosis_summary: "...", full_analysis: {...}}
```

**Check backend logs:**
```
[SkillExecutorV2] Executing step: frame_performance_summary
[SkillExecutorV2] Result organized into layer: L1
```

## Troubleshooting

### Issue: Frontend shows empty data

**Check:**
1. Browser console for data structure
2. Backend logs for step execution
3. Data key matches stepId exactly

```typescript
// Add debug logging
console.log('[Component] Data keys:', Object.keys(data));
console.log('[Component] Full data:', JSON.stringify(data, null, 2));
```

### Issue: L4 frames show no details

**Check:**
1. `transformL4FrameAnalysis()` in `skillExecutorV2.ts`
2. Frame data structure: `L4Data[session][frame].data`
3. Browser console for L4 data logging

### Issue: SQL syntax errors

**Check:**
1. All template variables closed: `${start_ts}` not `${start_ts`
2. Condition expressions use raw JS: `data[0].value > 10` not `${data[0].value > 10}`

### Issue: Port already in use

```bash
# Kill all trace_processor processes
pkill -f trace_processor_shell

# Or cleanup via API
curl -X POST http://localhost:3000/api/traces/cleanup
```

## Project-Specific Patterns

### Skill Naming Convention

- Atomic skills: `binder_in_range`, `cpu_slice_analysis`
- Composite skills: `scrolling_analysis`, `startup_analysis`
- Step IDs: `snake_case` (becomes data keys)

### Import Paths

```typescript
// Frontend (relative to perfetto/ui/src/)
import {L1OverviewCard} from './components/skill/l1_overview_card';

// Backend (relative to backend/src/)
import {SkillExecutorV2} from './services/skillEngine/skillExecutorV2';
```

### Environment Variables

Backend `.env` file:
```env
PORT=3000
DEEPSEEK_API_KEY=sk-xxx
MAX_FILE_SIZE=500MB
```

## Additional Resources

- **Perfetto SQL Docs**: https://perfetto.dev/docs/analysis/sql-queries
- **Skill Development Guide**: `backend/skills/README.md`
- **Main README**: Project overview and architecture details

## Before Making Changes

1. **Read existing code** - Find similar patterns before writing new code
2. **Check data flow** - Trace how data flows from YAML → Backend → Frontend
3. **Match stepIds** - Ensure frontend data keys match backend YAML `id:` fields
4. **Test with sample trace** - Use `./test-traces/app_aosp_scrolling_heavy_jank.pftrace`

## Contact

For questions or issues, refer to the project README or contact the maintainers.

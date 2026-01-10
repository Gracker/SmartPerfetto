# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Architecture

```
SmartPerfetto/
├── perfetto/ui/     Frontend (TypeScript + Mithril.js) @ localhost:10000
├── backend/         Node.js/Express API @ localhost:3000
└── trace_processor  HTTP RPC @ localhost:9100-9900 (shared by frontend & backend)
```

**Key Principles:**
- Frontend and backend share the same `trace_processor_shell` via HTTP RPC
- Analysis logic defined in YAML Skills (`backend/skills/v2/`)
- Results organized into layers: L1 (summary) → L2 (sessions) → L4 (frames)

## Agent Architecture (v4.0 - New)

```
MasterOrchestrator
  ├── PipelineExecutor (stages with checkpoints)
  ├── CircuitBreaker (max iterations, user intervention)
  ├── ModelRouter (Anthropic/DeepSeek/OpenAI)
  ├── SessionLogger (per-session JSONL logs)
  └── SubAgents
      ├── PlannerAgent (task decomposition)
      ├── EvaluatorAgent (quality assessment)
      └── WorkerAgents (ScrollingExpert, etc.)
```

**Core Components:**
| Component | Location | Purpose |
|-----------|----------|---------|
| MasterOrchestrator | `backend/src/agent/core/masterOrchestrator.ts` | Main coordinator |
| PipelineExecutor | `backend/src/agent/core/pipelineExecutor.ts` | Stage execution |
| CircuitBreaker | `backend/src/agent/core/circuitBreaker.ts` | Loop protection |
| ModelRouter | `backend/src/agent/core/modelRouter.ts` | Multi-model routing |
| SessionLogger | `backend/src/services/sessionLogger.ts` | Debug logging |

## Quick Start

```bash
# Start everything (auto-builds trace_processor_shell if missing)
./scripts/start-dev.sh

# Or manually:
cd backend && npm run dev      # Backend @ :3000
cd perfetto/ui && ./run-dev-server  # Frontend @ :10000
```

**Test:** Open http://localhost:10000, load a `.pftrace` file, ask AI to analyze.

## Key Locations

| Task | Location |
|------|----------|
| Add/modify analysis | `backend/skills/v2/composite/*.skill.yaml` |
| Result display | `perfetto/ui/src/components/skill/l*.ts` |
| AI chat panel | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts` |
| Agent system | `backend/src/agent/` |
| Agent routes | `backend/src/routes/agentRoutes.ts` |
| Session logs | `backend/logs/sessions/*.jsonl` |

## Debugging with Session Logs

Session logs persist to `backend/logs/sessions/` in JSONL format.

**Query logs via API:**
```bash
# List all sessions
curl http://localhost:3000/api/agent/logs

# Get logs for session
curl http://localhost:3000/api/agent/logs/{sessionId}

# Get only errors/warnings
curl http://localhost:3000/api/agent/logs/{sessionId}/errors

# Search in logs
curl "http://localhost:3000/api/agent/logs/{sessionId}?search=error&component=Analysis"
```

**Log format (JSONL):**
```json
{"timestamp":"2024-01-01T00:00:00.000Z","level":"info","sessionId":"xxx","component":"Analysis","message":"Starting analysis","data":{}}
```

## Frontend (Mithril.js)

```typescript
// Component pattern
export class MyComponent implements m.ClassComponent<Attrs> {
  view(vnode: m.Vnode<Attrs>) {
    return m('div', [
      m('span', vnode.attrs.title),
      m('button', {onclick: () => handler()}, 'Click')
    ]);
  }
}
```

Rebuild: `cd perfetto/ui && node build.js`

## Backend Skills (YAML)

```yaml
# backend/skills/v2/composite/my_analysis.skill.yaml
name: my_analysis
type: composite

steps:
  - id: summary_data        # <-- This ID becomes the frontend data key
    sql: "SELECT ..."
    display:
      level: summary        # L1 layer
```

**Frontend access:** `result.data.summary_data?.data`

## API Endpoints

### Analysis
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/analyze` | Start analysis |
| GET | `/api/agent/:id/stream` | SSE updates |
| GET | `/api/agent/:id/status` | Get status |
| POST | `/api/agent/:id/respond` | Respond to circuit breaker |
| POST | `/api/agent/resume` | Resume from checkpoint |

### Logs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agent/logs` | List sessions |
| GET | `/api/agent/logs/:sessionId` | Get session logs |
| GET | `/api/agent/logs/:sessionId/errors` | Get errors only |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | Ensure `trace_processor_shell` exists: `./scripts/start-dev.sh` |
| Empty data in frontend | Check browser console; verify stepId matches YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` or restart backend |
| Debug analysis issue | Check `backend/logs/sessions/*.jsonl` for session logs |

## Environment

Backend `.env`:
```
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_MODEL=deepseek-chat
```

## Dependencies

- `trace_processor_shell`: Auto-built by `start-dev.sh`, or manually:
  ```bash
  cd perfetto && tools/ninja -C out/ui trace_processor_shell
  ```

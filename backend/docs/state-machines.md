# SmartPerfetto State Machine Diagrams

This document describes the state machines for the DataEnvelope architecture introduced in the data contract refactoring.

---

## 1. DataEnvelope Lifecycle State Machine

This state machine describes how a DataEnvelope is created, transmitted, and consumed.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DataEnvelope Lifecycle State Machine                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐                                                             │
│  │   START     │                                                             │
│  └──────┬──────┘                                                             │
│         │                                                                    │
│         ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    SKILL EXECUTION (Backend)                         │    │
│  │                                                                      │    │
│  │   ┌───────────────┐    SQL Query    ┌───────────────┐               │    │
│  │   │ SkillExecutor │ ──────────────► │ TraceProcessor│               │    │
│  │   │ executeStep() │                 │   HTTP RPC    │               │    │
│  │   └───────────────┘                 └───────┬───────┘               │    │
│  │                                             │                        │    │
│  │                                             ▼                        │    │
│  │                                    ┌───────────────┐                 │    │
│  │                                    │  Raw Result   │                 │    │
│  │                                    │ { columns,    │                 │    │
│  │                                    │   rows }      │                 │    │
│  │                                    └───────┬───────┘                 │    │
│  └────────────────────────────────────────────┼─────────────────────────┘    │
│                                               │                              │
│                                               ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    ENVELOPE CREATION (Backend)                       │    │
│  │                                                                      │    │
│  │   createDataEnvelope() / buildDataEnvelope()                        │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  DataEnvelope                                            │       │    │
│  │   │  ├─ meta: { type, version, source, timestamp, skillId }  │       │    │
│  │   │  ├─ data: { columns, rows, text?, chart? }               │       │    │
│  │   │  └─ display: { layer, format, title, columns, highlights }│       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  │   Column definitions from:                                          │    │
│  │   1. YAML skill definition (explicit)                               │    │
│  │   2. buildColumnDefinitions() (inferred from patterns)              │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                               │                              │
│                                               ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    SSE TRANSMISSION (Backend→Frontend)               │    │
│  │                                                                      │    │
│  │   broadcastToClients(sessionId, update)                             │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  v2.0 Format (event: data)                               │       │    │
│  │   │  {                                                       │       │    │
│  │   │    id: "evt_xxx",                                        │       │    │
│  │   │    envelope: DataEnvelope | DataEnvelope[],              │       │    │
│  │   │    timestamp: 1234567890                                 │       │    │
│  │   │  }                                                       │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  │   OR (backward compatibility):                                      │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  Legacy Format (event: skill_data)                       │       │    │
│  │   │  {                                                       │       │    │
│  │   │    type: "skill_data",                                   │       │    │
│  │   │    data: LayeredSkillResult,                             │       │    │
│  │   │    timestamp: 1234567890                                 │       │    │
│  │   │  }                                                       │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                               │                              │
│                                               ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    FRONTEND PROCESSING                               │    │
│  │                                                                      │    │
│  │   handleSSEEvent(eventType, data)                                   │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  'data' event                                            │       │    │
│  │   │  → Extract envelopes                                     │       │    │
│  │   │  → envelopeToSqlQueryResult()                            │       │    │
│  │   │  → Add to messages                                       │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  'skill_data' / 'skill_layered_result' event             │       │    │
│  │   │  → Extract layers (overview, list, session, deep)        │       │    │
│  │   │  → Convert to SqlQueryResult[]                           │       │    │
│  │   │  → Bind L4 deep data to L2 rows (expandableData)         │       │    │
│  │   │  → Add to messages                                       │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                               │                              │
│                                               ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    RENDERING                                         │    │
│  │                                                                      │    │
│  │   SqlResultTable(result: SqlQueryResult)                            │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  Column Rendering (based on ColumnDefinition)            │       │    │
│  │   │  ├─ type: 'timestamp' → formatTimestamp() + clickable    │       │    │
│  │   │  ├─ type: 'duration'  → formatDuration()                 │       │    │
│  │   │  ├─ type: 'bytes'     → formatBytes()                    │       │    │
│  │   │  └─ clickAction: 'navigate_timeline' → scrollToTimestamp │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────┐       │    │
│  │   │  Expandable Rows (L4 deep data)                          │       │    │
│  │   │  ├─ Click row → Show nested sections                     │       │    │
│  │   │  └─ Each section rendered as sub-table                   │       │    │
│  │   └─────────────────────────────────────────────────────────┘       │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                               │                              │
│                                               ▼                              │
│                                        ┌─────────────┐                       │
│                                        │    END      │                       │
│                                        └─────────────┘                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### State Transitions

| From | Event | To | Action |
|------|-------|----|----|
| START | Skill step execution | SKILL_EXECUTION | Execute SQL via TraceProcessor |
| SKILL_EXECUTION | Query returns rows | ENVELOPE_CREATION | Build DataEnvelope with column definitions |
| ENVELOPE_CREATION | Envelope ready | SSE_TRANSMISSION | Broadcast to connected clients |
| SSE_TRANSMISSION | Client receives | FRONTEND_PROCESSING | Parse and transform data |
| FRONTEND_PROCESSING | Data transformed | RENDERING | Render SqlResultTable |
| RENDERING | Complete | END | Display in UI |

---

## 2. SSE Event Handling State Machine

This state machine describes how the frontend handles different SSE event types.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SSE Event Handler State Machine                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────────────┐                             │
│                              │ EventSource     │                             │
│                              │ onmessage       │                             │
│                              └────────┬────────┘                             │
│                                       │                                      │
│                                       ▼                                      │
│                              ┌─────────────────┐                             │
│                              │ Parse JSON      │                             │
│                              │ Extract type    │                             │
│                              └────────┬────────┘                             │
│                                       │                                      │
│         ┌─────────────────────────────┼─────────────────────────────┐        │
│         │                             │                             │        │
│         ▼                             ▼                             ▼        │
│  ┌─────────────┐             ┌─────────────────┐             ┌─────────────┐ │
│  │  progress   │             │   data (v2.0)   │             │  skill_*    │ │
│  │  connected  │             │                 │             │  (legacy)   │ │
│  │  phase_*    │             │                 │             │             │ │
│  └──────┬──────┘             └────────┬────────┘             └──────┬──────┘ │
│         │                             │                             │        │
│         ▼                             ▼                             ▼        │
│  ┌─────────────┐             ┌─────────────────┐             ┌─────────────┐ │
│  │ Update      │             │ Check envelope  │             │ Transform   │ │
│  │ progress    │             │ isDataEnvelope()│             │ to layers   │ │
│  │ indicator   │             │                 │             │             │ │
│  └──────┬──────┘             └────────┬────────┘             └──────┬──────┘ │
│         │                             │                             │        │
│         │                    ┌────────┴────────┐                    │        │
│         │                    │                 │                    │        │
│         │                    ▼                 ▼                    │        │
│         │           ┌─────────────┐    ┌─────────────┐              │        │
│         │           │ Single      │    │ Array of    │              │        │
│         │           │ Envelope    │    │ Envelopes   │              │        │
│         │           └──────┬──────┘    └──────┬──────┘              │        │
│         │                  │                  │                     │        │
│         │                  └────────┬─────────┘                     │        │
│         │                           │                               │        │
│         │                           ▼                               │        │
│         │                  ┌─────────────────┐                      │        │
│         │                  │ For each        │                      │        │
│         │                  │ envelope:       │                      │        │
│         │                  │ envelopeToSql   │                      │        │
│         │                  │ QueryResult()   │                      │        │
│         │                  └────────┬────────┘                      │        │
│         │                           │                               │        │
│         │                           ▼                               ▼        │
│         │                  ┌──────────────────────────────────────────┐     │
│         │                  │            Extract Layers                │     │
│         │                  │                                          │     │
│         │                  │   ┌─────────┐ ┌─────────┐ ┌─────────┐   │     │
│         │                  │   │overview │ │  list   │ │  deep   │   │     │
│         │                  │   │  (L1)   │ │  (L2)   │ │  (L4)   │   │     │
│         │                  │   └────┬────┘ └────┬────┘ └────┬────┘   │     │
│         │                  │        │           │           │        │     │
│         │                  └────────┼───────────┼───────────┼────────┘     │
│         │                           │           │           │               │
│         │                           ▼           ▼           ▼               │
│         │                  ┌──────────────────────────────────────────┐     │
│         │                  │           Bind L4 to L2 Rows             │     │
│         │                  │                                          │     │
│         │                  │   L2 rows get expandableData from        │     │
│         │                  │   matching L4 items by frame_id/item_id  │     │
│         │                  │                                          │     │
│         │                  └─────────────────────┬────────────────────┘     │
│         │                                        │                          │
│         └────────────────────────────────────────┼──────────────────────────┤
│                                                  │                          │
│                                                  ▼                          │
│                                  ┌───────────────────────────────┐          │
│                                  │     Deduplicate by stepId     │          │
│                                  │     (displayedSkillProgress)  │          │
│                                  └───────────────┬───────────────┘          │
│                                                  │                          │
│                                                  ▼                          │
│                                  ┌───────────────────────────────┐          │
│                                  │   Add to messages array       │          │
│                                  │   (type: 'sql_result')        │          │
│                                  └───────────────┬───────────────┘          │
│                                                  │                          │
│                                                  ▼                          │
│                                  ┌───────────────────────────────┐          │
│                                  │   scheduleFullUpdate()        │          │
│                                  │   → Re-render UI              │          │
│                                  └───────────────────────────────┘          │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Special Event Handlers                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  analysis_completed                                                  │    │
│  │  ├─ Extract summary, reportUrl, findings                            │    │
│  │  ├─ Set isLoading = false                                           │    │
│  │  ├─ Mark completionHandled = true (prevent duplicates)              │    │
│  │  └─ Add final summary message                                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  circuit_breaker                                                     │    │
│  │  ├─ Extract reason, options                                         │    │
│  │  ├─ Display user intervention UI                                    │    │
│  │  └─ Wait for user response                                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  error                                                               │    │
│  │  ├─ Check if recoverable                                            │    │
│  │  ├─ Display error message                                           │    │
│  │  └─ Offer retry option if recoverable                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Event Type Decision Table

| Event Type | Action | Adds Message? | Updates Progress? |
|------------|--------|---------------|-------------------|
| `connected` | Initialize session | No | Yes |
| `progress` | Update loading indicator | No | Yes |
| `phase_change` | Log phase transition | No | Yes |
| `data` (v2.0) | Convert envelopes → SqlQueryResult | Yes | No |
| `skill_data` (legacy) | Transform → skill_layered_result | Yes | No |
| `skill_layered_result` | Extract layers → SqlQueryResult[] | Yes | No |
| `skill_diagnostics` | Extract findings | Optional | No |
| `analysis_completed` | Show summary, set done | Yes | Yes (done) |
| `circuit_breaker` | Show intervention UI | Yes | Yes (paused) |
| `error` | Show error message | Yes | Yes (error) |
| `thought` | Skip (noise reduction) | No | No |
| `worker_thought` | Skip (noise reduction) | No | No |
| `finding` | Skip (shown in tables) | No | No |

---

## 3. Column Rendering Pipeline State Machine

This state machine describes how column values are formatted and rendered.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Column Rendering Pipeline State Machine                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                         ┌─────────────────┐                                  │
│                         │  Raw Cell Value │                                  │
│                         └────────┬────────┘                                  │
│                                  │                                           │
│                                  ▼                                           │
│                    ┌──────────────────────────────┐                          │
│                    │  Get ColumnDefinition         │                          │
│                    │  (from envelope.display.columns)│                          │
│                    └───────────────┬──────────────┘                          │
│                                    │                                         │
│               ┌────────────────────┼────────────────────┐                    │
│               │                    │                    │                    │
│               ▼                    ▼                    ▼                    │
│       ┌─────────────┐      ┌─────────────┐      ┌─────────────┐             │
│       │ Has explicit│      │  Inferred   │      │  No column  │             │
│       │ definition  │      │ from pattern│      │  definition │             │
│       └──────┬──────┘      └──────┬──────┘      └──────┬──────┘             │
│              │                    │                    │                     │
│              │                    ▼                    ▼                     │
│              │        ┌─────────────────────────────────────┐               │
│              │        │    inferColumnDefinition(name)      │               │
│              │        │    ├─ /^ts$|_ts$/ → timestamp       │               │
│              │        │    ├─ /^dur$|_dur$/ → duration      │               │
│              │        │    ├─ /rate$|percent/ → percentage  │               │
│              │        │    ├─ /size$|bytes$/ → bytes        │               │
│              │        │    └─ default → string              │               │
│              │        └─────────────────┬───────────────────┘               │
│              │                          │                                    │
│              └──────────────────────────┼────────────────────────────────────┤
│                                         │                                    │
│                                         ▼                                    │
│              ┌───────────────────────────────────────────────────────────┐  │
│              │                   Format by Type                           │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ type: 'timestamp'                                    │ │  │
│              │   │ ├─ unit: 'ns' (default)                              │ │  │
│              │   │ ├─ Convert ns → TimeSpan                             │ │  │
│              │   │ ├─ format: 'timestamp_relative' → "12.345s"          │ │  │
│              │   │ └─ format: 'timestamp_absolute' → "12345678901234ns" │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ type: 'duration'                                     │ │  │
│              │   │ ├─ unit: 'ns' (default) / 'us' / 'ms' / 's'          │ │  │
│              │   │ ├─ format: 'duration_ms' → "12.34 ms"                │ │  │
│              │   │ └─ format: 'duration_us' → "12345 µs"                │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ type: 'bytes'                                        │ │  │
│              │   │ └─ format: 'bytes_human' → "1.23 MB"                 │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ type: 'percentage'                                   │ │  │
│              │   │ └─ format: 'percentage' → "12.34%"                   │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ type: 'number' / 'string'                            │ │  │
│              │   │ ├─ format: 'compact' → "1.2K"                        │ │  │
│              │   │ └─ format: 'default' → as-is                         │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              └───────────────────────────┬───────────────────────────────┘  │
│                                          │                                   │
│                                          ▼                                   │
│              ┌───────────────────────────────────────────────────────────┐  │
│              │                   Apply Click Action                       │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ clickAction: 'navigate_timeline'                     │ │  │
│              │   │ ├─ Render as clickable link                          │ │  │
│              │   │ ├─ On click: scrollToTimestamp(ts)                   │ │  │
│              │   │ └─ Optional: durationColumn for range selection      │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ clickAction: 'navigate_range'                        │ │  │
│              │   │ ├─ Render as clickable link                          │ │  │
│              │   │ └─ On click: setViewportToRange(ts, ts + dur)        │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ clickAction: 'copy'                                  │ │  │
│              │   │ └─ On click: copyToClipboard(value)                  │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ clickAction: 'expand'                                │ │  │
│              │   │ └─ On click: Toggle row expansion (show L4 data)     │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              │   ┌─────────────────────────────────────────────────────┐ │  │
│              │   │ clickAction: 'none' (default)                        │ │  │
│              │   │ └─ Render as plain text                              │ │  │
│              │   └─────────────────────────────────────────────────────┘ │  │
│              │                                                            │  │
│              └───────────────────────────┬───────────────────────────────┘  │
│                                          │                                   │
│                                          ▼                                   │
│              ┌───────────────────────────────────────────────────────────┐  │
│              │                   Apply Highlights                         │  │
│              │                                                            │  │
│              │   For each HighlightRule in display.highlights:           │  │
│              │   ├─ Evaluate condition against row data                  │  │
│              │   ├─ If match: Apply CSS class / color / icon             │  │
│              │   └─ Severity styling:                                    │  │
│              │       ├─ 'critical' → Red background                      │  │
│              │       ├─ 'warning' → Yellow background                    │  │
│              │       └─ 'info' → Blue text                               │  │
│              │                                                            │  │
│              └───────────────────────────┬───────────────────────────────┘  │
│                                          │                                   │
│                                          ▼                                   │
│                               ┌─────────────────┐                            │
│                               │  Rendered Cell  │                            │
│                               │  (HTML/VNode)   │                            │
│                               └─────────────────┘                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Column Type Inference Patterns

| Pattern | Inferred Type | Default Format | Default Click Action |
|---------|---------------|----------------|---------------------|
| `/^ts$\|_ts$\|timestamp$/` | `timestamp` | `timestamp_relative` | `navigate_timeline` |
| `/^dur$\|_dur$\|duration$/` | `duration` | `duration_ms` | `none` |
| `/rate$\|percent\|pct$/` | `percentage` | `percentage` | `none` |
| `/size$\|bytes$\|memory$/` | `bytes` | `bytes_human` | `none` |
| `/^id$\|_id$\|^count$/` | `number` | `compact` | `none` |
| `/^is_\|^has_\|_flag$/` | `boolean` | `default` | `none` |
| (default) | `string` | `default` | `none` |

---

## 4. Session State Machine

This state machine describes the analysis session lifecycle.

**Note**: PENDING state is only used for multi-turn dialogue. New sessions start directly in RUNNING.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Session State Machine                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   New Analysis (POST /api/agent/analyze):                                   │
│                                                                              │
│         createSession()           orchestrator.analyze()                     │
│              │                          │                                    │
│              ▼                          ▼                                    │
│       ┌─────────────┐           ┌─────────────┐                              │
│       │   RUNNING   │ ─────────►│   RUNNING   │◄─────────────────┐          │
│       │  (created)  │           │ (analyzing) │                   │          │
│       └─────────────┘           └──────┬──────┘                   │          │
│                                        │                          │          │
│             ┌──────────────────────────┼──────────────────────┐   │          │
│             │                          │                      │   │          │
│             ▼                          ▼                      ▼   │          │
│  ┌───────────────────┐   ┌───────────────────┐   ┌──────────────┐ │          │
│  │ analysis_completed │   │  circuit_breaker  │   │    error     │ │          │
│  │     (success)      │   │    (tripped)      │   │  (failure)   │ │          │
│  └─────────┬─────────┘   └─────────┬─────────┘   └──────┬───────┘ │          │
│            │                       │                    │         │          │
│            ▼                       ▼                    ▼         │          │
│  ┌───────────────────┐   ┌───────────────────┐   ┌──────────────┐ │          │
│  │    COMPLETED      │   │  AWAITING_USER    │   │    FAILED    │ │          │
│  └───────────────────┘   └─────────┬─────────┘   └──────────────┘ │          │
│                                    │                              │          │
│                    ┌───────────────┼───────────────┐              │          │
│                    ▼               ▼               ▼              │          │
│             ┌───────────┐   ┌───────────┐   ┌───────────┐         │          │
│             │ continue  │   │   retry   │   │   abort   │         │          │
│             └─────┬─────┘   └─────┬─────┘   └─────┬─────┘         │          │
│                   │               │               │               │          │
│                   └───────────────┴───────────────┼───────────────┘          │
│                                                   ▼                          │
│                                          ┌──────────────┐                    │
│                                          │    FAILED    │                    │
│                                          │ (user abort) │                    │
│                                          └──────────────┘                    │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                    Multi-turn Dialogue (same traceId + new query)            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐   same traceId   ┌─────────────┐   analyze()   ┌─────────┐│
│   │  COMPLETED  │ ────────────────►│   PENDING   │─────────────►│ RUNNING ││
│   │             │   + new query    │  (turn N+1) │              │         ││
│   └─────────────┘                  └─────────────┘              └─────────┘│
│                                                                              │
│   Session context preserved: results, history, preferences                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Session Status Values

| Status | Description | Next Actions |
|--------|-------------|--------------|
| `pending` | Session created, waiting to start | Start analysis |
| `running` | Analysis in progress | Wait for completion |
| `awaiting_user` | Circuit breaker tripped, needs user input | continue/retry/abort |
| `completed` | Analysis finished successfully | View results, new query |
| `failed` | Analysis failed | Retry, start new |

---

## 5. Type Conversion Flow

This diagram shows how types are converted between backend and frontend.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Type Conversion Flow                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Backend (TypeScript)                          Frontend (TypeScript)         │
│                                                                              │
│  ┌─────────────────────┐                      ┌─────────────────────┐       │
│  │ backend/src/types/  │   generateFrontend   │ generated/          │       │
│  │ dataContract.ts     │   Types.ts           │ data_contract.types │       │
│  │                     │ ───────────────────► │ .ts                 │       │
│  │ - DataEnvelope<T>   │                      │                     │       │
│  │ - ColumnDefinition  │                      │ - DataEnvelope<T>   │       │
│  │ - DisplayConfig     │                      │ - ColumnDefinition  │       │
│  │ - SSEEvent types    │                      │ - DisplayConfig     │       │
│  └─────────────────────┘                      │ - SSEEvent types    │       │
│                                               │                     │       │
│                                               │ + SqlQueryResult    │       │
│                                               │ + envelopeToSql     │       │
│                                               │   QueryResult()     │       │
│                                               │ + inferColumn       │       │
│                                               │   Definition()      │       │
│                                               │ + buildColumn       │       │
│                                               │   Definitions()     │       │
│                                               └─────────────────────┘       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Runtime Conversion Functions                      │    │
│  │                                                                      │    │
│  │   Backend (skillExecutor.ts):                                       │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │ createDataEnvelope(meta, data, display) → DataEnvelope      │   │    │
│  │   │ displayResultToEnvelope(result) → DataEnvelope              │   │    │
│  │   │ layeredResultToEnvelopes(result) → DataEnvelope[]           │   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  │   Frontend (data_contract.types.ts):                                │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │ envelopeToSqlQueryResult(envelope) → SqlQueryResult         │   │    │
│  │   │ isDataEnvelope(obj) → boolean                               │   │    │
│  │   │ isLegacySkillEvent(event) → boolean                         │   │    │
│  │   │ inferColumnDefinition(name) → ColumnDefinition              │   │    │
│  │   │ buildColumnDefinitions(names, explicit?) → ColumnDefinition[]│   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Detailed Data Flow Analysis

### 6.0 End-to-End Data Flow (Complete Picture)

这是数据从 AI Agent 到前端渲染的完整链路：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    End-to-End Data Flow (Complete Picture)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    1. MasterOrchestrator                             │   │
│   │                                                                      │   │
│   │   handleQuery() → PipelineExecutor → AnalysisWorker                  │   │
│   │         │                                  │                         │   │
│   │         │                                  ▼                         │   │
│   │         │                         SkillExecutor.execute()            │   │
│   │         │                                  │                         │   │
│   │         │                                  ▼                         │   │
│   │         │                         LayeredSkillResult                 │   │
│   │         │                         { overview, list, deep }           │   │
│   │         │                                  │                         │   │
│   │         ▼                                  │                         │   │
│   │   this.emit('update', {                    │                         │   │
│   │     type: 'skill_data',  ◄─────────────────┘                         │   │
│   │     content: { skillId, layers }                                     │   │
│   │   })                                                                 │   │
│   │                                                                      │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   │ EventEmitter 'update' event              │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    2. OrchestratorBridge                             │   │
│   │                                                                      │   │
│   │   setupEventBridge():                                                │   │
│   │     orchestrator.on('update', (update) => {                          │   │
│   │       handleOrchestratorUpdate(sessionId, update)                    │   │
│   │     })                                                               │   │
│   │                                                                      │   │
│   │   handleOrchestratorUpdate():                                        │   │
│   │     switch (update.type) {                                           │   │
│   │       case 'skill_data':                                             │   │
│   │         emitSkillLayeredResult(sessionId, content)                   │   │
│   │         │                                                            │   │
│   │         ▼                                                            │   │
│   │         sessionService.emitSSE(sessionId, {                          │   │
│   │           type: 'skill_layered_result',                              │   │
│   │           timestamp: Date.now(),                                     │   │
│   │           data: content  // { skillId, layers }                      │   │
│   │         })                                                           │   │
│   │     }                                                                │   │
│   │                                                                      │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   │ HTTP SSE Stream                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    3. Frontend (ai_panel.ts)                         │   │
│   │                                                                      │   │
│   │   listenToAgentSSE(sessionId):                                       │   │
│   │     eventSource.onmessage = (event) => {                             │   │
│   │       const parsed = JSON.parse(event.data)                          │   │
│   │       handleSSEEvent(parsed.type, parsed)                            │   │
│   │     }                                                                │   │
│   │                                                                      │   │
│   │   handleSSEEvent('skill_layered_result', data):                      │   │
│   │     1. 提取 layers (overview, list, deep)                            │   │
│   │     2. 转换为 SqlQueryResult[]                                       │   │
│   │     3. 绑定 L4 deep 数据到 L2 rows                                   │   │
│   │     4. 添加到 messages[]                                             │   │
│   │     5. scheduleFullUpdate() 触发重渲染                               │   │
│   │                                                                      │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   │ React/Mithril Render                     │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    4. SqlResultTable Rendering                       │   │
│   │                                                                      │   │
│   │   for each SqlQueryResult in messages:                               │   │
│   │     renderTable(result)                                              │   │
│   │       │                                                              │   │
│   │       ├─► 读取 display.columns (ColumnDefinition[])                  │   │
│   │       ├─► 格式化每列 (formatTimestamp, formatDuration, etc.)         │   │
│   │       ├─► 应用 clickAction (navigate_timeline, copy, etc.)           │   │
│   │       ├─► 应用 highlights (条件样式)                                 │   │
│   │       └─► 渲染可展开行 (expandableData → L4 子表格)                  │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**关键要点:**
1. `MasterOrchestrator` 通过 EventEmitter 发出 `update` 事件
2. `OrchestratorBridge` 监听并转换事件类型 (`skill_data` → `skill_layered_result`)
3. SSE 推送到前端，前端 `handleSSEEvent` 处理
4. 数据最终由 `SqlResultTable` 根据 `ColumnDefinition` 渲染

---

### 6.1 Conversion Chain (Backend)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Detailed Conversion Chain (Backend)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐                                                         │
│  │   SQL Result    │  TraceProcessor HTTP RPC                               │
│  │  { columns: [], │  返回原始查询结果                                        │
│  │    rows: [][] } │                                                         │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    StepResult (内部格式)                             │    │
│  │                                                                      │    │
│  │   {                                                                  │    │
│  │     success: boolean,                                                │    │
│  │     data: any[],           // 查询结果数组                           │    │
│  │     error?: string,                                                  │    │
│  │     metadata?: {...}                                                 │    │
│  │   }                                                                  │    │
│  │                                                                      │    │
│  └────────┬────────────────────────────────────────────────────────────┘    │
│           │                                                                  │
│           │ createDisplayResult()                                            │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    DisplayResult (显示格式)                          │    │
│  │                                                                      │    │
│  │   {                                                                  │    │
│  │     stepId: string,                                                  │    │
│  │     title: string,                                                   │    │
│  │     level: DisplayLevel,                                             │    │
│  │     layer: DisplayLayer,                                             │    │
│  │     format: DisplayFormat,                                           │    │
│  │     data: DataPayload {                                              │    │
│  │       columns?: string[],                                            │    │
│  │       rows?: any[][],                                                │    │
│  │       text?: string,          // 文本格式                            │    │
│  │       chart?: ChartConfig,    // 图表格式                            │    │
│  │       summary?: SummaryContent,  // 摘要格式                         │    │
│  │       expandableData?: [...]  // L4 嵌入数据                         │    │
│  │     },                                                               │    │
│  │     highlight?: HighlightRule[],                                     │    │
│  │     sql?: string                                                     │    │
│  │   }                                                                  │    │
│  │                                                                      │    │
│  └────────┬────────────────────────────────────────────────────────────┘    │
│           │                                                                  │
│           │ displayResultToEnvelope()                                        │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    DataEnvelope (v2.0 契约格式)                       │    │
│  │                                                                      │    │
│  │   {                                                                  │    │
│  │     meta: {                                                          │    │
│  │       type: 'skill_result',                                          │    │
│  │       version: '2.0.0',                                              │    │
│  │       source: stepId,                                                │    │
│  │       timestamp: Date.now(),                                         │    │
│  │       skillId, stepId                                                │    │
│  │     },                                                               │    │
│  │     data: DataPayload,        // 直接复用 DisplayResult.data         │    │
│  │     display: {                                                       │    │
│  │       layer, format, title,                                          │    │
│  │       columns: ColumnDefinition[],  // ← 显式定义或推断              │    │
│  │       metadataFields?,                                               │    │
│  │       highlights?                                                    │    │
│  │     }                                                                │    │
│  │   }                                                                  │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 L4 Deep Data Binding Paths

**关键发现：v2.0 `data` 事件和 legacy `skill_layered_result` 事件的 L4 绑定方式不同！**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    L4 Deep Data Binding - Two Different Paths               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Path A: v2.0 'data' Event                                           │    │
│  │                                                                      │    │
│  │  Backend (SkillExecutor):                                           │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │ Iterator 执行时:                                              │    │    │
│  │  │ 1. 收集所有迭代结果                                           │    │    │
│  │  │ 2. flattenIteratorResults() 生成:                            │    │    │
│  │  │    - columns, rows (L2 表格数据)                              │    │    │
│  │  │    - expandableData[] (L4 数据已绑定!)                        │    │    │
│  │  │    - summary (汇总报告)                                       │    │    │
│  │  │ 3. DataEnvelope.data.expandableData 包含完整 L4 数据          │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │                              │                                       │    │
│  │                              ▼                                       │    │
│  │  Frontend (ai_panel.ts):                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │ case 'data':                                                  │    │    │
│  │  │   envelopeToSqlQueryResult(envelope)                          │    │    │
│  │  │   → expandableData 直接从 envelope.data.expandableData 复制   │    │    │
│  │  │   → 无需额外绑定逻辑                                          │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │                                                                      │    │
│  │  ✓ L4 数据已在后端预绑定                                           │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Path B: Legacy 'skill_layered_result' Event                         │    │
│  │                                                                      │    │
│  │  Backend:                                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │ LayeredSkillResult 结构:                                      │    │    │
│  │  │ {                                                             │    │    │
│  │  │   layers: {                                                   │    │    │
│  │  │     overview: { stepId: DisplayResult },                      │    │    │
│  │  │     list: { stepId: DisplayResult },     // L2                │    │    │
│  │  │     deep: {                              // L4 分开存储!      │    │    │
│  │  │       sessionId: {                                            │    │    │
│  │  │         frameId: DisplayResult                                │    │    │
│  │  │       }                                                       │    │    │
│  │  │     }                                                         │    │    │
│  │  │   }                                                           │    │    │
│  │  │ }                                                             │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │                              │                                       │    │
│  │                              ▼                                       │    │
│  │  Frontend (ai_panel.ts):                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │ case 'skill_layered_result':                                  │    │    │
│  │  │   1. 提取 layers.list (L2)                                    │    │    │
│  │  │   2. 提取 layers.deep (L4)                                    │    │    │
│  │  │   3. findFrameDetail(frameId, sessionId) 函数:                │    │    │
│  │  │      - 遍历 deep 查找匹配的 frame                             │    │    │
│  │  │      - 支持多种 key 格式: "123", "frame_123"                  │    │    │
│  │  │   4. 为每个 L2 行绑定对应的 L4 数据                           │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │                                                                      │    │
│  │  ✗ L4 绑定在前端进行，需要 frame_id/session_id 匹配               │    │
│  │  ✗ 如果 ID 不匹配，静默失败                                       │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. 待修复问题追踪

| # | Issue | Status | 说明 |
|---|-------|--------|------|
| 1 | ~~多轮分析时 SSE 事件去重键冲突~~ | ✅ NOT A BUG | `clear()` 在每次新消息时调用 |
| 2 | ~~PENDING 状态未统一使用~~ | ✅ DOC FIXED | 更新状态机图示反映实际行为 |
| 3 | ~~chart/metric/timeline 渲染器未实现~~ | ✅ IMPLEMENTED | 添加 format 分发 + ChartVisualizer/MetricCard |
| 4 | ~~无 runtime type validation~~ | ✅ IMPLEMENTED | broadcastToClients 中添加 validateDataEnvelope |

---

## 8. AI Agent State Machines (核心)

本节描述 AI Agent 系统的核心状态机，这是整个分析系统的大脑。

### 8.1 Agent Phase State Machine (AgentStateMachine)

Agent Phase 状态机是整个分析系统的核心，管理分析生命周期的所有阶段转换。

**文件:** `backend/src/agent/core/stateMachine.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Agent Phase State Machine                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────────┐                                 │
│                              │    IDLE     │                                 │
│                              │  初始状态   │                                 │
│                              └──────┬──────┘                                 │
│                                     │                                        │
│                                     │ START_ANALYSIS                         │
│                                     ▼                                        │
│                              ┌─────────────┐                                 │
│                              │  PLANNING   │◄────────────────────────┐       │
│                              │ 理解意图    │                         │       │
│                              │ 制定计划    │                         │       │
│                              └──────┬──────┘                         │       │
│                                     │                                │       │
│          INTENT_UNDERSTOOD / PLAN_CREATED                            │       │
│                                     │                                │       │
│                                     ▼                                │       │
│      ┌──────────────────────────────────────────────────────┐        │       │
│      │                                                      │        │       │
│      │    ┌─────────────┐           ┌─────────────┐         │        │       │
│      │    │  EXECUTING  │           │  EVALUATING │         │        │       │
│      │    │  执行分析   │◄─────────►│  评估结果   │         │        │       │
│      │    │  调用Skills │           │  质量检查   │         │        │       │
│      │    └──────┬──────┘           └──────┬──────┘         │        │       │
│      │           │                         │                │        │       │
│      │           │  STAGE_COMPLETED        │ EVALUATION_    │        │       │
│      │           ├────────────────────────►│ COMPLETE       │        │       │
│      │           │                         │                │        │       │
│      │           │                         ├─► passed=true ─┼───────►│ ──────┤
│      │           │                         │                │        │       │
│      │           │                         │                │        │       │
│      │           │                    passed=false          │        │       │
│      │           │                         │                │        │       │
│      │           │                         ▼                │        │       │
│      │           │                  ┌─────────────┐         │        │       │
│      │           │                  │  REFINING   │         │        │       │
│      │           │◄─────────────────│  优化迭代   │         │        │       │
│      │           │ NEEDS_REFINEMENT │  改进结果   │─────────┼───────►│ ──────┤
│      │           │                  └─────────────┘         │        │       │
│      │                                    │                 │        │       │
│      │              迭代循环 (最多 N 次)   │                 │        │       │
│      └──────────────────────────────────────────────────────┘        │       │
│                                                                      │       │
│                                     │                                │       │
│          ┌──────────────────────────┼────────────────────────────────┘       │
│          │                          │                                        │
│          │ CIRCUIT_TRIPPED          │ ANALYSIS_COMPLETE                      │
│          ▼                          ▼                                        │
│   ┌─────────────────┐        ┌─────────────┐         ┌─────────────┐        │
│   │  AWAITING_USER  │        │  COMPLETED  │         │   FAILED    │        │
│   │  等待用户决策   │        │  终态(成功) │         │  终态(失败) │        │
│   │                 │        └─────────────┘         └──────▲──────┘        │
│   │  Options:       │                                       │               │
│   │  - continue     │───────────────────────────────────────┤               │
│   │  - abort        │───────────────────────────────────────┘               │
│   │  - skip         │                                                       │
│   └─────────────────┘                                                       │
│          │                                                                   │
│          │ USER_RESPONDED                                                    │
│          │ (nextPhase in payload)                                            │
│          └──────────────────────────────────────────────────────────────────┤
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Agent Phase 定义

| Enum Value | 字符串值 | 描述 | 可转换到 |
|------------|----------|------|----------|
| `AgentPhase.IDLE` | `'idle'` | 初始状态，等待分析开始 | PLANNING, FAILED |
| `AgentPhase.PLANNING` | `'planning'` | 理解用户意图，制定分析计划 | EXECUTING, AWAITING_USER, FAILED |
| `AgentPhase.EXECUTING` | `'executing'` | 执行 Skill 分析任务 | EVALUATING, AWAITING_USER, FAILED |
| `AgentPhase.EVALUATING` | `'evaluating'` | 评估分析结果的质量和完整性 | REFINING, COMPLETED, AWAITING_USER, FAILED |
| `AgentPhase.REFINING` | `'refining'` | 根据评估反馈优化迭代 | EXECUTING, EVALUATING, COMPLETED, AWAITING_USER, FAILED |
| `AgentPhase.AWAITING_USER` | `'awaiting_user'` | 断路器触发，等待用户决策 | PLANNING, EXECUTING, EVALUATING, REFINING, COMPLETED, FAILED |
| `AgentPhase.COMPLETED` | `'completed'` | **终态** - 分析成功完成 | (无) |
| `AgentPhase.FAILED` | `'failed'` | **终态** - 分析失败 | IDLE (可重新开始) |

#### 核心枚举类型 (Type-Safe Enums)

**v2.1 更新**: 所有状态和事件类型已从 type alias 升级为 enum，提供更好的类型安全和 IDE 支持。

##### AgentPhase Enum

```typescript
// 文件: backend/src/agent/types.ts
export enum AgentPhase {
  IDLE = 'idle',
  PLANNING = 'planning',
  EXECUTING = 'executing',
  EVALUATING = 'evaluating',
  REFINING = 'refining',
  AWAITING_USER = 'awaiting_user',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
```

##### StateEventType Enum

```typescript
// 文件: backend/src/agent/types.ts
export enum StateEventType {
  START_ANALYSIS = 'START_ANALYSIS',       // idle → planning
  INTENT_UNDERSTOOD = 'INTENT_UNDERSTOOD', // planning → executing
  PLAN_CREATED = 'PLAN_CREATED',           // planning → executing
  STAGE_STARTED = 'STAGE_STARTED',         // (内部使用)
  STAGE_COMPLETED = 'STAGE_COMPLETED',     // executing → evaluating
  EVALUATION_COMPLETE = 'EVALUATION_COMPLETE', // evaluating → completed/refining
  NEEDS_REFINEMENT = 'NEEDS_REFINEMENT',   // refining → executing
  CIRCUIT_TRIPPED = 'CIRCUIT_TRIPPED',     // any → awaiting_user
  USER_RESPONDED = 'USER_RESPONDED',       // awaiting_user → (payload.nextPhase)
  ANALYSIS_COMPLETE = 'ANALYSIS_COMPLETE', // any → completed
  ERROR_OCCURRED = 'ERROR_OCCURRED',       // any → failed
}
```

##### CircuitState Enum

```typescript
// 文件: backend/src/agent/types.ts
export enum CircuitState {
  CLOSED = 'closed',      // 正常运行
  OPEN = 'open',          // 熔断状态
  HALF_OPEN = 'half-open', // 测试恢复中
}
```

#### StateEvent 接口

```typescript
interface StateEvent {
  type: StateEventType;
  payload?: any;
  timestamp?: number;
}
```

##### 使用示例

```typescript
// 触发状态转换
stateMachine.transition({ type: StateEventType.START_ANALYSIS });

// 检查状态
if (stateMachine.phase === AgentPhase.COMPLETED) {
  // ...
}

// 检查断路器状态
if (circuitBreaker.circuitState === CircuitState.OPEN) {
  // ...
}
```

#### Checkpoint 机制

状态机支持检查点持久化，用于长时间分析的暂停和恢复：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Checkpoint Mechanism                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐   checkpoint()    ┌──────────────────────────────────┐    │
│   │ StageResult │ ───────────────►  │  Checkpoint                      │    │
│   │ + Findings  │                   │  ├─ id: "session_stage_timestamp"│    │
│   └─────────────┘                   │  ├─ stageId: string              │    │
│                                     │  ├─ phase: AgentPhase            │    │
│                                     │  ├─ agentState: Serialized       │    │
│                                     │  ├─ stageResults: StageResult[]  │    │
│                                     │  ├─ findings: Finding[]          │    │
│                                     │  └─ canResume: boolean           │    │
│                                     └──────────────┬───────────────────┘    │
│                                                    │                        │
│                                                    │ persist()              │
│                                                    ▼                        │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    Disk (agent-state/*.json)                         │  │
│   │                                                                      │  │
│   │   自动保存间隔: 5 秒                                                  │  │
│   │   保存触发: 状态转换 / checkpoint 创建 / 定时器                        │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                    │                        │
│                                                    │ restore()              │
│                                                    ▼                        │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    Resume Execution                                  │  │
│   │                                                                      │  │
│   │   restoreFromCheckpoint(checkpoint)                                  │  │
│   │   → 恢复 phase, stageIndex, stageResults                            │  │
│   │   → 从中断点继续执行                                                  │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 8.2 Circuit Breaker State Machine

断路器状态机保护系统免受无限循环和级联失败的影响。

**文件:** `backend/src/agent/core/circuitBreaker.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Circuit Breaker State Machine                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────────┐                                 │
│                  ┌──────────►│   CLOSED    │◄────────────────┐               │
│                  │           │  正常状态   │                 │               │
│                  │           │  允许请求   │                 │               │
│                  │           └──────┬──────┘                 │               │
│                  │                  │                        │               │
│                  │   recordSuccess  │  recordFailure         │               │
│                  │   (在半开状态)    │  × N 次               │               │
│                  │                  │                        │               │
│                  │                  │  failureCount >=       │               │
│                  │                  │  maxRetriesPerAgent    │               │
│                  │                  │                        │               │
│                  │                  ▼                        │               │
│                  │           ┌─────────────┐                 │               │
│                  │           │    OPEN     │                 │               │
│                  │           │  熔断状态   │                 │               │
│                  │           │  拒绝请求   │                 │               │
│                  │           │  等待冷却   │                 │               │
│                  │           └──────┬──────┘                 │               │
│                  │                  │                        │               │
│                  │                  │ cooldownMs 过后        │               │
│                  │                  │                        │               │
│                  │                  ▼                        │               │
│                  │           ┌─────────────┐                 │               │
│                  └───────────│  HALF-OPEN  │─────────────────┘               │
│                    success   │  半开状态   │    failure                      │
│                    (首次)    │  测试恢复   │    → 回到 OPEN                  │
│                              └─────────────┘                                 │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Failure Recording Flow                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐                                                            │
│   │ Agent 执行  │                                                            │
│   │   失败      │                                                            │
│   └──────┬──────┘                                                            │
│          │                                                                   │
│          ▼                                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  recordFailure(agentId, error)                                       │   │
│   │                                                                      │   │
│   │   1. 增加 retryCounters[agentId]                                     │   │
│   │   2. 添加到 failureHistory (保留最近 20 条)                           │   │
│   │   3. 触发 'failure' 事件                                             │   │
│   │                                                                      │   │
│   │   if (count >= maxRetriesPerAgent):                                  │   │
│   │     → trip() → 进入 OPEN 状态                                        │   │
│   │     → 返回 { action: 'ask_user', reason, context }                   │   │
│   │   else:                                                              │   │
│   │     → 返回 { action: 'retry', delay: backoff(count) }                │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Iteration Recording Flow                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐                                                            │
│   │ 阶段迭代    │                                                            │
│   │   计数      │                                                            │
│   └──────┬──────┘                                                            │
│          │                                                                   │
│          ▼                                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  recordIteration(stageId)                                            │   │
│   │                                                                      │   │
│   │   1. 增加 iterationCounters[stageId]                                 │   │
│   │   2. 触发 'iteration' 事件                                           │   │
│   │                                                                      │   │
│   │   if (count >= maxIterationsPerStage):                               │   │
│   │     → 返回 { action: 'ask_user', reason, context: diagnostics }      │   │
│   │   else:                                                              │   │
│   │     → 返回 { action: 'continue' }                                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 断路器决策表

| 情况 | 返回决策 | 后续动作 |
|------|----------|----------|
| `count < maxRetries` | `{ action: 'retry', delay: backoff }` | 等待后重试 |
| `count >= maxRetries` | `{ action: 'ask_user', reason, context }` | 熔断，等待用户 |
| `iterations >= maxIterations` | `{ action: 'ask_user', reason }` | 请求用户决策 |
| 用户选择 `continue` | `{ action: 'continue' }` | 强制关闭断路器，继续 |
| 用户选择 `abort` | `{ action: 'abort' }` | 中止分析 |
| 用户选择 `skip` | `{ action: 'skip' }` | 跳过当前阶段 |

#### 指数退避公式

```typescript
delay = min(baseDelay * 2^(attemptNumber-1), maxDelay)
jitter = delay * 0.2 * random(-1, 1)
finalDelay = delay + jitter

// 配置默认值
baseDelay = 1000ms
maxDelay = 30000ms
```

---

### 8.3 Pipeline Executor State Machine

流水线执行器管理分析阶段的有序执行。

**文件:** `backend/src/agent/core/pipelineExecutor.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Pipeline Executor State Machine                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                          ┌─────────────┐                                     │
│                          │    IDLE     │                                     │
│                          │  isRunning  │                                     │
│                          │   = false   │                                     │
│                          └──────┬──────┘                                     │
│                                 │                                            │
│                                 │ execute(context, callbacks)                │
│                                 │ isRunning = true                           │
│                                 ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        RUNNING (执行循环)                             │   │
│  │                                                                      │   │
│  │   for each stage in executionOrder:                                  │   │
│  │                                                                      │   │
│  │     ┌─────────────────────────────────────────────────────────────┐  │   │
│  │     │  1. Check isPaused                                           │  │   │
│  │     │     → if true: return PausedResult                           │  │   │
│  │     │                                                              │  │   │
│  │     │  2. Check timeout                                            │  │   │
│  │     │     → if elapsed > maxTotalDuration: throw TimeoutError      │  │   │
│  │     │                                                              │  │   │
│  │     │  3. Wait for dependencies                                    │  │   │
│  │     │     → if not met: skip or fail                               │  │   │
│  │     │                                                              │  │   │
│  │     │  4. Execute stage (with retries)                             │  │   │
│  │     │     → Hook: subagent:start (pre)                             │  │   │
│  │     │     → executor.execute(stage, isolatedContext)               │  │   │
│  │     │     → Hook: subagent:complete (post)                         │  │   │
│  │     │                                                              │  │   │
│  │     │  5. Handle result                                            │  │   │
│  │     │     → success: save result, continue                         │  │   │
│  │     │     → failure: handleStageError() → retry/skip/abort/ask_user│  │   │
│  │     └─────────────────────────────────────────────────────────────┘  │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                 │                                            │
│            ┌────────────────────┼────────────────────┐                       │
│            │                    │                    │                       │
│            ▼                    ▼                    ▼                       │
│     ┌─────────────┐      ┌─────────────┐      ┌─────────────┐               │
│     │   SUCCESS   │      │   PAUSED    │      │   ERROR     │               │
│     │             │      │  pausedAt   │      │   error     │               │
│     │ completed   │      │  = stageId  │      │   message   │               │
│     │ Stages: []  │      └─────────────┘      └─────────────┘               │
│     │ failed: []  │                                                         │
│     └─────────────┘                                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 默认流水线阶段

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Default Pipeline Stages                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────┐     ┌─────────┐     ┌──────────┐     ┌─────────┐     ┌───────┐│
│   │  PLAN   │────►│ EXECUTE │────►│ EVALUATE │────►│ REFINE  │────►│CONCLUDE│
│   │         │     │         │     │          │     │         │     │       ││
│   │ planner │     │ worker  │     │ evaluator│     │ worker  │     │synth. ││
│   │ 30s     │     │ 120s    │     │ 60s      │     │ 120s    │     │ 60s   ││
│   │ retry:2 │     │ retry:2 │     │ retry:1  │     │ retry:2 │     │retry:1││
│   └─────────┘     └─────────┘     └──────────┘     └─────────┘     └───────┘│
│       │               │                │                │              │     │
│       │               │                │                │              │     │
│       ▼               ▼                ▼                ▼              ▼     │
│   理解意图        执行 Skills      检查质量        根据反馈       生成最终  │
│   制定计划        分析数据         评估完整性      优化迭代       答案      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 阶段依赖关系 (拓扑排序)

| Stage | Dependencies | Can Parallelize | Timeout | Max Retries |
|-------|--------------|-----------------|---------|-------------|
| plan | [] | ❌ | 30s | 2 |
| execute | [plan] | ✅ | 120s | 2 |
| evaluate | [execute] | ❌ | 60s | 1 |
| refine | [evaluate] | ❌ | 120s | 2 |
| conclude | [refine] | ❌ | 60s | 1 |

#### 错误处理决策

| PipelineErrorDecision | 说明 |
|----------------------|------|
| `retry` | 重试当前阶段 |
| `skip` | 跳过当前阶段，继续下一个 |
| `abort` | 中止整个流水线 |
| `ask_user` | 暂停流水线，等待用户决策 |

---

### 8.4 MasterOrchestrator 完整执行流程

MasterOrchestrator 协调 StateMachine、CircuitBreaker 和 PipelineExecutor 完成分析：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MasterOrchestrator Execution Flow                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   handleQuery(query, traceId, options)                                       │
│           │                                                                  │
│           ▼                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Session Initialization                                           │   │
│   │                                                                      │   │
│   │   - SessionStore.create(sessionId, traceId)                          │   │
│   │   - AgentStateMachine.create(sessionId, traceId)                     │   │
│   │   - emit('update', { type: 'progress', phase: 'starting' })          │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  2. Architecture Detection (可选)                                    │   │
│   │                                                                      │   │
│   │   - ArchitectureDetector.detect(traceId)                             │   │
│   │   - emit('architecture_detected', { type, flutter, webview })        │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  3. Intent Understanding (PlannerAgent)                              │   │
│   │                                                                      │   │
│   │   - stateMachine.transition({ type: 'START_ANALYSIS' })              │   │
│   │   - plannerAgent.understandIntent(query, context)                    │   │
│   │   - emit('thought', { agent: 'planner', message })                   │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  4. Plan Creation (PlannerAgent)                                     │   │
│   │                                                                      │   │
│   │   - plannerAgent.createPlan(intent, availableSkills)                 │   │
│   │   - stateMachine.transition({ type: 'PLAN_CREATED' })                │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  5. Analysis Loop (最多 maxTotalIterations 次)                       │   │
│   │                                                                      │   │
│   │   while (iterations < maxTotalIterations):                           │   │
│   │                                                                      │   │
│   │     ┌─────────────────────────────────────────────────────────────┐  │   │
│   │     │  5a. Circuit Breaker Check                                   │  │   │
│   │     │      decision = circuitBreaker.canExecute()                  │  │   │
│   │     │      if (decision.action === 'ask_user'):                    │  │   │
│   │     │        → emit('circuit_breaker', { reason, options })        │  │   │
│   │     │        → stateMachine.transition({ type: 'CIRCUIT_TRIPPED' })│  │   │
│   │     │        → 等待用户响应                                        │  │   │
│   │     └─────────────────────────────────────────────────────────────┘  │   │
│   │                               │                                      │   │
│   │                               ▼                                      │   │
│   │     ┌─────────────────────────────────────────────────────────────┐  │   │
│   │     │  5b. Pipeline Execution                                      │  │   │
│   │     │      pipelineExecutor.execute(context, callbacks)            │  │   │
│   │     │      → 执行 plan → execute → evaluate → refine → conclude    │  │   │
│   │     │      → emit('skill_data', { skillId, layers })               │  │   │
│   │     │      → emit('worker_thought', { agent, step })               │  │   │
│   │     └─────────────────────────────────────────────────────────────┘  │   │
│   │                               │                                      │   │
│   │                               ▼                                      │   │
│   │     ┌─────────────────────────────────────────────────────────────┐  │   │
│   │     │  5c. Evaluation (EvaluatorAgent)                             │  │   │
│   │     │      evaluation = evaluatorAgent.evaluate(results)           │  │   │
│   │     │      stateMachine.transition({ type: 'EVALUATION_COMPLETE',  │  │   │
│   │     │                                payload: { passed } })        │  │   │
│   │     │                                                              │  │   │
│   │     │      if (evaluation.passed):                                 │  │   │
│   │     │        → break (跳出循环)                                    │  │   │
│   │     │      else:                                                   │  │   │
│   │     │        → stateMachine.transition({ type: 'NEEDS_REFINEMENT'})│  │   │
│   │     │        → 继续迭代                                            │  │   │
│   │     └─────────────────────────────────────────────────────────────┘  │   │
│   │                                                                      │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  6. Synthesis                                                        │   │
│   │                                                                      │   │
│   │   - synthesizedAnswer = generateFinalAnswer(findings, results)       │   │
│   │   - stateMachine.transition({ type: 'ANALYSIS_COMPLETE' })           │   │
│   │   - emit('conclusion', { answer, confidence })                       │   │
│   └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│                                   ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  7. Return Result                                                    │   │
│   │                                                                      │   │
│   │   return {                                                           │   │
│   │     sessionId,                                                       │   │
│   │     success: true,                                                   │   │
│   │     synthesizedAnswer,                                               │   │
│   │     findings,                                                        │   │
│   │     stageResults,                                                    │   │
│   │     iterationCount                                                   │   │
│   │   }                                                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 8.5 OrchestratorBridge 事件映射

OrchestratorBridge 将 MasterOrchestrator 的内部事件转换为前端期望的 SSE 格式：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OrchestratorBridge Event Mapping                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   MasterOrchestrator Event              Frontend SSE Event                   │
│   ─────────────────────────             ──────────────────                   │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'progress'          │ ───────────►  │ type: 'progress'            │     │
│   │ { phase, message }  │               │ data: { step, message }     │     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'skill_data'        │ ───────────►  │ type: 'skill_layered_result'│     │
│   │ { skillId, layers } │               │ data: { skillId, layers }   │     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'finding'           │ ───────────►  │ type: 'skill_diagnostics'   │     │
│   │ { finding }         │               │ data: { diagnostics: [...] }│     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'worker_thought'    │ ───────────►  │ type: 'progress'            │     │
│   │ { agent, step }     │               │ data: { step, message,      │     │
│   │                     │               │         agent, skillId }    │     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'thought'           │ ───────────►  │ type: 'progress'            │     │
│   │ { agent, message }  │               │ data: { step: 'agent_thought│     │
│   │                     │               │         message, agent }    │     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ update.type:        │               │ emitSSE:                    │     │
│   │ 'error'             │ ───────────►  │ type: 'error'               │     │
│   │ { message }         │               │ data: { error, recoverable }│     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
│   ┌─────────────────────┐               ┌─────────────────────────────┐     │
│   │ Result (from        │               │ emitSSE:                    │     │
│   │  handleQuery)       │ ───────────►  │ type: 'analysis_completed'  │     │
│   │                     │               │ data: { sessionId, answer,  │     │
│   │                     │               │         metrics, reportUrl }│     │
│   └─────────────────────┘               └─────────────────────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. SSE Connection State Machine (Implemented)

> 注: 这是前端（Perfetto Plugin）的连接状态机

This state machine describes the SSE connection lifecycle with automatic reconnection and exponential backoff.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SSE Connection State Machine                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐                                                            │
│  │ DISCONNECTED │ ◄────────────────────────────────────────────────────┐    │
│  └──────┬───────┘                                                       │    │
│         │                                                               │    │
│         │ listenToAgentSSE(sessionId)                                   │    │
│         ▼                                                               │    │
│  ┌──────────────┐                                                       │    │
│  │  CONNECTING  │                                                       │    │
│  └──────┬───────┘                                                       │    │
│         │                                                               │    │
│    ┌────┴────┐                                                          │    │
│    │         │                                                          │    │
│    ▼         ▼                                                          │    │
│ success   error                                                         │    │
│    │         │                                                          │    │
│    ▼         ▼                                                          │    │
│  ┌──────────────┐      retryCount < maxRetries      ┌───────────────┐  │    │
│  │  CONNECTED   │                                   │  RECONNECTING │  │    │
│  │              │                                   │               │  │    │
│  │  Processing  │                                   │  Exponential  │  │    │
│  │  SSE events  │                                   │  Backoff Wait │  │    │
│  └──────┬───────┘                                   └───────┬───────┘  │    │
│         │                                                   │          │    │
│    ┌────┴────────────┐                    wait complete    │          │    │
│    │    │            │                                     │          │    │
│    │    │            ▼                                     │          │    │
│    │    │   ┌─────────────────┐                            │          │    │
│    │    │   │ Terminal Event  │ ───────────────────────────┼──────────┘    │
│    │    │   │ (completed/error)│                           │               │
│    │    │   └─────────────────┘                            │               │
│    │    │                                                  │               │
│    │    │ connection lost                                  │               │
│    │    ▼                                                  ▼               │
│    │ retryCount >= maxRetries         ┌──────────────────────┐            │
│    │         │                        │   Retry Connection   │            │
│    │         │                        │   (back to CONNECTING)│            │
│    │         │                        └──────────────────────┘            │
│    │         │                                                            │
│    │         ▼                                                            │
│    │   ┌─────────────────┐                                                │
│    │   │  MAX RETRIES    │ ──── Show error message ────────────────┐     │
│    │   │    EXCEEDED     │                                         │     │
│    │   └─────────────────┘                                         │     │
│    │                                                               │     │
│    │ stream ended normally                                         │     │
│    ▼                                                               │     │
│  ┌──────────────────┐                                              │     │
│  │   DISCONNECTED   │ ◄────────────────────────────────────────────┘     │
│  │    (success)     │                                                    │
│  └──────────────────┘                                                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Connection States

| State | Description |
|-------|-------------|
| `disconnected` | No active connection, initial state |
| `connecting` | First connection attempt in progress |
| `connected` | Successfully connected, processing events |
| `reconnecting` | Connection lost, waiting to retry |

### Key Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `sseMaxRetries` | 5 | Maximum reconnection attempts |
| Base delay | 1000ms | Initial backoff delay |
| Max delay | 30000ms | Maximum backoff delay |
| Jitter | ±20% | Randomization to prevent thundering herd |

### Exponential Backoff Formula

```typescript
delay = min(baseDelay * 2^retryCount, maxDelay)
jitter = delay * 0.2 * random(-1, 1)
finalDelay = delay + jitter
```

### Terminal Events (No Reconnection)

1. `analysis_completed` - Analysis finished successfully
2. `error` - Server reported fatal error
3. Stream ended normally (server closed connection)
4. User-initiated abort (new analysis started)

---

## 10. Error Aggregation State Machine (Implemented v1.3.0)

This state machine describes how skill execution errors are collected and displayed to users.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Error Aggregation State Machine                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        Backend (SkillExecutor)                         │  │
│  │                                                                        │  │
│  │  executeAtomicStep() / executeCompositeSkill()                        │  │
│  │       │                                                                │  │
│  │       ├─► Success → emit 'data' / 'skill_layered_result'               │  │
│  │       │                                                                │  │
│  │       └─► Failure → emit 'skill_error' event                          │  │
│  │            {                                                           │  │
│  │              type: 'skill_error',                                      │  │
│  │              data: {                                                   │  │
│  │                skillId: string,                                        │  │
│  │                stepId: string,                                         │  │
│  │                error: string,                                          │  │
│  │                sql?: string,           // 失败的 SQL                   │  │
│  │                timestamp: number                                       │  │
│  │              }                                                         │  │
│  │            }                                                           │  │
│  │                                                                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│                              │ SSE                                           │
│                              ▼                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        Frontend (AIPanel)                              │  │
│  │                                                                        │  │
│  │  State:                                                                │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  collectedErrors: Array<{                                        │  │  │
│  │  │    skillId: string,                                              │  │  │
│  │  │    stepId: string,                                               │  │  │
│  │  │    error: string,                                                │  │  │
│  │  │    timestamp: number                                             │  │  │
│  │  │  }>                                                              │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  handleSSEEvent('skill_error', data):                                 │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  1. Extract error info from data                                 │  │  │
│  │  │  2. Push to this.collectedErrors                                 │  │  │
│  │  │  3. console.warn() for debugging                                 │  │  │
│  │  │  4. (Errors NOT shown to user yet - collected for summary)       │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  handleSSEEvent('analysis_completed', ...):                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  1. Process completion normally                                  │  │  │
│  │  │  2. if (collectedErrors.length > 0):                             │  │  │
│  │  │     └─► showErrorSummary()                                       │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  showErrorSummary():                                                  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  1. Build summary message:                                       │  │  │
│  │  │     "⚠️ {n} 个步骤执行失败:                                       │  │  │
│  │  │      • skill/step: error message                                 │  │  │
│  │  │      ..."                                                        │  │  │
│  │  │  2. Add to messages as { type: 'assistant', content: summary }   │  │  │
│  │  │  3. Clear collectedErrors = []                                   │  │  │
│  │  │  4. scheduleFullUpdate()                                         │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Error Aggregation Flow

| Step | Action | Result |
|------|--------|--------|
| 1 | Skill step fails | Backend emits `skill_error` event |
| 2 | Frontend receives | Error pushed to `collectedErrors` |
| 3 | More steps execute | More errors may accumulate |
| 4 | Analysis completes | `analysis_completed` triggers summary |
| 5 | Summary displayed | User sees all errors at once |
| 6 | Errors cleared | `collectedErrors = []` for next analysis |

### Benefits

1. **Non-blocking**: Errors don't interrupt the analysis flow
2. **Aggregated view**: Users see all failures at once, not one by one
3. **Context preserved**: Each error includes skillId, stepId, and message
4. **Clean UX**: Errors shown at the end, not scattered in results

---

## 11. AI 闭环架构问题诊断

### 11.1 核心问题：当前系统不是真正的 AI Agents 驱动

经过深度 Review，发现当前架构存在根本性问题：**AI 更像是"装饰品"，而不是真正的决策核心**。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    当前架构 vs 真正的 AI Agents 架构                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   当前架构（AI 辅助的确定性执行器）：                                         │
│   ─────────────────────────────────                                          │
│                                                                              │
│   User Query ──► PlannerAgent ──► 预定义 Skills ──► 确定性执行 ──► 拼接结果  │
│                  (一次性 AI)      (YAML + SQL)      (无 AI)       (无 AI)    │
│                                                                              │
│   问题:                                                                      │
│   1. Skills 不是 Agent，只是配置文件                                         │
│   2. 执行是确定性的，无法根据中间结果调整                                    │
│   3. 评估结果被 hardcode 覆盖 (auto-pass)                                    │
│   4. 无多 Agent 协作和信息交换                                               │
│   5. AI 只在开头和结尾参与，中间完全缺席                                     │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   真正的 AI Agents 架构：                                                    │
│   ─────────────────────                                                      │
│                                                                              │
│   User Query ──► Master Agent ◄──► 多个子 Agents ──► 反馈循环 ──► AI 决策   │
│                  (AI 决策核心)    (每个有 AI)        (动态调整)    (智能洞见) │
│                                                                              │
│   特点:                                                                      │
│   1. 每个子 Agent 有独立的 AI 能理解、推理、反馈                             │
│   2. Master Agent 动态派发任务，根据反馈调整策略                             │
│   3. Agents 之间可以相互请求信息                                             │
│   4. 形成真正的分析-反馈-优化闭环                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 11.2 五大具体问题

| # | 问题 | 代码位置 | 影响 |
|---|------|----------|------|
| 1 | **评估结果被 hardcode 覆盖** | `masterOrchestrator.ts:746-757` | AI 评估永远不会触发迭代 |
| 2 | **评估反馈未被下轮使用** | `createPlan()` 不接收 feedback | refining 和 executing 做同样的事 |
| 3 | **多轮对话上下文断裂** | `understandIntent()` 不传递 sessionContext | AI 每轮都是"失忆"状态 |
| 4 | **AI 不参与数据解读** | L1/L2/L4 数据直接来自 SQL | 用户看到的主要内容无 AI 参与 |
| 5 | **Skills 不是 Agents** | YAML + SQL 配置文件 | 无法理解、推理、反馈 |

---

## 12. 真正的 AI Agents 架构设计

### 12.1 目标架构总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SmartPerfetto AI Agents 架构 (目标)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              用户查询                                        │
│                                 │                                            │
│                                 ▼                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                                                                      │   │
│   │                    Master Performance Agent                          │   │
│   │                    ═══════════════════════                           │   │
│   │                                                                      │   │
│   │    核心 AI 能力:                                                     │   │
│   │    ┌────────────────────────────────────────────────────────────┐   │   │
│   │    │ • 深度理解用户意图（不只是关键词匹配）                       │   │   │
│   │    │ • 维护对话上下文，理解追问和澄清                            │   │   │
│   │    │ • 动态决策：需要哪些信息来诊断问题                          │   │   │
│   │    │ • 综合推理：从多源信息建立因果链                            │   │   │
│   │    │ • 主动发现：识别信息缺口并补充                              │   │   │
│   │    │ • 生成洞见：不只是描述问题，而是提供解决思路                │   │   │
│   │    └────────────────────────────────────────────────────────────┘   │   │
│   │                                                                      │   │
│   │    状态:                                                             │   │
│   │    ┌────────────────────────────────────────────────────────────┐   │   │
│   │    │ • 当前假设 (Hypotheses)                                     │   │   │
│   │    │ • 已收集的证据 (Evidence)                                   │   │   │
│   │    │ • 待验证的问题 (Open Questions)                             │   │   │
│   │    │ • 对话历史 (Conversation Context)                           │   │   │
│   │    └────────────────────────────────────────────────────────────┘   │   │
│   │                                                                      │   │
│   └──────────────────────────┬──────────────────────────────────────────┘   │
│                              │                                               │
│                              │ 动态派发任务                                  │
│                              │                                               │
│   ┌──────────────────────────┴──────────────────────────────────────────┐   │
│   │                                                                      │   │
│   │                         子 Agent 层                                  │   │
│   │                         ═══════════                                  │   │
│   │                                                                      │   │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐│   │
│   │  │ Frame Agent  │ │ CPU Agent    │ │ Binder Agent │ │ Memory Agent ││   │
│   │  │              │ │              │ │              │ │              ││   │
│   │  │ AI 能力:     │ │ AI 能力:     │ │ AI 能力:     │ │ AI 能力:     ││   │
│   │  │ • 理解帧指标 │ │ • 分析调度   │ │ • 分析 IPC   │ │ • 分析内存   ││   │
│   │  │ • 判断卡顿   │ │ • 识别热点   │ │ • 检测超时   │ │ • 检测泄漏   ││   │
│   │  │ • 提出假设   │ │ • 定位瓶颈   │ │ • 追踪调用链 │ │ • 追踪分配   ││   │
│   │  │              │ │              │ │              │ │              ││   │
│   │  │ 工具:        │ │ 工具:        │ │ 工具:        │ │ 工具:        ││   │
│   │  │ SQL 查询     │ │ SQL 查询     │ │ SQL 查询     │ │ SQL 查询     ││   │
│   │  │ 指标计算     │ │ 调度分析     │ │ 事务追踪     │ │ 堆分析       ││   │
│   │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘│   │
│   │         │                │                │                │        │   │
│   │         │                │                │                │        │   │
│   │         └────────────────┴────────────────┴────────────────┘        │   │
│   │                                   │                                  │   │
│   │                                   │ 反馈                             │   │
│   │                                   ▼                                  │   │
│   │  ┌──────────────────────────────────────────────────────────────┐   │   │
│   │  │                      Agent 间通信总线                         │   │   │
│   │  │                                                              │   │   │
│   │  │  • Frame Agent → CPU Agent: "这些帧在哪个线程超时？"         │   │   │
│   │  │  • CPU Agent → Binder Agent: "这个线程在等什么 Binder？"     │   │   │
│   │  │  • Master ← All: 汇总反馈，更新假设                          │   │   │
│   │  └──────────────────────────────────────────────────────────────┘   │   │
│   │                                                                      │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                               │
│                              │ 多轮对话                                      │
│                              ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Master Agent 综合决策                             │   │
│   │                                                                      │   │
│   │    ┌────────────────────────────────────────────────────────────┐   │   │
│   │    │ 第 1 轮: 派发 Frame + Render                                │   │   │
│   │    │ 反馈: 帧超时集中在 32-35s，渲染线程阻塞                     │   │   │
│   │    │                                                             │   │   │
│   │    │ 第 2 轮: 派发 CPU + Binder (聚焦 32-35s)                     │   │   │
│   │    │ 反馈: 主线程等 Binder，getPackageInfo 耗时 89ms             │   │   │
│   │    │                                                             │   │   │
│   │    │ 决策: 根因定位完成，生成诊断报告                            │   │   │
│   │    └────────────────────────────────────────────────────────────┘   │   │
│   │                                                                      │   │
│   └──────────────────────────┬──────────────────────────────────────────┘   │
│                              │                                               │
│                              ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         最终输出                                     │   │
│   │                                                                      │   │
│   │    ┌────────────────────────────────────────────────────────────┐   │   │
│   │    │ 🔴 根因: 主线程 Binder 调用 getPackageInfo 阻塞 89ms       │   │   │
│   │    │                                                             │   │   │
│   │    │ 📊 证据链:                                                  │   │   │
│   │    │ 1. 帧超时集中在 32-35s (Frame Agent)                        │   │   │
│   │    │ 2. RenderThread 该区间阻塞 (Render Agent)                   │   │   │
│   │    │ 3. 主线程等待 Binder (CPU Agent)                            │   │   │
│   │    │ 4. getPackageInfo 调用 89ms (Binder Agent)                  │   │   │
│   │    │                                                             │   │   │
│   │    │ 💡 建议: 将 getPackageInfo 移至后台线程                     │   │   │
│   │    └────────────────────────────────────────────────────────────┘   │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 12.2 子 Agent 详细设计

每个子 Agent 是一个独立的 AI 实体，有自己的 prompt、推理能力和工具集。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    子 Agent 内部结构                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         BaseAgent (抽象类)                           │   │
│   │                                                                      │   │
│   │   interface BaseAgent {                                              │   │
│   │     id: string;                                                      │   │
│   │     domain: string;                // 'frame' | 'cpu' | 'binder'...  │   │
│   │     capabilities: string[];        // 能力描述                       │   │
│   │     tools: AgentTool[];            // 可用工具（SQL 查询等）         │   │
│   │                                                                      │   │
│   │     // 核心方法                                                      │   │
│   │     understand(task: AgentTask): Promise<TaskUnderstanding>;         │   │
│   │     plan(understanding: TaskUnderstanding): Promise<ExecutionPlan>;  │   │
│   │     execute(plan: ExecutionPlan): Promise<ExecutionResult>;          │   │
│   │     reflect(result: ExecutionResult): Promise<Reflection>;           │   │
│   │     respond(reflection: Reflection): Promise<AgentResponse>;         │   │
│   │   }                                                                  │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         Frame Agent 示例                             │   │
│   │                                                                      │   │
│   │   class FrameAgent extends BaseAgent {                               │   │
│   │     id = 'frame_agent';                                              │   │
│   │     domain = 'frame';                                                │   │
│   │     capabilities = [                                                 │   │
│   │       '分析帧渲染时间',                                              │   │
│   │       '检测卡顿模式',                                                │   │
│   │       '计算 FPS 和 Jank 率',                                         │   │
│   │       '定位问题帧'                                                   │   │
│   │     ];                                                               │   │
│   │                                                                      │   │
│   │     tools = [                                                        │   │
│   │       { name: 'query_frame_timeline', sql: '...' },                  │   │
│   │       { name: 'calculate_jank_metrics', sql: '...' },                │   │
│   │       { name: 'find_slow_frames', sql: '...' }                       │   │
│   │     ];                                                               │   │
│   │                                                                      │   │
│   │     systemPrompt = `你是帧分析专家，负责分析帧渲染性能。             │   │
│   │       你的目标是找出卡顿帧并分析其特征。                             │   │
│   │       当你发现问题时，要清晰地描述：                                 │   │
│   │       1. 问题帧的时间范围                                            │   │
│   │       2. 卡顿的严重程度                                              │   │
│   │       3. 可能的原因假设                                              │   │
│   │       4. 需要其他 Agent 协助验证的内容`;                             │   │
│   │                                                                      │   │
│   │     async understand(task) {                                         │   │
│   │       // AI 理解任务                                                 │   │
│   │       const prompt = `任务: ${task.description}                      │   │
│   │         上下文: ${task.context}                                      │   │
│   │         请分析需要执行哪些操作`;                                     │   │
│   │       return await this.llm.call(prompt);                            │   │
│   │     }                                                                │   │
│   │                                                                      │   │
│   │     async execute(plan) {                                            │   │
│   │       // 执行 SQL 获取数据                                           │   │
│   │       const data = await this.runTools(plan.toolCalls);              │   │
│   │       return { success: true, data };                                │   │
│   │     }                                                                │   │
│   │                                                                      │   │
│   │     async reflect(result) {                                          │   │
│   │       // AI 分析执行结果                                             │   │
│   │       const prompt = `分析以下帧数据: ${result.data}                 │   │
│   │         1. 发现了什么问题？                                          │   │
│   │         2. 有什么假设？                                              │   │
│   │         3. 需要哪些额外信息来验证？`;                                │   │
│   │       return await this.llm.call(prompt);                            │   │
│   │     }                                                                │   │
│   │                                                                      │   │
│   │     async respond(reflection) {                                      │   │
│   │       // 生成反馈给 Master Agent                                     │   │
│   │       return {                                                       │   │
│   │         findings: reflection.findings,                               │   │
│   │         hypotheses: reflection.hypotheses,                           │   │
│   │         needsFromOthers: reflection.needsFromOthers,                 │   │
│   │         confidence: reflection.confidence                            │   │
│   │       };                                                             │   │
│   │     }                                                                │   │
│   │   }                                                                  │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 12.3 Master Agent 决策流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Master Agent 决策状态机                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────────┐                                 │
│                              │ UNDERSTAND  │                                 │
│                              │ 理解意图    │                                 │
│                              └──────┬──────┘                                 │
│                                     │                                        │
│                                     │ 生成初始假设                           │
│                                     ▼                                        │
│                              ┌─────────────┐                                 │
│                              │ HYPOTHESIZE │                                 │
│                              │ 建立假设    │                                 │
│                              └──────┬──────┘                                 │
│                                     │                                        │
│                                     │ 决定需要哪些信息                       │
│                                     ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         DISPATCH (派发任务)                          │   │
│   │                                                                      │   │
│   │   决策逻辑:                                                          │   │
│   │   ┌────────────────────────────────────────────────────────────┐    │   │
│   │   │ 1. 根据假设确定需要验证的方面                               │    │   │
│   │   │ 2. 选择最相关的子 Agents                                    │    │   │
│   │   │ 3. 构建任务描述，包含上下文和聚焦点                         │    │   │
│   │   │ 4. 并行或串行派发（基于依赖关系）                           │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                      │   │
│   │   示例决策:                                                          │   │
│   │   ┌────────────────────────────────────────────────────────────┐    │   │
│   │   │ 假设: "滑动卡顿可能是帧超时导致"                            │    │   │
│   │   │ 派发:                                                       │    │   │
│   │   │   → Frame Agent: "检查是否有帧超时，定位时间范围"           │    │   │
│   │   │   → Render Agent: "分析渲染管线是否有瓶颈"                  │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                      │   │
│   └──────────────────────────┬──────────────────────────────────────────┘   │
│                              │                                               │
│                              │ 等待子 Agent 反馈                            │
│                              ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         COLLECT (收集反馈)                           │   │
│   │                                                                      │   │
│   │   AgentResponse 结构:                                                │   │
│   │   {                                                                  │   │
│   │     agentId: 'frame_agent',                                          │   │
│   │     findings: [                                                      │   │
│   │       { type: 'observation', content: '发现 23 帧超时' },            │   │
│   │       { type: 'pattern', content: '集中在 32-35s 区间' }             │   │
│   │     ],                                                               │   │
│   │     hypotheses: [                                                    │   │
│   │       { id: 'h1', content: '该区间有 CPU 调度问题', confidence: 0.7 }│   │
│   │     ],                                                               │   │
│   │     needsFromOthers: [                                               │   │
│   │       { targetAgent: 'cpu_agent', question: '该区间主线程在做什么？' }│   │
│   │     ],                                                               │   │
│   │     confidence: 0.85                                                 │   │
│   │   }                                                                  │   │
│   │                                                                      │   │
│   └──────────────────────────┬──────────────────────────────────────────┘   │
│                              │                                               │
│                              │ 综合分析                                     │
│                              ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         SYNTHESIZE (综合推理)                        │   │
│   │                                                                      │   │
│   │   AI 推理过程:                                                       │   │
│   │   ┌────────────────────────────────────────────────────────────┐    │   │
│   │   │ 输入:                                                       │    │   │
│   │   │ • Frame Agent: 23 帧超时，集中在 32-35s                     │    │   │
│   │   │ • Render Agent: GPU 正常，CPU 渲染线程阻塞                  │    │   │
│   │   │                                                             │    │   │
│   │   │ 推理:                                                       │    │   │
│   │   │ • 帧超时和渲染线程阻塞在同一时间段 → 因果关系               │    │   │
│   │   │ • GPU 正常 → 排除 GPU 瓶颈                                  │    │   │
│   │   │ • CPU 渲染线程阻塞 → 需要了解阻塞原因                       │    │   │
│   │   │                                                             │    │   │
│   │   │ 更新假设:                                                   │    │   │
│   │   │ • 原假设: "帧超时" → 已验证 ✓                               │    │   │
│   │   │ • 新假设: "渲染线程被阻塞，原因待查"                        │    │   │
│   │   │                                                             │    │   │
│   │   │ 缺失信息:                                                   │    │   │
│   │   │ • 是什么阻塞了渲染线程？                                    │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                      │   │
│   └──────────────────────────┬──────────────────────────────────────────┘   │
│                              │                                               │
│                     ┌────────┴────────┐                                      │
│                     │                 │                                      │
│              信息充分              信息不足                                  │
│                     │                 │                                      │
│                     ▼                 ▼                                      │
│              ┌─────────────┐   ┌─────────────┐                               │
│              │  CONCLUDE   │   │ 回到 DISPATCH│                              │
│              │  生成结论   │   │ 派发新任务  │                               │
│              └─────────────┘   └─────────────┘                               │
│                                       │                                      │
│                                       │ 新任务: CPU Agent, Binder Agent      │
│                                       │ 聚焦: 32-35s 区间                    │
│                                       │                                      │
│                                       └──────────────────────────────────────┤
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 12.4 Agent 间通信协议

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Agent 间通信协议设计                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   消息类型定义:                                                              │
│   ─────────────                                                              │
│                                                                              │
│   // Master → Sub Agent: 任务派发                                           │
│   interface TaskMessage {                                                    │
│     type: 'task';                                                            │
│     from: 'master';                                                          │
│     to: string;           // agent id                                        │
│     task: {                                                                  │
│       id: string;                                                            │
│       description: string;                                                   │
│       context: {                                                             │
│         hypothesis: string;       // 当前假设                                │
│         timeRange?: [number, number];  // 聚焦时间范围                       │
│         relatedFindings?: Finding[];   // 相关发现                           │
│         previousResponses?: AgentResponse[];  // 其他 Agent 的反馈          │
│       };                                                                     │
│       priority: 'high' | 'normal' | 'low';                                   │
│     };                                                                       │
│   }                                                                          │
│                                                                              │
│   // Sub Agent → Master: 反馈                                                │
│   interface ResponseMessage {                                                │
│     type: 'response';                                                        │
│     from: string;         // agent id                                        │
│     to: 'master';                                                            │
│     taskId: string;                                                          │
│     response: AgentResponse;                                                 │
│   }                                                                          │
│                                                                              │
│   // Sub Agent → Sub Agent: 信息请求                                        │
│   interface QueryMessage {                                                   │
│     type: 'query';                                                           │
│     from: string;                                                            │
│     to: string;                                                              │
│     query: {                                                                 │
│       question: string;                                                      │
│       context: any;                                                          │
│     };                                                                       │
│   }                                                                          │
│                                                                              │
│   // Sub Agent → Sub Agent: 信息响应                                        │
│   interface AnswerMessage {                                                  │
│     type: 'answer';                                                          │
│     from: string;                                                            │
│     to: string;                                                              │
│     queryId: string;                                                         │
│     answer: any;                                                             │
│   }                                                                          │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   通信示例:                                                                  │
│   ─────────                                                                  │
│                                                                              │
│   1. Master → Frame Agent                                                    │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ {                                                                   │    │
│   │   type: 'task',                                                     │    │
│   │   from: 'master',                                                   │    │
│   │   to: 'frame_agent',                                                │    │
│   │   task: {                                                           │    │
│   │     id: 'task_001',                                                 │    │
│   │     description: '分析滑动过程中的帧渲染情况，找出卡顿帧',         │    │
│   │     context: {                                                      │    │
│   │       hypothesis: '用户反馈滑动卡顿，可能是帧超时导致'             │    │
│   │     },                                                              │    │
│   │     priority: 'high'                                                │    │
│   │   }                                                                 │    │
│   │ }                                                                   │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   2. Frame Agent → Master                                                    │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ {                                                                   │    │
│   │   type: 'response',                                                 │    │
│   │   from: 'frame_agent',                                              │    │
│   │   to: 'master',                                                     │    │
│   │   taskId: 'task_001',                                               │    │
│   │   response: {                                                       │    │
│   │     findings: [                                                     │    │
│   │       { type: 'observation', content: '发现 23 帧超时 (>16ms)' },   │    │
│   │       { type: 'pattern', content: '超时帧集中在 32.5s-35.2s' }      │    │
│   │     ],                                                              │    │
│   │     hypotheses: [                                                   │    │
│   │       {                                                             │    │
│   │         id: 'frame_h1',                                             │    │
│   │         content: '该时间段有系统级阻塞',                            │    │
│   │         confidence: 0.75                                            │    │
│   │       }                                                             │    │
│   │     ],                                                              │    │
│   │     needsFromOthers: [                                              │    │
│   │       {                                                             │    │
│   │         targetAgent: 'cpu_agent',                                   │    │
│   │         question: '32.5s-35.2s 区间主线程的调度情况如何？'          │    │
│   │       }                                                             │    │
│   │     ],                                                              │    │
│   │     confidence: 0.85                                                │    │
│   │   }                                                                 │    │
│   │ }                                                                   │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   3. Frame Agent → CPU Agent (Agent 间直接通信)                             │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ {                                                                   │    │
│   │   type: 'query',                                                    │    │
│   │   from: 'frame_agent',                                              │    │
│   │   to: 'cpu_agent',                                                  │    │
│   │   query: {                                                          │    │
│   │     question: '主线程在 32.5s-35.2s 区间是否有长时间阻塞？',        │    │
│   │     context: {                                                      │    │
│   │       timeRange: [32500000000, 35200000000],                         │    │
│   │       threadName: 'RenderThread'                                    │    │
│   │     }                                                               │    │
│   │   }                                                                 │    │
│   │ }                                                                   │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 12.5 实施路线图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AI Agents 架构实施路线图                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Phase 1: 基础修复 (1 周)                                                  │
│   ═══════════════════════                                                    │
│   目标: 修复当前架构的闭环问题，为后续重构打基础                             │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ 1.1 移除 auto-pass 逻辑                           [0.5 天]         │    │
│   │     - 删除 masterOrchestrator.ts:746-757                           │    │
│   │     - 让 AI 评估真正生效                                           │    │
│   │                                                                     │    │
│   │ 1.2 评估反馈传递给下轮迭代                        [1 天]           │    │
│   │     - 新增 IterationContext 接口                                   │    │
│   │     - 修改 createPlan() 接收 previousEvaluation                    │    │
│   │                                                                     │    │
│   │ 1.3 上下文贯穿整个流程                            [1 天]           │    │
│   │     - 修改 understandIntent() 传递 sessionContext                  │    │
│   │     - 修改所有 Agent 方法接收上下文                                │    │
│   │                                                                     │    │
│   │ 1.4 新增 IterationStrategyPlanner                 [1.5 天]         │    │
│   │     - 根据评估反馈规划下一轮策略                                   │    │
│   │     - 实现 continue/deep_dive/pivot/conclude 策略                  │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   Phase 2: Agent 化改造 (2 周)                                              │
│   ════════════════════════════                                               │
│   目标: 将 Skills 升级为真正的 AI Agents                                    │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ 2.1 设计 BaseAgent 抽象类                         [1 天]           │    │
│   │     - 定义 understand/plan/execute/reflect/respond 方法            │    │
│   │     - 定义 tools 和 capabilities 接口                              │    │
│   │                                                                     │    │
│   │ 2.2 实现 Frame Agent                              [2 天]           │    │
│   │     - 将 scrolling_analysis 等 Skills 能力集成                     │    │
│   │     - 添加 AI 推理能力                                             │    │
│   │     - 实现假设生成和需求表达                                       │    │
│   │                                                                     │    │
│   │ 2.3 实现 CPU Agent                                [2 天]           │    │
│   │     - 集成 cpu_analysis, scheduling_analysis 等                    │    │
│   │     - 添加调度问题诊断能力                                         │    │
│   │                                                                     │    │
│   │ 2.4 实现 Binder Agent                             [1.5 天]         │    │
│   │     - 集成 binder_analysis 相关 Skills                             │    │
│   │     - 添加 IPC 问题诊断能力                                        │    │
│   │                                                                     │    │
│   │ 2.5 实现 Memory Agent                             [1.5 天]         │    │
│   │     - 集成 memory_analysis, gc_analysis 等                         │    │
│   │     - 添加内存问题诊断能力                                         │    │
│   │                                                                     │    │
│   │ 2.6 实现更多 Agents (可选)                        [2 天]           │    │
│   │     - Render Agent, Input Agent, ANR Agent...                      │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   Phase 3: Master Agent 升级 (1.5 周)                                       │
│   ═══════════════════════════════════                                        │
│   目标: 升级 MasterOrchestrator 为真正的 AI 决策核心                        │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ 3.1 实现动态任务派发                              [2 天]           │    │
│   │     - 根据假设决定派发给哪些 Agents                                │    │
│   │     - 支持并行和串行派发                                           │    │
│   │                                                                     │    │
│   │ 3.2 实现反馈综合推理                              [2 天]           │    │
│   │     - 收集多个 Agent 的反馈                                        │    │
│   │     - AI 综合推理，建立因果链                                      │    │
│   │     - 更新假设，发现信息缺口                                       │    │
│   │                                                                     │    │
│   │ 3.3 实现多轮对话循环                              [1.5 天]         │    │
│   │     - 信息不足时自动派发新任务                                     │    │
│   │     - 设置最大轮次防止无限循环                                     │    │
│   │                                                                     │    │
│   │ 3.4 实现智能结论生成                              [2 天]           │    │
│   │     - 从证据链生成根因分析                                         │    │
│   │     - 生成可操作的建议                                             │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   Phase 4: Agent 间通信 (1 周)                                              │
│   ════════════════════════════                                               │
│   目标: 实现 Agents 之间的直接通信                                          │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ 4.1 实现消息总线                                  [1.5 天]         │    │
│   │     - AgentMessageBus 类                                           │    │
│   │     - 消息路由和分发                                               │    │
│   │                                                                     │    │
│   │ 4.2 实现 Agent 间查询协议                         [1.5 天]         │    │
│   │     - Query/Answer 消息类型                                        │    │
│   │     - 异步查询和等待                                               │    │
│   │                                                                     │    │
│   │ 4.3 实现上下文共享                                [2 天]           │    │
│   │     - 共享的发现和假设                                             │    │
│   │     - 时间范围聚焦传递                                             │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   Phase 5: 前端升级 (1 周)                                                  │
│   ════════════════════════                                                   │
│   目标: 前端展示 AI 推理过程和智能洞见                                      │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ 5.1 Agent 对话可视化                              [2 天]           │    │
│   │     - 展示 Master 与 Sub Agents 的对话过程                         │    │
│   │     - 实时显示假设更新                                             │    │
│   │                                                                     │    │
│   │ 5.2 证据链可视化                                  [1.5 天]         │    │
│   │     - 展示从证据到结论的推理链                                     │    │
│   │     - 支持点击跳转到相关数据                                       │    │
│   │                                                                     │    │
│   │ 5.3 AI 洞见展示                                   [1.5 天]         │    │
│   │     - 专门的洞见区域                                               │    │
│   │     - 突出显示关键发现和建议                                       │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   总计: 约 6.5 周                                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 12.6 验证指标

| 指标 | 当前值 | 目标值 | 衡量方法 |
|------|--------|--------|----------|
| **AI 决策有效性** | 0% (被覆盖) | 100% | 评估结果真正影响迭代 |
| **信息补充能力** | 无 | 有 | 能主动发现缺失并补充 |
| **跨领域关联** | 无 | 有 | 能建立因果链 |
| **根因定位准确率** | - | >80% | 人工评估 |
| **用户满意度** | - | >4/5 | 用户反馈 |

---

## 13. Agent-Driven Architecture (已实现)

> **状态**: ✅ Phase 1-4 已实现，本节描述实现后的状态机

本节描述 Section 12 中设计的 Agent-Driven 架构的实际实现状态机。

### 13.1 AgentDrivenOrchestrator 状态机

**文件:** `backend/src/agent/core/agentDrivenOrchestrator.ts`

这是新架构的 AI 决策核心，替代原有的 MasterOrchestrator。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       AgentDrivenOrchestrator.analyze()                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌───────────┐                                                             │
│    │   START   │                                                             │
│    └─────┬─────┘                                                             │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   INITIALIZING  │ ← Initialize session context & shared context         │
│    │   emit: progress │   sessionContextManager.getOrCreate()                │
│    │   phase: starting│   messageBus.createSharedContext()                   │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │  UNDERSTANDING  │ ← understandIntent(query)                             │
│    │  emit: progress │   AI 解析用户意图                                     │
│    │  phase: under..  │   返回 Intent { primaryGoal, aspects, complexity }   │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   HYPOTHESIZING │ ← generateInitialHypotheses(query, intent)            │
│    │  emit: progress │   AI 生成初始假设                                     │
│    │  phase: hypo... │   messageBus.updateHypothesis() 注册假设              │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ╔═════════════════════════════════════════════════════════════════════╗   │
│    ║              ANALYSIS LOOP (max: config.maxRounds)                  ║   │
│    ╚═════════════════════════════════════════════════════════════════════╝   │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   ROUND_START   │ currentRound++                                        │
│    │  emit: progress │ phase: round_start                                    │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐        ┌─────────────────┐                            │
│    │ DISPATCHING     │───────►│  (no tasks)     │───────────┐                │
│    │ TASKS           │ tasks=0└─────────────────┘           │                │
│    │  emit: progress │                                      │                │
│    │  phase: tasks.. │                                      │                │
│    └─────┬───────────┘                                      │                │
│          │ tasks.length > 0                                 │                │
│          ▼                                                  │                │
│    ┌─────────────────┐                                      │                │
│    │   EXECUTING     │ ← messageBus.dispatchTasksParallel() │                │
│    │                 │   并行执行 Domain Agent 任务          │                │
│    └─────┬───────────┘                                      │                │
│          │                                                  │                │
│          ▼                                                  │                │
│    ┌─────────────────┐                                      │                │
│    │  SYNTHESIZING   │ ← synthesizeFeedback(responses)      │                │
│    │  emit: progress │   AI 综合多 Agent 反馈               │                │
│    │  phase: synthe..│   更新假设，收集 findings            │                │
│    └─────┬───────────┘                                      │                │
│          │                                                  │                │
│          ▼                                                  │                │
│    ┌─────────────────┐                                      │                │
│    │  STRATEGIZING   │ ← strategyPlanner.planNextIteration()│                │
│    │  emit: progress │   AI 决定下一步策略                  │                │
│    │  phase: strategy│                                      │                │
│    └─────┬───────────┘                                      │                │
│          │                                                  │                │
│          ├─► strategy='conclude' ────────────────────────────┼───────────────┤
│          │                                                   │               │
│          ├─► strategy='deep_dive' ◄──── 聚焦特定领域 ────────┤               │
│          │   创建新假设，更新 focusedTimeRange               │               │
│          │                                                   │               │
│          ├─► strategy='pivot' ◄───── 改变分析方向 ───────────┤               │
│          │   重置现有假设，创建新方向假设                    │               │
│          │                                                   │               │
│          └─► strategy='continue' ◄─── 继续执行 ──────────────┘               │
│                     │                                                        │
│                     └──► LOOP (回到 ROUND_START)                             │
│                                                                              │
│    ╚═════════════════════════════════════════════════════════════════════╝   │
│                                     │                                        │
│                                     ▼                                        │
│    ┌─────────────────┐                                                       │
│    │   CONCLUDING    │ ← generateConclusion(sharedContext, findings, intent) │
│    │  emit: progress │   AI 生成最终结论                                     │
│    │  emit: conclusion│  包含根因分析、证据链、置信度                        │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌───────────┐                                                             │
│    │   DONE    │ return AnalysisResult                                       │
│    └───────────┘                                                             │
│                                                                              │
│    ┌─────────────────┐                                                       │
│    │     ERROR       │ ← Exception at any stage                              │
│    │  emit: error    │   返回 { success: false, conclusion: error }          │
│    └─────────────────┘                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### AgentDrivenOrchestrator 状态定义

| State | Description | Emitted Event |
|-------|-------------|---------------|
| INITIALIZING | 初始化会话和共享上下文 | `progress: starting` |
| UNDERSTANDING | AI 解析用户意图 | `progress: understanding` |
| HYPOTHESIZING | AI 生成初始假设 | `progress: hypotheses_generated` |
| ROUND_START | 开始新一轮分析 | `progress: round_start` |
| DISPATCHING | AI 决定派发哪些 Agent | `progress: tasks_dispatched` |
| EXECUTING | 并行执行 Agent 任务 | (internal) |
| SYNTHESIZING | AI 综合 Agent 反馈 | `progress: synthesis_complete` |
| STRATEGIZING | AI 规划下一步策略 | `progress: strategy_decision` |
| CONCLUDING | AI 生成最终结论 | `progress: concluding`, `conclusion` |
| ERROR | 异常处理 | `error` |

---

### 13.2 BaseAgent 状态机 (Think-Act-Reflect Loop)

**文件:** `backend/src/agent/agents/base/baseAgent.ts`

每个 Domain Agent (Frame, CPU, Binder, Memory 等) 都继承此基类，实现 Think-Act-Reflect 循环。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BaseAgent.executeTask()                              │
│                         Think-Act-Reflect Loop                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌───────────┐                                                             │
│    │   START   │                                                             │
│    └─────┬─────┘                                                             │
│          │ emit: task_started                                                │
│          ▼                                                                   │
│    ╔═══════════════════════════════════════╗                                 │
│    ║          THINK PHASE                  ║                                 │
│    ╚═══════════════════════════════════════╝                                 │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │  UNDERSTANDING  │ ← understand(task)                                    │
│    │                 │   buildUnderstandingPrompt() → LLM                    │
│    │                 │   返回: TaskUnderstanding {                           │
│    │                 │     objective, questions, relevantAreas,              │
│    │                 │     recommendedTools, constraints, confidence         │
│    │                 │   }                                                   │
│    └─────┬───────────┘                                                       │
│          │ emit: understanding_complete                                      │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   PLANNING      │ ← plan(understanding, task)                           │
│    │                 │   buildPlanningPrompt() → LLM                         │
│    │                 │   返回: ExecutionPlan {                               │
│    │                 │     steps: ExecutionStep[],                           │
│    │                 │     expectedOutcomes, estimatedTimeMs, confidence     │
│    │                 │   }                                                   │
│    └─────┬───────────┘                                                       │
│          │ emit: plan_created                                                │
│          ▼                                                                   │
│    ╔═══════════════════════════════════════╗                                 │
│    ║          ACT PHASE                    ║                                 │
│    ╚═══════════════════════════════════════╝                                 │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────────────────────────────┐                               │
│    │           EXECUTING PLAN                │                               │
│    │                                         │                               │
│    │  for each step in plan.steps:           │                               │
│    │  ┌───────────────────────────────────┐  │                               │
│    │  │ 1. Check dependencies (dependsOn) │  │                               │
│    │  │    → skip if not met              │  │                               │
│    │  │                                   │  │                               │
│    │  │ 2. Get tool from tools Map        │  │                               │
│    │  │    → warn if not found            │  │                               │
│    │  │                                   │  │                               │
│    │  │ 3. emit: tool_executing           │  │                               │
│    │  │                                   │  │                               │
│    │  │ 4. tool.execute(params, context)  │  │                               │
│    │  │    → 执行 Skill (SQL 查询等)      │  │                               │
│    │  │                                   │  │                               │
│    │  │ 5. emit: tool_completed           │  │                               │
│    │  │                                   │  │                               │
│    │  │ 6. Collect findings + observations│  │                               │
│    │  └───────────────────────────────────┘  │                               │
│    │                                         │                               │
│    └───────────────────┬─────────────────────┘                               │
│                        │ emit: execution_complete                            │
│                        ▼                                                     │
│    ╔═══════════════════════════════════════╗                                 │
│    ║         REFLECT PHASE                 ║                                 │
│    ╚═══════════════════════════════════════╝                                 │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   REFLECTING    │ ← reflect(result, task)                               │
│    │                 │   buildReflectionPrompt() → LLM                       │
│    │                 │   返回: Reflection {                                  │
│    │                 │     insights, objectivesMet, findingsConfidence,      │
│    │                 │     gaps, nextSteps, hypothesisUpdates,               │
│    │                 │     questionsForOthers                                │
│    │                 │   }                                                   │
│    └─────┬───────────┘                                                       │
│          │ emit: reflection_complete                                         │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │   RESPONDING    │ ← respond(reflection, result, task, startTime)        │
│    │                 │   generateHypotheses() → 从 findings 生成假设         │
│    │                 │   构建 AgentResponse {                                │
│    │                 │     agentId, taskId, success, findings,               │
│    │                 │     hypothesisUpdates, questionsForAgents,            │
│    │                 │     suggestions, confidence, reasoning                │
│    │                 │   }                                                   │
│    └─────┬───────────┘                                                       │
│          │ emit: task_completed                                              │
│          ▼                                                                   │
│    ┌───────────┐                                                             │
│    │   DONE    │ return AgentResponse                                        │
│    └───────────┘                                                             │
│                                                                              │
│    ┌─────────────────┐                                                       │
│    │     ERROR       │ ← emit: task_failed                                   │
│    │                 │   返回 { success: false, findings: [], confidence: 0 }│
│    └─────────────────┘                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Domain Agent 实例

| Agent | Domain | 集成的 Skills | AI 能力 |
|-------|--------|---------------|---------|
| FrameAgent | frame | janky_frame_analysis, jank_frame_detail, scrolling_analysis | 识别卡顿模式、定位问题帧 |
| CPUAgent | cpu | cpu_analysis, scheduling_analysis, cpu_profiling | 分析调度、定位热点 |
| BinderAgent | binder | binder_analysis, binder_detail, lock_contention_analysis | 分析 IPC、检测超时 |
| MemoryAgent | memory | memory_analysis, gc_analysis, lmk_analysis | 检测泄漏、追踪分配 |
| StartupAgent | startup | startup_analysis, startup_detail | 冷/热启动分析 |
| InteractionAgent | interaction | click_response_analysis, click_response_detail | 点击响应分析 |
| ANRAgent | anr | anr_analysis, anr_detail | ANR 根因定位 |
| SystemAgent | system | thermal_throttling, io_pressure, suspend_wakeup_analysis | 系统级问题分析 |

---

### 13.3 IterationStrategyPlanner 状态机

**文件:** `backend/src/agent/agents/iterationStrategyPlanner.ts`

策略规划器决定每轮分析后的下一步动作。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  IterationStrategyPlanner.planNextIteration()                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌───────────┐                                                             │
│    │   START   │                                                             │
│    └─────┬─────┘                                                             │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ CHECK_CONCLUDE  │ ← shouldConclude(context)                             │
│    │                 │                                                       │
│    │ 硬条件检查:     │                                                       │
│    │ ┌─────────────────────────────────────────────────────┐                │
│    │ │ IF (passed &&                                        │                │
│    │ │     qualityScore >= 0.7 &&                          │                │
│    │ │     completenessScore >= 0.6)                       │                │
│    │ │   → conclude                                        │                │
│    │ │                                                     │                │
│    │ │ OR IF (criticalFindings.length > 0 &&               │                │
│    │ │        qualityScore >= 0.6)                         │                │
│    │ │   → conclude                                        │                │
│    │ └─────────────────────────────────────────────────────┘                │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──────────── YES ──────────► ┌───────────────────┐                │
│          │                             │ RETURN conclude   │                │
│          │                             │ confidence: 0.9   │                │
│          │                             │ reason: "阈值满足" │                │
│          │                             └───────────────────┘                │
│          │ NO                                                                │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ CHECK_MAX_ITER  │ ← iterationCount >= maxIterations                     │
│    │                 │   ⚠️ 已修复: 原为 >= maxIterations - 1               │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──────────── YES ──────────► ┌───────────────────┐                │
│          │                             │ RETURN conclude   │                │
│          │                             │ confidence: 0.8   │                │
│          │                             │ reason: "达到最大轮次"│              │
│          │                             └───────────────────┘                │
│          │ NO                                                                │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ CHECK_AI_MODE   │ ← config.useAIDecisions?                              │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          │ YES                                                               │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │  AI_DECISION    │ ← getAIDecision(context)                              │
│    │                 │   buildDecisionPrompt() → LLM                         │
│    │                 │   返回: StrategyDecision {                            │
│    │                 │     strategy, confidence, reasoning,                  │
│    │                 │     focusArea?, newDirection?,                        │
│    │                 │     additionalSkills?, priorityActions?               │
│    │                 │   }                                                   │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──────────── SUCCESS ──────► ┌───────────────────┐                │
│          │                             │ RETURN AI result  │                │
│          │                             │ validateDecision()│                │
│          │                             └───────────────────┘                │
│          │ FAILED (parse error)                                              │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ HEURISTIC       │ ← getHeuristicDecision(context)                       │
│    │ DECISION        │                                                       │
│    │                 │ 决策逻辑:                                             │
│    │ ┌───────────────────────────────────────────────────────────┐          │
│    │ │ IF (criticalFindings > 0 && completenessScore < 0.5)       │          │
│    │ │   → deep_dive (聚焦 critical findings 的领域)              │          │
│    │ │                                                            │          │
│    │ │ ELSE IF (missingAspects.length > 0 && completeness < 0.6)  │          │
│    │ │   → continue (分析缺失的方面)                              │          │
│    │ │                                                            │          │
│    │ │ ELSE IF (qualityScore < 0.5)                               │          │
│    │ │   → continue (质量太低，需要更多分析)                      │          │
│    │ │                                                            │          │
│    │ │ ELSE                                                       │          │
│    │ │   → conclude (没有明确改进路径)                            │          │
│    │ └───────────────────────────────────────────────────────────┘          │
│    └─────────────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌───────────────────┐                                                     │
│    │ RETURN decision   │                                                     │
│    └───────────────────┘                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 策略决策矩阵

| Condition | Strategy | Confidence | Reasoning |
|-----------|----------|------------|-----------|
| quality≥0.7 && complete≥0.6 | conclude | 0.9 | 质量和完整性阈值满足 |
| iteration >= maxIterations | conclude | 0.8 | 达到最大迭代次数 |
| AI decision success | (varies) | (varies) | AI 推理决策 |
| critical && complete<0.5 | deep_dive | 0.7 | 严重问题需深入调查 |
| missing aspects && complete<0.6 | continue | 0.6 | 缺失分析方面 |
| quality<0.5 | continue | 0.6 | 质量分数过低 |
| default | conclude | 0.5 | 无明确改进路径 |

---

### 13.4 AgentMessageBus 状态机

**文件:** `backend/src/agent/communication/agentMessageBus.ts`

消息总线管理 Agent 间通信和并发控制。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AgentMessageBus.dispatchTask()                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌───────────┐                                                             │
│    │   START   │                                                             │
│    └─────┬─────┘                                                             │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ FIND_AGENT      │ ← agents.get(targetAgentId)                           │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──── NOT FOUND ────► ┌───────────────────┐                        │
│          │                     │ throw Error       │                        │
│          │                     │ "Agent not found" │                        │
│          │                     └───────────────────┘                        │
│          │ FOUND                                                             │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ CHECK_CONTEXT   │ ← this.sharedContext !== null                         │
│    │ ⚠️ 已修复       │   原为非空断言 (!)                                    │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──── NULL ────────► ┌───────────────────┐                         │
│          │                    │ throw Error       │                         │
│          │                    │ "Shared context   │                         │
│          │                    │  not initialized" │                         │
│          │                    └───────────────────┘                         │
│          │ OK                                                                │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ ACQUIRE_PERMIT  │ ← taskSemaphore.acquire()                             │
│    │ ⚠️ 已修复       │   原为 busy-wait 轮询                                 │
│    │                 │   现使用 Semaphore 异步控制                           │
│    └─────┬───────────┘                                                       │
│          │ permit acquired                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ DISPATCH        │ emit: task_dispatched                                 │
│    │                 │ agent.setSharedContext(context)                       │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ EXECUTING       │ ← agent.executeTask(task, sharedContext)              │
│    │                 │   Think-Act-Reflect Loop                              │
│    └─────┬───────────┘                                                       │
│          │                                                                   │
│          ├──── ERROR ────► ┌───────────────────┐                            │
│          │                 │ finally:          │                            │
│          │                 │ taskSemaphore.    │                            │
│          │                 │   release()       │                            │
│          │                 │ throw error       │                            │
│          │                 └───────────────────┘                            │
│          │ SUCCESS                                                           │
│          ▼                                                                   │
│    ┌─────────────────┐                                                       │
│    │ PROCESS         │ ← processAgentResponse(response)                      │
│    │ RESPONSE        │                                                       │
│    │                 │ 1. 添加 critical/high-conf findings                   │
│    │                 │    → addConfirmedFinding() → broadcast                │
│    │                 │                                                       │
│    │                 │ 2. 处理 hypothesis updates                            │
│    │                 │    support → confidence += 0.1                        │
│    │                 │    contradict → confidence -= 0.2                     │
│    │                 │    confirm → status = 'confirmed'                     │
│    │                 │    reject → status = 'rejected'                       │
│    │                 │                                                       │
│    │                 │ 3. 更新 investigation path                            │
│    │                 │                                                       │
│    │                 │ 4. 处理 inter-agent questions                         │
│    │                 │    → emit: agent_question                             │
│    └─────┬───────────┘                                                       │
│          │ emit: task_completed                                              │
│          │ taskSemaphore.release()                                           │
│          ▼                                                                   │
│    ┌───────────────────┐                                                     │
│    │ RETURN response   │                                                     │
│    └───────────────────┘                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Semaphore 并发控制 (新增)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Semaphore 实现                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   class Semaphore {                                                          │
│     permits: number;        // 可用许可数                                    │
│     waitQueue: Array<() => void>;  // 等待队列                               │
│                                                                              │
│     async acquire(): Promise<void> {                                         │
│       if (permits > 0) {                                                     │
│         permits--;                                                           │
│         return;  // 立即返回                                                 │
│       }                                                                      │
│       // 加入等待队列                                                        │
│       return new Promise((resolve) => waitQueue.push(resolve));              │
│     }                                                                        │
│                                                                              │
│     release(): void {                                                        │
│       permits++;                                                             │
│       if (waitQueue.length > 0 && permits > 0) {                             │
│         permits--;                                                           │
│         waitQueue.shift()!();  // 唤醒等待者                                 │
│       }                                                                      │
│     }                                                                        │
│   }                                                                          │
│                                                                              │
│   优点:                                                                      │
│   1. 无 busy-wait，CPU 友好                                                  │
│   2. 真正的异步并发控制                                                      │
│   3. 公平队列 (FIFO)                                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### SharedAgentContext 状态更新

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SharedAgentContext 状态流转                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SharedAgentContext {                                                       │
│     sessionId: string;                                                       │
│     traceId: string;                                                         │
│     hypotheses: Map<string, Hypothesis>;                                     │
│     confirmedFindings: Finding[];                                            │
│     investigationPath: InvestigationStep[];                                  │
│     focusedTimeRange?: [number, number];                                     │
│   }                                                                          │
│                                                                              │
│   Hypothesis Status Transitions:                                             │
│                                                                              │
│   ┌──────────┐                                                               │
│   │ proposed │ ◄───── 初始状态 (Agent 提出)                                  │
│   └────┬─────┘                                                               │
│        │                                                                     │
│        ├──── support ────► ┌─────────────────┐                               │
│        │                   │ investigating   │ confidence += 0.1             │
│        │                   └────────┬────────┘                               │
│        │                            │                                        │
│        │                   ┌────────┴────────┐                               │
│        │                   │                 │                               │
│        │              confirm            contradict                          │
│        │                   │                 │                               │
│        │                   ▼                 ▼                               │
│        │            ┌───────────┐     ┌───────────┐                          │
│        │            │ confirmed │     │ rejected  │                          │
│        │            │ conf=0.9  │     │ conf=0    │                          │
│        │            └───────────┘     └───────────┘                          │
│        │                                     ▲                               │
│        └──── reject ─────────────────────────┘                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 13.5 已修复问题清单

在状态机分析过程中发现并修复的问题：

| Issue ID | 位置 | 严重程度 | 问题描述 | 修复方案 |
|----------|------|----------|----------|----------|
| ISP-001 | iterationStrategyPlanner.ts:127 | **Critical** | Off-by-one 错误：`>= maxIterations - 1` | 改为 `>= maxIterations` |
| ISP-002 | iterationStrategyPlanner.ts:164 | Low | `allFindings` 可能为 null | 添加 `context.allFindings \|\| []` |
| AMB-001 | agentMessageBus.ts:218-220 | **High** | Busy-wait 轮询效率低 | 替换为 Semaphore 类 |
| AMB-002 | agentMessageBus.ts:234 | **Critical** | 非空断言 `!` 可能导致崩溃 | 添加 null 检查并抛出明确错误 |
| AMB-003 | agentMessageBus.ts:329 | Low | `finding.confidence` 未检查 | 使用 `finding.confidence ?? 0` |
| ADO-001 | agentDrivenOrchestrator.ts:265-267 | **High** | deep_dive/pivot 策略处理不完整 | 实现完整的假设创建和上下文更新 |

---

### 13.6 新旧架构对比

| 维度 | MasterOrchestrator (旧) | AgentDrivenOrchestrator (新) |
|------|------------------------|------------------------------|
| AI 参与度 | 仅开头(规划)和结尾(合成) | 全流程 AI 驱动 |
| 执行方式 | 确定性 Pipeline | 动态任务派发 |
| 子 Agent | 无 (Skills 只是配置) | 有 AI 推理能力的 Domain Agents |
| 迭代策略 | 固定 (plan→execute→evaluate→refine) | AI 决策 (continue/deep_dive/pivot/conclude) |
| Agent 通信 | 无 | AgentMessageBus 支持查询和广播 |
| 假设管理 | 无 | SharedAgentContext 维护假设状态 |
| 评估有效性 | 被 auto-pass 覆盖 | AI 评估真正影响决策 |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-21 | Initial state machine documentation |
| 1.1.0 | 2026-01-21 | Added SSE Connection State Machine (Section 9), Error Aggregation State Machine (Section 10) |
| 1.2.0 | 2026-01-21 | Simplified documentation: consolidated issues to Section 7, removed redundant content |
| 1.3.0 | 2026-01-21 | **All issues resolved**: (1) SM2 去重键 - NOT A BUG; (2) SM4 PENDING 状态 - DOC FIXED; (3) SM8 渲染器 - IMPLEMENTED; (4) SM5 类型验证 - IMPLEMENTED |
| 2.0.0 | 2026-01-21 | **Major update - AI Agent State Machines**: Added Section 8 with (1) Agent Phase State Machine (AgentStateMachine) - 完整生命周期; (2) Circuit Breaker State Machine - 熔断器模式; (3) Pipeline Executor State Machine - 流水线执行; (4) MasterOrchestrator 完整执行流程; (5) OrchestratorBridge 事件映射 |
| 3.0.0 | 2026-01-21 | **Critical Architecture Review**: Added Section 11 (AI 闭环架构问题诊断 - 5大缺陷分析) and Section 12 (真正的 AI Agents 架构设计 - 完整重构方案，包含子 Agent 设计、Master Agent 决策流程、Agent 间通信协议、6.5 周实施路线图) |
| 4.0.0 | 2026-01-22 | **Agent-Driven Implementation**: Added Section 13 with implemented state machines for (1) AgentDrivenOrchestrator - 新 AI 决策核心; (2) BaseAgent Think-Act-Reflect Loop - 子 Agent 执行循环; (3) IterationStrategyPlanner - 迭代策略决策; (4) AgentMessageBus with Semaphore - Agent 通信; (5) 已修复问题清单 (6 issues fixed); (6) 新旧架构对比 |
| 4.1.0 | 2026-01-22 | **Type Safety Refactoring**: (1) Converted `AgentPhase`, `CircuitState`, `StateEventType` from type aliases to enums for better type safety; (2) Migrated `skill_data` → `skill_layered_result` event type; (3) Added `SSEEventType` and `StreamingUpdateType` enums in `types/analysis.ts`; (4) Added `forceClose` limit (MAX=5) to CircuitBreaker; (5) Added comprehensive CircuitBreaker unit tests (28 tests) |

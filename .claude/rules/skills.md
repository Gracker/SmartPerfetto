# YAML Skill Rules

## Skill types

atomic, composite, iterator, parallel, conditional

## Layered results (L1-L4)

- **L1 (overview):** Aggregated metrics — `display.level: overview/summary`
- **L2 (list):** Data lists — `display.level: list/detail` + expandableData
- **L3 (diagnosis):** Per-frame diagnosis — iterator over jank frames
- **L4 (deep):** Detailed analysis — `display.level: deep/frame`

## Parameter substitution

Skills receive parameters via `${param|default}` syntax:
```yaml
inputs:
  - name: max_frames_per_session
    type: number
    required: false
steps:
  - id: diagnose
    type: iterator
    max_items: "${max_frames_per_session|8}"
```

## Skill locations

- `backend/skills/atomic/` — single-step detection (80 skills)
- `backend/skills/composite/` — combined analysis (28 skills)
- `backend/skills/deep/` — deep analysis (2 skills)
- `backend/skills/pipelines/` — render pipeline detection + teaching (30 skills)
- `backend/skills/modules/` — module config (app/framework/hardware/kernel)
- `backend/skills/vendors/` — vendor adaptation (pixel/samsung/xiaomi/honor/oppo/vivo/qualcomm/mtk)

## DataEnvelope (v2.0)

Unified data contract — self-describing data, frontend renders by config:
```typescript
interface DataEnvelope<T> {
  meta: { type, version, source, skillId?, stepId? };
  data: T;  // { columns, rows, expandableData }
  display: { layer, format, title, columns?: ColumnDefinition[] };
}
```

Column types: `timestamp`, `duration`, `number`, `string`, `percentage`, `bytes`
Click actions: `navigate_timeline`, `navigate_range`, `copy`

Type generation: `npm run generate:frontend-types` (auto-run by start-dev.sh)

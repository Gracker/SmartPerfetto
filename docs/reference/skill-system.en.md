# SmartPerfetto Skill System Guide

[English](skill-system.en.md) | [中文](skill-system.md)

SmartPerfetto Skills are YAML-defined trace analysis pipelines. They package performance expertise into reusable, composable, deterministic analysis units. The agent decides which Skill to use; the Skill engine handles SQL execution, iteration, conditional flow, display metadata, and layered output.

## Skill Inventory

The authoritative inventory is the `backend/skills/**/*.skill.yaml` file tree.
Do not hardcode a total count in code or durable docs. To inspect the current
inventory, run:

```bash
rg --files backend/skills | rg '\.skill\.yaml$' | wc -l
```

Directory roles:

| Type | Location | Description |
|---|---|---|
| Atomic | `backend/skills/atomic/` | Single SQL query or small query group |
| Composite | `backend/skills/composite/` | Multi-step orchestration |
| Comparison | `backend/skills/comparison/` | Multi-trace or multi-result comparison Skills |
| Deep | `backend/skills/deep/` | Deep analysis such as CPU profiling |
| Pipeline | `backend/skills/pipelines/` | Rendering subpath detection, supporting feature evidence, and teaching-source references |
| Module | `backend/skills/modules/` | Modular app/framework/hardware/kernel analysis |
| Template | `backend/skills/_template/` | Authoring templates, not necessarily runtime analysis capability |

## YAML Structure

```yaml
name: consumer_jank_detection
version: "2.0"
type: atomic
category: rendering

meta:
  display_name: "Consumer jank detection"
  description: "Detects real jank from present_ts intervals"
  tags: [jank, consumer, surfaceflinger]

inputs:
  - name: package
    type: string
    required: false
    description: "Application package name"

steps:
  - id: frame_stats
    type: atomic
    sql: |
      SELECT COUNT(*) AS total_frames
      FROM actual_frame_timeline_slice
      WHERE process_name GLOB '${package}*'
    save_as: frame_stats
    display:
      layer: overview
      title: "Frame statistics"
```

## Input Types

| Type | Description | SQL default |
|---|---|---|
| `string` | String value | Empty string `''` |
| `number` | Floating number | `NULL` |
| `integer` | Integer | `NULL` |
| `boolean` | Boolean | `NULL` |
| `timestamp` | Nanosecond timestamp | `NULL` |
| `duration` | Nanosecond duration | `NULL` |

## Step Types

| Step type | Purpose |
|---|---|
| `atomic` | Execute one SQL query |
| `skill` / `skill_ref` | Call another Skill |
| `iterator` | Iterate over rows and run nested steps |
| `parallel` | Run independent child steps concurrently |
| `conditional` | Branch by expression |
| `diagnostic` | Emit rule-based findings |
| `ai_decision` | Ask the configured AI runtime for a structured decision; disabled runtimes produce an explicit skipped result |
| `ai_summary` | Ask the configured AI runtime to summarize selected step inputs; disabled runtimes produce an explicit skipped result |
| `pipeline` | Detect or describe rendering pipeline behavior |

A `skill` step with `save_as` binds one of the referenced Skill's step
results. By default the engine picks the first displayed step that returned
data. When the parent reads specific fields, name the step with `save_from`:

```yaml
- id: cpu_throttling
  skill: cpu_throttling_in_range
  save_as: freq_limit_evidence
  save_from: limit_evidence   # a top-level step id of the referenced Skill
```

If that step did not observe a result (failed, skipped by its condition, or
an optional query error), `save_as` stays unbound; the engine never falls back
to another step. A genuinely empty result binds `[]`. `save_from` is honoured
only on a top-level step of the parent, and `validate:skills` rejects an
unknown target step.

## Rendering Pipeline Catalog

`docs/rendering_pipelines/*.md` is synchronized from a pinned
`Gracker/rendering_pipelines` commit and is the Android 17 teaching source of
truth. `backend/skills/pipelines/index.yaml` is the live inventory that maps
concrete rendering types to detector entries. A `variant` may become the
primary type; a `feature` only adds evidence such as ANGLE, PIP, HWC overlay,
or SurfaceControl usage.

Pipeline definitions retain trace signals, auto-pin guidance, and analysis
recommendations, but their `teaching` block contains only a `source` reference
to one of the synchronized documents. Builds copy all catalog documents into
`backend/dist/rendering_pipelines/` for Docker, portable, and npm CLI runtime
paths. Use `npm run sync:rendering-pipelines -- --source <checkout> --apply` to
update the import and `npm run check:rendering-pipelines` to verify the pin,
hashes, and references.

## Parameter Substitution

Skill parameters use `${param|default}`. Placeholders, `condition`, iterator `filter`, diagnostic and AI step `inputs`, and input evidence scope all resolve a root name in one order; the first scope that binds it wins:

1. **Current iteration item** (iterator `filter` only): `item` and its own fields → `currentItem`
2. **Saved variable**: `${save_as_name}` → `variables[save_as_name]`; a `null` value counts as bound (an unobserved `save_from` step binds `null`)
3. **Step result**: `${step_id}` → `results[step_id].data`
4. **Input**: `${package}` → `params.package`, including a declared `default`
5. **Inherited context**: `${parent_var}` → `inherited[parent_var]`, the calling Skill's inherited values and `save_as` bindings

A Skill's own binding therefore hides a caller's value of the same name, and a `save_as` reads its declared binding (including the child step `save_from` selects) rather than a same-named step result. A step's `save_as` may not reuse another step's id (`validate:skills` reports `save_as_step_id_collision`); naming the binding after its own step is the usual form. Once a scope binds the root name, lookup never falls back to a lower scope (a `null` variable does not yield to a same-named input). When the full path then resolves to `null` or `undefined` (unbound, bound to `null`, `[0]` of an empty array, a missing field), the inline `|default` applies, then the type default (`''` inside SQL quotes, otherwise `NULL`). The engine escapes substituted values to reduce SQL injection risk.

## Display Configuration

Display metadata tells the frontend how to render results:

| Field | Purpose |
|---|---|
| `layer` | Logical output layer |
| `title` | Section title |
| `format` | Table, metric, chart, timeline, text, or summary |
| `columns` | Column definitions for table rendering |
| `highlights` | Conditional highlighting rules |
| `expandable` | Whether JSON/details can be expanded |

## Layered Results

| Layer | Meaning |
|---|---|
| L1 | Executive summary and primary conclusion |
| L2 | Key lists, sessions, frames, or slices |
| L3 | Drill-down evidence |
| L4 | Raw diagnostics or supporting detail |

## Development Workflow

1. Add or edit a YAML file under `backend/skills/`.
2. Keep prompt text out of TypeScript.
3. Prefer existing fragments/modules when possible.
4. Run validation:

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```

## Relationship To Standard Agent Skills

SmartPerfetto YAML Skills and standard Agent Skills serve different execution
boundaries. YAML under `backend/skills/` remains the deterministic product
runtime truth: it drives registry selection, multi-step execution,
DataEnvelope output, artifacts, reports, session provenance, and frontend
projection. It is not replaced by Markdown instructions.

[Gracker/Perfetto-Skills](https://github.com/Gracker/Perfetto-Skills) is the
generated and curated portable projection for compatible agents with local
filesystem and terminal access. It exports agent-readable workflows, extracted
SQL, selected strategy and knowledge methodology, rendering-pipeline material,
and a checksum-pinned local trace-processor runtime. It does not export provider
management, session state, artifacts, streaming, or UI behavior.

`backend/skills/public-export.yaml` explicitly classifies every runtime
candidate by workflow, disposition, and destination. The public catalog records
the SmartPerfetto source commit and per-file SHA-256 values; normal export never
infers missing policy entries. After changing `backend/skills/`,
`backend/strategies/`, `docs/rendering_pipelines/`, or the export policy, run:

```bash
npm run verify:public-skills
```

The command uses the sibling `../Perfetto-Skills` checkout by default, or
`PERFETTO_SKILLS_DIR` when set, and rejects source/catalog/generated-file drift.

## Skill Tiers And Validation Rules

Skills may declare top-level `tier: S | A | B` to express target complexity and
review expectations:

| Tier | Use case | Structural expectation |
|---|---|---|
| `S` | Flagship cross-domain analysis such as startup, scrolling, CPU, or scene reconstruction | `type: composite` or `deep`, usually multiple Perfetto stdlib modules and 5+ steps |
| `A` | Focused single-domain analysis that can produce diagnostic findings or key lists | Declares relevant `prerequisites.modules` and reusable display layers |
| `B` | Single-fact or helper data provider | Clear query boundary, fields, and missing-data semantics |

`cd backend && npm run validate:skills` enforces these stable rules:

| Rule | Behavior |
|---|---|
| `skill-tier-must-match-declared` | Validates `tier` is `S/A/B` and reports structural gaps as migration warnings |
| `skill-stdlib-detected-vs-declared` | Scans SQL for Perfetto stdlib symbols and requires coverage in `prerequisites.modules` |
| `skill-include-budget-soft-cap` | Warns when `prerequisites.modules` exceeds 8 modules |
| `skill-step-id-uniqueness` | Requires unique step ids inside each Skill |
| `skill-vendor-override-runtime-conformant` | Requires vendor overrides to contain real `additional_steps`, vendor signatures, and a registered base Skill |

`backend/skills/_template/` contains authoring templates and is not loaded into
the runtime registry. After copying a template, remove placeholders, place the
Skill under a runtime Skill directory, then run `validate:skills` and the
matching trace regression.

## Local Skill Packs

Local Skill Packs let reviewed team or OEM Skills be installed for one
workspace without editing `backend/skills/`. The first release is a local
directory import path, not a remote marketplace: HTTPS URLs, auto-sync,
`.well-known` discovery, and archive unpacking are not supported.

The directory must contain `smartperfetto-skill-pack.json`:

```json
{
  "schemaVersion": 1,
  "packId": "vendor-scroll-pack",
  "name": "Vendor Scroll Pack",
  "version": "1.0.0",
  "publisher": "vendor-team",
  "description": "Reviewed scrolling diagnostics",
  "license": "AGPL-3.0-or-later",
  "compatibility": {
    "smartPerfettoMinVersion": "0.1.0"
  },
  "assets": [
    {
      "kind": "skill",
      "path": "atomic/vendor_scroll.skill.yaml",
      "sha256": "<64 hex chars>",
      "sizeBytes": 1234
    }
  ]
}
```

Allowed asset roots are `atomic/`, `composite/`, `deep/`, `system/`,
`comparison/`, `modules/`, `pipelines/`, `fragments/`, and `docs/`.
`strategies/`, `vendors/`, `custom/`, hidden files, symlinks, executable
extensions, and undeclared files are rejected. Each asset's `sha256` and
`sizeBytes` must match the actual file.

Workspace management endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/workspaces/:workspaceId/skill-packs/preview` | Read-only preview |
| `POST` | `/api/workspaces/:workspaceId/skill-packs/install` | Rerun preview, then install |
| `GET` | `/api/workspaces/:workspaceId/skill-packs` | List installed packs |
| `PATCH` | `/api/workspaces/:workspaceId/skill-packs/:packId` | Enable or disable |
| `DELETE` | `/api/workspaces/:workspaceId/skill-packs/:packId` | Disable and remove the managed copy |

Install copies declared assets to managed storage and records manifest hash,
content hash, approver, Skill IDs, fragment keys, and docs paths in
`skill_registry_entries.metadata_json`. Reinstalling the same `packId +
version` with a different content hash is rejected. External Skill IDs cannot
override built-in Skills, and SQL fragment keys cannot override different
built-in fragment content.

Agent sessions with workspace context load built-in Skills plus the enabled
Skill Packs for that workspace at runtime. `list_skills` returns external-pack
`origin` metadata, and `invoke_skill` refreshes the executor and SQL fragment
cache when the registry fingerprint changes, so enabling, disabling, or
removing a pack does not keep stale content executable. Legacy global
`/api/admin/skills` and the current `smp skill` CLI path remain built-in-only;
CLI execution of workspace packs requires future explicit tenant/workspace
context support.

## System investigation evidence contract

A scene Strategy references versioned profiles from `backend/strategies/investigation-profiles.yaml` through `investigation_contract`. `evidence_metrics` uses producer-declared metric IDs; display column names cannot confer semantic authority. Ordinary-answer investigation obligations are separate from `final_report_contract`.

A requirement's `condition` decides when the obligation applies. `kind: semantic` is judged by the final semantic review. `kind: evidence` carries `metric_id`, `operator` (`gt`/`gte`/`lt`/`lte`) and a numeric `value`, and is resolved from the producer-bound evidence ledger without the model, so a `ledgerAcquisition` row is still produced when the semantic review is unavailable. Only `observed` records are compared; a metric absent from the ledger stays unknown rather than reading as a condition that did not hold.

System SQL intersects requested windows, scheduling spans and frequency samples, preserving original and clipped timestamps, UTID/UPID, CPU/ucpu and topology provenance. Thread states distinguish Running, R/R+, S/I, D/DK and unknown coverage. Placement retains medium and unknown clusters. An exact same-ucpu next-task handoff establishes an observed switch, not its motive or all attributable waiting. Observed priority does not establish FIFO/RR/OTHER policy.

`display.columns` projection must preserve identity, scope and provenance fields needed by downstream evidence reads. Composite Skills, artifact save/restore and fetch retain these facts. Formatted missing values cannot replace original typed nulls.

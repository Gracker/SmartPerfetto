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
results: its `root` step when there is one, else the first displayed step that
returned data, else the first step that returned data, else the last step that
returned a result (so a leading setup step that returns `[]` is never picked). Reading the reference step by its id — a
`${step_id.data...}` expression, diagnostic and AI step `inputs`, an iterator
or pipeline `source` — reads that same default step and its scope provenance.
When the parent reads specific fields, name the step with `save_from` (it
changes only the `save_as` binding; a read by step id keeps the default):

```yaml
- id: cpu_throttling
  skill: cpu_throttling_in_range
  save_as: freq_limit_evidence
  save_from: limit_evidence   # a top-level step id of the referenced Skill
```

If that step did not observe a result (failed, skipped by its condition, an
optional query error, or absent), `save_as` binds `null`; lookup never falls
back to another step or to a same-named input or inherited value. A genuinely
empty result binds `[]`. When the reference step itself fails (the child Skill
failed, or a required condition was not met), it binds `null` too, even when
the named step returned data, and a read by its step id sees none of the
child's data, including partial results returned before the failure.
`save_from` is honoured only on a top-level step of the parent, and
`validate:skills` rejects an unknown target step.

Layered output (the composite path behind the Skill HTTP API and HTML report)
shows a reference step the same way: as the default child step's data and that
step's own scope provenance (none when the step declares none, never the merged
scope of every child step). A failed reference shows its failure with no child
rows; when the step is `optional`, the failure is shown as an optional error
(`executionStatus: optional_error`, as for an optional query) and does not fail
the Skill.

An iterator's per-item results attach as expandable data to the step whose
rows it read: the step that bound its `source` name just before the iterator
ran (or the step of that id), including when several steps declare the same
`save_as`.

When the default child step is itself a Skill reference, the binding holds the
grandchild Skill's result: expressions reading `.data` select one more level by
the same rule, diagnostic and AI `inputs` receive that result object, and an
iterator cannot iterate it. `save_from` selects only a top-level step of the
direct child and cannot reach into the grandchild: when the parent needs
specific fields, bind the child's own read step rather than that reference
step.

A `diagnostic` step lists in `inputs` every step it reads (by step id or
`save_as`); those inputs are its reported `data.inputs` and the only names an
`evidence_fields` entry may cite. Each rule has a `condition`, a `diagnosis`
template, a literal `confidence`, optional `suggestions` and optional
`evidence_fields`:

```yaml
- id: diagnose
  type: diagnostic
  inputs: [startups]
  rules:
    - condition: "startups.data[0]?.dur_ms > 2000"
      severity: critical
      confidence: high
      diagnosis: "Startup took ${startups.data[0].dur_ms}ms"
      evidence_fields:
        - startups.data[0]?.dur_ms
        - startups.data.length
```

An evidence field is a read-only path, not a JavaScript expression or a
`${...}` template: an input's `name.data` (or `name?.data`), then any of
`.column`, `[n]`, `.length` and `.find(r => r.column OP literal)` /
`.filter(...)` (OP is a comparison, literal a number, quoted string, boolean or
`null`), each optionally `?.`. It reads the same value the condition sees as
`name.data`, reads own data properties only, calls nothing and writes nothing;
a predicate compares scalar values, and a missing or non-scalar value never
matches. Its value is bounded before it
is reported: a row set becomes `{_rowCount, _firstRow}`, a row keeps its
scalar fields, and long strings are cut. A fired rule also reports a bounded sample of every input its condition reads, whether written `name.data`, `name?.data` or `name?.["data"]`; a name that appears only inside a string or comment is not read. `validate:skills` rejects an evidence
field outside that grammar or rooted outside `inputs`, a rule that reads a step
missing from `inputs`, a condition that reads step data other than through
`.data` (a placeholder resolved as a path, `${name[0].x|default}` or an
embedded `${name[0].x}`, may still index it; JavaScript inside a placeholder,
and a whole `${...}` without a default, bind as the condition does), a
diagnostic step without `inputs`, and a rule that reads a name no scope binds.
The checks on root names apply only when the roots read are certain; a
condition with a function body, method or block, where a local may be
declared, is not reported.
Read a Skill parameter such as a threshold by its own name, for example
`(threshold_ms ?? 50)`: there is no `inputs` object in scope, so
`inputs?.threshold_ms` is always `undefined` and the rule silently uses its
default.

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
2. **Saved variable**: `${save_as_name}` → `variables[save_as_name]`; a `null` value counts as bound
3. **Step result**: `${step_id}` → `results[step_id].data`; both execution paths record successful steps, condition-skipped steps, steps whose exact scope was unavailable, and failed query or Skill reference steps. For a Skill reference this is the child step data its default `save_as` would bind (see above), and no data once the reference failed
4. **Input**: `${package}` → `params.package`, including a declared `default`
5. **Inherited context**: `${parent_var}` → `inherited[parent_var]`, the calling Skill's inherited values and `save_as` bindings

A SQL path read of an earlier step's result (`${step_id.data[0].field}`) must state its intent: a `|default` (the step runs when the result has no row; usually `|` inside quotes and `|NULL` elsewhere), or a step `condition` with the top-level conjunct `step_id.data?.length > 0` (the step does not run without a row; a condition that merely mentions the result and can be true without a row does not count). This runtime binds a missing value with the type default below and runs; the public Perfetto-Skills runtime treats a path without a default as a dependency and skips the whole step when the result has no row. `validate:skills` rejects a read that states neither with `result_path_read_undecided`.

A Skill's own binding therefore hides a caller's value of the same name, and a `save_as` reads its declared binding (including the child step `save_from` selects) rather than a same-named step result. A step's `save_as` may not reuse another step's id (`validate:skills` reports `save_as_step_id_collision`); naming the binding after its own step is the usual form. Once a scope binds the root name, lookup never falls back to a lower scope (a `null` variable does not yield to a same-named input). When the full path then resolves to `null` or `undefined` (unbound, bound to `null`, `[0]` of an empty array, a missing field), the inline `|default` applies, then the type default (`''` inside SQL quotes, otherwise `NULL`). The engine escapes substituted values to reduce SQL injection risk.

In expressions (`condition`, iterator `filter`, JS expressions inside `${...}`, diagnosis text) a fixed set of names always means the standard language global and is never resolved through the five scopes above: `Infinity`, `NaN`, `undefined`, `isFinite`, `isNaN`, `parseFloat`, `parseInt`, `decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `Array`, `BigInt`, `Boolean`, `Date`, `Error`, `Intl`, `JSON`, `Map`, `Math`, `Number`, `Object`, `RegExp`, `Set`, `String`, `Symbol` (the list is `EXPRESSION_GLOBALS` in `expressionUtils.ts`). An input, `save_as` or data column with one of these names cannot be read by an expression. Every other name, including host global names such as `window`, `process` and `console`, resolves through the five scopes and is `undefined` when none binds it; reserved words (such as `enum` or `default`) are never taken as names, so writing one inside a string does not affect evaluation. `validate:skills` checks step `condition` references against the same vocabulary: a `${path|default}` placeholder reads the root of `path` (also inside quotes), while arrow-function parameters and static object-literal keys are not references. Only ASCII names are checked; contextual keywords (`async`, `await`, `let`, `of`, `static`, `yield`) and `window`, `console` and `globalThis` need no declaration. Where strings, templates, regexes and comments end is confirmed by the JS engine's own compiler; a condition that does not compile, or cannot be confirmed, falls back to a coarse scan (identifiers outside paired quotes, not after `.`), which may read words inside regexes, templates or comments as references.

A step that declares `save_as` always binds that name once it ran: the selected data on success (`[]` for an optional step skipped by its condition or whose query errored), and `null`, carrying that step's own result scope (with `save_from`, the named child step's scope, or none when that step is absent), when the step did not succeed (a non-optional step skipped by its condition, an unavailable exact scope, or a failed step of any type, including a failed optional Skill reference). A step skipped by its condition did not run, so it never replaces a binding an earlier step of the same Skill made; alternative steps under exclusive conditions can therefore declare one name.

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
| `expandableBindSource` | `save_as` name whose rows expand this step's rows; they carry the scope provenance of that binding |

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
| `skill-top-level-key-unknown` | Rejects a top-level key no loader reads: a Skill may use the `SkillDefinition` fields plus the legacy spellings the loader normalizes (`display`, `description`, `tags`, `icon`, `display_name`, `displayName`); a pipeline only the `PipelineDefinition` fields; a vendor override only `extends`, `version`, `meta`, `vendor_detection` and `additional_steps`. An external Skill Pack with such a key is rejected as a whole |
| `result-path-read-undecided` | Rejects a SQL placeholder that reads an earlier top-level step result by path (in `sql` and `exact_sql.sql`) without a `\|default` or a step `condition` with the top-level conjunct `<result>.data?.length > 0` (`result_path_read_undecided`). Self-Evolution proposal gates reject it in the Skill a proposal defines or changes (including that Skill's earlier overlay steps, and a `skill_sql` candidate checked in the step it replaces) and only warn about other already-published overlays |

A top-level key nothing reads is not a harmless comment: it reads as
configuration that takes effect. A top-level `diagnostics`, `thresholds`,
`synthesis` and vendor `thresholds_override` all sat in the corpus doing
nothing, and the public projection rendered them as live. Diagnostic rules
belong in a `type: diagnostic` step and summaries in step-level `synthesize`;
a vendor override contributes only its vendor, display name and the ids of its
`additional_steps`, as a hint on the base Skill's result.

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

# SmartPerfetto Skill System Guide

[English](skill-system.en.md) | [中文](skill-system.md)

<!-- i18n-headings: paired -->

> Complete authoring guide for the YAML Skill DSL, for developers who create or modify Skills.

---

## Contents

1. [What Is A Skill?](#1-what-is-a-skill)
2. [Skill Landscape](#2-skill-landscape)
3. [YAML Format](#3-yaml-format)
4. [Step Types](#4-step-types)
5. [Parameter Substitution](#5-parameter-substitution)
6. [Display Configuration](#6-display-configuration)
7. [SQL Fragment Reuse](#7-sql-fragment-reuse)
8. [Prerequisites And Modules](#8-prerequisites-and-modules)
9. [Layered Results (L1-L4)](#9-layered-results-l1-l4)
10. [Synthesize Data Summaries](#10-synthesize-data-summaries)
11. [Pipeline Skills](#11-pipeline-skills)
12. [Development Workflow](#12-development-workflow)
13. [Relationship To Standard Agent Skills](#13-relationship-to-standard-agent-skills)
14. [Skill Tiers And Validation Rules](#14-skill-tiers-and-validation-rules)
15. [Local Skill Packs](#15-local-skill-packs)

---

## 1. What Is A Skill?

A SmartPerfetto Skill is a **domain-specific language (DSL)** that defines a
trace analysis pipeline in YAML.

**Core value:** it packages performance expertise into reusable, composable,
deterministic analysis pipelines. The agent runtime only decides "which Skill
to use"; the Skill engine handles "how to query the data and how to present the
result".

```
Agent call: invoke_skill("scrolling_analysis", { package: "com.app" })
    │
    ▼
Skill Engine executes:
    ├─ Detect the VSync period (IQR-filtered median)
    ├─ Detect real jank from present_ts intervals
    ├─ Count the jank severity distribution
    ├─ Run root-cause analysis for each janky frame (iterator)
    ├─ Collect CPU/GPU/Binder/GC metrics in parallel
    └─ Assemble L1-L4 layered results → DataEnvelope → SSE → frontend
```

One MCP call lets the engine orchestrate multi-step SQL, child Skills, and
conditional branches, reducing agent round trips and context; the actual steps
are whatever the current YAML defines.

---

## 2. Skill Landscape

### By Type

The authoritative inventory is the `backend/skills/**/*.skill.yaml` file tree.
Do not hardcode a total count in code or durable docs. To inspect the current
inventory, run:

```bash
rg --files backend/skills | rg '\.skill\.yaml$' | wc -l
```

Directory roles:

| Type | Location | Description |
|------|------|------|
| **Atomic** | `backend/skills/atomic/` | Single SQL query or small query group |
| **Composite** | `backend/skills/composite/` | Multi-step orchestration (iterator/parallel/conditional) |
| **Comparison** | `backend/skills/comparison/` | Multi-trace or multi-result comparison Skills |
| **Deep** | `backend/skills/deep/` | Deep analysis (CPU profiling, callstack) |
| **Pipeline** | `backend/skills/pipelines/` | Rendering subpath detection, supporting feature evidence, and teaching-source references |
| **Module** | `backend/skills/modules/` | Modular analysis (app/framework/hardware/kernel) |
| **Template** | `backend/skills/_template/` | Authoring templates, not necessarily runtime analysis capability |

### By Scene

Scenes, tags, and runtime candidates come from the current Skill frontmatter
and registry; the docs keep no static list. Developers can see the live
classification with:

```bash
cd backend
npm run skill:list
```

---

## 3. YAML Format

### Complete Skill Structure

```yaml
# === Metadata ===
name: consumer_jank_detection       # unique identifier (required)
version: "2.0"                       # version (required)
type: atomic                         # type (required), per SkillType and the validator
category: rendering                  # category (optional)

meta:
  display_name: "Consumer jank detection"  # display name (required)
  display_name_i18n:                   # display name in the other language (optional); generated from the identifier when omitted
    zh-CN: "Consumer Jank 检测"
  description: "Detects real jank from present_ts intervals"  # description (required)
  description_i18n:                    # description in the other language (optional)
    zh-CN: "基于 present_ts 间隔的真实卡顿检测"
  tags: [jank, consumer, surfaceflinger]  # tags (optional)

# === Triggers (optional) ===
triggers:
  keywords:
    zh: [卡顿, 掉帧, 帧率]
    en: [jank, frame drop, fps]
  patterns:
    - ".*jank.*analysis.*"

# === Prerequisites (optional) ===
prerequisites:
  required_tables:
    - actual_frame_timeline_slice
  modules:
    - android.frames.timeline

# === Inputs (optional) ===
inputs:
  - name: package
    type: string
    required: false
    description: "Application package name"
  - name: start_ts
    type: timestamp
    required: false
  - name: end_ts
    type: timestamp
    required: false
  - name: max_frames_per_session
    type: number
    required: false

# === Steps (required) ===
steps:
  - id: vsync_config
    type: atomic
    sql: |
      SELECT vsync_period_ns FROM ...
    save_as: vsync_data
    display:
      level: summary
      title: "VSync configuration"

  - id: jank_frames
    type: atomic
    sql: |
      SELECT frame_id, duration_ms, jank_type
      FROM ... WHERE ...
    display:
      layer: list
      title: "Janky frames"
      columns:
        - { name: frame_id, type: number }
        - { name: duration_ms, type: duration, clickAction: navigate_timeline }
        - { name: jank_type, type: string }

# === Outputs (optional) ===
outputs:
  - stepId: jank_frames
    layer: list
  - stepId: jank_summary
    layer: overview
```

### Input Types

| Type | Description | SQL default |
|------|------|---------------|
| `string` | String value | Empty string `''` |
| `number` | Floating number | `NULL` |
| `integer` | Integer | `NULL` |
| `boolean` | Boolean | `NULL` |
| `timestamp` | Nanosecond timestamp | `NULL` |
| `duration` | Nanosecond duration | `NULL` |

---

## 4. Step Types

Every step type is deterministic: none calls a model. The analysis runtime
writes the narrative from the Skill's evidence.

### 4.1 atomic — Single SQL Step

The most basic step type executes one SQL query.

```yaml
- id: frame_stats
  type: atomic
  sql: |
    SELECT COUNT(*) as total_frames,
           SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) as jank_frames
    FROM actual_frame_timeline_slice
    WHERE process_name GLOB '${package}*'
  save_as: stats        # keep the result for later steps
  display:
    level: summary
    title: "Frame statistics"
```

**Optional fields:**

| Field | Type | Description |
|------|------|------|
| `condition` | string | Condition expression; the step runs only when it is true. Evaluated as JavaScript (`?.`, `??`, `&&`, `\|\|`); SQL `AND` / `OR` never compiles and the step is silently skipped, so `validate:skills` reports `condition_uses_sql_boolean_words` |
| `on_empty` | string | Message shown when the query returns no rows, telling the user which data is missing |

```yaml
# Conditional execution — runs only when frame_timeline data is available
- id: vsync_config
  type: atomic
  condition: "frame_timeline.data[0]?.has_frame_timeline === 1"
  sql: SELECT vsync_period_ns FROM ...

# Empty-result message
- id: callstack
  type: atomic
  sql: SELECT * FROM cpu_profile_stack_sample ...
  on_empty: "No CPU samples found; make sure the trace contains simpleperf/perf data"
```

### 4.2 skill_ref — Reference Another Skill

```yaml
- id: detailed_startup
  type: skill              # or omit type and use the skill field
  skill: startup_detail    # referenced Skill ID
  params:
    package: "${package}"
    startup_id: "${startup_data.data[0].startup_id}"
```

A reference step with `save_as` binds one of the referenced Skill's step
results: its `root` step when there is one, else the first displayed step that
returned data, else the first step that returned data, else the last step that
returned a result (so a leading setup step that returns `[]` is never picked).
Reading the reference step by its id — a `${step_id.data...}` expression,
diagnostic step `inputs`, an iterator or pipeline `source` — reads that
same default step and its scope provenance. When the parent reads specific
fields, name the step with `save_from` (it changes only the `save_as` binding;
a read by step id keeps the default):

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

When the default child step is itself a Skill reference, the binding holds the
grandchild Skill's result: expressions reading `.data` select one more level by
the same rule, diagnostic `inputs` receive that result object, and an
iterator cannot iterate it. `save_from` selects only a top-level step of the
direct child and cannot reach into the grandchild: when the parent needs
specific fields, bind the child's own read step rather than that reference
step.

### 4.3 iterator — Iterate Over Rows

Runs a child Skill for every row of an earlier result. Each `item_params`
value is a column name of the current row: the executor reads `item[column]`
and passes the value through as a constant when that column does not exist, so
writing `${item.x}` here passes only the literal string. Without `item_params`
the whole row is the parameter set.

```yaml
- id: per_frame_analysis
  type: iterator
  source: jank_frames           # a save_as binding
  item_skill: jank_frame_detail # Skill called for each row
  item_params:                  # child Skill params ← column names of the current row
    frame_id: frame_id
  max_items: 8                  # process at most N items (a number, no ${...} substitution; default 100)
  display:
    layer: deep
```

Each item's result attaches as expandable data to the step whose rows the
iterator read: the step that bound the `source` name just before the iterator
ran (the step of that id for a read by step id). The same rule applies when
several steps declare the same `save_as`.

### 4.4 parallel — Run Concurrently

Independent steps run concurrently.

```yaml
- id: multi_metric
  type: parallel
  steps:
    - id: cpu_load
      type: atomic
      sql: SELECT avg_cpu_pct FROM ...

    - id: gpu_load
      type: atomic
      sql: SELECT avg_gpu_freq FROM ...

    - id: thermal_state
      type: atomic
      sql: SELECT max_temperature FROM ...
```

### 4.5 conditional — Branch

Chooses the execution path from runtime data.

```yaml
- id: arch_branch
  type: conditional
  conditions:
    - when: "${architecture_type} == 'FLUTTER'"
      then:
        - id: flutter_analysis
          skill: flutter_scrolling_analysis

    - when: "${architecture_type} == 'COMPOSE'"
      then:
        - id: compose_analysis
          skill: compose_recomposition_hotspot
  else:
    - id: standard_analysis
      skill: scrolling_analysis
```

### 4.6 diagnostic — Rule-Based Diagnosis

```yaml
- id: diagnose
  type: diagnostic
  inputs: [startups]
  rules:
    - condition: "startups.data[0]?.dur_ms > 2000"
      severity: critical
      confidence: high
      diagnosis: "Startup took ${startups.data[0].dur_ms}ms, over 2 seconds"
      suggestions:
        - "Check Application.onCreate time"
        - "Optimize ContentProvider initialization"
      evidence_fields:
        - startups.data[0]?.dur_ms
        - startups.data.length
```

`inputs` lists every step the rules read (by step id or `save_as`); those
inputs are the step's reported `data.inputs` and the only names an
`evidence_fields` entry may cite. Read a Skill parameter such as a threshold by
its own name, for example `(threshold_ms ?? 50)`: there is no `inputs` object
in scope, so `inputs?.threshold_ms` is always `undefined` and the rule silently
uses its default.
An evidence field is a read-only path, not a JavaScript expression or a
`${...}` template: an input's `name.data` (or `name?.data`), then any of
`.column`, `[n]`, `.length` and `.find(r => r.column OP literal)` /
`.filter(...)` (OP is a comparison, literal a number, quoted string, boolean or
`null`), each optionally `?.`. It reads the same value the condition sees as
`name.data`, reads own data properties only, calls nothing and writes nothing;
a predicate compares scalar values, and a missing or non-scalar value never
matches. Its value is bounded before it is reported: a row set becomes
`{_rowCount, _firstRow}`, a row keeps its scalar fields, and long strings are
cut.
A fired rule also reports a bounded sample of every input its condition reads,
whether written `name.data`, `name?.data` or `name?.["data"]`; a name that
appears only inside a string or comment is not read.
`validate:skills` rejects an evidence field outside that grammar or rooted
outside `inputs`, a rule that reads a step missing from `inputs`, a condition
that reads step data other than through `.data` (a placeholder resolved as a
path, `${name[0].x|default}` or an embedded `${name[0].x}`, may still index it;
JavaScript inside a placeholder, and a whole `${...}` without a default, bind
as the condition does), a diagnostic step without `inputs`, and a rule that
reads a name no scope binds (such as `inputs`). The checks on root names apply
only when the roots read are certain; a condition with a function body, method
or block, where a local may be declared, is not reported.

### 4.7 pipeline — Rendering Pipeline Detection

Dedicated to matching the rendering pipeline types in a trace. See
[Pipeline Skills](#11-pipeline-skills).

### 4.8 Exact Process Scope And Investigation Evidence

An atomic step (and the root of an atomic Skill) may declare three optional
fields, checked by the same predicates the executor admits them with.

`process_scope` states how the SQL's evidence relates to the target process:

| Field | Description |
|---|---|
| `role` | `target` (evidence of the target process itself), `global_context`, `peer_context`, or `identity_metadata` (context evidence, which cannot declare a `binding`) |
| `binding` | How target SQL binds the trusted UPID: `native_upid` (the SQL uses `${__process_scope.upid}` directly), or `effective_target_processes` (includes `fragments/effective_target_processes.sql` and reads `FROM` / `JOIN effective_target_processes`) |
| `context_fields` | Fields of context evidence, listed per role |
| `exact_unavailable` | Why this SQL cannot run under an exact process scope (a reason is required) |
| `limitations` | Limits that remain under an exact run |

`exact_sql` is the SQL the same step runs under an exact process scope; it may
contain only `sql`, `sql_fragments`, and its own `process_scope`. When the
identity gate settles a unique target UPID for the call, the executor runs
`exact_sql`, otherwise the named `sql`; an invalid `exact_sql` fails the step
and never falls back to the named SQL.

```yaml
- id: frame_coverage
  type: atomic
  sql: |
    SELECT ... FROM actual_frame_timeline_slice a
    JOIN process p USING (upid) WHERE p.name GLOB '${package}*'
  exact_sql:
    process_scope:
      role: target
      binding: effective_target_processes
    sql_fragments:
      - fragments/effective_target_processes.sql
    sql: |
      SELECT ... FROM actual_frame_timeline_slice a
      JOIN effective_target_processes p ON a.upid = p.upid
```

`investigation_evidence` records the step's result in the investigation
evidence ledger, which a scene Strategy's `investigation_contract` reads
through `evidence` conditions and `evidence_metrics` (see "System investigation
evidence contract" at the end):

| Field | Description |
|---|---|
| `window: {start, end}` | Result columns that give the evidence time window |
| `identity` | Optional: columns for `upid`, `utid`, `cpu`, `ucpu`, `machine_id` |
| `metrics[]` | Each with a `domain`, a producer-declared `metric_id`, the `value` column, a `status` column (only `observed` is compared), and optional `unit`, `coverage`, `denominator`, `aggregation` |
| `scan` | Optional: completeness columns of the step's own non-paged scan (total rows, output truncated, cursor closed, parse failures) |

An invalid `exact_sql` or `investigation_evidence` is an error everywhere; an
invalid `process_scope` only makes the exact scope unavailable and reports
`process_scope_invalid`. Every exact unit in the corpus (each `exact_sql`, and
each target step without one whose own SQL binds the UPID through
`binding: native_upid` or `binding: effective_target_processes`) must be
executed and pass under some Trace case's `exact_scope` binding, or
`npm run trace:sql-regression` fails; a Skill the executor never admits to an
exact run (some step it runs has no `process_scope`) runs no unit under one
and owes no binding until it is admitted. Passing also
requires its rows to depend on that UPID alone: rerun without the process
selectors the identity gate wrote (the package and its aliases, upid, pid) it
must answer the same, and rerun unscoped it must answer differently (otherwise
the trace cannot tell the processes apart and the binding is inconclusive).
This proves independence from process-selection parameters, not that the data
itself is per process: rx packets record only a socket uid, so processes that
share a uid (a same-package `:worker`) share packet evidence, and a step that
reads such data says so in `process_scope.limitations`, which makes its exact
support partial.

---

## 5. Parameter Substitution

### Basic Syntax

```
${name}                  → direct reference
${name|default}          → default when missing
${item.field}            → a field of the iterator's current row
${step_id.data[0].field} → a step result
```

### Resolution Order

Placeholders, `condition`, iterator `filter`, diagnostic step `inputs`,
and input evidence scope all resolve a root name in one order; the first scope
that binds it wins:

1. **Current iteration item** (iterator `filter` only): `item` and its own fields → `currentItem`
2. **Saved variable**: `${save_as_name}` → `variables[save_as_name]`; a `null` value counts as bound
3. **Step result**: `${step_id}` → `results[step_id].data`; both execution paths record successful steps, condition-skipped steps, steps whose exact scope was unavailable, and failed query or Skill reference steps. For a Skill reference this is the child step data its default `save_as` would bind (see 4.2), and no data once the reference failed
4. **Input**: `${package}` → `params.package`, including a declared `default`
5. **Inherited context**: `${parent_var}` → `inherited[parent_var]`, the calling Skill's inherited values and `save_as` bindings

A SQL path read of an earlier step's result (`${step_id.data[0].field}`) must
state its intent: a `|default` (the step runs when the result has no row;
usually `|` inside quotes and `|NULL` elsewhere), or a step `condition` with
the top-level conjunct `step_id.data?.length > 0` (the step does not run
without a row; a condition that merely mentions the result and can be true
without a row does not count). This runtime binds a missing value with the
smart defaults below and runs; the public Perfetto-Skills runtime treats a path
without a default as a dependency and skips the whole step when the result has
no row. `validate:skills` rejects a read that states neither with
`result_path_read_undecided`.

A Skill's own binding therefore hides a caller's value of the same name, and a
`save_as` reads its declared binding (including the child step `save_from`
selects) rather than a same-named step result. A step's `save_as` may not reuse
another step's id (`validate:skills` reports `save_as_step_id_collision`);
naming the binding after its own step is the usual form. Once a scope binds the
root name, lookup never falls back to a lower scope (a `null` variable does not
yield to a same-named input). When the full path then resolves to `null` or
`undefined` (unbound, bound to `null`, `[0]` of an empty array, a missing
field), the inline `|default` applies, then the smart defaults below.

In expressions (`condition`, iterator `filter`, JS expressions inside `${...}`,
diagnosis text) a fixed set of names always means the standard language global
and is never resolved through the five scopes above: `Infinity`, `NaN`,
`undefined`, `isFinite`, `isNaN`, `parseFloat`, `parseInt`, `decodeURI`,
`decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `Array`, `BigInt`,
`Boolean`, `Date`, `Error`, `Intl`, `JSON`, `Map`, `Math`, `Number`, `Object`,
`RegExp`, `Set`, `String`, `Symbol` (the list is `EXPRESSION_GLOBALS` in
`expressionUtils.ts`). An input, `save_as` or data column with one of these
names cannot be read by an expression. Every other name, including host global
names such as `window`, `process` and `console`, resolves through the five
scopes and is `undefined` when none binds it; reserved words (such as `enum` or
`default`) are never taken as names, so writing one inside a string does not
affect evaluation. `validate:skills` checks step `condition` references against
the same vocabulary: a `${path|default}` placeholder reads the root of `path`
(also inside quotes), while arrow-function parameters and static object-literal
keys are not references. Only ASCII names are checked; contextual keywords
(`async`, `await`, `let`, `of`, `static`, `yield`) and `window`, `console` and
`globalThis` need no declaration. Where strings, templates, regexes and
comments end is confirmed by the JS engine's own compiler; a condition that
does not compile, or cannot be confirmed, falls back to a coarse scan
(identifiers outside paired quotes, not after `.`), which may read words inside
regexes, templates or comments as references.

A step that declares `save_as` always binds that name once it ran: the selected
data on success (`[]` for an optional step skipped by its condition or whose
query errored), and `null`, carrying that step's own result scope (with
`save_from`, the named child step's scope, or none when that step is absent),
when the step did not succeed (a non-optional step skipped by its condition, an
unavailable exact scope, or a failed step of any type, including a failed
optional Skill reference). A step skipped by its condition did not run, so it
never replaces a binding an earlier step of the same Skill made; alternative
steps under exclusive conditions can therefore declare one name.

### Smart Defaults

```yaml
# String context (inside single quotes): defaults to an empty string
WHERE package = '${package}'
# → package missing: WHERE package = ''

# Numeric context (outside quotes): defaults to NULL
WHERE ts >= ${start_ts}
# → start_ts missing: WHERE ts >= NULL (the condition never holds)

# Explicit default: highest priority
WHERE ts >= ${start_ts|0}
# → start_ts missing: WHERE ts >= 0
```

### SQL Injection Protection

String parameters escape single quotes automatically: `O'Brien` → `O''Brien`.

---

## 6. Display Configuration

### Core Fields

```yaml
display:
  layer: overview              # overview | list | session | deep | diagnosis
  level: summary               # none | debug | detail | summary | key | hidden
  title: "Frame overview"      # display title
  format: table                # table | chart | text | timeline | summary | metric
  columns:                     # column definitions
    - name: ts
      label: "Timestamp"
      type: timestamp           # timestamp | duration | number | string | percentage | bytes
      clickAction: navigate_timeline  # navigate_timeline | navigate_range | copy | expand | filter | link
    - name: dur_ms
      label: "Duration"
      type: duration
      unit: ms                  # ns | us | ms | s
    - name: jank_rate
      label: "Jank rate"
      type: percentage
  # optional advanced fields
  severity: warning            # critical | warning | info | normal — the frontend sorts by severity
  collapsible: true            # whether the table can collapse
  defaultCollapsed: false      # collapsed by default
  maxVisibleRows: 20           # limit visible rows
  priority: 1                  # render priority (smaller first)
  group: "frame_analysis"      # group id; related DataEnvelopes render together
```

**Special level value:**
- `hidden` — the step runs normally but sends no DataEnvelope to the frontend.
  Use it for intermediate data collection (such as a composite's setup steps);
  10+ composite Skills use it.

**Special layer value:**
- `diagnosis` — the diagnosis layer for structured findings from a diagnostic
  step.

### Expandable Data

```yaml
display:
  layer: list
  expandable: true
  expandableBindSource: frame_details  # detail data source
```

`expandableBindSource` names a `save_as` binding whose rows expand this step's
rows; the expanded data carries the scope provenance of that binding.

### Highlight Rules

```yaml
display:
  highlight:
    - condition: "jank_rate > 10"
      color: "red"
    - condition: "jank_rate > 5"
      color: "orange"
```

### Bilingual Labels And Cause Wording

Every text a Skill shows is checked in both Chinese and English: display names,
descriptions, column labels, step titles, diagnoses and suggestions, input
descriptions, catalog labels derived from identifiers, and every string literal
its SQL and referenced fragments can show (CASE results, labels a VALUES table
carries). A literal that is a comparison operand, an `IN (…)` member, a
GLOB/LIKE operand, or a simple CASE's WHEN value shows nothing and does not
count. Identifiers, paths, and patterns written as data (such as
`*thermal-engine*`) are names; so is an English clause that only names its
component (thermal HAL service process).

- Heat words (温控, 过热, thermal) need temperature, cooling-device, or
  cpufreq-limit evidence;
- cap words (throttle, 限频, 降频, 热节流, and 频率上限 when blamed for
  something) need cooling-device or cpufreq-limit evidence — a temperature shows
  heat, not a cap;
- write an observed step-down as 频率下调 (frequency step-down).

When an identifier reads as a claim, do not rename the column; give the label
an authored `label_i18n` (display columns, synthesize fields) or `title_i18n`
(step titles), and use `display_name_i18n` / `description_i18n` in `meta`.
Wording without supporting evidence reports `cause_wording_without_evidence`.
An exact run shows its `exact_sql` text and needs the evidence that run reads.

---

## 7. SQL Fragment Reuse

### Fragment Format

A fragment is a bare CTE definition (without the `WITH` keyword) stored under
`backend/skills/fragments/`:

```sql
-- fragments/vsync_config.sql
-- Estimate the VSync period from the median interval of the VSYNC-sf counter
-- and snap it to standard refresh rates (30/60/90/120/144/165 Hz)
-- Params: ${start_ts}, ${end_ts}
vsync_ticks AS (
  SELECT c.ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND c.ts >= ${start_ts} - 100000000
    AND c.ts < ${end_ts} + 100000000
),
vsync_config AS (
  SELECT CASE
    WHEN raw_ns BETWEEN 5500000 AND 6500000 THEN 6060606      -- 165 Hz
    WHEN raw_ns BETWEEN 6500001 AND 7500000 THEN 6944444      -- 144 Hz
    WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333      -- 120 Hz
    WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111    -- 90 Hz
    WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667   -- 60 Hz
    WHEN raw_ns BETWEEN 20000001 AND 35000000 THEN 33333333   -- 30 Hz
    ELSE raw_ns
  END AS vsync_period_ns
  FROM (
    SELECT CAST(COALESCE(
      (SELECT PERCENTILE(interval_ns, 50)
       FROM vsync_ticks
       WHERE interval_ns > 5500000 AND interval_ns < 50000000),
      16666667
    ) AS INTEGER) AS raw_ns
  )
)
```

### Referencing Fragments In A Skill

```yaml
steps:
  - id: jank_detection
    type: atomic
    sql_fragments:
      - fragments/vsync_config.sql
      - fragments/thread_states_quadrant.sql
    sql: |
      SELECT frame_id, duration_ms
      FROM frames
      CROSS JOIN vsync_config v
      WHERE duration_ms > v.vsync_period_ns / 1e6 * 1.5
```

**Injection rules:**
- SQL starting with `WITH` → fragments are inserted after `WITH`, before the
  existing CTEs
- SQL not starting with `WITH` → the whole query is wrapped as
  `WITH <fragments>\n<sql>`
- `${variable}` placeholders inside fragments are substituted too

### The Two Wait-Attribution Fragments

- `fragments/thread_role.sql`: gives every utid in the trace a role
  (main/render/gc/jit/binder/network/image/worker/flutter_ui/flutter_raster/
  webview/system/other). Wakers are usually outside the analyzed process, so it
  is not trimmed by package; the role comes from the thread name and is a
  purpose hint, not behavioral evidence.
- `fragments/sleep_wake_source.sql`: takes `wake_source_scope(utid)` and
  `thread_roles`, joins each S/I/D/DK wait row to the R/R+ row at its end,
  extracts `waker_utid` / `irq_context`, and outputs `wake_source` and a
  candidate `wait_class`. The Android kernel emits `sched_blocked_reason` only
  for TASK_UNINTERRUPTIBLE; an S wait has no `blocked_function`, so this is the
  only kernel-side attribution signal for S waits.

---

## 8. Prerequisites And Modules

### Declaring Dependencies

```yaml
prerequisites:
  required_tables:              # tables that must exist (the Skill is skipped otherwise)
    - actual_frame_timeline_slice
    - slice
  optional_tables:              # optional tables (missing ones do not block execution)
    - gpu_counter_track
  modules:                      # Perfetto stdlib modules (INCLUDEd automatically)
    - android.frames.timeline
    - android.binder
    - sched.states
```

### Module Alias Expansion

| Alias | Expands to |
|------|--------|
| `sched` | `sched.states`, `sched.runnable` |
| `android.frames` | `android.frames.timeline`, `android.frames.jank_type` |
| `stack_profile` | `callstacks.stack_profile` |

### Runtime Behavior

```sql
-- The engine inserts before the SQL:
INCLUDE PERFETTO MODULE android.frames.timeline;
INCLUDE PERFETTO MODULE android.binder;
INCLUDE PERFETTO MODULE sched.states;

-- then runs the Skill SQL
SELECT ...
```

---

## 9. Layered Results (L1-L4)

Skill output is organized into semantic layers that the frontend renders
automatically:

```
L1 (Overview)  ─── aggregate metrics
    │  e.g. "47 janky frames, P90=23.5ms, SEVERE 12%"
    │  display: { layer: overview, level: summary }
    ▼
L2 (List)      ─── data lists
    │  e.g. frame_id, duration, jank_type of every frame
    │  display: { layer: list, expandable: true }
    ▼
L3 (Diagnosis) ─── per-item diagnosis
    │  e.g. an iterator over each janky frame's thread states and blocking causes
    │  display: { layer: session }
    ▼
L4 (Deep)      ─── deep analysis
       e.g. blocking chains, Binder root causes, call stacks
       display: { layer: deep }
```

**Frontend rendering protocol (DataEnvelope v2.0):**

```typescript
interface DataEnvelope<T> {
  meta: {
    type: 'skill_result' | 'sql_result' | 'ai_response' | 'diagnostic' | 'chart';
    version: string;
    source: string;
    timestamp: number;
    skillId?: string;
    stepId?: string;
  };
  data: T;  // { columns, rows, expandableData? }
  display: {
    layer: 'overview' | 'list' | 'session' | 'deep' | 'diagnosis';
    format: 'table' | 'chart' | 'text' | 'timeline' | 'summary' | 'metric';
    level?: 'none' | 'debug' | 'detail' | 'summary' | 'key' | 'hidden';
    title: string;
    columns?: ColumnDefinition[];
    metadataFields?: string[];
    highlights?: HighlightRule[];
    defaultExpanded?: boolean;
    severity?: 'critical' | 'warning' | 'info' | 'normal';
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    maxVisibleRows?: number;
    priority?: number;
    group?: string;
  };
}
```

The frontend **renders automatically** from the column types and
`clickAction` in `display.columns` — tables, navigation links, formatted
numbers — with no Skill-specific UI code. `severity` and `priority` control
ordering and visual weight.

---

## 10. Synthesize Data Summaries

Mark a step `synthesize: true` to produce a data-driven summary:

```yaml
# Simple form
- id: metrics
  type: atomic
  sql: SELECT fps, jank_rate FROM ...
  synthesize: true

# Structured form
- id: metrics
  type: atomic
  sql: SELECT fps, jank_rate, jank_count FROM ...
  synthesize:
    role: overview        # overview | list | clusters | conclusion
    fields:
      - key: fps
        label: "Average FPS"
        format: "{{fps}}.0 fps"
      - key: jank_rate
        label: "Jank rate"
        format: "{{jank_rate}}.1%"
    insights:             # conditional insights
      - condition: "jank_rate > 10"
        template: "High jank rate: {{jank_rate}}% (>10%)"
      - condition: "jank_rate >= 5 && jank_rate <= 10"
        template: "Slightly high jank rate: {{jank_rate}}%"
```

Synthesize data is stored with the Artifact; the agent can read it through
`fetch_artifact`.

---

## 11. Pipeline Skills

Pipeline Skills identify and teach Android rendering pipelines, but a "type"
and a "detector entry" are different layers:

- `docs/rendering_pipelines/*.md` is the Android 17 teaching source of truth,
  synchronized from a pinned upstream commit;
- `backend/skills/pipelines/index.yaml` is the live inventory mapping concrete
  rendering types to detector entries;
- a `variant` may become the primary type; a `feature` only adds evidence;
- each Pipeline Skill keeps signals, auto-pin guidance, and analysis
  recommendations, and references the authoritative document through
  `teaching.source`.

How the catalog and a single definition relate:

```yaml
# backend/skills/pipelines/index.yaml
pipelines:
  FLUTTER_TEXTUREVIEW:
    classification_role: variant
    rendering_type_id: S10_FLUTTER
    primary_eligible: true
  ANGLE_GLES_VULKAN:
    classification_role: feature
    related_rendering_type_ids: [S08_NATIVE_GRAPHICS]
    primary_eligible: false

# backend/skills/pipelines/flutter_textureview.skill.yaml
name: FLUTTER_TEXTUREVIEW
type: pipeline_definition
detection:
  signals:
    - { name: "SurfaceTexture", source: "slice" }
teaching:
  source: "rendering_pipelines/S10_flutter_type.md"
```

Detection reports the primary `rendering type`, the concrete pipeline subpath,
and feature candidates separately, so ANGLE, PIP, HWC overlay and similar
features are never reported as the app's primary output type. Builds copy the
synchronized catalog to `backend/dist/rendering_pipelines/`, so Docker,
portable, and the npm CLI use the same content.

Run the sync script to update the upstream import; never edit the synchronized
Markdown by hand:

```bash
npm run sync:rendering-pipelines -- --source /path/to/rendering_pipelines --apply
npm run check:rendering-pipelines
```

---

## 12. Development Workflow

### Creating A Skill

1. Create `<name>.skill.yaml` in the matching directory
2. Define meta, inputs, steps, and display
3. **No TypeScript change is needed** — `skillRegistry` loads it at startup
4. The agent discovers the new Skill through `list_skills`

### When Changes Take Effect

| File type | Takes effect | Restart needed? |
|---------|---------|----------|
| `*.skill.yaml` | Refresh the browser | No |
| `fragments/*.sql` | Refresh the browser | No |
| TypeScript (Skill Engine) | tsx watch recompiles | No |

### Validation

```bash
# Validate every Skill YAML's syntax and constraints
cd backend && npm run validate:skills

# Run the full trace regression
cd backend && npm run test:scene-trace-regression
```

### Debugging

1. Check the Skill execution log in `backend/logs/sessions/*.jsonl`
2. Test a SQL fragment on its own with `execute_sql`
3. Check that the DataEnvelope in the SSE events is correct

## 13. Relationship To Standard Agent Skills

SmartPerfetto YAML Skills are **not** an equivalent of standard Agent Skills;
the two solve different problems:

| Dimension | Standard Agent Skill | SmartPerfetto YAML Skills |
|------|---|---|
| **Nature** | Markdown prompt template | Domain DSL (SQL orchestration engine) |
| **Executor** | A compatible agent follows instructions and scripts | The SkillExecutor engine runs deterministically |
| **File format** | `SKILL.md` (YAML frontmatter + Markdown) | `.skill.yaml` (SQL + display configuration) |
| **Capability** | Inject context, guide behavior | Multi-step SQL orchestration + layered results + Artifact cache |
| **Invocation** | Routed automatically by the agent or named explicitly | Called indirectly by the current agent runtime through the registry and tools |
| **Reproducibility** | Depends on agent reasoning and local scripts | Deterministic (same input = same output) |
| **Product capability** | Local files, terminal, and `trace_processor_shell` | DataEnvelope, Artifact, reports, sessions, and UI projection |

**Architecture:**

```
Perfetto-Skills (standard SKILL.md)
    └─ Public portable methodology, SQL, pipeline knowledge, and local query scripts
        └─ Run by compatible agents, independent of the SmartPerfetto service

SmartPerfetto Skills (backend/skills/)
    └─ Product-internal deterministic DSL and runtime truth
        └─ Drive DataEnvelope, Artifact, reports, and frontend projection

backend/strategies + docs/rendering_pipelines
    └─ Methodology and rendering-pipeline sources for the public projection
```

The public repository [Gracker/Perfetto-Skills](https://github.com/Gracker/Perfetto-Skills)
is a generated and curated standard Agent Skill projection; it does not replace
this repository's runtime. `backend/skills/public-export.yaml` must declare the
workflow, disposition, and destination of every runtime candidate; the public
catalog records the source commit and per-file SHA-256 values and exports SQL,
strategy/knowledge material, and rendering-pipeline documents. Provider,
session, Artifact, DataEnvelope, SSE, and frontend behavior belong to
SmartPerfetto only.

### Portable Boundary Of Batch Analysis

A runtime candidate may declare `batch_analysis` to mark a bounded result of one
deterministic Skill step as batch post-processing input. The YAML SQL, field
contract, single-trace missing-data semantics, and row limits are portable
analysis capability and can be reused through the public projection; they
perform no cross-trace aggregation themselves.

`BatchTraceRunner` keeps only the declared source step and hands its validated,
bounded rows to a registered TypeScript post-processor. The cross-trace
`BatchTraceDomainAnalysisV1` result, evidence artifacts, clustering limits, and
report projection are SmartPerfetto product runtime capability, not part of the
public Agent Skill's local execution contract. The aggregate belongs to the
batch run/report and is never copied into each single-trace snapshot; a
single-trace snapshot keeps only its own extracted metrics and evidence
references.

After changing `backend/skills/`, `backend/strategies/`,
`docs/rendering_pipelines/`, or the public policy, run in an environment with a
Perfetto-Skills checkout:

```bash
npm run verify:public-skills
```

It uses the sibling `../Perfetto-Skills` by default, or `PERFETTO_SKILLS_DIR`
when set. The gate rejects unclassified sources, source hash/commit drift, and
generated-file drift.

---

## 14. Skill Tiers And Validation Rules

Skills may declare top-level `tier: S | A | B` to express target complexity and
review expectations:

| Tier | Use case | Structural expectation |
|---|---|---|
| `S` | Flagship cross-domain analysis such as startup, scrolling, CPU, or scene reconstruction | `type: composite` or `deep`, usually multiple Perfetto stdlib modules and 5+ steps |
| `A` | Focused single-domain analysis that can produce diagnostic findings or key lists | Declares relevant `prerequisites.modules` and reusable display layers |
| `B` | Single-fact or helper data provider | Clear query boundary, fields, and missing-data semantics |

`cd backend && npm run validate:skills` runs, in order:

1. `tsx src/cli/index.ts validate --contracts --all`: per-file structural
   lint plus the in-process validator shared with the Self-Evolution gates
   (`selfEvolution/inProcessValidator.ts`);
2. `check:skill-localizations`: `backend/skills/localization.catalog.json`
   matches the current Skills (regenerate with
   `npm --prefix backend run generate:skill-localizations`);
3. `check:skill-identity-policies`: `backend/skills/identity-policy.catalog.json`
   (every built-in Skill's effective identity policy, read directly by the
   Perfetto-Skills exporter) is current (`npm --prefix backend run generate:skill-identity-policies`);
4. `check:skill-sql-inventory`: `Trace/skill-sql.inventory.json` (the Skill SQL
   inventory the Trace SQL regression reads) is current
   (`npm --prefix backend run generate:skill-sql-inventory`); `npm run trace:validate` also
   checks each Skill file's text hash against the inventory.

Structural lint reports text messages (no issue code):

| Rule | Behavior |
|---|---|
| Tier matches declaration | Validates `tier` is `S/A/B` and reports structural gaps as migration warnings |
| Declared stdlib coverage | Scans SQL for Perfetto stdlib symbols and requires coverage in `prerequisites.modules` |
| Include budget | Warns when `prerequisites.modules` exceeds 8 modules |
| Unique step ids | Requires unique step ids inside each Skill |
| Valid vendor override | Requires vendor overrides to contain real `additional_steps`, vendor signatures, and a registered base Skill |

Shared validator findings carry an issue code (proposal gates and
`validate:skills` report the same code):

| Code | Behavior |
|---|---|
| `skill_top_level_key_unknown` | Rejects a top-level key no loader reads: a Skill may use the `SkillDefinition` fields plus the legacy spellings the loader normalizes (`display`, `description`, `tags`, `icon`, `display_name`, `displayName`); a pipeline only the `PipelineDefinition` fields; a vendor override only `extends`, `version`, `meta`, `vendor_detection` and `additional_steps`. An external Skill Pack with such a key is rejected as a whole |
| `result_path_read_undecided` | A SQL placeholder that reads an earlier top-level step result by path (in `sql` and `exact_sql.sql`) needs a `\|default` or a step `condition` with the top-level conjunct `<result>.data?.length > 0` |
| `cause_wording_without_evidence` | Heat or cap wording without its evidence; see [Bilingual Labels And Cause Wording](#bilingual-labels-and-cause-wording) |
| `process_scope_invalid` | An invalid `process_scope` declaration, which makes the exact scope unavailable; see [4.8](#48-exact-process-scope-and-investigation-evidence) |
| `sql_not_executed` | SQL the executor never runs: the root SQL of a non-atomic Skill, steps beside an atomic root, steps of a metadata-only Skill |
| `condition_uses_sql_boolean_words` | SQL `AND` / `OR` in the code of a step `condition`, a conditional branch `when`, or a diagnostic rule `condition` (not inside a string literal or a property name). These expressions are JavaScript, so `AND` / `OR` never compiles, evaluates to false, and the step is silently skipped (the branch never taken, the rule never fired). An iterator `filter` is the exception: its `AND` / `OR` is rewritten |
| Other structural errors | Such as `step_id_duplicate`, `save_as_step_id_collision`, `save_from_target_missing`, `fragment_reference_missing`, `skill_reference_missing`, `display_contract`; errors everywhere |

Of these, `result_path_read_undecided`, `cause_wording_without_evidence`,
`process_scope_invalid`, `sql_not_executed`, and
`condition_uses_sql_boolean_words` belong to `PREDATING_RULE_CODES`: they are
errors in `validate:skills` and for the Skills a proposal defines or changes
(including that Skill's earlier overlay steps, and a `skill_sql` candidate
checked in the step it replaces), and only warnings for other already-published
overlays and Skill Packs, so one overlay that predates a rule cannot take every
overlay of its scope offline. The built-in registry has no error under them.

Every check that reads a Skill's SQL takes its units from one walk
(`executableSqlUnits`): an atomic Skill's root SQL, or else every atomic step at
any depth (nested steps, inline conditional branches) with its `exact_sql`;
every check that reads steps likewise uses only `stepNodesOf`.

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

## 15. Local Skill Packs

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

# YAML Skill Rules

## Role of Skills

Skills are deterministic trace-analysis programs. They are the agent's evidence
collection layer, not a place for open-ended prompt prose.

Location:

```text
backend/skills/
  atomic/       # single-purpose SQL/evidence steps
  composite/    # multi-step scene analyses
  comparison/   # comparison-specific Skill contracts
  deep/         # deeper diagnostics
  modules/      # app/framework/kernel/hardware expert modules
  pipelines/    # rendering-pipeline detection and teaching
  _template/    # skill authoring templates
```

The repository currently contains 200+ Skill YAML files. Avoid hardcoding counts
in code or docs unless a test enforces them. When a precise inventory is
needed, compute it from the tree:

```bash
rg --files backend/skills | rg '\.skill\.yaml$' | wc -l
```

## Skill Types and Layers

Common skill types:

- `atomic`
- `composite`
- `iterator`
- `parallel`
- `conditional`

Layered results:

- L1 overview: aggregated metrics, `display.layer: overview` with `display.level: summary` or `key`.
- L2 list/detail: tables and expandable rows, usually `display.layer: list` with `display.level: detail`.
- L3 diagnosis: per-frame or per-event diagnosis, often iterator output.
- L4 deep: detailed frame/slice/callstack evidence.

Keep DataEnvelope output self-describing so frontend rendering stays generic.

Final conclusions, reports, snapshots, and comparison all depend on Skill
evidence metadata. When adding or changing a scene-critical Skill, keep these
fields meaningful enough for claim verification and report provenance:

- `display.layer` and `display.level`
- table column names and typed column metadata
- `synthesize` / summary-facing outputs
- process, thread, timestamp, duration, and source identifiers used by identity
  resolution
- `doc_path` references for runtime-read rendering pipeline docs

## Parameter and Display Contracts

Skill parameters use:

```yaml
${param|default}
```

DataEnvelope columns should use typed column metadata where possible:

`display.layer` controls where the result appears: `overview`, `list`,
`session`, `deep`, or `diagnosis`. `display.level` controls visibility/detail:
`none`, `debug`, `detail`, `summary`, `key`, or `hidden`.

- `timestamp`
- `duration`
- `number`
- `string`
- `percentage`
- `bytes`

Click actions should be explicit, for example:

- `navigate_timeline`
- `navigate_range`
- `copy`

## Runtime Boundaries

- SQL should stay inside Skills or MCP SQL helpers, not UI code.
- Skill docs and `doc_path` references must point at committed repository docs.
- If a rendering-pipeline doc becomes runtime evidence, validate the matching
  Skill after editing that doc.
- Vendor or platform-specific behavior should be explicit in Skill inputs,
  conditions, or overrides, not hidden in generic SQL.
- Do not treat the frontend chat table as the only consumer. The same
  DataEnvelope output can feed HTML reports, CLI artifacts, evidence contracts,
  analysis-result snapshots, and comparison.

## Public Agent Skill Projection

- `backend/skills/` is the product runtime source of truth.
- `backend/skills/public-export.yaml` must explicitly classify every runtime
  candidate and every selected strategy/pipeline source for the public
  `Gracker/Perfetto-Skills` projection. Do not infer missing entries in normal
  export or hand-edit generated public references.
- Keep product-only provider, session, artifact, DataEnvelope, streaming, and
  frontend semantics in SmartPerfetto. The public projection contains portable
  workflows, SQL, methodology, pipeline knowledge, and local scripts.
- The public runtime evaluates step `condition`, iterator `filter`, Skill
  `params` written as one whole `${...}`, and diagnostic rule `condition`,
  `diagnosis` and `suggestions` with its own portable expression subset
  (Perfetto-Skills `runtime/expressions.py`). The exporter parses every one of
  them with that parser, so a construct outside it fails the sync rather than a
  public run. Compute derived or rounded numbers in SQL and cite the column; a
  rule `confidence` is a literal level or number, never a template; never put
  `AND`/`OR` inside a quoted string of a condition or filter.
- A Skill SQL path read of an earlier step's result needs a `|default` or a
  step `condition` with the top-level conjunct `<result>.data?.length > 0`.
  SmartPerfetto binds a missing value as '' or NULL and runs; the public
  runtime skips a step whose default-less path reads an empty result.
  `validate:skills` rejects an undecided read as `result_path_read_undecided`;
  Self-Evolution rejects it in the Skill a proposal defines or changes
  (including that Skill's earlier overlay steps, and a `skill_sql` candidate
  checked in the step it replaces) and only warns about one in other
  already-published overlays.
- Heat and frequency-cap wording follows the evidence a Skill reads
  (`skillEngine/causeWording.ts`, `causeWordingEvidence.ts`). Every text the
  Skill shows counts, in both languages: labels, rule diagnoses and
  suggestions, input descriptions, the catalog labels
  `skillLocalizationCatalog.ts` derives (including English humanized from an
  identifier), and every string literal its SQL and declared fragments can
  show (CASE results, labels a VALUES table carries), judged by where the
  literal stands: an operand of a comparison, an `IN (…)` member, a
  GLOB/LIKE operand and a simple CASE's WHEN value show nothing. An exact run
  shows its `exact_sql` text and needs the evidence that run reads. A word
  inside an identifier, a path or a pattern written as data (`*thermal-engine*`)
  is a name, and so is an English one whose clause only names its component
  (thermal HAL service process, thermal-named track); Thermal zone overheated
  still names heat. Heat words (温控, 过热, thermal) need temperature, cooling
  or cpufreq-limit evidence; cap words (throttle, 限频, 降频, 热节流, and 频率上限
  when blamed for something) need cooling or cpufreq-limit evidence, since a
  temperature shows heat, not a cap. Write an observed step-down as 频率下调.
  When an identifier reads as a claim, give the label an authored
  `label_i18n` (display columns, synthesize fields) or `title_i18n` rather
  than renaming the column. `validate:skills` rejects unsupported wording as
  `cause_wording_without_evidence`, with the same proposal-gate and
  published-overlay severities as `result_path_read_undecided`
  (`PREDATING_RULE_CODES`).
- `validate:skills` and the Self-Evolution gates run the same validator
  (`selfEvolution/inProcessValidator.ts`), closed step schema included: an
  atomic step or a Skill root may declare `process_scope`, `exact_sql` and
  `investigation_evidence`, checked by the predicates the executor admits them
  with, and every diagnostic rule states a literal `confidence`. An invalid
  `exact_sql` or `investigation_evidence` fails execution and is an error
  everywhere; an invalid `process_scope` only leaves exact scope unsupported
  and is a `PREDATING_RULE_CODES` rule (`process_scope_invalid`). The built-in
  registry has no error under it (`inProcessValidator.test.ts`), so a base
  Skill never blocks an overlay; a rule the base cannot meet yet belongs in
  `PREDATING_RULE_CODES` with its reason, not in a switch that skips the check.
- After a source or policy change, regenerate in the public checkout, commit the
  updated source commit/hash provenance, and run `npm run verify:public-skills`.
- The verification script uses sibling `../Perfetto-Skills` by default; set
  `PERFETTO_SKILLS_DIR` for another checkout.

### Bidirectional impact review

SmartPerfetto and Perfetto-Skills develop independently, but changes to their
shared portable-analysis contract need an explicit paired review before commit
or push. Run:

```bash
npm run check:perfetto-skills-impact -- \
  --base "$(git merge-base HEAD origin/main)"
```

The command includes merge-base-to-HEAD, staged, unstaged, and untracked paths.
The classifier triggers on Skills, Strategies, Skill engine/packs,
evidence/claim/identity contracts, Perfetto SQL/schema services,
rendering-pipeline knowledge, processor pins, export policy, and exporter
verification. It only identifies candidates; the author must record one of:

- `required`: pass `--paired-path PATH` and an immutable `--paired-ref COMMIT`
  that exists and exactly equals the paired checkout HEAD, update
  Perfetto-Skills in its architecture, run its independent complete gate, and
  record the validated paired evidence;
- `not_required`: provide a concrete reason the behavior remains product-only;
- `deferred`: provide both a reason and a durable issue, PR, or commit handoff.

Example:

```bash
npm run check:perfetto-skills-impact -- \
  --base "$(git merge-base HEAD origin/main)" \
  --decision required \
  --reason "portable query and evidence contract changed" \
  --paired-path /absolute/path/to/Perfetto-Skills
```

Record the emitted change fingerprint and paired evidence in the commit or PR
notes. If a required paired update cannot be validated, use `deferred` with a
stable shared issue/task URL instead of claiming completion.

A public-project overlay must be reviewed, not copied mechanically into
SmartPerfetto. Re-express an applicable fix as native YAML/Strategy/runtime
behavior with SmartPerfetto tests, then regenerate the public projection. A
paired update never makes either installed product depend on a sibling checkout.

Perfetto-Skills owns its normal real-trace suite and upstream locks. Its
`docs/maintenance/upstream-sync.md` is the public-side procedure for importing
SmartPerfetto, gap-checking Google's official Skill, syncing PerfettoSQL stdlib,
and validating local SQL overlays. SmartPerfetto remains responsible for its
own real test traces and scene regressions; never replace them with public
fixture downloads.

## Validation

After changing Skill YAML:

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```

For scene-critical Skills, also run the relevant Agent SSE e2e check from
`.claude/rules/testing.md` and inspect both `backend/test-output/` and
`backend/logs/sessions/`.

## Strategy/Parser Co-Versioning

Strategy frontmatter (`backend/strategies/*.strategy.md`,
`investigation-profiles.yaml`) is read from the live directory by whichever
artifact runs — `dist/` and `tsx` resolve the same path. A strategy schema
change plus a stale parser build therefore kills every session at startup with
a bare `strategy_invalid_*` code.

- Strategy file changes and `strategyLoader.ts` parser changes must land in the
  same commit, with `dist/` rebuilt before any dist-based run.
- Before a batch of `smp analyze` runs, probe the exact artifact the batch will
  use: `node dist/cli-user/bin.js probe` (or `npx tsx src/cli-user/bin.ts
  probe`). A green source-tree `validate --strategies` does not clear a dist
  run.

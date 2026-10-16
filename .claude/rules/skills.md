# YAML Skill Rules

`backend/skills/` owns deterministic trace evidence; strategies own methodology.
Read [Skill System](../../docs/reference/skill-system.md) for the DSL, typed
parameters/display, identity/exact scope, expression validation and corpus rules.
Discover Skill types/inventory from source, never hardcoded counts.

## Evidence and Execution Contracts

- SQL belongs in Skills/shared SQL helpers, not UI. Preserve self-describing
  DataEnvelope columns, producer units, layers/levels, summary fields and
  process/thread/time/source identity. Reports, CLI, snapshots and comparison
  consume the same contract. `doc_path` targets committed runtime-read docs.
- Parameters use `${param|default}`. Vendor/platform differences are explicit
  inputs/conditions/overrides. Conditions/branch `when`/diagnostic conditions
  use JavaScript `&&`/`||`, not SQL boolean words; iterator filter's rewrite is
  its own contract. Diagnostic confidence is literal, not an expression.
- Missing earlier-step result reads need an explicit default or top-level
  nonempty-result guard. Named/exact SQL and conditional paths retain the same
  admitted validation; a public runtime's differing fallback cannot excuse a
  product step silently skipping.
- Heat wording requires temperature/cooling/cpufreq-limit evidence; frequency
  caps require cooling/cpufreq-limit evidence, not temperature alone. Observe
  frequency step-down as such. Apply to bilingual labels, SQL-visible literals,
  descriptions/diagnoses/suggestions and exact-run text; names are not claims.
- Built-ins and Self-Evolution use the same closed in-process validator.
  `PREDATING_RULE_CODES` handles explicitly justified older overlay debt; never
  bypass a check wholesale to let a base Skill or proposal pass. Invalid
  `exact_sql`/investigation evidence fails execution; unsupported process scope
  remains unsupported, never exact proof.
- All SQL readers use `executableSqlUnits` (`processScopeSql.ts`); all step
  readers use `stepNodesOf` (`skillSteps.ts`) with explicit options. Preserve
  nested/conditional traversal, named versus exact execution and step-object
  identity; do not add a private partial walk. Regenerate identity policies and
  named-SQL inventory from those shared readers; validation rejects stale output.
- Exact-process support binds issued UPID, never an inferred process name. Every
  admitted exact unit must execute through a passing corpus binding. Differential
  probes retain parameter-removal, unscoped and restarted-instance distinctions,
  each starting with its own results; scopes with shared UID/coarse attribution
  stay explicitly partial. Keep read-only probes isolated from state-changing
  setup. Missing/skipped/unavailable units or inconclusive bindings cannot count
  as SQL coverage. Nested exact units unsupported by the runner fail explicitly.
  See the Skill System exact-scope section for assertions and known limits.

## Public Agent Skill Projection

- Product YAML is authoritative; `public-export.yaml` explicitly classifies every
  runtime candidate and selected strategy/pipeline for `Gracker/Perfetto-Skills`.
  Missing policy fails, never inferred. Regenerate public references from sources.
- Public projection contains portable SQL/workflows/methodology/pipeline knowledge;
  provider/session/artifact/DataEnvelope/streaming/UI behavior stays product-owned.
  Portable expressions must pass the public parser; compute derived/rounded
  metrics in SQL and cite producer columns instead of unsupported expressions.
- Regenerate source commit/hash provenance in the public checkout and run
  `npm run verify:public-skills` after source/policy changes. It uses sibling
  `../Perfetto-Skills` or explicit `PERFETTO_SKILLS_DIR`; installed products must
  never depend on that checkout. Public overlays are reviewed and re-expressed
  natively, not copied mechanically into product runtime.

## Bidirectional Impact Review

Before committing/pushing shared Skills, Strategies, engine/evidence/identity,
SQL/schema/pins/pipeline/export changes:

```bash
npm run check:perfetto-skills-impact -- --base "$(git merge-base HEAD origin/main)"
```

The classifier includes committed/staged/unstaged/untracked deltas and identifies
candidates, not applicability. Record decision, reason, emitted fingerprint and
paired evidence in commit/PR notes:

- `required`: update the paired product in its architecture and pass its full
  independent gate; bind `--paired-path` and immutable `--paired-ref` exactly to
  that checkout's HEAD.
- `not_required`: concrete product-only reason.
- `deferred`: concrete reason plus durable issue/PR/commit handoff when the paired
  update cannot be validated; do not claim paired completion.

Perfetto-Skills owns its independent upstream locks and real-trace acceptance;
its `docs/maintenance/upstream-sync.md` defines public-side imports/SQL overlays.
SmartPerfetto still owns its corpus/scenes; public fixture downloads do not replace
product regressions.

## Validation and Co-Versioning

Skill edits run backend `validate:skills` and `test:scene-trace-regression`;
SQL-bearing edits additionally run `trace:sql-regression`. Scene-critical behavior
needs applicable authenticated E2E from [testing](testing.md), not just YAML syntax.

Strategies are runtime-read by dist and source alike. Schema changes and
`strategyLoader.ts` land together; rebuild dist before dist-based acceptance.
Probe the exact artifact a batch uses (`node dist/cli-user/bin.js probe` or
source `npx tsx src/cli-user/bin.ts probe` from backend). Source validation cannot
establish a stale dist parser is usable. See [prompts](prompts.md).

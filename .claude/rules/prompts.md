# Prompt and Strategy Rules

`backend/strategies/*.strategy.md` and `*.template.md` own durable instructions;
TypeScript loads, validates, substitutes, routes and assembles them. Skills collect
deterministic evidence. Discover scenes/output contracts from pinned frontmatter
and registry, not duplicated lists. Read
[Agent Runtime](../../docs/architecture/agent-runtime.md) and
[Skill System](../../docs/reference/skill-system.md) for current contracts.

## Runtime Contract

- All native prompt entrypoints use resolved typed intent and a pinned strategy
  registry; missing context fails, never a legacy quick/full contract fallback.
  `lookup_strategy_detail` returns full pinned detail, not a catalog preview.
- Budget, scope, deliverable, evidence access and source need remain independent.
  Existing-only forbids acquisition; sourceNeed sizes depth but grants no access.
  Plans/source lookup are on demand, submitted plans and investigation obligations
  stay binding, selected knowledge remains background rather than trace evidence.
- Conclusions preserve material findings, evidence, uncertainty and recommendations
  within scope. Runtime budget/preview imposes no hidden length/row/claim cap.
  Provider/review limits remain explicit incomplete states; never truncate or waive
  verification to pass. Native completion is not inferred from prose/headings.
- Preserve original claim semantics/references. Shared semantic review has no tools,
  at most one call, pinned provider/original deadline, and cannot rewrite the body.
  Structured repairs stay inside the same contract and remaining budget.
- Retained-evidence metadata remains bounded and authorized; titles/columns are
  data, not instructions or proof. Missing/evicted data stays unavailable.

## Authoring and Language

- Templates use `{{variable}}`; Skill parameters use `${param|default}`.
  Never put brace placeholders in comments: substitution/split logic reads them
  too. HTML comments are stripped before prompt delivery.
- Frontmatter schemas/loaders own field support; update their validators/tests
  with new syntax. `keywords` are classifier lexical anchors, not regex routing.
  Removed fields (`compound_patterns`, `phase_hints`, `plan_template`) cannot be
  reintroduced as inert metadata. Actual evidence obligations belong in
  `investigation_contract`; model plans remain a distinct live contract.
- `entry_skill` must pass strict schema and registry admission: executable
  single-trace, declared inputs, identity/time bindings and read-only SQL. Product
  scene-entry evidence runs under scope/lease/deadline/authorization/identity
  guards; it is not a model tool call. Guidance belongs in templates.
- Default strategy detail and new prompt sections consume the measured prompt
  budget; run backend
  `claudeSystemPrompt.realStrategyTokenRegression.test.ts` when enlarging them
  and inspect dropped segment labels. Added prose must not silently evict useful
  schema or completeness context.
- Runtime language is `SMARTPERFETTO_OUTPUT_LANGUAGE` (`zh-CN` default, `en`
  override), external language templates and `outputLanguage.ts` `localize`.
  Preserve bilingual user-facing runtime/report/insight strings.

## Verification

```bash
npm --prefix backend run validate:strategies
npm --prefix backend run test:scene-trace-regression
```

Add affected finalization/result-quality owner tests for output/evidence/recovery
contracts and authenticated scene E2E for actual agent behavior according to
[testing](testing.md). Schema/parser co-versioning belongs to [skills](skills.md).

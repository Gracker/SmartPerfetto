# Prompt and Strategy Rules

## No Prompt Content in TypeScript

Do not hardcode durable prompt instructions in TypeScript. TypeScript should
load, validate, substitute, route, and assemble prompt assets. The content lives
in Markdown strategy/template files.

Runtime prompt assets live in `backend/strategies/` as `*.strategy.md` and
`*.template.md`. Deterministic evidence programs live in `backend/skills/`.

Current strategy set is discovered from strategy frontmatter through
`strategyLoader.ts`; do not duplicate the scene list in TypeScript when the
frontmatter can be the source of truth.

Strategy frontmatter can also declare final-output requirements such as
`final_report_contract`. Add or update those fields in the strategy/template
layer, then update `strategyLoader.ts` and contract tests only when the schema
itself changes.

## Runtime Content Paths

SmartPerfetto uses two content tracks:

```text
Markdown strategies/templates
  -> strategyLoader.ts
  -> system prompt / quick prompt / classifier prompt
  -> agent runtime

YAML Skills
  -> invoke_skill MCP tool
  -> SkillExecutor
  -> SQL / trace_processor_shell
  -> DataEnvelope / DisplayResult
```

Strategies shape agent behavior. Skills collect deterministic evidence. Keep
that boundary intact.

`lookup_strategy_detail` returns the complete detail from the run's pinned
strategy registry. Do not truncate its body or substitute a catalog preview;
the final sections carry interpretation limits and system-analysis guidance.
Keep discovery metadata and general runtime budgets separate from this read.
Scene `investigation_requirements` preserve relevant evidence depth for both
answers and reports; presentation freedom does not waive that coverage.

The five native runtimes share external typed-intent and conclusion-declaration
templates. Scene choices come from the pinned strategy registry, and the finite
proof catalog comes from `SUPPORTED_DETERMINISTIC_CLAIM_RULES`. Valid JSON only
establishes a declaration's shape; it does not prove its interpretation or
claims correct.

All system-prompt entrypoints require the resolved turn intent and pinned
strategy registry. There is no legacy quick/full prompt fallback. Missing
context fails explicitly instead of selecting a different answer contract.
Final conclusions are the primary user record: retain all material findings,
evidence, uncertainty and relevant recommendations within scope. Neither a
runtime budget setting nor an artifact preview imposes a conclusion length,
table-row or claim-count limit. Actual provider/review limits remain explicit
incomplete states; do not truncate a conclusion or waive verification to pass.

Keep budget, question scope, deliverable, evidence access and source need
separate. An `existing_only` turn cannot acquire new evidence; `read_new` never
widens authorization; `sourceNeed` (asked only when source is selected, in
`prompt-analysis-turn-intent-source-need`) sizes source depth and never grants
source access. Plans and source lookup are on demand. A larger budget does not
require a report, extra source pass, fixed Skill sequence or plan template.
Selected document knowledge bases are background (`prompt-knowledge-use-*`,
`knowledge_authorization`): an `existing_only` turn may consult them to explain
names in retained evidence, and they never count as trace evidence.

Preserve the original claim semantics and references. Do not use wording,
headings or error-like prose to infer native completion, rewrite causal claims
into easier assertions, or force another answer. Structured delivery repairs
must respect the same strategy contract and remaining runtime budget.

The shared final semantic review uses an external template, the pinned provider
and original deadline, with no tools and at most one review. It checks the
canonical body, declarations and available evidence; it does not perform new
queries or rewrite the body. Known-misdiagnosis regex metadata is not a substitute
for this current semantic boundary.

Conversation's retained-evidence template receives only bounded, authorized
locator metadata from live captures. Titles and column names are data, not
instructions or proof; private metadata passes the existing projection before
entering the native prompt path. Missing or evicted data remains unavailable.

## Template Syntax

- Prompt/template variables use `{{variable}}`.
- Skill YAML parameter substitution uses `${param|default}`.
- Strategy frontmatter may include `keywords`, `priority`,
  `investigation_contract`, and final-report contract fields. `keywords` are
  lexical anchors: the first eight of each scene reach the classifier's scene
  catalog, so put the words a user actually types first. `compound_patterns`
  is not a frontmatter field; scene routing is semantic and no runtime path
  evaluates regular expressions against the query.
- `entry_skill` (`id` plus closed `params` bindings: `focus_app`,
  `user_target`, `trace_start`, `trace_end`, `selection_start`,
  `selection_end`) names the Skill the product runs for a scene-wide
  investigation before the model's first turn (`sceneEntryEvidence.ts`).
  `parseEntrySkill` is its strict schema; `validate:strategies` also checks it
  against the Skill registry (`entrySkillPolicy.ts`: executable single-trace
  Skill, declared inputs, process bindings on identity selectors, time
  bindings on timestamp inputs, no writing SQL unit). Its guidance lives in
  `prompt-scene-evidence.template.md`, not in TypeScript.
- A `strategy-detail` block marked `default="true"` is rendered in full into a
  resolved investigation's first prompt as `scene_default_detail`, the most
  expendable segment (dropped first under budget pressure; its title stays in
  `scene_strategy_details`). Measure a larger default detail with the token
  regression test below.
- `phase_hints` and `plan_template` are unsupported
  (`REMOVED_STRATEGY_FRONTMATTER_KEYS`); validation rejects them and
  Self-Evolution refuses new inert targets and quarantines persisted overlays.
  An obligation binding to actual measurements belongs in
  `investigation_contract`: its evidence conditions and metrics resolve
  against the producer ledger even without semantic review. Model-submitted
  plans (`submit_plan` / `revise_plan` expected calls) remain a separate live
  contract.
- Never write a variable in braces inside a template comment. Rendering
  substitutes inside comments too, and split points that search for a
  placeholder find the documented one first. Write `Variable "name" = ...`
  instead.
- HTML comments are stripped when a template becomes a prompt segment, so
  SPDX and authoring notes cost no tokens and never reach the model.
- The full-mode prompt is budget-bound (`MAX_PROMPT_TOKENS`). Before adding a
  section, measure with
  `npx jest src/agentv3/__tests__/claudeSystemPrompt.realStrategyTokenRegression.test.ts`
  and read the typed prompt budget report: a new section that pushes
  `droppedLabels` wider has traded trace-completeness or schema context for
  its own text.

`strategyLoader.ts` owns loading, frontmatter parsing, template rendering and
cache behavior. Update it and its tests when adding template syntax or
frontmatter fields.

## Language Output

Runtime output language is controlled by `SMARTPERFETTO_OUTPUT_LANGUAGE`.

- Default: `zh-CN`.
- English override: `en`.
- Use `backend/strategies/prompt-language-zh.template.md` and
  `prompt-language-en.template.md`.
- For TypeScript-generated runtime text, use `localize(...)` from
  `backend/src/agentv3/outputLanguage.ts`.

Do not reintroduce hardcoded English-only or Chinese-only runtime messages in
paths that stream to users, reports, or insights.

## Validation

After changing strategies/templates:

```bash
cd backend
npm run validate:strategies
npm run test:scene-trace-regression
```

If the change affects startup, scrolling, Flutter, comparison, selection,
system prompt, verifier, or MCP tool behavior, also run the relevant Agent SSE
e2e command from `.claude/rules/testing.md`.

If the change affects final-answer completeness, evidence summaries, claim
verification wording, or OpenAI final-report continuation, include the focused
result-quality tests listed in `.claude/rules/testing.md`.

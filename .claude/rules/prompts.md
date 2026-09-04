# Prompt and Strategy Rules

## No Prompt Content in TypeScript

Do not hardcode durable prompt instructions in TypeScript. TypeScript should
load, validate, substitute, route, and assemble prompt assets. The content lives
in Markdown strategy/template files.

Runtime prompt assets:

- Scene strategies: `backend/strategies/*.strategy.md`
- Prompt templates: `backend/strategies/prompt-*.template.md`
- Architecture templates: `backend/strategies/arch-*.template.md`
- Selection templates: `backend/strategies/selection-*.template.md`
- Knowledge templates: `backend/strategies/knowledge-*.template.md`
- Comparison methodology: `backend/strategies/comparison-methodology.template.md`

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

Final-report continuation templates must respect the same strategy contract as
the main system prompt. Do not fix a missing conclusion by adding a
scenario-specific TypeScript prompt string; fix the strategy/frontmatter or the
shared continuation template so both Claude and OpenAI runtimes use the same
rules.

## Template Syntax

- Prompt/template variables use `{{variable}}`.
- Skill YAML parameter substitution uses `${param|default}`.
- Strategy frontmatter may include `keywords`, `compound_patterns`, `priority`,
  `phase_hints`, and final-report contract fields.
- Never write a variable in braces inside a template comment. Rendering
  substitutes inside comments too, and split points that search for a
  placeholder find the documented one first — that once injected the whole
  scene core inside an unterminated HTML comment and pushed the methodology
  preamble after it. Write `Variable "name" = ...` instead.
- HTML comments are stripped when a template becomes a prompt segment, so
  SPDX and authoring notes cost no tokens and never reach the model. Marker
  comments such as `<!-- tool-description:start -->` are consumed by their own
  loader before that point; keep any new marker on the same contract.
- The full-mode prompt is budget-bound (`MAX_PROMPT_TOKENS`). Before adding a
  section, measure with
  `npx jest src/agentv3/__tests__/claudeSystemPrompt.realStrategyTokenRegression.test.ts`
  and read the `[SystemPromptTokenGate]` line: a new section that pushes
  `droppedLabels` wider has traded trace-completeness or schema context for
  its own text.

`strategyLoader.ts` owns loading, frontmatter parsing, template rendering, cache
behavior, and phase hint access. Update it and its tests when adding template
syntax or frontmatter fields.

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

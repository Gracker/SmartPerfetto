// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Heat and frequency-cap wording follows the evidence a Skill reads. A text
// that names heat as a cause (causeWording.ts) needs a step that reads
// temperature, a cooling device or a cpufreq limit; one that names a cap
// ("throttle", 限频, 降频) needs a cooling device or a cpufreq limit, since a
// temperature shows heat, not a cap. Every text a Skill shows is read: its
// authored labels and rule text, its user-facing SQL literals, its input
// descriptions, and the catalog labels in both languages, including those
// humanized from an identifier (skillLocalizationCatalog.ts).
//
// A step reads evidence through its own SQL (normalizedSourceReads.ts: the
// names it reads and the literals it selects by, never its own aliases or
// output codes), a shared fragment, a referenced Skill that reads it, or an
// earlier evidence step's result. A step label may name what the step reads;
// a rule's diagnosis and suggestions need a condition that cannot hold while
// every evidence result it reads is empty, judged statically.

import type {SkillDefinition} from './types';
import {namesFrequencyCap, namesThermalCause} from './causeWording';
import {extractRootVariables, parseEvidenceField, parseEvidenceLiteral, readEvidenceField} from './expressionUtils';
import {sqlReads} from './normalizedSourceReads';
import {builtInFragmentText} from './skillFragments';
import {isExactSqlSource} from './processScopeSql';
import {scanOutsideStrings, topLevelOperands} from './resultPathReads';
import {allStepsOf} from './skillSteps';
import {boundSqlPlaceholderPaths} from './sqlTemplate';
import {closingParen, operandEndingAt, operandStartingAt, structuralSqlTokens, tokenMatchers} from './sqlStructure';
import {
  CATALOG_ROOT_STEP,
  CATALOG_SYNTHESIZE_SUMMARY_STEP,
  HAN_RE,
  skillCatalogEntry,
  type LocalizedText,
} from '../skillLocalizationCatalog';

/**
 * Evidence a step can read: by the names its SQL reads, by a literal it
 * selects by (a track name; a name must match the stricter `sql`), or through
 * a shared fragment.
 */
interface EvidenceKind { sql: RegExp; selected: RegExp; fragment: RegExp }

type Wording = 'heat' | 'cap';

/** What a wording check looks for, the evidence that allows it, and how to name both. */
export interface CauseWordingRule {
  wording: Wording;
  names: (text: string) => boolean;
  kind: EvidenceKind;
  /** What the wording names: "heat", "a frequency cap". */
  cause: string;
  /** The evidence that may support it. */
  evidence: string;
}

export const HEAT_WORDING: CauseWordingRule = {
  wording: 'heat',
  names: namesThermalCause,
  kind: {
    sql: /thermal_zone|Temperature|cdev|cooling|cpu_frequency_limits|max_limit|freq_limit/i,
    selected: /thermal|\btemp|cdev|cooling|freq_limit|max_limit/i,
    fragment: /fragments\/(thermal_|system_cpu_freq_limit_)/,
  },
  cause: 'heat',
  evidence: 'temperature, cooling-device or cpufreq-limit evidence',
};
export const CAP_WORDING: CauseWordingRule = {
  wording: 'cap',
  names: namesFrequencyCap,
  kind: {
    sql: /cdev|cooling|cpu_frequency_limits|max_limit|freq_limit/i,
    selected: /cdev|cooling|freq_limit|max_limit/i,
    fragment: /fragments\/(thermal_cooling_|system_cpu_freq_limit_)/,
  },
  cause: 'a frequency cap',
  evidence: 'cooling-device or cpufreq-limit evidence (a temperature shows heat, not a cap)',
};
const RULES = [HEAT_WORDING, CAP_WORDING] as const;

/**
 * How a Skill runs: on its named SQL, or under an exact process scope, where
 * each `exact_sql` replaces the SQL and fragments beside it (and a referenced
 * Skill runs exact too). Evidence and wording are judged per variant: text an
 * exact run shows needs evidence that run reads.
 */
type Variant = 'named' | 'exact';

/**
 * A step as `variant` runs it: an exact run executes a valid exact_sql
 * (selectProcessScopeSql; an invalid one fails as exact_sql_invalid).
 * `sqlField` says where the SQL it runs is written.
 */
function asRun(step: any, variant: Variant): any {
  return variant === 'exact' && isExactSqlSource(step?.exact_sql)
    ? {...step, sql: step.exact_sql.sql, sql_fragments: step.exact_sql.sql_fragments, sqlField: 'exact_sql.'}
    : step;
}

/** A Skill's root SQL as a step, then every step at any depth, as `variant` runs them. */
function stepsOf(skill: any, variant: Variant): any[] {
  const root = typeof skill?.sql === 'string'
    ? [{id: CATALOG_ROOT_STEP, sql: skill.sql, sql_fragments: skill.sql_fragments, exact_sql: skill.exact_sql}] : [];
  return [...root, ...allStepsOf(skill)].map(step => asRun(step, variant));
}


/** Roots of the saved results a step's SQL reads through placeholders. */
function sqlResultRoots(sql: unknown): string[] {
  return typeof sql === 'string' ? boundSqlPlaceholderPaths(sql).map(path => path.split(/[.[]/)[0]) : [];
}

/** Whether a step's own SQL reads `kind` evidence: by the names it reads, or the tracks it selects by. */
function readsEvidenceSql(sql: unknown, kind: EvidenceKind): boolean {
  if (typeof sql !== 'string' || !sql.trim()) return false;
  const reads = sqlReads(sql);
  return reads.identifiers.some(name => kind.sql.test(name))
    || reads.selectionLiterals.some(literal => !HAN_RE.test(literal) && kind.selected.test(literal));
}

const COMPARISON_PUNCT = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);
/** Words that compare the operands on either side of them (`NOT LIKE`, `IS NOT` included). */
const COMPARISON_WORDS = new Set(['IS', 'LIKE', 'GLOB', 'REGEXP', 'MATCH']);
const shownBySql = new Map<string, string[]>();
const SHOWN_CACHE_LIMIT = 2048;

/**
 * The string literals `sql` can show, in either language, decided by where
 * each one stands (sqlStructure.ts operand spans): every literal but one in an
 * operand of a comparison, an `IN (…)` list or BETWEEN bound, a simple CASE's
 * WHEN value, a GLOB/LIKE/REGEXP operand or its ESCAPE. CASE results, labels a
 * VALUES table carries and text concatenated into a column remain; a pattern
 * written as data reads as a name to the classifier. Kept by text: Skill SQL
 * and fragments are a fixed set.
 */
function shownSqlLiterals(sql: string): string[] {
  const cached = shownBySql.get(sql);
  if (cached) return cached;
  const tokens = structuralSqlTokens(sql);
  const {word, punct} = tokenMatchers(tokens);
  const compared = new Set<number>();
  const mark = (span: [number, number] | undefined) => {
    for (let at = span?.[0] ?? 0; span && at <= span[1]; at++) compared.add(at);
  };
  const leftOf = (index: number) => operandEndingAt(tokens, word(index - 1, 'NOT') ? index - 2 : index - 1);
  tokens.forEach((token, index) => {
    if ((token.kind === 'punct' && COMPARISON_PUNCT.has(token.text)) || (token.kind === 'word' && COMPARISON_WORDS.has(token.text))) {
      let right = index + 1;
      if (word(right, 'NOT')) right++;
      if (word(right, 'DISTINCT') && word(right + 1, 'FROM')) right += 2;
      mark(leftOf(index));
      mark(operandStartingAt(tokens, right));
    } else if (word(index, 'IN') && punct(index + 1, '(')) {
      mark(leftOf(index));
      mark([index + 1, closingParen(tokens, index + 1)]);
    } else if (word(index, 'BETWEEN')) {
      mark(leftOf(index));
      const low = operandStartingAt(tokens, index + 1);
      mark(low);
      if (low && word(low[1] + 1, 'AND')) mark(operandStartingAt(tokens, low[1] + 2));
    } else if (word(index, 'WHEN') || word(index, 'ESCAPE')) {
      mark(operandStartingAt(tokens, index + 1));
    }
  });
  const shown = tokens.flatMap((token, index) =>
    token.kind === 'string' && !token.pattern && !token.inPatternExpression && !compared.has(index) ? [token.text] : []);
  if (shownBySql.size >= SHOWN_CACHE_LIMIT) shownBySql.clear();
  shownBySql.set(sql, shown);
  return shown;
}

/** Each SQL text a step runs (as its variant runs it) and can show, by field: its SQL and the fragments it declares. */
function stepSqlTexts(step: any): Array<[string, string]> {
  const prefix: string = step?.sqlField ?? '';
  const texts: Array<[string, string]> = typeof step?.sql === 'string' ? [[`${prefix}sql`, step.sql]] : [];
  for (const path of Array.isArray(step?.sql_fragments) ? step.sql_fragments : []) {
    const text = typeof path === 'string' ? builtInFragmentText(path) : undefined;
    if (text !== undefined) texts.push([`${prefix}sql_fragments.${path}`, text]);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Static judgement of a condition over evidence results.
// ---------------------------------------------------------------------------

const COMPARISON = /^(===|!==|==|!=|>=|<=|>|<)/;
const LITERAL = /^(-?\d+(?:\.\d+)?|'[^'\\]*'|"[^"\\]*"|true|false|null)$/;

/** The first top-level comparison operator of `expression`, outside brackets and strings. */
function topLevelComparison(expression: string): {at: number; operator: string} | undefined {
  let found: {at: number; operator: string} | undefined;
  scanOutsideStrings(expression, (index, depth) => {
    const operator = depth === 0 ? COMPARISON.exec(expression.slice(index))?.[1] : undefined;
    if (operator) found = {at: index, operator};
    return Boolean(operator);
  });
  return found;
}

/** JS comparison of an empty-evidence read with a literal. */
function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    // eslint-disable-next-line eqeqeq
    case '==': return left == right;
    case '===': return left === right;
    // eslint-disable-next-line eqeqeq
    case '!=': return left != right;
    case '!==': return left !== right;
    case '>': return (left as number) > (right as number);
    case '>=': return (left as number) >= (right as number);
    case '<': return (left as number) < (right as number);
    default: return (left as number) <= (right as number);
  }
}

/**
 * Whether a conjunct can hold while every evidence result it reads is empty:
 * `limit.data.length === 0` and `limit.data[0]?.status !== 'observed'` can,
 * so they read the absence of evidence. Only an evidence field (the read-only
 * grammar of diagnostic evidence_fields), alone or compared to a literal, is
 * judged; anything else may hold.
 */
function holdsWithoutEvidence(conjunct: string): boolean {
  const comparison = topLevelComparison(conjunct);
  const field = parseEvidenceField(comparison ? conjunct.slice(0, comparison.at) : conjunct);
  if (!field) return true;
  const value = readEvidenceField(field, []);
  if (!comparison) return Boolean(value);
  const literal = conjunct.slice(comparison.at + comparison.operator.length).trim();
  if (!LITERAL.test(literal)) return true;
  return compare(value, comparison.operator, parseEvidenceLiteral(literal));
}

/** The inside of `expression` when one pair of parentheses wraps all of it. */
function unwrapParentheses(expression: string): string | undefined {
  if (!expression.startsWith('(')) return undefined;
  let close = -1;
  scanOutsideStrings(expression, (index, depth) => {
    if (depth === 1 && expression[index] === ')') close = index;
    return close >= 0;
  });
  return close === expression.length - 1 ? expression.slice(1, -1).trim() : undefined;
}

/** Condition roots by text: conditions are a fixed set, and reading roots compiles each name. */
const rootsByConjunct = new Map<string, string[]>();
const ROOTS_CACHE_LIMIT = 4096;

function conjunctRoots(conjunct: string): string[] {
  let roots = rootsByConjunct.get(conjunct);
  if (!roots) {
    if (rootsByConjunct.size >= ROOTS_CACHE_LIMIT) rootsByConjunct.clear();
    roots = extractRootVariables(conjunct);
    rootsByConjunct.set(conjunct, roots);
  }
  return roots;
}

/**
 * Whether a condition can only hold with evidence present: each top-level
 * alternative has a conjunct that needs a non-empty evidence result, judged
 * recursively through parentheses. Mentioning an evidence step is not
 * reading it: a condition on its absence speaks to no cause, and a ternary or
 * nullish fallback at the top level is not judged.
 */
function requiresEvidence(condition: unknown, evidenceNames: ReadonlySet<string>): boolean {
  if (evidenceNames.size === 0 || typeof condition !== 'string' || !condition.trim()) return false;
  const alternatives = topLevelOperands(condition.trim(), '||');
  if (!alternatives) return false;
  return alternatives.every(alternative => (topLevelOperands(alternative, '&&') ?? []).some(conjunct => {
    const inner = unwrapParentheses(conjunct);
    if (inner !== undefined && /&&|\|\|/.test(inner)) return requiresEvidence(inner, evidenceNames);
    // An atomic conjunct counts only when it reads nothing but evidence:
    // another name's value could make it hold without any.
    const roots = conjunctRoots(conjunct);
    return roots.length > 0 && roots.every(root => evidenceNames.has(root)) && !holdsWithoutEvidence(inner ?? conjunct);
  }));
}

/**
 * The steps that read evidence, in order, with the names their results are
 * read under: by their own SQL or fragments, by referencing a Skill that reads
 * it (an iterator's item Skill included), by reading an earlier such step's
 * result in their SQL or their condition, or through their inputs (a
 * diagnostic step) or source (an iterator).
 */
function evidenceSteps(steps: readonly any[], readers: ReadonlySet<string>, kind: EvidenceKind) {
  const found = new Set<any>();
  const names = new Set<string>();
  for (const step of steps) {
    const reads = readers.has(step.skill) || readers.has(step.item_skill)
      || readsEvidenceSql(step.sql, kind)
      || (Array.isArray(step.sql_fragments) ? step.sql_fragments : []).some((fragment: unknown) =>
        typeof fragment === 'string' && kind.fragment.test(fragment))
      || [...sqlResultRoots(step.sql), ...(Array.isArray(step.inputs) ? step.inputs : []), step.source].some(root => names.has(root))
      || requiresEvidence(step.condition, names);
    if (!reads) continue;
    found.add(step);
    for (const name of [step.id, step.save_as]) if (typeof name === 'string') names.add(name);
  }
  return {steps: found, names};
}

/**
 * Names of the Skills that read each kind of evidence in each variant (a Skill
 * referencing one reads it too), and whether the variants differ anywhere.
 */
export type CauseWordingReaders = Readonly<Record<Variant, Readonly<Record<Wording, ReadonlySet<string>>>>>
  & {readonly variantsDiffer: boolean};

export function causeWordingReaders(skills: readonly SkillDefinition[]): CauseWordingReaders {
  const variant = (run: Variant) => readersIn(skills.map(skill => ({name: skill.name, steps: stepsOf(skill, run)})));
  const named = variant('named');
  const exact = variant('exact');
  const same = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    left.size === right.size && [...left].every(name => right.has(name));
  return {named, exact, variantsDiffer: !same(named.heat, exact.heat) || !same(named.cap, exact.cap)};
}

function readersIn(stepLists: ReadonlyArray<{name: string; steps: any[]}>): Record<Wording, ReadonlySet<string>> {
  const readersOf = (kind: EvidenceKind) => {
    const found = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const {name, steps} of stepLists) {
        if (!found.has(name) && evidenceSteps(steps, found, kind).steps.size > 0) { found.add(name); grew = true; }
      }
    }
    return found;
  };
  return {heat: readersOf(HEAT_WORDING.kind), cap: readersOf(CAP_WORDING.kind)};
}

/** One text that names a cause, where it sits, and what allows it (undefined: nothing does). */
export interface CauseWordingSite {
  rule: CauseWordingRule;
  /** The step id the text belongs to, absent for the Skill's own texts. */
  stepId?: string;
  /** Where in the Skill: `meta.description`, `catalog.columns.<name>.label.en`, `rules[2].diagnosis`, ... */
  field: string;
  text: string;
  allowedBy?: string;
}

/** What every wording rule reads of one Skill: its steps and its catalog labels. */
interface SkillTexts { steps: any[]; catalog: ReturnType<typeof skillCatalogEntry> }

function sitesOf(skill: SkillDefinition, texts: SkillTexts, readers: ReadonlySet<string>, rule: CauseWordingRule): CauseWordingSite[] {
  const found: CauseWordingSite[] = [];
  const seen = new Set<string>();
  const add = (stepId: string | undefined, field: string, text: unknown, allowedBy?: string) => {
    if (typeof text !== 'string') return;
    // The same text twice (a YAML label and its catalog copy) is one finding,
    // but only under the same allowance: an allowed rule text never hides an
    // identical one whose condition reads no evidence.
    const key = `${stepId ?? ''}\u0000${allowedBy ?? ''}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (rule.names(text)) found.push({rule, ...(stepId ? {stepId} : {}), field, text, allowedBy});
  };
  const addLocalized = (stepId: string | undefined, field: string, text: LocalizedText | undefined, allowedBy?: string) => {
    if (!text) return;
    add(stepId, `${field}.zh-CN`, text['zh-CN'], allowedBy);
    add(stepId, `${field}.en`, text.en, allowedBy);
  };
  const raw = skill as any;
  const name = String(raw?.name);
  const skillAllowance = readers.has(name) ? `skill ${name}` : undefined;
  const evidence = evidenceSteps(texts.steps, readers, rule.kind);
  const evidenceIds = new Set([...evidence.steps].map(step => step.id));
  const allowanceOf = (stepId: string | undefined) => stepId === undefined
    ? skillAllowance : evidenceIds.has(stepId) ? `step ${name}/${stepId}` : undefined;

  // What the Skill says it does and what its inputs mean.
  add(undefined, 'meta.display_name', raw?.meta?.display_name, skillAllowance);
  add(undefined, 'meta.description', raw?.meta?.description, skillAllowance);
  (Array.isArray(raw?.inputs) ? raw.inputs : []).forEach((input: any, index: number) =>
    add(undefined, `inputs[${index}].description`, input?.description, skillAllowance));
  for (const insight of raw?.synthesize?.insights ?? []) add(undefined, 'synthesize.insights', insight?.template, skillAllowance);

  // Every label the Skill shows, in both languages.
  addLocalized(undefined, 'catalog.displayName', texts.catalog.displayName, skillAllowance);
  addLocalized(undefined, 'catalog.description', texts.catalog.description, skillAllowance);
  for (const [stepId, step] of Object.entries(texts.catalog.steps)) {
    if (stepId === CATALOG_SYNTHESIZE_SUMMARY_STEP) continue; // a fixed title
    const owner = stepId === CATALOG_ROOT_STEP ? undefined : stepId;
    const allowedBy = allowanceOf(owner);
    addLocalized(owner, 'catalog.title', step.title, allowedBy);
    addLocalized(owner, 'catalog.description', step.description, allowedBy);
    for (const [column, entry] of Object.entries(step.columns)) {
      addLocalized(owner, `catalog.columns.${column}.label`, entry.label, allowedBy);
      addLocalized(owner, `catalog.columns.${column}.tooltip`, entry.tooltip, allowedBy);
    }
    for (const [key, label] of Object.entries(step.synthesizeLabels)) addLocalized(owner, `catalog.synthesize.${key}`, label, allowedBy);
  }

  for (const step of texts.steps) {
    const stepId = step.id === CATALOG_ROOT_STEP ? undefined : step.id;
    const allowedBy = allowanceOf(stepId);
    add(stepId, 'name', step.name, allowedBy);
    add(stepId, 'display.title', step.display?.title, allowedBy);
    for (const insight of step.synthesize?.insights ?? []) add(stepId, 'synthesize.insights', insight?.template, allowedBy);
    // Text the step's SQL can show; a code such as 'thermal_zone' reads as a name to the classifier.
    for (const [field, sql] of stepSqlTexts(step)) {
      for (const literal of shownSqlLiterals(sql)) add(stepId, field, literal, allowedBy);
    }
    (Array.isArray(step.rules) ? step.rules : []).forEach((ruleDefinition: any, index: number) => {
      const ruleAllowance = requiresEvidence(ruleDefinition?.condition, evidence.names) ? `rule ${name}/${step.id}` : undefined;
      add(stepId, `rules[${index}].diagnosis`, ruleDefinition?.diagnosis, ruleAllowance);
      (Array.isArray(ruleDefinition?.suggestions) ? ruleDefinition.suggestions : []).forEach((text: unknown, at: number) =>
        add(stepId, `rules[${index}].suggestions[${at}]`, text, ruleAllowance));
    });
  }
  return found;
}



/**
 * Every user-facing text of `skill` that names a cause of `rule`'s kind, with
 * the evidence that allows it: the step that reads evidence (for its labels and
 * SQL text), the Skill for its own texts, or a rule whose condition reads such
 * a step's result. Texts are read as authored and as the catalog shows them in
 * each language.
 * @internal The contract test reads each text's allowance through it.
 */
export function causeWordingSites(skill: SkillDefinition, readers: CauseWordingReaders, rule: CauseWordingRule): CauseWordingSite[] {
  return sitesOf(skill, {steps: stepsOf(skill, 'named'), catalog: skillCatalogEntry(skill)}, readers.named[rule.wording], rule);
}

/** Texts of `skill` that name heat or a frequency cap with no evidence to allow them. */
export function unsupportedCauseWording(skill: SkillDefinition, readers: CauseWordingReaders): CauseWordingSite[] {
  const found = new Map<string, CauseWordingSite>();
  const catalog = skillCatalogEntry(skill);
  // The exact run differs where the Skill has an exact_sql of its own, or where
  // some Skill reads evidence in one run and not the other (a child it references).
  const exactDiffers = readers.variantsDiffer || stepsOf(skill, 'named').some(step => isExactSqlSource(step?.exact_sql));
  for (const variant of exactDiffers ? (['named', 'exact'] as const) : (['named'] as const)) {
    const texts = {steps: stepsOf(skill, variant), catalog};
    for (const rule of RULES) {
      for (const site of sitesOf(skill, texts, readers[variant][rule.wording], rule)) {
        // A text both runs show is one finding.
        const key = `${rule.wording}\u0000${site.stepId ?? ''}\u0000${site.field}\u0000${site.text}`;
        if (!site.allowedBy && !found.has(key)) found.set(key, site);
      }
    }
  }
  return [...found.values()];
}

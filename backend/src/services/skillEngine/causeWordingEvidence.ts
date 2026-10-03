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
import {scanOutsideStrings, topLevelOperands} from './resultPathReads';
import {allStepsOf} from './skillSteps';
import {boundSqlPlaceholderPaths, skillSqlTokens} from './sqlTemplate';
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

/** A Skill's root SQL as a step, then every step at any depth. */
function stepsOf(skill: any): any[] {
  return [...(typeof skill?.sql === 'string'
    ? [{id: CATALOG_ROOT_STEP, sql: skill.sql, sql_fragments: skill.sql_fragments}] : []), ...allStepsOf(skill)];
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

/** Names of the Skills that read each kind of evidence; a Skill referencing one reads it too. */
export type CauseWordingReaders = Readonly<Record<Wording, ReadonlySet<string>>>;

export function causeWordingReaders(skills: readonly SkillDefinition[]): CauseWordingReaders {
  const stepLists = skills.map(skill => ({name: skill.name, steps: stepsOf(skill)}));
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
    // Only literals with Chinese text are user-facing; codes such as 'thermal_zone' are not.
    if (typeof step.sql === 'string') {
      for (const token of skillSqlTokens(step.sql)) {
        if (token.kind === 'string' && HAN_RE.test(token.text)) add(stepId, 'sql', token.text, allowedBy);
      }
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

const textsOf = (skill: SkillDefinition): SkillTexts => ({steps: stepsOf(skill), catalog: skillCatalogEntry(skill)});

/**
 * Every user-facing text of `skill` that names a cause of `rule`'s kind, with
 * the evidence that allows it: the step that reads evidence (for its labels and
 * SQL text), the Skill for its own texts, or a rule whose condition reads such
 * a step's result. Texts are read as authored and as the catalog shows them in
 * each language.
 * @internal The contract test reads each text's allowance through it.
 */
export function causeWordingSites(skill: SkillDefinition, readers: CauseWordingReaders, rule: CauseWordingRule): CauseWordingSite[] {
  return sitesOf(skill, textsOf(skill), readers[rule.wording], rule);
}

/** Texts of `skill` that name heat or a frequency cap with no evidence to allow them. */
export function unsupportedCauseWording(skill: SkillDefinition, readers: CauseWordingReaders): CauseWordingSite[] {
  const texts = textsOf(skill);
  return RULES.flatMap(rule => sitesOf(skill, texts, readers[rule.wording], rule).filter(site => !site.allowedBy));
}

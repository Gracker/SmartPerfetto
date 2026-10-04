// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Validator
 *
 * Centralized validation logic for the Skill Engine:
 *
 * 1. **validateSkillInputs()** — Runtime parameter validation against SkillInput declarations.
 *    Catches missing required params, type mismatches, and undeclared params.
 *
 * 2. **validateSkillConditions()** — Load-time condition expression checking.
 *    Verifies that all variables referenced in step `condition` fields resolve to
 *    declared inputs, prior step IDs, save_as variables, or implicit context params.
 *
 * 3. **validateFragmentReferences()** — Load-time fragment path validation.
 *    Ensures that all `sql_fragments` paths in AtomicStep definitions point to
 *    files that exist in the fragment cache.
 */

import {
  SkillDefinition,
  SkillInput,
  SkillInputValidationError,
  ValidatedParams,
} from './types';
import { CONTEXTUAL_KEYWORDS, extractRootVariables } from './expressionUtils';
import { executableSqlUnits, sqlScopeDeclarationError } from './processScopeSql';
import { stepNodesOf } from './skillSteps';
import { sqlReads } from './normalizedSourceReads';

// =============================================================================
// Validation Types
// =============================================================================

/** Warning produced by load-time validation (conditions, fragments, etc.) */
export interface SkillValidationWarning {
  stepId: string;
  message: string;
}

// =============================================================================
// 1. Runtime Input Validation
// =============================================================================

/**
 * Validate runtime parameters against a skill's declared inputs.
 *
 * - Required params that are missing → error
 * - Missing params with defaults → filled with coerced default
 * - Type coercion: number/integer/boolean/timestamp/duration/string
 * - Undeclared params (not in inputs) → warning
 * - If skill has no inputs declaration, params are passed through as-is
 */
export function validateSkillInputs(
  _skillId: string,
  inputs: SkillInput[] | undefined,
  params: Record<string, any>,
): ValidatedParams {
  // No inputs declared → pass through unchanged (backward compatible)
  if (!inputs || inputs.length === 0) {
    return { params: { ...params }, errors: [], warnings: [] };
  }

  const errors: SkillInputValidationError[] = [];
  const warnings: SkillInputValidationError[] = [];
  const validated: Record<string, any> = { ...params };
  const declaredNames = new Set(inputs.map(i => i.name));

  for (const input of inputs) {
    const { name, type, required } = input;
    let value = validated[name];

    // Missing value handling
    if (value === undefined || value === null) {
      if (input.default !== undefined) {
        value = coerceValue(name, input.default, type, errors);
        if (value !== undefined) {
          validated[name] = value;
        }
        continue;
      }
      if (required) {
        errors.push({
          paramName: name,
          message: `Required parameter missing`,
          severity: 'error',
        });
      }
      continue;
    }

    // Type coercion
    const coerced = coerceValue(name, value, type, errors);
    if (coerced !== undefined) {
      validated[name] = coerced;
    }
    // If coercion failed, the error was already pushed; keep original value
  }

  // Detect undeclared params
  for (const key of Object.keys(params)) {
    if (!declaredNames.has(key)) {
      warnings.push({
        paramName: key,
        message: `Undeclared parameter (not in skill inputs)`,
        severity: 'warning',
      });
    }
  }

  return { params: validated, errors, warnings };
}

/**
 * Coerce a value to the declared type. Returns the coerced value or undefined on failure.
 * On failure, pushes an error into the `errors` array.
 */
function coerceValue(
  name: string,
  value: any,
  type: SkillInput['type'],
  errors: SkillInputValidationError[],
): any {
  switch (type) {
    case 'number':
    case 'timestamp':
    case 'duration': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      if (isNaN(n)) {
        errors.push({
          paramName: name,
          message: `Expected ${type}, got non-numeric value: ${JSON.stringify(value)}`,
          severity: 'error',
        });
        return undefined;
      }
      return n;
    }

    case 'integer': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      const i = parseInt(String(value), 10);
      if (isNaN(i)) {
        errors.push({
          paramName: name,
          message: `Expected integer, got: ${JSON.stringify(value)}`,
          severity: 'error',
        });
        return undefined;
      }
      return i;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase().trim();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      errors.push({
        paramName: name,
        message: `Expected boolean, got: ${JSON.stringify(value)}`,
        severity: 'error',
      });
      return undefined;
    }

    case 'string': {
      if (typeof value === 'string') return value;
      // Soft coerce non-strings
      return String(value);
    }

    case 'array': {
      if (Array.isArray(value)) return value;
      errors.push({
        paramName: name,
        message: `Expected array, got ${typeof value}`,
        severity: 'error',
      });
      return undefined;
    }

    case 'object': {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      errors.push({
        paramName: name,
        message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`,
        severity: 'error',
      });
      return undefined;
    }

    default:
      // Unknown type, pass through
      return value;
  }
}

// =============================================================================
// 2. Load-time Condition Validation
// =============================================================================

/**
 * Parameters the runtime and tooling pass to every Skill without a
 * declaration: what a Skill's SQL and conditions may read undeclared.
 */
export const RUNTIME_SKILL_PARAMS: readonly string[] = ['package', 'vendor', 'start_ts', 'end_ts'];

/**
 * Implicit parameters always available in a condition's execution context:
 * the runtime parameters and the iterator context.
 */
const IMPLICIT_PARAMS: ReadonlySet<string> = new Set([
  ...RUNTIME_SKILL_PARAMS, 'item',
  // Iterator context variables
  'currentItem', 'currentItemIndex',
]);

/**
 * Names a condition may read without a declaration: contextual keywords, which
 * also act as keywords, and host names existing Skill packs read undeclared.
 * The evaluator still resolves both through the Skill scopes like any name.
 */
const UNCHECKED_CONDITION_NAMES: ReadonlySet<string> = new Set([...CONTEXTUAL_KEYWORDS, 'console', 'globalThis', 'window']);
/**
 * Only ASCII names are checked: without a parser, a local declaration reads
 * as a root, and existing packs may declare non-ASCII locals.
 */
const CHECKED_CONDITION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a root a Skill expression reads needs no declaration: a runtime
 * parameter, an exempt name, or a name validation does not check.
 */
export function isUncheckedConditionRoot(name: string): boolean {
  return !CHECKED_CONDITION_NAME.test(name) || UNCHECKED_CONDITION_NAMES.has(name) || IMPLICIT_PARAMS.has(name);
}

/** The names a Skill declares for its expressions to read: its inputs and context dependencies. */
export function declaredSkillNames(skill: SkillDefinition): Set<string> {
  return new Set([...(skill.inputs ?? []).map(input => input.name), ...(skill.context ?? [])]);
}

/**
 * Validate all condition expressions in a skill definition.
 *
 * For each step's `condition` field, extracts root variables and checks that
 * every variable resolves to one of:
 *   - A declared input parameter
 *   - An implicit runtime parameter (package, vendor, start_ts, etc.)
 *   - A context dependency (skill.context[])
 *   - A prior step ID (context.results[stepId])
 *   - A prior step's save_as variable
 *   - A language global or local name (not returned by extractRootVariables)
 *   - An unchecked name (UNCHECKED_CONDITION_NAMES, non-ASCII names)
 *
 * Also validates iterator step `source` references.
 */
export function validateSkillConditions(skill: SkillDefinition): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];

  // Build the set of known variable sources
  const declared = declaredSkillNames(skill);
  const declaredInputs = new Set((skill.inputs || []).map(i => i.name));
  const available = new Set<string>();

  // A step reads what the top-level steps before its own recorded, at any
  // depth: its condition runs in executeStep wherever the step sits.
  const nodes = stepNodesOf(skill);
  for (const top of stepNodesOf(skill, { topLevelOnly: true })) {
    for (const { node: step, name } of nodes.filter(node => node.topLevelIndex === top.topLevelIndex)) {
      if (typeof step.condition === 'string' && step.condition.trim()) {
        for (const v of extractRootVariables(step.condition)) {
          if (isUncheckedConditionRoot(v) || declared.has(v) || available.has(v)) continue;
          warnings.push({
            stepId: name,
            message: `Condition references unknown variable '${v}' in expression: ${step.condition}`,
          });
        }
      }

      // Validate iterator source reference
      if (step.type === 'iterator' && typeof step.source === 'string') {
        const src = step.source;
        if (!available.has(src) && !declaredInputs.has(src) && !IMPLICIT_PARAMS.has(src)) {
          warnings.push({
            stepId: name,
            message: `Iterator source '${src}' references undefined step or variable`,
          });
        }
      }
    }
    for (const name of recordedStepNames(top.node)) available.add(name);
  }

  return warnings;
}

/**
 * The names a top-level step makes readable to the steps after it once it ran
 * (the executor's recordStepResult): its id and save_as, and the ids (and
 * save_as) of a parallel step's own steps, which executeParallelStep records
 * as results too.
 */
export function recordedStepNames(step: any): string[] {
  const recorders = [step, ...(step?.type === 'parallel' ? stepNodesOf(step, { topLevelOnly: true }).map(({ node }) => node) : [])];
  return recorders.flatMap(recorder => [recorder.id, recorder.save_as])
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

// =============================================================================
// 3. Fragment Reference Validation
// =============================================================================

/**
 * Validate that all sql_fragments references in a skill definition
 * point to fragments that exist in the loaded fragment cache.
 */
export function validateFragmentReferences(
  skill: SkillDefinition,
  availableFragments: Set<string>,
): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];
  for (const {path, source} of executableSqlUnits(skill)) {
    for (const fragPath of source.sql_fragments || []) {
      if (!availableFragments.has(fragPath)) {
        warnings.push({ stepId: path, message: `SQL fragment '${fragPath}' not found in fragments directory` });
      }
    }
  }
  return warnings;
}

/**
 * The fragment that owns the only raw read of a source, the relation it
 * defines, and the names or types of the counter tracks that source reads.
 */
interface NormalizedReadOwner {
  fragment: string;
  relation: string;
  trackSelectors?: readonly string[];
}

/**
 * Stdlib relations whose raw values differ across trace-processor runtimes or
 * writers and must be read through one normalizing fragment.
 * android_gpu_frequency returns the gpufreq counter as written: kHz, Hz or MHz,
 * and selecting that track by name or type reads the same raw values.
 */
const NORMALIZED_STDLIB_READS: ReadonlyMap<string, NormalizedReadOwner> = new Map([
  ['android_input_events', {
    fragment: 'fragments/android_input_events_normalized.sql', relation: 'android_input_events_normalized',
  }],
  ['android_gpu_frequency', {
    fragment: 'fragments/gpu_frequency_intervals.sql', relation: 'gpu_frequency_intervals',
    trackSelectors: ['gpufreq', 'gpu_frequency'],
  }],
]);

/**
 * Reject a read of a normalized stdlib relation, or a selection of its track
 * by name or type, in Skill SQL or in a referenced fragment other than the
 * owning fragment. The check follows the SQL structure
 * (normalizedSourceReads.ts): a wrapped or aliased column (LOWER(t.name),
 * track_name) and an exact comparison in a conditional aggregate select as
 * surely as a bare filter, while an exclusion (!=, NOT IN) or a CASE label
 * does not. Its accepted limits are listed there.
 */
export function validateNormalizedStdlibReads(
  skill: SkillDefinition,
  fragments: ReadonlyMap<string, string> = new Map(),
): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];
  const check = (sql: string, path: string, where: string, exemptFragment?: string): void => {
    const reads = sqlReads(sql);
    for (const [source, owner] of NORMALIZED_STDLIB_READS) {
      if (owner.fragment === exemptFragment) continue;
      if (reads.readsRelation(source)) {
        warnings.push({ stepId: path, message: `${where} reads ${source} directly; read ${owner.relation} via sql_fragments: [${owner.fragment}]` });
      }
      const selector = owner.trackSelectors?.find(value => reads.selectsTrack(value));
      if (selector) {
        warnings.push({ stepId: path, message: `${where} selects the ${selector} counter track directly; read ${owner.relation} via sql_fragments: [${owner.fragment}]` });
      }
    }
  };
  for (const {path, source} of executableSqlUnits(skill)) {
    if (typeof source.sql === 'string') check(source.sql, path, 'SQL');
    for (const fragPath of source.sql_fragments || []) {
      const body = fragments.get(fragPath);
      if (body !== undefined) check(body, path, `Fragment '${fragPath}'`, fragPath);
    }
  }
  return warnings;
}

/** Validate declarations without requiring unmigrated named Skills to opt in. */
export function validateProcessScopeDeclarations(
  skill: SkillDefinition,
  fragments: ReadonlyMap<string, string>,
): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];
  for (const {path, source} of executableSqlUnits(skill)) {
    const reason = source.process_scope ? sqlScopeDeclarationError(source, fragments) : undefined;
    if (reason) warnings.push({ stepId: path, message: reason });
  }
  for (const {node, name} of [{node: skill as any, name: 'root'}, ...stepNodesOf(skill)]) {
    if ([...(node.inputs || []).map((input: SkillInput) => input.name), node.save_as]
      .some(binding => typeof binding === 'string' && binding.startsWith('__process_scope'))) {
      warnings.push({ stepId: name, message: '__process_scope is reserved for trusted execution bindings' });
    }
  }
  return warnings;
}

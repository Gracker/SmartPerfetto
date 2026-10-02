// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  formatDisplayContractIssue,
  validateSkillDisplayContract,
} from '../skillEngine/displayContractValidator';
import {validateSkillBatchAnalysis} from '../skillEngine/skillBatchAnalysis';
import {
  declaredSkillNames,
  isUncheckedConditionRoot,
  validateFragmentReferences,
  validateNormalizedStdlibReads,
  validateSkillConditions,
} from '../skillEngine/skillValidator';
import {parseEvidenceField, rootReads, templateRootReads, type RootReads} from '../skillEngine/expressionUtils';
import {UNKNOWN_TOP_LEVEL_KEY_MESSAGE, unknownSkillTopLevelKeys} from '../skillEngine/skillTopLevelKeys';
import {undecidedResultPathReads} from '../skillEngine/resultPathReads';
import type {SkillDefinition, SkillStep} from '../skillEngine/types';
import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
} from '../sqlGuardrailAnalyzer';
import type {StrategyDefinition} from '../../agentv3/strategyLoader';
import {
  checkStrategySkillCalls,
  extractStrategySkillCalls,
  formatUndeclaredStrategySkillParams,
  strategySkillCallTexts,
  type StrategySkillInputs,
} from '../../agentv3/strategySkillCalls';
import {isDiagnosticConfidence, validateSkillStepListRuntime} from './skillStepRuntimeValidator';

export const IN_PROCESS_VALIDATOR_VERSION = '6';

export type InProcessValidationSeverity = 'error' | 'warning';

export interface InProcessValidationIssue {
  severity: InProcessValidationSeverity;
  code: string;
  skillId: string;
  path: string;
  message: string;
}

export interface InProcessSkillValidationResult {
  validatorVersion: string;
  affectedSkillIds: string[];
  valid: boolean;
  issues: InProcessValidationIssue[];
}

export interface ValidateSkillDefinitionsInProcessInput {
  definitions: readonly SkillDefinition[];
  affectedSkillIds?: readonly string[];
  fragmentCache?: ReadonlyMap<string, string>;
  knownSkillIds?: ReadonlySet<string>;
  validateReferences?: boolean;
  sqlGuardrailMode?: 'default' | 'disabled';
  /**
   * Severity of `result_path_read_undecided` (default error). Runtime
   * composition and a proposal's view of Skills it does not change pass
   * 'warning': the rule is a public-runtime portability check, this runtime's
   * own behaviour for the read is defined, and one published overlay that
   * predates it would otherwise take every overlay of the scope offline.
   */
  resultPathReadSeverity?: InProcessValidationSeverity;
}

export interface InProcessStrategyValidationResult {
  validatorVersion: string;
  affectedScenes: string[];
  valid: boolean;
  issues: Array<{
    severity: InProcessValidationSeverity;
    code: string;
    scene: string;
    path: string;
    message: string;
  }>;
}

function issue(
  severity: InProcessValidationSeverity,
  code: string,
  skillId: string,
  path: string,
  message: string,
): InProcessValidationIssue {
  return {severity, code, skillId, path, message};
}

function visitSteps(
  steps: readonly SkillStep[],
  callback: (step: SkillStep, path: string) => void,
  prefix = 'steps',
): void {
  steps.forEach((step, index) => {
    const path = `${prefix}[${index}]`;
    callback(step, path);
    if (step.type === 'parallel') {
      visitSteps(step.steps, callback, `${path}.steps`);
    }
    if (step.type === 'conditional') {
      step.conditions.forEach((condition, conditionIndex) => {
        if (typeof condition.then !== 'string') {
          visitSteps(
            [condition.then],
            callback,
            `${path}.conditions[${conditionIndex}].then`,
          );
        }
      });
      if (step.else && typeof step.else !== 'string') {
        visitSteps([step.else], callback, `${path}.else`);
      }
    }
  });
}

function validateDefinitionShape(
  skill: SkillDefinition,
  includeSqlGuardrails: boolean,
): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  if (!skill.name.trim()) {
    issues.push(issue(
      'error',
      'skill_name_missing',
      skill.name,
      'name',
      'Skill name must be a non-empty string.',
    ));
  }
  if (!skill.version?.trim()) {
    issues.push(issue(
      'error',
      'skill_version_missing',
      skill.name,
      'version',
      'Skill version must be a non-empty string.',
    ));
  }
  const hasSteps = Array.isArray(skill.steps) && skill.steps.length > 0;
  const hasRootSql = typeof skill.sql === 'string' && skill.sql.trim().length > 0;
  if (skill.type === 'atomic' && !hasRootSql && !hasSteps) {
    issues.push(issue(
      'error',
      'atomic_execution_missing',
      skill.name,
      'sql',
      'Atomic Skill must define root SQL or at least one step.',
    ));
  }
  if (
    skill.type !== 'atomic'
    && skill.type !== 'comparison'
    && skill.type !== 'pipeline_definition'
    && !hasSteps
  ) {
    issues.push(issue(
      'error',
      'skill_steps_missing',
      skill.name,
      'steps',
      `Skill type '${skill.type}' must define at least one step.`,
    ));
  }

  const stepIds = new Set<string>();
  const stepContractIssues = hasSteps
    ? validateSkillStepListRuntime(skill.steps, 'steps')
    : [];
  issues.push(...stepContractIssues.map(stepIssue => issue(
    'error',
    stepIssue.code,
    skill.name,
    stepIssue.path,
    stepIssue.message,
  )));
  if (stepContractIssues.length === 0) {
    visitSteps(skill.steps ?? [], (step, path) => {
    if (!step.id?.trim()) {
      issues.push(issue(
        'error',
        'step_id_missing',
        skill.name,
        `${path}.id`,
        'Step id must be a non-empty string.',
      ));
    } else if (stepIds.has(step.id)) {
      issues.push(issue(
        'error',
        'step_id_duplicate',
        skill.name,
        `${path}.id`,
        `Duplicate step id '${step.id}'.`,
      ));
    } else {
      stepIds.add(step.id);
    }
    const sql = 'sql' in step ? step.sql : undefined;
    if (includeSqlGuardrails && typeof sql === 'string') {
      for (const guardrail of analyzeSqlGuardrails(sql, {
        includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
      })) {
        issues.push(issue(
          guardrail.ruleId === 'percentile-percent-scale' ? 'error' : 'warning',
          `sql_guardrail_${guardrail.ruleId}`,
          skill.name,
          `${path}.sql`,
          guardrail.message,
        ));
      }
    }
    });
    // Expressions resolve a save_as binding before a step result of the same
    // name, so another step's id reused as a save_as would never be readable.
    // A separate pass: the colliding id may belong to a later step.
    visitSteps(skill.steps ?? [], (step, path) => {
      const saveAs = 'save_as' in step ? step.save_as : undefined;
      if (typeof saveAs === 'string' && saveAs !== step.id && stepIds.has(saveAs)) {
        issues.push(issue(
          'error',
          'save_as_step_id_collision',
          skill.name,
          `${path}.save_as`,
          `save_as '${saveAs}' is the id of another step; name the binding after its own step or choose a distinct name.`,
        ));
      }
    });
  }
  if (includeSqlGuardrails && hasRootSql) {
    for (const guardrail of analyzeSqlGuardrails(skill.sql!, {
      includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
    })) {
      issues.push(issue(
        guardrail.ruleId === 'percentile-percent-scale' ? 'error' : 'warning',
        `sql_guardrail_${guardrail.ruleId}`,
        skill.name,
        'sql',
        guardrail.message,
      ));
    }
  }
  return issues;
}

export function validateSkillDefinitionInProcess(
  skill: SkillDefinition,
  options: {
    fragmentCache?: ReadonlyMap<string, string>;
    includeStructuralChecks?: boolean;
    sqlGuardrailMode?: 'default' | 'disabled';
    /** The complete registry by name; when present, `save_from` targets are checked against it. */
    definitions?: ReadonlyMap<string, SkillDefinition>;
    resultPathReadSeverity?: InProcessValidationSeverity;
  } = {},
): InProcessValidationIssue[] {
  const issues = options.includeStructuralChecks === false
    ? []
    : validateDefinitionShape(
        skill,
        options.sqlGuardrailMode !== 'disabled',
      );
  for (const key of unknownSkillTopLevelKeys(skill)) {
    issues.push(issue('error', 'skill_top_level_key_unknown', skill.name, key, UNKNOWN_TOP_LEVEL_KEY_MESSAGE));
  }
  for (const warning of validateSkillConditions(skill)) {
    issues.push(issue(
      'warning',
      'condition_reference',
      skill.name,
      warning.stepId,
      warning.message,
    ));
  }
  for (const batchIssue of validateSkillBatchAnalysis(skill)) {
    issues.push(issue(
      'error',
      'batch_analysis_contract',
      skill.name,
      batchIssue.path,
      batchIssue.message,
    ));
  }
  for (const displayIssue of validateSkillDisplayContract(skill)) {
    issues.push(issue(
      'error',
      'display_contract',
      skill.name,
      displayIssue.path,
      formatDisplayContractIssue(displayIssue),
    ));
  }
  for (const readIssue of validateNormalizedStdlibReads(skill, options.fragmentCache)) {
    issues.push(issue(
      'error',
      'normalized_stdlib_read',
      skill.name,
      readIssue.stepId,
      readIssue.message,
    ));
  }
  issues.push(...validateDiagnosticConfidence(skill));
  issues.push(...validateDiagnosticReads(skill));
  // A saved-result path read without a default runs on '' / NULL here but is
  // skipped by the public runtime when the result has no row (resultPathReads.ts).
  for (const read of undecidedResultPathReads(skill)) {
    issues.push(issue(options.resultPathReadSeverity ?? 'error', 'result_path_read_undecided', skill.name, read.path,
      `${read.placeholder} reads an earlier step's result without a default: write \`|default\` (the step runs `
      + 'without its row) or give the step a condition with the conjunct `<result>.data?.length > 0` (it does not).'));
  }
  issues.push(...validateSaveFromPlacement(skill));
  if (options.definitions) issues.push(...validateSaveFromTargets(skill, options.definitions));
  if (options.fragmentCache) {
    for (const warning of validateFragmentReferences(
      skill,
      new Set(options.fragmentCache.keys()),
    )) {
      issues.push(issue(
        'error',
        'fragment_reference_missing',
        skill.name,
        warning.stepId,
        warning.message,
      ));
    }
  }
  return issues;
}

/**
 * A diagnostic rule's confidence must be a literal level or number even when
 * structural checks are off: the executor maps anything else to 0.5 and the
 * public runtime would publish the text, so a template there silently misreports.
 */
function validateDiagnosticConfidence(skill: SkillDefinition): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  visitSteps(skill.steps ?? [], (step, path) => {
    if (step.type !== 'diagnostic') return;
    (step.rules ?? []).forEach((rule, index) => {
      if (rule.confidence !== undefined && !isDiagnosticConfidence(rule.confidence)) {
        issues.push(issue('error', 'diagnostic_confidence_invalid', skill.name, `${path}.rules[${index}].confidence`,
          `Diagnostic rule confidence must be high, medium, low or a number, got ${JSON.stringify(rule.confidence)}.`));
      }
    });
  });
  return issues;
}

/**
 * A diagnostic step's `inputs` are the step data its rules read: they are what
 * the step reports as `data.inputs` and the only names an evidence field may
 * cite. Skill parameters stay readable (thresholds) but are not evidence.
 *
 * An evidence field must parse as the read-only grammar the executor reads
 * (parseEvidenceField), rooted at an input. For a condition and `${...}`
 * placeholders this is a lint over arbitrary JS: it finds step data the rule
 * reads without declaring it, and, outside placeholders (where `${rows[0].x}`
 * is a valid simple path), JS access to step data other than through `.data`,
 * which is always undefined. Arrow parameters bind inside their callback only.
 *
 * Any other root a rule reads must be a Skill input, a context dependency or
 * a runtime parameter: no scope binds anything else, so it is always
 * undefined (`inputs?.threshold_ms` once silently ignored every caller's
 * threshold). Every check here judges root names, so it runs only on exact
 * reads: where a local could share a step's name, a guess is no finding.
 */
function validateDiagnosticReads(skill: SkillDefinition): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  const skillNames = declaredSkillNames(skill);
  const stepData = new Set<string>();
  visitSteps(skill.steps ?? [], step => {
    if (typeof step.id === 'string') stepData.add(step.id);
    const saveAs = 'save_as' in step ? step.save_as : undefined;
    if (typeof saveAs === 'string') stepData.add(saveAs);
  });
  visitSteps(skill.steps ?? [], (step, path) => {
    if (step.type !== 'diagnostic') return;
    const report = (code: string, fieldPath: string, message: string) =>
      issues.push(issue('error', code, skill.name, fieldPath, message));
    if (!Array.isArray(step.inputs) || !step.inputs.every(name => typeof name === 'string')) {
      report('diagnostic_inputs_missing', `${path}.inputs`,
        'A diagnostic step must declare inputs as a list of step names (it may be empty).');
    }
    const inputs = new Set(Array.isArray(step.inputs) ? step.inputs : []);
    const reportUndeclared = (names: string[], fieldPath: string) => {
      const undeclared = names.filter(name => stepData.has(name) && !inputs.has(name));
      if (undeclared.length > 0) {
        report('diagnostic_input_undeclared', fieldPath,
          `Reads step data ${undeclared.map(name => `'${name}'`).join(', ')} not listed in this diagnostic step's inputs.`);
      }
    };
    const checkReads = ({reads, exact}: RootReads, fieldPath: string, {accessChecked = false} = {}) => {
      if (!exact) return;
      const names = [...new Set(reads.map(read => read.name))];
      reportUndeclared(names, fieldPath);
      const unknown = names.filter(name => !stepData.has(name) && !skillNames.has(name) && !isUncheckedConditionRoot(name));
      if (unknown.length > 0) {
        report('diagnostic_root_unknown', fieldPath,
          `Reads ${unknown.map(name => `'${name}'`).join(', ')}, which is no Skill input, step, context dependency or `
          + 'runtime parameter, so it is always undefined.');
      }
      const misread = accessChecked && reads.find(read =>
        stepData.has(read.name) && read.access !== undefined && read.access !== 'data');
      if (misread) {
        report('diagnostic_step_data_shape', fieldPath,
          `Step data '${misread.name}' is read as '${misread.name}.data...'; any other access is always undefined.`);
      }
    };
    (step.rules ?? []).forEach((rule, index) => {
      const rulePath = `${path}.rules[${index}]`;
      if (typeof rule.condition === 'string') {
        checkReads(rootReads(rule.condition), `${rulePath}.condition`, {accessChecked: true});
      }
      (rule.evidence_fields ?? []).forEach((field, fieldIndex) => {
        const fieldPath = `${rulePath}.evidence_fields[${fieldIndex}]`;
        const parsed = typeof field === 'string' ? parseEvidenceField(field) : undefined;
        if (!parsed) {
          report('diagnostic_evidence_field_shape', fieldPath,
            'An evidence field is `input.data` followed by `.column`, `[n]`, `.length` or '
            + '`.find(r => r.column OP literal)` / `.filter(...)`, each optionally `?.`.');
        } else if (stepData.has(parsed.root)) {
          reportUndeclared([parsed.root], fieldPath);
        } else if (!inputs.has(parsed.root)) {
          report('diagnostic_evidence_field_root', fieldPath,
            `An evidence field cites this step's inputs only; '${parsed.root}' is not one.`);
        }
      });
      const templates = [rule.diagnosis, ...(rule.suggestions ?? [])];
      templates.forEach((template, templateIndex) => {
        if (typeof template !== 'string') return;
        checkReads(templateRootReads(template),
          `${rulePath}.${templateIndex === 0 ? 'diagnosis' : `suggestions[${templateIndex - 1}]`}`);
      });
    });
  });
  return issues;
}

/**
 * `save_from` is bound only by the top-level step loops of the executor, so a
 * nested one would pass validation and never bind.
 */
function validateSaveFromPlacement(skill: SkillDefinition): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  const topLevel = new Set<SkillStep>(skill.steps ?? []);
  visitSteps(skill.steps ?? [], (step, path) => {
    const problem = saveFromPlacementProblem(step, topLevel.has(step));
    if (problem) {
      issues.push(issue('error', 'save_from_invalid', skill.name, `${path}.save_from`, `save_from ${problem}.`));
    }
  });
  return issues;
}

function saveFromPlacementProblem(step: SkillStep, topLevel: boolean): string | undefined {
  const saveFrom = (step as {save_from?: unknown}).save_from;
  if (saveFrom === undefined) return undefined;
  if (typeof saveFrom !== 'string' || saveFrom.trim() === '') return 'must name a step of the referenced Skill';
  if (!('skill' in step) || typeof step.skill !== 'string') return 'is valid only on a Skill reference step';
  if (!step.save_as) return 'requires save_as';
  if (!topLevel) return 'is honoured only on a top-level step';
  return undefined;
}

/** Top-level Skill references that bind a named child step, by position. */
function saveFromBindings(skill: SkillDefinition): Array<{index: number; target: string; stepId: string}> {
  return (skill.steps ?? []).flatMap((step, index) =>
    'skill' in step && typeof step.skill === 'string' && typeof step.save_from === 'string' && step.save_from.trim()
      ? [{index, target: step.skill, stepId: step.save_from}]
      : []);
}

/**
 * A top-level Skill reference's `save_from` must name a top-level step of the
 * referenced Skill: those are the only child results the executor can bind.
 * `definitions` is the complete registry, so a target outside it is missing.
 */
function validateSaveFromTargets(
  skill: SkillDefinition,
  definitions: ReadonlyMap<string, SkillDefinition>,
): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  for (const {index, target: targetId, stepId} of saveFromBindings(skill)) {
    const target = definitions.get(targetId);
    if (!target) {
      issues.push(issue(
        'error',
        'save_from_target_missing',
        skill.name,
        `steps[${index}].save_from`,
        `Referenced Skill '${targetId}' does not exist, so save_from '${stepId}' cannot bind.`,
      ));
    } else if (!(target.steps ?? []).some(childStep => childStep.id === stepId)) {
      issues.push(issue(
        'error',
        'save_from_step_missing',
        skill.name,
        `steps[${index}].save_from`,
        `Referenced Skill '${targetId}' has no top-level step '${stepId}'.`,
      ));
    }
  }
  return issues;
}

function validateSkillReferences(
  skill: SkillDefinition,
  knownSkillIds: ReadonlySet<string>,
): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  visitSteps(skill.steps ?? [], (step, path) => {
    const target = 'skill' in step && typeof step.skill === 'string'
      ? step.skill
      : step.type === 'iterator'
        ? step.item_skill
        : undefined;
    if (target && !knownSkillIds.has(target)) {
      issues.push(issue(
        'error',
        'skill_reference_missing',
        skill.name,
        path,
        `Referenced Skill '${target}' is not present in the effective registry.`,
      ));
    }
  });
  return issues;
}

export function validateSkillDefinitionsInProcess(
  input: ValidateSkillDefinitionsInProcessInput,
): InProcessSkillValidationResult {
  const byId = new Map<string, SkillDefinition>();
  const issues: InProcessValidationIssue[] = [];
  for (const definition of input.definitions) {
    if (byId.has(definition.name)) {
      issues.push(issue(
        'error',
        'skill_id_duplicate',
        definition.name,
        'name',
        `Duplicate Skill id '${definition.name}'.`,
      ));
    } else {
      byId.set(definition.name, definition);
    }
  }
  const selectedIds = input.affectedSkillIds
    ? [...new Set(input.affectedSkillIds)].sort()
    : [...byId.keys()].sort();
  const knownSkillIds = input.knownSkillIds ?? new Set(byId.keys());
  for (const skillId of selectedIds) {
    const definition = byId.get(skillId);
    if (!definition) {
      issues.push(issue(
        'error',
        'affected_skill_missing',
        skillId,
        'name',
        `Affected Skill '${skillId}' is not present in the effective registry.`,
      ));
      continue;
    }
    issues.push(...validateSkillDefinitionInProcess(definition, {
      fragmentCache: input.fragmentCache,
      sqlGuardrailMode: input.sqlGuardrailMode,
      definitions: input.validateReferences !== false ? byId : undefined,
      resultPathReadSeverity: input.resultPathReadSeverity,
    }));
    if (input.validateReferences !== false) {
      issues.push(...validateSkillReferences(definition, knownSkillIds));
    }
  }
  if (input.validateReferences !== false) {
    // save_from makes a child's step ids part of its parents' contract, so a
    // change to an affected Skill re-checks the unchanged parents binding it.
    const selected = new Set(selectedIds);
    for (const parent of byId.values()) {
      if (!selected.has(parent.name) && saveFromBindings(parent).some(binding => selected.has(binding.target))) {
        issues.push(...validateSaveFromTargets(parent, byId));
      }
    }
  }
  return {
    validatorVersion: IN_PROCESS_VALIDATOR_VERSION,
    affectedSkillIds: selectedIds,
    valid: issues.every(entry => entry.severity !== 'error'),
    issues,
  };
}

export function validateStrategyDefinitionsInProcess(input: {
  definitions: readonly StrategyDefinition[];
  affectedScenes?: readonly string[];
  skills: ReadonlyMap<string, StrategySkillInputs>;
  /**
   * The proposal gate rejects an undeclared example key; reconciling an
   * already-published overlay only warns, because `invoke_skill` still admits
   * identity aliases after verified resolution and the overlay predates the rule.
   */
  undeclaredSkillParamSeverity: InProcessValidationSeverity;
  knownScenes?: ReadonlySet<string>;
}): InProcessStrategyValidationResult {
  const byScene = new Map(
    input.definitions.map(definition => [definition.scene, definition]),
  );
  const affectedScenes = input.affectedScenes
    ? [...new Set(input.affectedScenes)].sort()
    : [...byScene.keys()].sort();
  const knownScenes = input.knownScenes ?? new Set(
    input.definitions
      .filter(definition => definition.strategyKind !== 'contract_only')
      .map(definition => definition.scene),
  );
  const issues: InProcessStrategyValidationResult['issues'] = [];
  for (const scene of affectedScenes) {
    const definition = byScene.get(scene);
    if (!definition) {
      issues.push({
        severity: 'error',
        code: 'affected_strategy_missing',
        scene,
        path: 'scene',
        message: `Affected strategy '${scene}' is not present in the registry.`,
      });
      continue;
    }
    const missing = new Set<string>();
    for (const [path, content] of strategySkillCallTexts(definition)) {
      for (const finding of checkStrategySkillCalls(
        extractStrategySkillCalls(content),
        input.skills,
      )) {
        if (finding.kind === 'skill_missing') {
          missing.add(finding.call.skillId);
          continue;
        }
        issues.push({
          severity: input.undeclaredSkillParamSeverity,
          code: 'strategy_skill_param_undeclared',
          scene,
          path,
          message: formatUndeclaredStrategySkillParams(finding),
        });
      }
    }
    for (const skillId of [...missing].sort()) {
      issues.push({
        severity: 'error',
        code: 'strategy_skill_reference_missing',
        scene,
        path: 'content',
        message:
          `invoke_skill("${skillId}") is not present in the effective Skill registry.`,
      });
    }
    for (const pattern of definition.verifierMisdiagnosisPatterns) {
      for (const referencedScene of pattern.scenes) {
        if (!knownScenes.has(referencedScene)) {
          issues.push({
            severity: 'error',
            code: 'strategy_scene_reference_missing',
            scene,
            path: `verifierMisdiagnosisPatterns.${pattern.id}.scenes`,
            message:
              `Referenced scene '${referencedScene}' is not present in the effective Strategy registry.`,
          });
        }
      }
    }
  }
  return {
    validatorVersion: IN_PROCESS_VALIDATOR_VERSION,
    affectedScenes,
    valid: issues.every(entry => entry.severity !== 'error'),
    issues,
  };
}

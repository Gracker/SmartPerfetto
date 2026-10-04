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
import {skillExecution, stepNodesOf, stepSkillReferences} from '../skillEngine/skillSteps';
import {executableSqlUnits} from '../skillEngine/processScopeSql';
import {undecidedResultPathReads} from '../skillEngine/resultPathReads';
import {causeWordingReaders, unsupportedCauseWording, type CauseWordingReaders} from '../skillEngine/causeWordingEvidence';
import type {DiagnosticStep, SkillDefinition, SkillStep} from '../skillEngine/types';
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
import {validateScopedSqlDeclarations, validateSkillStepListRuntime, type SkillStepRuntimeIssue} from './skillStepRuntimeValidator';

export const IN_PROCESS_VALIDATOR_VERSION = '9';

/**
 * Rules that already-published overlays and packs may predate. Each is an
 * error for the Skills a proposal defines or changes and in validate:skills,
 * and a warning everywhere else (`predatingRuleSeverity`): one predating
 * overlay must not take every overlay of its scope offline.
 * - result_path_read_undecided: a public-runtime portability check; this
 *   runtime's own behaviour for the read is defined (resultPathReads.ts).
 * - cause_wording_without_evidence: heat or frequency-cap wording in a text
 *   the Skill shows with no evidence read behind it (causeWordingEvidence.ts).
 * - process_scope_invalid: a malformed process_scope declaration; the runtime
 *   only reports exact scope unsupported for it (processScopeSql.ts), and a
 *   Skill root's declaration was not checked before validator version 8.
 * - sql_not_executed: SQL the executor never runs (skillSteps.skillExecution),
 *   which no SQL check reads; it does nothing at runtime, and it was accepted
 *   before validator version 9.
 */
export const PREDATING_RULE_CODES: ReadonlySet<string> = new Set([
  'result_path_read_undecided',
  'cause_wording_without_evidence',
  'process_scope_invalid',
  'sql_not_executed',
]);

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
   * Severity of the PREDATING_RULE_CODES (default error). Runtime composition
   * and a proposal's view of Skills it does not change pass 'warning'.
   */
  predatingRuleSeverity?: InProcessValidationSeverity;
  /** Evidence readers across `definitions`, when the caller validates the same registry more than once. */
  causeWordingReaders?: CauseWordingReaders;
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

const readersByRegistry = new WeakMap<ReadonlyMap<string, SkillDefinition>, CauseWordingReaders>();

/**
 * Evidence readers across the registry `skill` is validated in, computed once
 * per registry; without one, only `skill` itself is known.
 */
function registryCauseWordingReaders(
  skill: SkillDefinition,
  definitions: ReadonlyMap<string, SkillDefinition> | undefined,
): CauseWordingReaders {
  if (!definitions) return causeWordingReaders([skill]);
  let readers = readersByRegistry.get(definitions);
  if (!readers) {
    readers = causeWordingReaders([...definitions.values()]);
    readersByRegistry.set(definitions, readers);
  }
  return readers;
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

  // SQL the executor never runs is in no SQL unit (executableSqlUnits), so no SQL check reads it.
  const execution = skillExecution(skill);
  const root = skill as unknown as Record<string, unknown>;
  if (execution !== 'root' && ['sql', 'sql_fragments', 'exact_sql'].some(key => root[key] !== undefined)) {
    issues.push(issue(
      'error',
      'sql_not_executed',
      skill.name,
      'sql',
      `A Skill of type '${String(skill.type)}' never runs root SQL; only an atomic Skill with root sql does.`,
    ));
  }
  if (execution !== 'steps' && hasSteps) {
    issues.push(issue(
      'error',
      'sql_not_executed',
      skill.name,
      'steps',
      execution === 'root'
        ? 'An atomic Skill with root sql never runs its steps.'
        : `A Skill of type '${String(skill.type)}' runs no steps.`,
    ));
  }

  const stepIds = new Set<string>();
  const rootIssues: SkillStepRuntimeIssue[] = [];
  validateScopedSqlDeclarations(root, '', rootIssues);
  const stepContractIssues = [
    ...rootIssues,
    ...(hasSteps ? validateSkillStepListRuntime(skill.steps, 'steps') : []),
  ];
  issues.push(...stepContractIssues.map(stepIssue => issue(
    'error',
    stepIssue.code,
    skill.name,
    stepIssue.path,
    stepIssue.message,
  )));
  // A malformed process_scope only leaves exact scope unsupported; the step itself is checked on.
  if (stepContractIssues.every(entry => entry.code === 'process_scope_invalid')) {
    for (const {node: step, at: path} of stepNodesOf(skill)) {
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
    }
    // Expressions resolve a save_as binding before a step result of the same
    // name, so another step's id reused as a save_as would never be readable.
    // A separate pass: the colliding id may belong to a later step.
    for (const {node: step, at: path} of stepNodesOf(skill)) {
      const saveAs = step.save_as;
      if (typeof saveAs === 'string' && saveAs !== step.id && stepIds.has(saveAs)) {
        issues.push(issue(
          'error',
          'save_as_step_id_collision',
          skill.name,
          `${path}.save_as`,
          `save_as '${saveAs}' is the id of another step; name the binding after its own step or choose a distinct name.`,
        ));
      }
    }
  }
  // Every SQL the executor runs, named and exact (executableSqlUnits).
  for (const unit of includeSqlGuardrails ? executableSqlUnits(skill) : []) {
    if (typeof unit.source.sql !== 'string') continue;
    for (const guardrail of analyzeSqlGuardrails(unit.source.sql, {
      includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
    })) {
      issues.push(issue(
        guardrail.ruleId === 'percentile-percent-scale' ? 'error' : 'warning',
        `sql_guardrail_${guardrail.ruleId}`,
        skill.name,
        unit.sqlAt,
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
    sqlGuardrailMode?: 'default' | 'disabled';
    /** The complete registry by name; when present, `save_from` targets are checked against it. */
    definitions?: ReadonlyMap<string, SkillDefinition>;
    predatingRuleSeverity?: InProcessValidationSeverity;
    /** Skills that read heat or cap evidence across the registry; derived from `definitions` when absent. */
    causeWordingReaders?: CauseWordingReaders;
  } = {},
): InProcessValidationIssue[] {
  const issues = validateDefinitionShape(skill, options.sqlGuardrailMode !== 'disabled');
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
  issues.push(...validateDiagnosticReads(skill));
  // A saved-result path read without a default runs on '' / NULL here but is
  // skipped by the public runtime when the result has no row (resultPathReads.ts).
  for (const read of undecidedResultPathReads(skill)) {
    issues.push(issue('error', 'result_path_read_undecided', skill.name, read.path,
      `${read.placeholder} reads an earlier step's result without a default: write \`|default\` (the step runs `
      + 'without its row) or give the step a condition with the conjunct `<result>.data?.length > 0` (it does not).'));
  }
  // Heat or frequency-cap wording reads as a conclusion in either language;
  // only evidence the Skill reads may support it (causeWordingEvidence.ts).
  const readers = options.causeWordingReaders ?? registryCauseWordingReaders(skill, options.definitions);
  for (const site of unsupportedCauseWording(skill, readers)) {
    const quoted = site.text.length > 80 ? `${site.text.slice(0, 80)}…` : site.text;
    issues.push(issue('error', 'cause_wording_without_evidence', skill.name,
      `${site.stepId ? `steps.${site.stepId}` : 'skill'}.${site.field}`,
      `"${quoted}" names ${site.rule.cause} as a cause, but the ${site.stepId ? 'step' : 'Skill'} reads no `
      + `${site.rule.evidence}: state the observation, leave the cause undetermined (是否…以…证据为准, 未判定), `
      + 'or read the evidence.'));
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
  // A rule published overlays may predate is graded once, here, wherever it was found.
  const predatingSeverity = options.predatingRuleSeverity ?? 'error';
  return issues.map(entry => PREDATING_RULE_CODES.has(entry.code) ? {...entry, severity: predatingSeverity} : entry);
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
  const steps = stepNodesOf(skill);
  for (const {node: step} of steps) {
    if (typeof step.id === 'string') stepData.add(step.id);
    if (typeof step.save_as === 'string') stepData.add(step.save_as);
  }
  for (const {node, at: path} of steps) {
    if (node.type !== 'diagnostic') continue;
    const step = node as DiagnosticStep;
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
  }
  return issues;
}

/**
 * `save_from` is bound only by the top-level step loops of the executor, so a
 * nested one would pass validation and never bind.
 */
function validateSaveFromPlacement(skill: SkillDefinition): InProcessValidationIssue[] {
  const issues: InProcessValidationIssue[] = [];
  const topLevel = new Set(stepNodesOf(skill, {topLevelOnly: true}).map(({node}) => node));
  for (const {node: step, at: path} of stepNodesOf(skill)) {
    const problem = saveFromPlacementProblem(step, topLevel.has(step));
    if (problem) {
      issues.push(issue('error', 'save_from_invalid', skill.name, `${path}.save_from`, `save_from ${problem}.`));
    }
  }
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
  for (const {skillId: target, at} of stepSkillReferences(skill)) {
    if (!knownSkillIds.has(target)) {
      issues.push(issue(
        'error',
        'skill_reference_missing',
        skill.name,
        at,
        `Referenced Skill '${target}' is not present in the effective registry.`,
      ));
    }
  }
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
  const readers = input.causeWordingReaders ?? causeWordingReaders([...byId.values()]);
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
      predatingRuleSeverity: input.predatingRuleSeverity,
      causeWordingReaders: readers,
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

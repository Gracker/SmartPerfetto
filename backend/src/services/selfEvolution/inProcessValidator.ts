// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  formatDisplayContractIssue,
  validateSkillDisplayContract,
} from '../skillEngine/displayContractValidator';
import {validateSkillBatchAnalysis} from '../skillEngine/skillBatchAnalysis';
import {
  validateFragmentReferences,
  validateSkillConditions,
} from '../skillEngine/skillValidator';
import type {SkillDefinition, SkillStep} from '../skillEngine/types';
import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
} from '../sqlGuardrailAnalyzer';
import type {StrategyDefinition} from '../../agentv3/strategyLoader';
import {validateSkillStepListRuntime} from './skillStepRuntimeValidator';

export const IN_PROCESS_VALIDATOR_VERSION = '1';

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
}

export interface InProcessStrategyValidationResult {
  validatorVersion: string;
  affectedScenes: string[];
  valid: boolean;
  issues: Array<{
    severity: 'error';
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
  } = {},
): InProcessValidationIssue[] {
  const issues = options.includeStructuralChecks === false
    ? []
    : validateDefinitionShape(
        skill,
        options.sqlGuardrailMode !== 'disabled',
      );
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
    }));
    if (input.validateReferences !== false) {
      issues.push(...validateSkillReferences(definition, knownSkillIds));
    }
  }
  return {
    validatorVersion: IN_PROCESS_VALIDATOR_VERSION,
    affectedSkillIds: selectedIds,
    valid: issues.every(entry => entry.severity !== 'error'),
    issues,
  };
}

export function extractReferencedSkillIdsFromStrategyText(
  content: string,
): Set<string> {
  const referenced = new Set<string>();
  const invokeSkillPattern = /invoke_skill\(\"([^\"]+)\"/g;
  let match: RegExpExecArray | null;
  while ((match = invokeSkillPattern.exec(content)) !== null) {
    referenced.add(match[1]);
  }
  return referenced;
}

export function validateStrategyDefinitionsInProcess(input: {
  definitions: readonly StrategyDefinition[];
  affectedScenes?: readonly string[];
  knownSkillIds: ReadonlySet<string>;
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
    const referenced = new Set<string>();
    for (const content of [
      definition.content,
      ...definition.detailSections.map(section => section.content),
      ...definition.phaseHints.map(hint => hint.constraints),
    ]) {
      for (const skillId of extractReferencedSkillIdsFromStrategyText(content)) {
        referenced.add(skillId);
      }
    }
    for (const skillId of [...referenced].sort()) {
      if (!input.knownSkillIds.has(skillId)) {
        issues.push({
          severity: 'error',
          code: 'strategy_skill_reference_missing',
          scene,
          path: 'content',
          message:
            `invoke_skill("${skillId}") is not present in the effective Skill registry.`,
        });
      }
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
    valid: issues.length === 0,
    issues,
  };
}

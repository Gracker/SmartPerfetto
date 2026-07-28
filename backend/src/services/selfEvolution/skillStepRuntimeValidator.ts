// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillStep} from '../skillEngine/types';

export interface SkillStepRuntimeIssue {
  path: string;
  code: string;
  message: string;
}

type RecordValue = Record<string, unknown>;

const DISPLAY_LEVELS = new Set([
  'none',
  'debug',
  'detail',
  'summary',
  'key',
  'hidden',
]);
const DISPLAY_LAYERS = new Set([
  'overview',
  'list',
  'session',
  'deep',
  'diagnosis',
]);
const DISPLAY_FORMATS = new Set([
  'table',
  'chart',
  'text',
  'timeline',
  'summary',
  'metric',
]);
const SYNTHESIZE_ROLES = new Set([
  'overview',
  'list',
  'clusters',
  'conclusion',
  'detail',
]);
const DIAGNOSTIC_CONFIDENCE_LEVELS = new Set([
  'low',
  'medium',
  'high',
  'critical',
]);

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(entry => typeof entry === 'string');
}

function hasOnlyKeys(value: RecordValue, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function pushIssue(
  issues: SkillStepRuntimeIssue[],
  path: string,
  code: string,
  message: string,
): false {
  issues.push({path, code, message});
  return false;
}

function validateOptionalString(
  record: RecordValue,
  key: string,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  return record[key] === undefined
    || typeof record[key] === 'string'
    || pushIssue(
      issues,
      `${path}.${key}`,
      'step_field_type_invalid',
      `${key} must be a string when present.`,
    );
}

function validateOptionalBoolean(
  record: RecordValue,
  key: string,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  return record[key] === undefined
    || typeof record[key] === 'boolean'
    || pushIssue(
      issues,
      `${path}.${key}`,
      'step_field_type_invalid',
      `${key} must be a boolean when present.`,
    );
}

function validateStringArrayField(
  record: RecordValue,
  key: string,
  path: string,
  issues: SkillStepRuntimeIssue[],
  required = false,
): boolean {
  if (record[key] === undefined) {
    return required
      ? pushIssue(
        issues,
        `${path}.${key}`,
        'step_field_missing',
        `${key} is required.`,
      )
      : true;
  }
  return isStringArray(record[key])
    || pushIssue(
      issues,
      `${path}.${key}`,
      'step_field_type_invalid',
      `${key} must be a string array.`,
    );
}

function validateColumn(
  value: unknown,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  if (typeof value === 'string') return true;
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'name',
      'label',
      'type',
      'format',
      'clickAction',
      'durationColumn',
      'description',
      'unit',
      'hidden',
      'sortable',
      'defaultSort',
      'width',
      'tooltip',
      'enumValues',
      'cssClass',
    ])
  ) {
    return pushIssue(
      issues,
      path,
      'step_display_column_invalid',
      'Display columns must be strings or closed ColumnDefinition objects.',
    );
  }
  for (const key of [
    'name',
    'label',
    'type',
    'format',
    'clickAction',
    'durationColumn',
    'description',
    'unit',
    'defaultSort',
    'tooltip',
    'cssClass',
  ]) {
    if (!validateOptionalString(value, key, path, issues)) return false;
  }
  for (const key of ['hidden', 'sortable']) {
    if (!validateOptionalBoolean(value, key, path, issues)) return false;
  }
  if (
    value.width !== undefined
    && typeof value.width !== 'string'
    && typeof value.width !== 'number'
  ) {
    return pushIssue(
      issues,
      `${path}.width`,
      'step_display_column_invalid',
      'Column width must be a string or number.',
    );
  }
  return validateStringArrayField(value, 'enumValues', path, issues);
}

function validateDisplay(
  value: unknown,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  if (value === undefined || typeof value === 'boolean') return true;
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'show',
      'level',
      'layer',
      'title',
      'format',
      'columns',
      'aggregate',
      'highlight',
      'expandable',
      'expandableBindSource',
      'metadataFields',
      'hidden_columns',
      'collapsible',
      'defaultCollapsed',
    ])
  ) {
    return pushIssue(
      issues,
      path,
      'step_display_invalid',
      'display must be a boolean or a closed DisplayConfig object.',
    );
  }
  for (const key of [
    'show',
    'aggregate',
    'expandable',
    'collapsible',
    'defaultCollapsed',
  ]) {
    if (!validateOptionalBoolean(value, key, path, issues)) return false;
  }
  for (const key of ['title', 'expandableBindSource']) {
    if (!validateOptionalString(value, key, path, issues)) return false;
  }
  if (
    value.level !== undefined
    && (
      typeof value.level !== 'string'
      || !DISPLAY_LEVELS.has(value.level)
    )
  ) {
    return pushIssue(
      issues,
      `${path}.level`,
      'step_display_invalid',
      'display.level is invalid.',
    );
  }
  if (
    value.layer !== undefined
    && (
      typeof value.layer !== 'string'
      || !DISPLAY_LAYERS.has(value.layer)
    )
  ) {
    return pushIssue(
      issues,
      `${path}.layer`,
      'step_display_invalid',
      'display.layer is invalid.',
    );
  }
  if (
    value.format !== undefined
    && (
      typeof value.format !== 'string'
      || !DISPLAY_FORMATS.has(value.format)
    )
  ) {
    return pushIssue(
      issues,
      `${path}.format`,
      'step_display_invalid',
      'display.format is invalid.',
    );
  }
  if (
    value.columns !== undefined
    && (
      !Array.isArray(value.columns)
      || value.columns.some((column, index) =>
        !validateColumn(column, `${path}.columns[${index}]`, issues))
    )
  ) {
    return false;
  }
  if (
    value.highlight !== undefined
    && (
      !Array.isArray(value.highlight)
      || value.highlight.some((rule, index) => {
        const rulePath = `${path}.highlight[${index}]`;
        return !isRecord(rule)
          || !hasOnlyKeys(rule, ['condition', 'color', 'icon'])
          || !isNonEmptyString(rule.condition)
          || !validateOptionalString(rule, 'color', rulePath, issues)
          || !validateOptionalString(rule, 'icon', rulePath, issues);
      })
    )
  ) {
    return pushIssue(
      issues,
      `${path}.highlight`,
      'step_display_invalid',
      'display.highlight contains an invalid rule.',
    );
  }
  return validateStringArrayField(value, 'metadataFields', path, issues)
    && validateStringArrayField(value, 'hidden_columns', path, issues);
}

export function validateDisplayConfigRuntime(
  value: unknown,
  path = 'display',
): SkillStepRuntimeIssue[] {
  const issues: SkillStepRuntimeIssue[] = [];
  validateDisplay(value, path, issues);
  return issues;
}

function validateSynthesize(
  value: unknown,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  if (value === undefined || typeof value === 'boolean') return true;
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'role',
      'fields',
      'groupBy',
      'clusterBy',
      'insights',
    ])
    || typeof value.role !== 'string'
    || !SYNTHESIZE_ROLES.has(value.role)
  ) {
    return pushIssue(
      issues,
      path,
      'step_synthesize_invalid',
      'synthesize must be a boolean or a closed SynthesizeConfig object.',
    );
  }
  if (
    value.fields !== undefined
    && (
      !Array.isArray(value.fields)
      || value.fields.some(field =>
        !isRecord(field)
        || !hasOnlyKeys(field, ['key', 'label', 'format'])
        || !isNonEmptyString(field.key)
        || !isNonEmptyString(field.label)
        || (
          field.format !== undefined
          && typeof field.format !== 'string'
        ))
    )
  ) {
    return pushIssue(
      issues,
      `${path}.fields`,
      'step_synthesize_invalid',
      'synthesize.fields is invalid.',
    );
  }
  const groupByEntries = value.groupBy === undefined
    ? []
    : Array.isArray(value.groupBy)
      ? value.groupBy
      : [value.groupBy];
  if (groupByEntries.some(group => {
    if (
      !isRecord(group)
      || !hasOnlyKeys(group, [
        'field',
        'label',
        'title',
        'aggregations',
      ])
      || !isNonEmptyString(group.field)
      || (
        !isNonEmptyString(group.label)
        && !isNonEmptyString(group.title)
      )
    ) {
      return true;
    }
    return group.aggregations !== undefined
      && (
        !Array.isArray(group.aggregations)
        || group.aggregations.some(aggregation =>
          !isRecord(aggregation)
          || !hasOnlyKeys(aggregation, ['type', 'field', 'label'])
          || !isNonEmptyString(aggregation.type)
          || !isNonEmptyString(aggregation.label)
          || (
            aggregation.field !== undefined
            && typeof aggregation.field !== 'string'
          ))
      );
  })) {
    return pushIssue(
      issues,
      `${path}.groupBy`,
      'step_synthesize_invalid',
      'synthesize.groupBy is invalid.',
    );
  }
  if (
    value.clusterBy !== undefined
    && typeof value.clusterBy !== 'string'
    && (
      !isRecord(value.clusterBy)
      || !hasOnlyKeys(value.clusterBy, ['field', 'label'])
      || !isNonEmptyString(value.clusterBy.field)
      || !validateOptionalString(
        value.clusterBy,
        'label',
        `${path}.clusterBy`,
        issues,
      )
    )
  ) {
    return pushIssue(
      issues,
      `${path}.clusterBy`,
      'step_synthesize_invalid',
      'synthesize.clusterBy is invalid.',
    );
  }
  if (
    value.insights !== undefined
    && (
      !Array.isArray(value.insights)
      || value.insights.some(insight =>
        !isRecord(insight)
        || !hasOnlyKeys(insight, ['condition', 'template'])
        || !isNonEmptyString(insight.template)
        || (
          insight.condition !== undefined
          && typeof insight.condition !== 'string'
        ))
    )
  ) {
    return pushIssue(
      issues,
      `${path}.insights`,
      'step_synthesize_invalid',
      'synthesize.insights is invalid.',
    );
  }
  return true;
}

function validateSharedFields(
  step: RecordValue,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  if (!isNonEmptyString(step.id)) {
    return pushIssue(
      issues,
      `${path}.id`,
      'step_id_missing',
      'Step id must be a non-empty string.',
    );
  }
  for (const key of ['name', 'save_as']) {
    if (!validateOptionalString(step, key, path, issues)) return false;
  }
  return validateDisplay(step.display, `${path}.display`, issues)
    && validateSynthesize(step.synthesize, `${path}.synthesize`, issues);
}

function validateRequiredString(
  step: RecordValue,
  key: string,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  return isNonEmptyString(step[key])
    || pushIssue(
      issues,
      `${path}.${key}`,
      'step_field_missing',
      `${key} must be a non-empty string.`,
    );
}

function validateDiagnosticRules(
  value: unknown,
  path: string,
  issues: SkillStepRuntimeIssue[],
): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return pushIssue(
      issues,
      path,
      'diagnostic_rules_missing',
      'Diagnostic steps require at least one rule.',
    );
  }
  for (let index = 0; index < value.length; index++) {
    const rule = value[index];
    const rulePath = `${path}[${index}]`;
    if (
      !isRecord(rule)
      || !hasOnlyKeys(rule, [
        'condition',
        'diagnosis',
        'confidence',
        'severity',
        'suggestions',
        'evidence_fields',
      ])
      || !isNonEmptyString(rule.condition)
      || !isNonEmptyString(rule.diagnosis)
      || (
        (
          typeof rule.confidence !== 'number'
          || !Number.isFinite(rule.confidence)
        )
        && (
          typeof rule.confidence !== 'string'
          || !DIAGNOSTIC_CONFIDENCE_LEVELS.has(rule.confidence)
        )
      )
      || (
        rule.severity !== undefined
        && rule.severity !== 'info'
        && rule.severity !== 'warning'
        && rule.severity !== 'critical'
      )
      || !validateStringArrayField(
        rule,
        'suggestions',
        rulePath,
        issues,
      )
      || !validateStringArrayField(
        rule,
        'evidence_fields',
        rulePath,
        issues,
      )
    ) {
      return pushIssue(
        issues,
        rulePath,
        'diagnostic_rule_invalid',
        'Diagnostic rule has an invalid closed shape.',
      );
    }
  }
  return true;
}

function validateStep(
  value: unknown,
  path: string,
  issues: SkillStepRuntimeIssue[],
): value is SkillStep {
  if (!isRecord(value)) {
    return pushIssue(
      issues,
      path,
      'step_invalid',
      'Step must be an object.',
    );
  }
  const type = typeof value.type === 'string'
    ? value.type
    : typeof value.skill === 'string'
      ? 'skill'
      : undefined;
  if (!type) {
    return pushIssue(
      issues,
      `${path}.type`,
      'step_type_missing',
      'Step type is required unless the step is a Skill reference.',
    );
  }
  if (!validateSharedFields(value, path, issues)) return false;

  const common = ['id', 'type', 'name', 'display', 'save_as', 'synthesize'];
  switch (type) {
    case 'atomic':
      return hasOnlyKeys(value, [
        ...common,
        'description',
        'sql',
        'sql_fragments',
        'output_schema',
        'optional',
        'on_empty',
        'condition',
      ])
        && validateRequiredString(value, 'sql', path, issues)
        && validateOptionalString(value, 'description', path, issues)
        && validateStringArrayField(value, 'sql_fragments', path, issues)
        && (
          value.output_schema === undefined
          || isRecord(value.output_schema)
          || pushIssue(
            issues,
            `${path}.output_schema`,
            'atomic_output_schema_invalid',
            'Atomic output_schema must be an object.',
          )
        )
        && validateOptionalBoolean(value, 'optional', path, issues)
        && validateOptionalString(value, 'on_empty', path, issues)
        && validateOptionalString(value, 'condition', path, issues)
        || pushIssue(
          issues,
          path,
          'atomic_step_invalid',
          'Atomic step has unknown fields or invalid values.',
        );
    case 'skill':
      return hasOnlyKeys(value, [
        ...common,
        'skill',
        'params',
        'condition',
        'on_empty',
        'optional',
      ])
        && validateRequiredString(value, 'skill', path, issues)
        && (
          value.params === undefined
          || isRecord(value.params)
          || pushIssue(
            issues,
            `${path}.params`,
            'skill_step_params_invalid',
            'Skill step params must be an object.',
          )
        )
        && validateOptionalString(value, 'condition', path, issues)
        && validateOptionalString(value, 'on_empty', path, issues)
        && validateOptionalBoolean(value, 'optional', path, issues)
        || pushIssue(
          issues,
          path,
          'skill_step_invalid',
          'Skill reference step has unknown fields or invalid values.',
        );
    case 'iterator':
      return hasOnlyKeys(value, [
        ...common,
        'source',
        'item_skill',
        'item_params',
        'max_items',
        'condition',
        'filter',
      ])
        && validateRequiredString(value, 'source', path, issues)
        && validateRequiredString(value, 'item_skill', path, issues)
        && validateOptionalString(value, 'condition', path, issues)
        && validateOptionalString(value, 'filter', path, issues)
        && (
          value.item_params === undefined
          || (
            isRecord(value.item_params)
            && Object.values(value.item_params)
              .every(entry => typeof entry === 'string')
          )
          || pushIssue(
            issues,
            `${path}.item_params`,
            'iterator_step_params_invalid',
            'Iterator item_params must map strings to strings.',
          )
        )
        && (
          value.max_items === undefined
          || (
            Number.isInteger(value.max_items)
            && (value.max_items as number) > 0
          )
          || pushIssue(
            issues,
            `${path}.max_items`,
            'iterator_step_limit_invalid',
            'Iterator max_items must be a positive integer.',
          )
        )
        || pushIssue(
          issues,
          path,
          'iterator_step_invalid',
          'Iterator step has unknown fields or invalid values.',
        );
    case 'parallel': {
      if (
        !hasOnlyKeys(value, [...common, 'steps'])
        || !Array.isArray(value.steps)
        || value.steps.length === 0
      ) {
        return pushIssue(
          issues,
          path,
          'parallel_step_invalid',
          'Parallel step requires a non-empty closed steps array.',
        );
      }
      return value.steps.every((step, index) => {
        const nestedPath = `${path}.steps[${index}]`;
        if (!validateStep(step, nestedPath, issues)) return false;
        const nestedType = isRecord(step) && typeof step.type === 'string'
          ? step.type
          : 'skill';
        return nestedType === 'atomic'
          || nestedType === 'skill'
          || pushIssue(
            issues,
            `${nestedPath}.type`,
            'parallel_step_type_invalid',
            'Parallel steps may contain only atomic or Skill reference steps.',
          );
      });
    }
    case 'diagnostic':
      return hasOnlyKeys(value, [
        ...common,
        'inputs',
        'rules',
        'ai_assist',
        'fallback',
        'condition',
      ])
        && validateStringArrayField(value, 'inputs', path, issues, true)
        && validateDiagnosticRules(value.rules, `${path}.rules`, issues)
        && validateOptionalBoolean(value, 'ai_assist', path, issues)
        && validateOptionalString(value, 'condition', path, issues)
        && (
          value.fallback === undefined
          || (
            isRecord(value.fallback)
            && hasOnlyKeys(value.fallback, ['type', 'prompt'])
            && value.fallback.type === 'ai_decision'
            && isNonEmptyString(value.fallback.prompt)
          )
          || pushIssue(
            issues,
            `${path}.fallback`,
            'diagnostic_fallback_invalid',
            'Diagnostic fallback must be a closed ai_decision fallback.',
          )
        )
        || pushIssue(
          issues,
          path,
          'diagnostic_step_invalid',
          'Diagnostic step has unknown fields or invalid values.',
        );
    case 'ai_decision':
      return hasOnlyKeys(value, [...common, 'prompt', 'inputs', 'output_schema'])
        && validateRequiredString(value, 'prompt', path, issues)
        && validateStringArrayField(value, 'inputs', path, issues)
        && (
          value.output_schema === undefined
          || isRecord(value.output_schema)
          || pushIssue(
            issues,
            `${path}.output_schema`,
            'ai_output_schema_invalid',
            'AI output_schema must be an object.',
          )
        )
        || pushIssue(
          issues,
          path,
          'ai_decision_step_invalid',
          'AI decision step has unknown fields or invalid values.',
        );
    case 'ai_summary':
      return hasOnlyKeys(value, [...common, 'prompt', 'inputs'])
        && validateRequiredString(value, 'prompt', path, issues)
        && validateStringArrayField(value, 'inputs', path, issues)
        || pushIssue(
          issues,
          path,
          'ai_summary_step_invalid',
          'AI summary step has unknown fields or invalid values.',
        );
    case 'conditional': {
      if (
        !hasOnlyKeys(value, [...common, 'conditions', 'else'])
        || !Array.isArray(value.conditions)
        || value.conditions.length === 0
      ) {
        return pushIssue(
          issues,
          path,
          'conditional_step_invalid',
          'Conditional step requires a non-empty conditions array.',
        );
      }
      for (let index = 0; index < value.conditions.length; index++) {
        const condition = value.conditions[index];
        const conditionPath = `${path}.conditions[${index}]`;
        if (
          !isRecord(condition)
          || !hasOnlyKeys(condition, ['when', 'then'])
          || !isNonEmptyString(condition.when)
          || (
            !isNonEmptyString(condition.then)
            && !validateStep(
              condition.then,
              `${conditionPath}.then`,
              issues,
            )
          )
        ) {
          return pushIssue(
            issues,
            conditionPath,
            'conditional_branch_invalid',
            'Conditional branch requires when and a Skill id or nested step.',
          );
        }
      }
      if (
        value.else !== undefined
        && !isNonEmptyString(value.else)
        && !validateStep(value.else, `${path}.else`, issues)
      ) {
        return false;
      }
      return true;
    }
    case 'pipeline':
      return hasOnlyKeys(value, [
        ...common,
        'pipeline_id',
        'pipeline_source',
        'active_processes_source',
        'trace_requirements_source',
      ])
        && validateOptionalString(value, 'pipeline_id', path, issues)
        && validateOptionalString(value, 'pipeline_source', path, issues)
        && validateOptionalString(value, 'active_processes_source', path, issues)
        && validateOptionalString(value, 'trace_requirements_source', path, issues)
        || pushIssue(
          issues,
          path,
          'pipeline_step_invalid',
          'Pipeline step has unknown fields or invalid values.',
        );
    default:
      return pushIssue(
        issues,
        `${path}.type`,
        'step_type_unsupported',
        `Unsupported step type '${type}'.`,
      );
  }
}

export function validateSkillStepRuntime(
  value: unknown,
  path: string,
): readonly SkillStepRuntimeIssue[] {
  const issues: SkillStepRuntimeIssue[] = [];
  validateStep(value, path, issues);
  return issues;
}

export function validateSkillStepListRuntime(
  value: unknown,
  path: string,
): readonly SkillStepRuntimeIssue[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{
      path,
      code: 'step_list_invalid',
      message: 'steps must be a non-empty array.',
    }];
  }
  const issues: SkillStepRuntimeIssue[] = [];
  value.forEach((step, index) => {
    validateStep(step, `${path}[${index}]`, issues);
  });
  return issues;
}

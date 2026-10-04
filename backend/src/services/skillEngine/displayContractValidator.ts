// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DisplayConfig, SkillDefinition, SkillStep } from './types';
import {
  VALID_CLICK_ACTIONS,
  VALID_COLUMN_FORMATS,
  VALID_COLUMN_TYPES,
  VALID_DISPLAY_FORMATS,
  VALID_DISPLAY_LAYERS,
  VALID_DISPLAY_LEVELS,
  isValidDisplayLayer,
} from '../../types/dataContract';

export interface DisplayContractIssue {
  skillName: string;
  stepId?: string;
  field: string;
  path: string;
  message: string;
  value?: unknown;
  filePath?: string;
}

export interface ValidateDisplayContractOptions {
  filePath?: string;
}

const VALID_TIME_UNITS = ['ns', 'us', 'ms', 's'] as const;
const VALID_WIDTHS = ['narrow', 'medium', 'wide', 'auto'] as const;

export function isDisplayTitleTranslations(value: unknown): value is NonNullable<DisplayConfig['title_i18n']> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([locale, title]) => ['zh-CN', 'en'].includes(locale) &&
      typeof title === 'string' && title.trim().length > 0));
}

function pushIssue(
  issues: DisplayContractIssue[],
  skillName: string,
  field: string,
  path: string,
  message: string,
  value: unknown,
  options: ValidateDisplayContractOptions,
  stepId?: string,
): void {
  issues.push({
    skillName,
    stepId,
    field,
    path,
    message,
    value,
    filePath: options.filePath,
  });
}

/** A label's `label_i18n`, when present, maps en or zh-CN to non-empty strings. */
function validateLabelTranslations(
  issues: DisplayContractIssue[],
  skillName: string,
  translations: unknown,
  path: string,
  options: ValidateDisplayContractOptions,
  stepId: string | undefined,
): void {
  if (translations === undefined || isDisplayTitleTranslations(translations)) return;
  pushIssue(issues, skillName, `${path}.label_i18n`, `${path}.label_i18n`,
    'label_i18n must map en or zh-CN to non-empty strings', translations, options, stepId);
}

function validateColumnDefinition(
  issues: DisplayContractIssue[],
  skillName: string,
  stepId: string | undefined,
  column: unknown,
  path: string,
  options: ValidateDisplayContractOptions,
): void {
  if (typeof column === 'string') {
    if (column.length === 0) {
      pushIssue(issues, skillName, path, path, 'Column shorthand must be a non-empty string', column, options, stepId);
    }
    return;
  }

  if (!column || typeof column !== 'object' || Array.isArray(column)) {
    pushIssue(issues, skillName, path, path, 'Column definition must be an object', column, options, stepId);
    return;
  }

  const col = column as Record<string, unknown>;
  validateLabelTranslations(issues, skillName, col.label_i18n, path, options, stepId);
  if (!col.name || typeof col.name !== 'string') {
    pushIssue(
      issues,
      skillName,
      `${path}.name`,
      `${path}.name`,
      'Column name is required and must be a string',
      col.name,
      options,
      stepId,
    );
  }

  if (col.type && !VALID_COLUMN_TYPES.includes(col.type as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.type`,
      `${path}.type`,
      `Invalid column type. Valid values: ${VALID_COLUMN_TYPES.join(', ')}`,
      col.type,
      options,
      stepId,
    );
  }

  if (col.format && !VALID_COLUMN_FORMATS.includes(col.format as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.format`,
      `${path}.format`,
      `Invalid column format. Valid values: ${VALID_COLUMN_FORMATS.join(', ')}`,
      col.format,
      options,
      stepId,
    );
  }

  if (col.clickAction && !VALID_CLICK_ACTIONS.includes(col.clickAction as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.clickAction`,
      `${path}.clickAction`,
      `Invalid click action. Valid values: ${VALID_CLICK_ACTIONS.join(', ')}`,
      col.clickAction,
      options,
      stepId,
    );
  }

  if (col.unit && !VALID_TIME_UNITS.includes(col.unit as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.unit`,
      `${path}.unit`,
      `Invalid time unit. Valid values: ${VALID_TIME_UNITS.join(', ')}`,
      col.unit,
      options,
      stepId,
    );
  }

  if (col.width !== undefined && typeof col.width !== 'number' && !VALID_WIDTHS.includes(col.width as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.width`,
      `${path}.width`,
      `Invalid width. Must be a number or one of: ${VALID_WIDTHS.join(', ')}`,
      col.width,
      options,
      stepId,
    );
  }
}

function validateDisplayConfig(
  issues: DisplayContractIssue[],
  skillName: string,
  display: unknown,
  path: string,
  options: ValidateDisplayContractOptions,
  stepId?: string,
): void {
  if (!display || typeof display !== 'object' || Array.isArray(display)) return;

  const config = display as Record<string, unknown>;
  if (config.title_i18n !== undefined && (!stepId?.trim() || !/^steps\[\d+\](?:\.steps\[\d+\])*\.display$/.test(path))) {
    pushIssue(issues, skillName, `${path}.title_i18n`, `${path}.title_i18n`,
      'title_i18n is supported only on named steps[].display and nested steps[].steps[].display',
      config.title_i18n, options, stepId);
  }
  if (config.title_i18n !== undefined && !isDisplayTitleTranslations(config.title_i18n)) {
    pushIssue(issues, skillName, `${path}.title_i18n`, `${path}.title_i18n`,
      'title_i18n must map en or zh-CN to non-empty strings', config.title_i18n, options, stepId);
  }
  if (config.layer && !isValidDisplayLayer(String(config.layer))) {
    pushIssue(
      issues,
      skillName,
      `${path}.layer`,
      `${path}.layer`,
      `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
      config.layer,
      options,
      stepId,
    );
  }

  if (config.level && !VALID_DISPLAY_LEVELS.includes(config.level as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.level`,
      `${path}.level`,
      `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
      config.level,
      options,
      stepId,
    );
  }

  if (config.format && !VALID_DISPLAY_FORMATS.includes(config.format as any)) {
    pushIssue(
      issues,
      skillName,
      `${path}.format`,
      `${path}.format`,
      `Invalid format value. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
      config.format,
      options,
      stepId,
    );
  }

  if (config.columns !== undefined) {
    if (!Array.isArray(config.columns)) {
      pushIssue(
        issues,
        skillName,
        `${path}.columns`,
        `${path}.columns`,
        'Display columns must be an array',
        config.columns,
        options,
        stepId,
      );
    } else {
      config.columns.forEach((column, index) => {
        validateColumnDefinition(issues, skillName, stepId, column, `${path}.columns[${index}]`, options);
      });
    }
  }

  if (config.metadataFields !== undefined) {
    if (!Array.isArray(config.metadataFields)) {
      pushIssue(
        issues,
        skillName,
        `${path}.metadataFields`,
        `${path}.metadataFields`,
        'metadataFields must be an array of strings',
        config.metadataFields,
        options,
        stepId,
      );
    } else {
      config.metadataFields.forEach((field, index) => {
        if (typeof field !== 'string') {
          pushIssue(
            issues,
            skillName,
            `${path}.metadataFields[${index}]`,
            `${path}.metadataFields[${index}]`,
            'Each metadataField must be a string',
            field,
            options,
            stepId,
          );
        }
      });
    }
  }
}

function validateStepDisplay(
  issues: DisplayContractIssue[],
  skillName: string,
  step: unknown,
  path: string,
  options: ValidateDisplayContractOptions,
): void {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return;

  const stepObj = step as Record<string, unknown>;
  const stepId = typeof stepObj.id === 'string' ? stepObj.id : undefined;
  validateDisplayConfig(issues, skillName, stepObj.display, `${path}.display`, options, stepId);
  const synthesize = stepObj.synthesize as {fields?: unknown} | undefined;
  if (synthesize && typeof synthesize === 'object' && Array.isArray(synthesize.fields)) {
    synthesize.fields.forEach((field, index) => validateLabelTranslations(issues, skillName,
      (field as {label_i18n?: unknown} | null)?.label_i18n, `${path}.synthesize.fields[${index}]`, options, stepId));
  }

  if (Array.isArray(stepObj.steps)) {
    stepObj.steps.forEach((nestedStep, index) => {
      validateStepDisplay(issues, skillName, nestedStep, `${path}.steps[${index}]`, options);
    });
  }

  if (stepObj.then) {
    validateStepDisplay(issues, skillName, stepObj.then, `${path}.then`, options);
  }

  if (Array.isArray(stepObj.conditions)) {
    stepObj.conditions.forEach((condition, index) => {
      if (!condition || typeof condition !== 'object') return;
      const thenStep = (condition as Record<string, unknown>).then;
      validateStepDisplay(issues, skillName, thenStep, `${path}.conditions[${index}].then`, options);
    });
  }

  if (stepObj.else) {
    validateStepDisplay(issues, skillName, stepObj.else, `${path}.else`, options);
  }
}

export function validateSkillDisplayContract(
  skill: SkillDefinition | Record<string, unknown>,
  options: ValidateDisplayContractOptions = {},
): DisplayContractIssue[] {
  const issues: DisplayContractIssue[] = [];
  const skillName = typeof skill?.name === 'string' ? skill.name : 'unknown_skill';

  const seenDisplays = new WeakSet<object>();
  const validateOnce = (display: unknown, path: string): void => {
    if (!display || typeof display !== 'object' || Array.isArray(display)) return;
    if (seenDisplays.has(display)) return;
    seenDisplays.add(display);
    validateDisplayConfig(issues, skillName, display, path, options);
  };

  validateOnce((skill as any).display, 'display');
  validateOnce((skill as any).output?.display, 'output.display');
  // The catalog translations of the Skill's own name and description.
  for (const field of ['display_name_i18n', 'description_i18n'] as const) {
    const translations = (skill as any).meta?.[field];
    if (translations !== undefined && !isDisplayTitleTranslations(translations)) {
      pushIssue(issues, skillName, `meta.${field}`, `meta.${field}`,
        `${field} must map en or zh-CN to non-empty strings`, translations, options);
    }
  }

  if (Array.isArray((skill as any).steps)) {
    (skill as any).steps.forEach((step: SkillStep, index: number) => {
      validateStepDisplay(issues, skillName, step, `steps[${index}]`, options);
    });
  }

  return issues;
}

export function formatDisplayContractIssue(issue: DisplayContractIssue): string {
  const subject = issue.stepId ? `${issue.skillName}.${issue.stepId}` : issue.skillName;
  return `${subject}: ${issue.path} - ${issue.message} (value: ${String(issue.value)})`;
}

export function sanitizeDisplayConfigForRuntime(
  config: DisplayConfig,
  context: {
    skillName?: string;
    stepId?: string;
    defaultLevel?: DisplayConfig['level'];
    defaultLayer?: DisplayConfig['layer'];
    defaultFormat?: DisplayConfig['format'];
  } = {},
): { config: DisplayConfig; issues: DisplayContractIssue[] } {
  const sanitized: DisplayConfig = { ...config };
  delete sanitized.title_i18n; // Authoring metadata belongs to the localization catalog.
  const issues: DisplayContractIssue[] = [];
  const skillName = context.skillName || 'runtime_display';
  const stepId = context.stepId;
  const options: ValidateDisplayContractOptions = {};

  if (sanitized.layer && !isValidDisplayLayer(String(sanitized.layer))) {
    pushIssue(
      issues,
      skillName,
      'display.layer',
      'display.layer',
      `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
      sanitized.layer,
      options,
      stepId,
    );
    sanitized.layer = context.defaultLayer || 'list';
  }

  if (sanitized.level && !VALID_DISPLAY_LEVELS.includes(sanitized.level as any)) {
    pushIssue(
      issues,
      skillName,
      'display.level',
      'display.level',
      `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
      sanitized.level,
      options,
      stepId,
    );
    sanitized.level = context.defaultLevel || 'detail';
  }

  if (sanitized.format && !VALID_DISPLAY_FORMATS.includes(sanitized.format as any)) {
    pushIssue(
      issues,
      skillName,
      'display.format',
      'display.format',
      `Invalid format value. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
      sanitized.format,
      options,
      stepId,
    );
    sanitized.format = context.defaultFormat || 'table';
  }

  if (!sanitized.level) sanitized.level = context.defaultLevel || 'summary';
  if (!sanitized.format) sanitized.format = context.defaultFormat || 'table';

  if (sanitized.columns !== undefined) {
    if (!Array.isArray(sanitized.columns)) {
      pushIssue(
        issues,
        skillName,
        'display.columns',
        'display.columns',
        'Display columns must be an array',
        sanitized.columns,
        options,
        stepId,
      );
      delete sanitized.columns;
    } else {
      const cleanColumns: Array<NonNullable<DisplayConfig['columns']>[number]> = [];
      sanitized.columns.forEach((column, index) => {
        const path = `display.columns[${index}]`;
        if (typeof column === 'string') {
          if (column.length > 0) {
            cleanColumns.push({ name: column });
          } else {
            pushIssue(issues, skillName, path, path, 'Column shorthand must be a non-empty string', column, options, stepId);
          }
          return;
        }

        if (!column || typeof column !== 'object' || Array.isArray(column)) {
          pushIssue(issues, skillName, path, path, 'Column definition must be an object', column, options, stepId);
          return;
        }

        const rawColumn = column as Record<string, unknown>;
        if (!rawColumn.name || typeof rawColumn.name !== 'string') {
          pushIssue(
            issues,
            skillName,
            `${path}.name`,
            `${path}.name`,
            'Column name is required and must be a string',
            rawColumn.name,
            options,
            stepId,
          );
          return;
        }

        const cleanColumn: Record<string, unknown> = { ...rawColumn };
        delete cleanColumn.label_i18n; // Authoring metadata belongs to the localization catalog.
        if (cleanColumn.type && !VALID_COLUMN_TYPES.includes(cleanColumn.type as any)) {
          pushIssue(
            issues,
            skillName,
            `${path}.type`,
            `${path}.type`,
            `Invalid column type. Valid values: ${VALID_COLUMN_TYPES.join(', ')}`,
            cleanColumn.type,
            options,
            stepId,
          );
          delete cleanColumn.type;
        }

        if (cleanColumn.format && !VALID_COLUMN_FORMATS.includes(cleanColumn.format as any)) {
          pushIssue(
            issues,
            skillName,
            `${path}.format`,
            `${path}.format`,
            `Invalid column format. Valid values: ${VALID_COLUMN_FORMATS.join(', ')}`,
            cleanColumn.format,
            options,
            stepId,
          );
          delete cleanColumn.format;
        }

        if (cleanColumn.clickAction && !VALID_CLICK_ACTIONS.includes(cleanColumn.clickAction as any)) {
          pushIssue(
            issues,
            skillName,
            `${path}.clickAction`,
            `${path}.clickAction`,
            `Invalid click action. Valid values: ${VALID_CLICK_ACTIONS.join(', ')}`,
            cleanColumn.clickAction,
            options,
            stepId,
          );
          delete cleanColumn.clickAction;
        }

        if (cleanColumn.unit && !VALID_TIME_UNITS.includes(cleanColumn.unit as any)) {
          pushIssue(
            issues,
            skillName,
            `${path}.unit`,
            `${path}.unit`,
            `Invalid time unit. Valid values: ${VALID_TIME_UNITS.join(', ')}`,
            cleanColumn.unit,
            options,
            stepId,
          );
          delete cleanColumn.unit;
        }

        if (cleanColumn.width !== undefined && typeof cleanColumn.width !== 'number' && !VALID_WIDTHS.includes(cleanColumn.width as any)) {
          pushIssue(
            issues,
            skillName,
            `${path}.width`,
            `${path}.width`,
            `Invalid width. Must be a number or one of: ${VALID_WIDTHS.join(', ')}`,
            cleanColumn.width,
            options,
            stepId,
          );
          delete cleanColumn.width;
        }

        cleanColumns.push(cleanColumn as NonNullable<DisplayConfig['columns']>[number]);
      });
      sanitized.columns = cleanColumns;
    }
  }

  if (sanitized.metadataFields !== undefined) {
    if (!Array.isArray(sanitized.metadataFields)) {
      pushIssue(
        issues,
        skillName,
        'display.metadataFields',
        'display.metadataFields',
        'metadataFields must be an array of strings',
        sanitized.metadataFields,
        options,
        stepId,
      );
      delete sanitized.metadataFields;
    } else {
      sanitized.metadataFields = sanitized.metadataFields.filter((field, index) => {
        if (typeof field === 'string') return true;
        pushIssue(
          issues,
          skillName,
          `display.metadataFields[${index}]`,
          `display.metadataFields[${index}]`,
          'Each metadataField must be a string',
          field,
          options,
          stepId,
        );
        return false;
      });
    }
  }

  return { config: sanitized, issues };
}

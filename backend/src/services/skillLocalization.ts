// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {SkillDefinition} from './skillEngine/types';
import {humanizeSkillIdentifier} from './skillLocalizationLabels';

interface LocalizedText {
  'zh-CN': string;
  en: string;
}

interface CatalogColumn {
  label: LocalizedText;
  tooltip?: LocalizedText;
}

interface CatalogStep {
  title: LocalizedText;
  description?: LocalizedText;
  columns: Record<string, CatalogColumn>;
  synthesizeLabels: Record<string, LocalizedText>;
}

interface CatalogSkill {
  displayName: LocalizedText;
  description: LocalizedText;
  type: string;
  steps: Record<string, CatalogStep>;
}

interface SkillLocalizationCatalog {
  schemaVersion: 1;
  inventory: {
    skillCount: number;
    pipelineDefinitionCount: number;
    moduleExpertCount: number;
    stepCount: number;
    explicitColumnCount: number;
  };
  skills: Record<string, CatalogSkill>;
}

export interface LocalizableSkillListItem {
  id: string;
  displayName: string;
  description: string;
  origin?: {origin?: 'built_in' | 'external_pack'};
}

export interface SkillLocalizationOptions {
  externalAuthored?: boolean;
  /**
   * Resolved skill parameters for the run being localized.
   *
   * Display titles may be templates (`启动 #${startup_id} 详情`). The executor
   * substitutes them, then localization replaces the title with the catalog
   * string — which is the same template. Without the parameters here the raw
   * `${startup_id}` reaches the user, which it did in the default language.
   */
  parameters?: Record<string, unknown>;
}

/**
 * Fill `${name}` placeholders in a localized display title.
 *
 * Unknown placeholders are left as-is rather than blanked: a visible
 * `${unknown_param}` is a bug report, an empty gap is a silent one.
 */
export function substituteDisplayTitleParameters(
  title: string,
  parameters: Record<string, unknown> | undefined,
): string {
  if (!title || !parameters || !title.includes('${')) return title;
  return title.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, name: string) => {
    const value = parameters[name];
    return value === undefined || value === null || value === ''
      ? match
      : String(value);
  });
}

const CATALOG_PATH = path.resolve(
  __dirname,
  '../../skills/localization.catalog.json',
);
let cachedCatalog: SkillLocalizationCatalog | undefined;

function loadCatalog(): SkillLocalizationCatalog {
  if (cachedCatalog) return cachedCatalog;
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(
      `Missing Skill localization catalog: ${CATALOG_PATH}. ` +
      'Run npm run generate:skill-localizations.',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as
    Partial<SkillLocalizationCatalog>;
  if (parsed.schemaVersion !== 1 || !parsed.inventory || !parsed.skills) {
    throw new Error(`Invalid Skill localization catalog: ${CATALOG_PATH}`);
  }
  cachedCatalog = parsed as SkillLocalizationCatalog;
  return cachedCatalog;
}

function getCatalogSkill(
  skillId: string,
  options: SkillLocalizationOptions = {},
): CatalogSkill | undefined {
  if (options.externalAuthored) return undefined;
  const entry = loadCatalog().skills[skillId];
  if (entry) return entry;
  throw new Error(
    `Missing built-in Skill localization entry for "${skillId}". ` +
    'Run npm run generate:skill-localizations and review the generated catalog.',
  );
}

export function localizedSchemaLabel(
  stableName: string,
  outputLanguage: OutputLanguage,
): string {
  return humanizeSkillIdentifier(stableName, outputLanguage) || stableName;
}

function catalogStep(
  skill: CatalogSkill,
  stepId: string | undefined,
  outputLanguage: OutputLanguage,
): CatalogStep {
  const normalized = stepId || 'root';
  const entry = skill.steps[normalized];
  if (entry) return entry;

  if (/^frame_(?:\d+|unknown)$/i.test(normalized)) {
    const frameId = normalized.replace(/^frame_/i, '');
    return {
      title: {
        'zh-CN': `帧 #${frameId}`,
        en: `Frame #${frameId}`,
      },
      columns: {},
      synthesizeLabels: {},
    };
  }

  return {
    title: {
      'zh-CN': localizedSchemaLabel(normalized, 'zh-CN'),
      en: localizedSchemaLabel(normalized, 'en'),
    },
    columns: {},
    synthesizeLabels: {},
  };
}

/**
 * Narrative text can contain evidence, failure causes, or authored guidance.
 * Keep a locale-matched source verbatim. When the authored language does not
 * match, expose a neutral localized explanation and retain the original in the
 * caller's sourceContent/sourceNarrative/sourceEmptyMessage provenance field.
 */
export function localizeSkillNarrative(
  value: string | undefined,
  outputLanguage: OutputLanguage,
  kind: 'summary' | 'execution' | 'diagnostic' = 'summary',
  options: SkillLocalizationOptions = {},
): string | undefined {
  if (!value?.trim()) return value;
  if (options.externalAuthored) return value;
  const hasHan = /\p{Script=Han}/u.test(value);
  const matches = outputLanguage === 'en' ? !hasHan : hasHan;
  if (matches) return value;
  const fallback: Record<typeof kind, LocalizedText> = {
    summary: {
      'zh-CN': 'Skill 已生成结构化摘要；请结合下方指标和证据表核对。',
      en: 'The Skill produced a structured summary; verify it against the metrics and evidence tables below.',
    },
    execution: {
      'zh-CN': 'Skill 步骤执行状态已更新。',
      en: 'The Skill step execution status was updated.',
    },
    diagnostic: {
      'zh-CN': 'Skill 返回了一项诊断；请结合结构化证据与原始日志核对。',
      en: 'The Skill returned a diagnostic; verify it against structured evidence and raw logs.',
    },
  };
  return fallback[kind][outputLanguage];
}

function localizeColumnDefinitions(
  value: unknown,
  step: CatalogStep,
  outputLanguage: OutputLanguage,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(column => {
    if (!column || typeof column !== 'object') return column;
    const typed = column as Record<string, unknown>;
    const name = typeof typed.name === 'string' ? typed.name : '';
    if (!name) return column;
    const catalogColumn = step.columns[name];
    return {
      ...typed,
      label: catalogColumn?.label[outputLanguage] ||
        localizedSchemaLabel(name, outputLanguage),
      ...(catalogColumn?.tooltip
        ? {tooltip: catalogColumn.tooltip[outputLanguage]}
        : {}),
    };
  });
}

function localizeSummary(
  value: unknown,
  step: CatalogStep,
  outputLanguage: OutputLanguage,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const summary = value as Record<string, unknown>;
  const metrics = Array.isArray(summary.metrics)
    ? summary.metrics.map(metric => {
        if (!metric || typeof metric !== 'object') return metric;
        const typed = metric as Record<string, unknown>;
        const currentLabel = typeof typed.label === 'string' ? typed.label : '';
        const mapped = Object.values(step.synthesizeLabels)
          .find(pair => pair['zh-CN'] === currentLabel || pair.en === currentLabel);
        return {
          ...typed,
          label: mapped?.[outputLanguage] ||
            (currentLabel
              ? localizedSchemaLabel(currentLabel, outputLanguage)
              : currentLabel),
        };
      })
    : summary.metrics;
  return {
    ...summary,
    title: step.title[outputLanguage],
    content:
      typeof summary.content === 'string'
          ? localizeSkillNarrative(
              summary.content,
              outputLanguage,
              'summary',
          )
        : summary.content,
    ...(typeof summary.content === 'string'
      ? {sourceContent: summary.content}
      : {}),
    ...(metrics ? {metrics} : {}),
  };
}

function localizeDisplayData(
  value: unknown,
  step: CatalogStep,
  outputLanguage: OutputLanguage,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  return {
    ...data,
    ...(data.summary
      ? {summary: localizeSummary(data.summary, step, outputLanguage)}
      : {}),
  };
}

export function localizeSkillListItem<T extends LocalizableSkillListItem>(
  item: T,
  outputLanguage: OutputLanguage,
): T & {localizationStatus: 'catalog' | 'external_authored'} {
  const externalAuthored = item.origin?.origin === 'external_pack';
  const skill = getCatalogSkill(item.id, {externalAuthored});
  if (!skill) {
    return {...item, localizationStatus: 'external_authored'};
  }
  return {
    ...item,
    displayName: skill.displayName[outputLanguage],
    description: skill.description[outputLanguage],
    localizationStatus: 'catalog',
  };
}

export function localizeSkillDefinition(
  skill: SkillDefinition,
  outputLanguage: OutputLanguage,
  options: SkillLocalizationOptions = {},
): SkillDefinition {
  const catalogSkill = getCatalogSkill(skill.name, options);
  if (!catalogSkill) return skill;
  const projectSteps = (steps: SkillDefinition['steps']): SkillDefinition['steps'] =>
    steps?.map(definition => {
      const raw = definition as unknown as Record<string, unknown>;
      const step = catalogStep(
        catalogSkill,
        typeof raw.id === 'string' ? raw.id : undefined,
        outputLanguage,
      );
      return {
        ...raw,
        ...(raw.name !== undefined ? {name: step.title[outputLanguage]} : {}),
        ...(raw.description !== undefined && step.description
          ? {description: step.description[outputLanguage]}
          : {}),
        ...(Array.isArray(raw.steps)
          ? {steps: projectSteps(raw.steps as SkillDefinition['steps'])}
          : {}),
      } as SkillDefinition['steps'] extends Array<infer T> ? T : never;
    });
  return {
    ...skill,
    meta: {
      ...skill.meta,
      display_name: catalogSkill.displayName[outputLanguage],
      description: catalogSkill.description[outputLanguage],
    },
    steps: projectSteps(skill.steps),
  };
}

export function localizeSkillDisplayResults<T extends {
  stepId?: string;
  title?: string;
  data?: unknown;
  columnDefinitions?: unknown;
  executionMessage?: string;
  executionError?: string;
}>(
  skillId: string,
  results: T[] | undefined,
  outputLanguage: OutputLanguage,
  options: SkillLocalizationOptions = {},
): T[] | undefined {
  if (!results) return results;
  const skill = getCatalogSkill(skillId, options);
  if (!skill) return results;
  return results.map(result => {
    const step = catalogStep(skill, result.stepId, outputLanguage);
    return {
      ...result,
      title: substituteDisplayTitleParameters(
        step.title[outputLanguage],
        options.parameters,
      ),
      data: localizeDisplayData(result.data, step, outputLanguage),
      columnDefinitions: localizeColumnDefinitions(
        result.columnDefinitions,
        step,
        outputLanguage,
      ),
    };
  });
}

export function localizeSkillDiagnostics<T extends {
  message?: string;
  diagnosis?: string;
  suggestions?: string[];
}>(
  diagnostics: T[] | undefined,
  outputLanguage: OutputLanguage,
  options: SkillLocalizationOptions = {},
): T[] | undefined {
  if (!diagnostics || options.externalAuthored) return diagnostics;
  return diagnostics.map(diagnostic => ({
    ...diagnostic,
    message: localizeSkillNarrative(
      diagnostic.message,
      outputLanguage,
      'diagnostic',
    ),
    diagnosis: localizeSkillNarrative(
      diagnostic.diagnosis,
      outputLanguage,
      'diagnostic',
    ),
    suggestions: diagnostic.suggestions?.map(
      suggestion =>
        localizeSkillNarrative(
          suggestion,
          outputLanguage,
          'diagnostic',
        ) || suggestion,
    ),
    sourceNarrative: {
      message: diagnostic.message,
      diagnosis: diagnostic.diagnosis,
      suggestions: diagnostic.suggestions,
    },
  }));
}

export function localizeSkillLayeredResult<T extends {
  layers?: Record<string, unknown>;
  stepResults?: unknown[];
}>(
  skillId: string,
  layeredResult: T | undefined,
  outputLanguage: OutputLanguage,
  options: SkillLocalizationOptions = {},
): T | undefined {
  if (!layeredResult) return layeredResult;
  const skill = getCatalogSkill(skillId, options);
  if (!skill) return layeredResult;

  const projectStep = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const raw = value as Record<string, unknown>;
    const stepId = typeof raw.stepId === 'string' ? raw.stepId : undefined;
    const step = catalogStep(skill, stepId, outputLanguage);
    const display = raw.display && typeof raw.display === 'object'
      ? raw.display as Record<string, unknown>
      : undefined;
    return {
      ...raw,
      data: localizeDisplayData(raw.data, step, outputLanguage),
      ...(display
        ? {
            display: {
              ...display,
              title: step.title[outputLanguage],
              columns: localizeColumnDefinitions(
                display.columns,
                step,
                outputLanguage,
              ),
            },
          }
        : {}),
      emptyMessage:
        typeof raw.emptyMessage === 'string'
          ? localizeSkillNarrative(
              raw.emptyMessage,
              outputLanguage,
              'execution',
            )
          : raw.emptyMessage,
      ...(typeof raw.emptyMessage === 'string'
        ? {sourceEmptyMessage: raw.emptyMessage}
        : {}),
    };
  };

  const projectRecord = (value: unknown, depth: number): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        depth > 1 ? projectStep(entry) : projectRecord(entry, depth + 1),
      ]),
    );
  };

  const layers = layeredResult.layers || {};
  const projectedLayers = Object.fromEntries(
    Object.entries(layers).map(([layer, value]) => [
      layer,
      layer === 'session' || layer === 'deep'
        ? projectRecord(value, 1)
        : projectRecord(value, 2),
    ]),
  );
  return {
    ...layeredResult,
    layers: projectedLayers,
    ...(Array.isArray(layeredResult.stepResults)
      ? {stepResults: layeredResult.stepResults.map(projectStep)}
      : {}),
  };
}

export function assertBuiltInSkillLocalizationCoverage(
  skills: SkillDefinition[],
): void {
  const catalog = loadCatalog();
  const expected = new Set(skills.map(skill => skill.name));
  const actual = new Set(Object.keys(catalog.skills));
  const missing = [...expected].filter(skillId => !actual.has(skillId)).sort();
  const stale = [...actual].filter(skillId => !expected.has(skillId)).sort();
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Skill localization catalog coverage mismatch; ` +
      `missing=[${missing.join(', ')}], stale=[${stale.join(', ')}].`,
    );
  }
}

export function skillLocalizationInventory(): SkillLocalizationCatalog['inventory'] {
  return {...loadCatalog().inventory};
}

export function resetSkillLocalizationCatalogForTests(): void {
  cachedCatalog = undefined;
}

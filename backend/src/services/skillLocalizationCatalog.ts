// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The localized text a Skill shows, in both languages: what
// skills/localization.catalog.json records for a built-in Skill and what the
// wording checks read for any Skill, overlay or proposal. Authored text in a
// language wins (an *_i18n translation first, then authored text in that
// language); otherwise the stable identifier is humanized.

import type {
  AuthoredTranslations,
  DisplayConfig,
  SkillDefinition,
  SkillStep,
  SynthesizeConfig,
} from './skillEngine/types';
import {humanizeSkillIdentifier} from './skillLocalizationLabels';

export interface LocalizedText {
  'zh-CN': string;
  en: string;
}

export interface CatalogColumn {
  label: LocalizedText;
  tooltip?: LocalizedText;
}

export interface CatalogStep {
  title: LocalizedText;
  description?: LocalizedText;
  columns: Record<string, CatalogColumn>;
  synthesizeLabels: Record<string, LocalizedText>;
}

export interface CatalogSkill {
  displayName: LocalizedText;
  description: LocalizedText;
  type: string;
  steps: Record<string, CatalogStep>;
}

/** skills/localization.catalog.json: the catalog entry of every built-in Skill. */
export interface SkillLocalizationCatalog {
  schemaVersion: 1;
  generationPolicy?: {
    sourceOfTruth: string;
    stableIdentifiersRemainUntranslated: boolean;
    inferredSchemaLabelsUseLocaleHumanizer: boolean;
    authoredNarrativeRemainsVerbatim: boolean;
  };
  inventory: {
    skillCount: number;
    pipelineDefinitionCount: number;
    moduleExpertCount: number;
    stepCount: number;
    explicitColumnCount: number;
  };
  skills: Record<string, CatalogSkill>;
}

/** The catalog step that holds a Skill's own display name and output columns. */
export const CATALOG_ROOT_STEP = 'root';
/** The catalog step that titles a Skill's synthesized insight summary. */
export const CATALOG_SYNTHESIZE_SUMMARY_STEP = '__synthesize_summary__';

/** Whether text is written in Chinese: the catalog files authored text under zh-CN by it. */
export const HAN_RE = /\p{Script=Han}/u;

function sentence(text: unknown): string {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

/** A stable identifier as a label in each language. */
function humanized(value: string): LocalizedText {
  return {
    'zh-CN': humanizeSkillIdentifier(value, 'zh-CN') || value.trim() || '未命名',
    en: humanizeSkillIdentifier(value, 'en') || value.trim() || 'Untitled',
  };
}

/** An authored translation, when it is a string; the display contract reports a malformed one. */
function translation(translations: AuthoredTranslations | undefined, language: keyof LocalizedText): string | undefined {
  const value: unknown = translations && typeof translations === 'object' ? translations[language] : undefined;
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Authored text in each language: an explicit translation first, else the
 * authored source when it is in that language, else a fallback.
 */
function localizedText(
  authored: unknown,
  translations: AuthoredTranslations | undefined,
  fallback: LocalizedText,
): LocalizedText {
  const source = sentence(authored);
  return {
    'zh-CN': translation(translations, 'zh-CN') ?? (source && HAN_RE.test(source) ? source : fallback['zh-CN']),
    en: translation(translations, 'en') ?? (source && !HAN_RE.test(source) ? source : fallback.en),
  };
}

/** A title or label: authored text, else the humanized identifier. */
function localizedLabel(authored: unknown, stableId: string, translations?: AuthoredTranslations): LocalizedText {
  return localizedText(authored, translations, humanized(stableId));
}

function localizedDescription(authored: unknown, stableId: string, translations?: AuthoredTranslations): LocalizedText {
  const name = humanized(stableId);
  return localizedText(authored, translations, {
    'zh-CN': `基于 Trace 指标与证据分析${name['zh-CN']}。`,
    en: `Analyzes ${name.en} using trace metrics and supporting evidence.`,
  });
}

function localizedTooltip(authored: unknown, label: LocalizedText): LocalizedText {
  return localizedText(authored, undefined, {'zh-CN': `字段：${label['zh-CN']}`, en: `Column: ${label.en}`});
}

function emptyStep(title: LocalizedText): CatalogStep {
  return {
    title,
    columns: {},
    synthesizeLabels: {},
  };
}

function collectColumns(step: CatalogStep, display: DisplayConfig | boolean | undefined): void {
  if (!display || typeof display !== 'object' || !Array.isArray(display.columns)) return;
  for (const entry of display.columns) {
    const column = typeof entry === 'string' ? {name: entry, label: entry} : entry;
    if (typeof column?.name !== 'string' || !column.name) continue;
    const label = localizedLabel(column.label, column.name, column.label_i18n);
    step.columns[column.name] = {
      label,
      ...(column.tooltip ? {tooltip: localizedTooltip(column.tooltip, label)} : {}),
    };
  }
}

function collectSynthesizeLabels(
  step: CatalogStep,
  synthesize: boolean | SynthesizeConfig | undefined,
): void {
  if (!synthesize || typeof synthesize !== 'object') return;
  for (const field of Array.isArray(synthesize.fields) ? synthesize.fields : []) {
    if (!field?.key) continue;
    step.synthesizeLabels[`field:${field.key}`] = localizedLabel(field.label, field.key, field.label_i18n);
  }
  for (const group of Array.isArray(synthesize.groupBy) ? synthesize.groupBy : []) {
    if (!group?.field) continue;
    step.synthesizeLabels[`group:${group.field}`] = localizedLabel(group.title, group.field);
  }
  const cluster = synthesize.clusterBy;
  if (typeof cluster === 'object' && cluster?.field) {
    step.synthesizeLabels[`cluster:${cluster.field}`] = localizedLabel(
      cluster.label,
      cluster.field,
    );
  }
}

function nestedSteps(step: SkillStep): SkillStep[] {
  const value = step as SkillStep & {steps?: SkillStep[]};
  return Array.isArray(value.steps) ? value.steps : [];
}

function skillDisplayName(skill: SkillDefinition): LocalizedText {
  return localizedLabel(skill.meta?.display_name, skill.name, skill.meta?.display_name_i18n);
}

function collectSteps(skill: SkillDefinition): Record<string, CatalogStep> {
  const result: Record<string, CatalogStep> = {
    [CATALOG_ROOT_STEP]: emptyStep(skillDisplayName(skill)),
    [CATALOG_SYNTHESIZE_SUMMARY_STEP]: emptyStep({
      'zh-CN': '洞见摘要',
      en: 'Insight Summary',
    }),
  };

  const visit = (steps: SkillStep[]): void => {
    for (const definition of steps) {
      const raw = definition as SkillStep & {
        id?: string;
        name?: string;
        description?: string;
        display?: DisplayConfig | boolean;
        synthesize?: boolean | SynthesizeConfig;
      };
      const stepId = String(raw.id || '').trim();
      if (!stepId) continue;
      const displayTitle = typeof raw.display === 'object'
        ? raw.display.title
        : undefined;
      const entry = result[stepId] || emptyStep(
        localizedLabel(displayTitle || raw.name, stepId,
          typeof raw.display === 'object' ? raw.display.title_i18n : undefined),
      );
      if (typeof raw.description === 'string' && raw.description.trim()) {
        entry.description = localizedDescription(raw.description, stepId);
      }
      collectColumns(entry, raw.display);
      collectSynthesizeLabels(entry, raw.synthesize);
      result[stepId] = entry;
      visit(nestedSteps(definition));
    }
  };

  visit(Array.isArray(skill.steps) ? skill.steps : []);
  // The loader moves a legacy top-level display to output.display; read either.
  collectColumns(result[CATALOG_ROOT_STEP],
    skill.output?.display ?? (skill as SkillDefinition & {display?: DisplayConfig}).display);
  for (const field of Array.isArray(skill.output?.fields) ? skill.output.fields : []) {
    if (!field?.name) continue;
    result[CATALOG_ROOT_STEP].columns[field.name] = {
      label: localizedLabel(field.label, field.name),
    };
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** The catalog entry of `skill`: every text it shows, in both languages. */
export function skillCatalogEntry(skill: SkillDefinition): CatalogSkill {
  return {
    displayName: skillDisplayName(skill),
    description: localizedDescription(skill.meta?.description, skill.name, skill.meta?.description_i18n),
    type: skill.type,
    steps: collectSteps(skill),
  };
}

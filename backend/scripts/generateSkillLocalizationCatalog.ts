// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {
  ensureSkillRegistryInitialized,
  skillRegistry,
} from '../src/services/skillEngine/skillLoader';
import type {
  AuthoredTranslations,
  DisplayConfig,
  SkillDefinition,
  SkillStep,
  SynthesizeConfig,
} from '../src/services/skillEngine/types';
import {humanizeSkillIdentifier} from '../src/services/skillLocalizationLabels';
import {validateSkillDisplayContract} from '../src/services/skillEngine/displayContractValidator';

type OutputLanguage = 'zh-CN' | 'en';

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
  generationPolicy: {
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

const OUTPUT_PATH = path.resolve(__dirname, '../skills/localization.catalog.json');
const HAN_RE = /\p{Script=Han}/u;
function sentence(text: unknown): string {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

function humanizeIdentifier(value: string): string {
  return humanizeSkillIdentifier(value, 'en') || value.trim() || 'Untitled';
}

function humanizeIdentifierZh(value: string): string {
  return humanizeSkillIdentifier(value, 'zh-CN') || value.trim() || '未命名';
}

/**
 * Authored text in each language: an explicit translation first, else the
 * authored source when it is in that language, else a fallback. The display
 * contract has already rejected malformed translations.
 */
function localizedText(
  authored: unknown,
  translations: AuthoredTranslations | undefined,
  fallback: LocalizedText,
): LocalizedText {
  const source = sentence(authored);
  return {
    'zh-CN': translations?.['zh-CN']?.trim() ?? (source && HAN_RE.test(source) ? source : fallback['zh-CN']),
    en: translations?.en?.trim() ?? (source && !HAN_RE.test(source) ? source : fallback.en),
  };
}

function localizedTitle(authored: unknown, stableId: string, titles?: AuthoredTranslations): LocalizedText {
  return localizedText(authored, titles, {'zh-CN': humanizeIdentifierZh(stableId), en: humanizeIdentifier(stableId)});
}

function localizedDescription(authored: unknown, stableId: string, translations?: AuthoredTranslations): LocalizedText {
  return localizedText(authored, translations, {
    'zh-CN': `基于 Trace 指标与证据分析${humanizeIdentifierZh(stableId)}。`,
    en: `Analyzes ${humanizeIdentifier(stableId)} using trace metrics and supporting evidence.`,
  });
}

function localizedLabel(authored: unknown, stableId: string): LocalizedText {
  const source = sentence(authored);
  return {
    'zh-CN': source && HAN_RE.test(source) ? source : humanizeIdentifierZh(stableId),
    en: source && !HAN_RE.test(source) ? source : humanizeIdentifier(stableId),
  };
}

function localizedTooltip(authored: unknown, label: LocalizedText): LocalizedText {
  const source = sentence(authored);
  return {
    'zh-CN':
      source && HAN_RE.test(source) ? source : `字段：${label['zh-CN']}`,
    en:
      source && !HAN_RE.test(source) ? source : `Column: ${label.en}`,
  };
}

function skillDisplayName(skill: SkillDefinition): LocalizedText {
  return localizedTitle(skill.meta.display_name, skill.name, skill.meta.display_name_i18n);
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
  for (const column of display.columns) {
    const name = typeof column === 'string'
      ? column
      : typeof column?.name === 'string'
        ? column.name
        : '';
    if (!name) continue;
    const authoredLabel = typeof column === 'string' ? column : column.label;
    const label = localizedLabel(authoredLabel, name);
    step.columns[name] = {
      label,
      ...(typeof column === 'object' && column.tooltip
        ? {tooltip: localizedTooltip(column.tooltip, label)}
        : {}),
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
    step.synthesizeLabels[`field:${field.key}`] = localizedLabel(field.label, field.key);
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

function collectSteps(skill: SkillDefinition): Record<string, CatalogStep> {
  const result: Record<string, CatalogStep> = {
    root: emptyStep(skillDisplayName(skill)),
    __synthesize_summary__: emptyStep({
      'zh-CN': '洞见摘要',
      en: 'Insight Summary',
    }),
  };

  const visit = (steps: SkillStep[]): void => {
    for (const definition of steps) {
      const raw = definition as SkillStep & {
        id?: string;
        name?: string;
        display?: DisplayConfig | boolean;
        synthesize?: boolean | SynthesizeConfig;
      };
      const stepId = String(raw.id || '').trim();
      if (!stepId) continue;
      const displayTitle = typeof raw.display === 'object'
        ? raw.display.title
        : undefined;
      const entry = result[stepId] || emptyStep(
        localizedTitle(displayTitle || raw.name, stepId,
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

  visit(skill.steps || []);
  collectColumns(result.root, skill.output?.display);
  for (const field of skill.output?.fields || []) {
    if (!field?.name) continue;
    result.root.columns[field.name] = {
      label: localizedLabel(field.label, field.name),
    };
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildCatalog(skills: SkillDefinition[]): SkillLocalizationCatalog {
  for (const skill of skills) {
    const invalidTitles = validateSkillDisplayContract(skill).filter(issue => issue.field.endsWith('_i18n'));
    if (invalidTitles.length) throw new Error(invalidTitles.map(issue => `${skill.name}: ${issue.path}: ${issue.message}`).join('\n'));
  }
  const orderedSkills = [...skills].sort((left, right) =>
    left.name.localeCompare(right.name));
  const catalogSkills: Record<string, CatalogSkill> = {};
  let stepCount = 0;
  let explicitColumnCount = 0;

  for (const skill of orderedSkills) {
    const displayName = skillDisplayName(skill);
    const steps = collectSteps(skill);
    stepCount += Object.keys(steps).length;
    explicitColumnCount += Object.values(steps)
      .reduce((total, step) => total + Object.keys(step.columns).length, 0);
    catalogSkills[skill.name] = {
      displayName,
      description: localizedDescription(skill.meta.description, skill.name, skill.meta.description_i18n),
      type: skill.type,
      steps,
    };
  }

  return {
    schemaVersion: 1,
    generationPolicy: {
      sourceOfTruth: 'backend/skills/**/*.skill.yaml and generated built-in Skills',
      stableIdentifiersRemainUntranslated: true,
      inferredSchemaLabelsUseLocaleHumanizer: true,
      authoredNarrativeRemainsVerbatim: true,
    },
    inventory: {
      skillCount: orderedSkills.length,
      pipelineDefinitionCount: orderedSkills
        .filter(skill => skill.type === 'pipeline_definition').length,
      moduleExpertCount: orderedSkills.filter(skill => Boolean(skill.module)).length,
      stepCount,
      explicitColumnCount,
    },
    skills: catalogSkills,
  };
}

async function main(): Promise<void> {
  await ensureSkillRegistryInitialized();
  const catalog = buildCatalog(
    skillRegistry.getAllSkills().filter(skill =>
      skillRegistry.getSkillOrigin(skill.name)?.origin !== 'external_pack'),
  );
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    const current = fs.existsSync(OUTPUT_PATH)
      ? fs.readFileSync(OUTPUT_PATH, 'utf8')
      : '';
    if (current !== content) {
      console.error(
        'Skill localization catalog is stale. Run: npm run generate:skill-localizations',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Skill localization catalog verified: ${catalog.inventory.skillCount} Skills, ` +
      `${catalog.inventory.pipelineDefinitionCount} pipelines, ` +
      `${catalog.inventory.stepCount} display steps.`,
    );
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(
    `Generated ${path.relative(process.cwd(), OUTPUT_PATH)} for ` +
    `${catalog.inventory.skillCount} Skills and ` +
    `${catalog.inventory.pipelineDefinitionCount} pipelines.`,
  );
}

void main();

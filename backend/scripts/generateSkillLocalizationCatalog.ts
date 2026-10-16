// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {
  ensureSkillRegistryInitialized,
  skillRegistry,
} from '../src/services/skillEngine/skillLoader';
import type {SkillDefinition} from '../src/services/skillEngine/types';
import {validateSkillDisplayContract} from '../src/services/skillEngine/displayContractValidator';
import {skillCatalogEntry, type CatalogSkill, type SkillLocalizationCatalog} from '../src/services/skillLocalizationCatalog';

const OUTPUT_PATH = path.resolve(__dirname, '../skills/localization.catalog.json');

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
    const entry = skillCatalogEntry(skill);
    stepCount += Object.keys(entry.steps).length;
    explicitColumnCount += Object.values(entry.steps)
      .reduce((total, step) => total + Object.keys(step.columns).length, 0);
    catalogSkills[skill.name] = entry;
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// skills/identity-policy.catalog.json: the effective process-identity policy
// of every built-in Skill, as identityGate.ts decides it. Perfetto-Skills
// exports each Skill with this policy; reading it here keeps one
// implementation of the decision (sqlUsesProcessNameFilter's structural SQL
// reading) instead of a second one in the exporter.

import fs from 'fs';
import path from 'path';
import {ensureSkillRegistryInitialized, skillRegistry} from '../src/services/skillEngine/skillLoader';
import {getEffectiveIdentityConfig} from '../src/services/processIdentity/identityGate';
import {getPerfettoSqlDocsAssetPath, loadPerfettoSqlDocsAsset} from '../src/services/perfettoSqlDocs';

const OUTPUT_PATH = path.resolve(__dirname, '../skills/identity-policy.catalog.json');

async function main(): Promise<void> {
  // Table columns come from these docs; without them every table may have any
  // column, and the policies would be decided on guesses rather than schema.
  if (!loadPerfettoSqlDocsAsset()) {
    console.error(`Perfetto SQL docs are missing or invalid: ${getPerfettoSqlDocsAssetPath()}. Run: npm run stdlib:generate-runtime-assets`);
    process.exitCode = 1;
    return;
  }
  await ensureSkillRegistryInitialized();
  const skills = skillRegistry.getAllSkills()
    .filter(skill => skillRegistry.getSkillOrigin(skill.name)?.origin !== 'external_pack')
    .sort((left, right) => left.name.localeCompare(right.name));
  const catalog = {
    schemaVersion: 1,
    source: 'processIdentity getEffectiveIdentityConfig',
    skills: Object.fromEntries(skills.map(skill => [skill.name, getEffectiveIdentityConfig(skill)])),
  };
  const content = `${JSON.stringify(catalog, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== content) {
      console.error('Skill identity policy catalog is stale. Run: npm run generate:skill-identity-policies');
      process.exitCode = 1;
      return;
    }
    console.log(`Skill identity policy catalog verified: ${skills.length} Skills.`);
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(`Generated ${path.relative(process.cwd(), OUTPUT_PATH)} for ${skills.length} Skills.`);
}

void main();

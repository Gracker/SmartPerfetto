// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Trace/skill-sql.inventory.json: the SQL every built-in Skill runs, as the
// runtime's readers see it (skillSqlInventory.ts). The Trace corpus tooling
// reads this file instead of re-deriving the units, scope bindings,
// placeholders, result columns and read-only SQL with private copies.

import fs from 'fs';
import path from 'path';
import {buildSkillSqlInventory} from '../src/services/skillEngine/skillSqlInventory';
import {builtInSkillsDir, readSkillFragments} from '../src/services/skillEngine/skillFragments';

const REPO_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'Trace/skill-sql.inventory.json');

function main(): void {
  const skillsDir = builtInSkillsDir();
  const inventory = buildSkillSqlInventory({repoRoot: REPO_ROOT, skillsDir, fragments: readSkillFragments(skillsDir)});
  const content = `${JSON.stringify(inventory, null, 2)}\n`;
  const skillCount = Object.keys(inventory.skills).length;
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== content) {
      console.error('Skill SQL inventory is stale. Run: npm run generate:skill-sql-inventory');
      process.exitCode = 1;
      return;
    }
    console.log(`Skill SQL inventory verified: ${skillCount} Skills.`);
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(`Generated ${path.relative(process.cwd(), OUTPUT_PATH)} for ${skillCount} Skills.`);
}

main();

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

// The contract is read from Trace/skill-sql.inventory.json; how the backend
// derives each fact is tested with its readers
// (backend/src/services/skillEngine/__tests__/skillSqlInventory.test.ts).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {INVENTORY_FILE, loadSkillSqlInventory, skillSqlContract} = require('../lib/skill-sql-contract.cjs');

const unit = (fields) => ({
  at: 'steps[0].sql', top_level_index: 0, sha256: 'a'.repeat(64), required_columns: [], has_condition: false,
  read_only: true, placeholders: [], process_scope_valid: null, forceable: true, ...fields,
});

test('reads root SQL as the root SQL id and a metadata-only Skill as no SQL', () => {
  const root = skillSqlContract({top_level_steps: [], unexecuted_sql: false, declared_modules: [],
    units: [unit({id: 'root', at: 'sql', top_level_index: null})]});
  assert.equal(root.hasRootSql, true);
  assert.equal(root.hasStepSql, false);
  assert.deepEqual(root.sqlIds, ['root']);
  assert.equal(root.lastSqlTopLevelIndex, -1);
  const metadata = skillSqlContract({top_level_steps: [], unexecuted_sql: false, declared_modules: [], units: []});
  assert.deepEqual(metadata.sqlIds, []);
  assert.deepEqual(metadata.topLevelStepIds, []);
});

test('splits conditional SQL into forced probes and production-branch skips', () => {
  const contract = skillSqlContract({
    top_level_steps: ['setup', 'parallel', null], unexecuted_sql: false, declared_modules: ['android.frames.timeline'],
    units: [
      unit({id: 'setup'}),
      unit({id: 'read_branch', top_level_index: 1, has_condition: true}),
      unit({id: 'write_branch', top_level_index: 1, has_condition: true, read_only: false, forceable: false}),
      unit({id: null, top_level_index: 2, required_columns: ['n']}),
    ],
  });
  assert.deepEqual(contract.sqlIds, ['setup', 'read_branch', 'write_branch']);
  assert.deepEqual(contract.forcedSqlStepIds, ['read_branch']);
  assert.deepEqual(contract.conditionOnlySqlStepIds, ['write_branch']);
  assert.equal(contract.lastSqlTopLevelIndex, 2);
  assert.deepEqual(contract.topLevelStepIds, ['setup', 'parallel', null]);
  assert.deepEqual(contract.declaredModules, ['android.frames.timeline']);
  assert.deepEqual(contract.sqlSourceSteps.at(-1), {id: undefined, sha256: 'a'.repeat(64), requiredColumns: ['n']});
});

test('carries SQL the executor never runs so the catalog can reject it', () => {
  assert.equal(skillSqlContract({units: [], top_level_steps: [], unexecuted_sql: true}).unexecutedSql, true);
});

test('refuses a missing or foreign inventory with the command that regenerates it', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sql-inventory-'));
  assert.throws(() => loadSkillSqlInventory(repoRoot), /generate:skill-sql-inventory/);
  fs.mkdirSync(path.join(repoRoot, 'Trace'));
  fs.writeFileSync(path.join(repoRoot, INVENTORY_FILE), JSON.stringify({schemaVersion: 2, layout: {}, skills: {}}));
  assert.throws(() => loadSkillSqlInventory(repoRoot), /unsupported schema/);
});

test('the committed inventory lists every Skill with its source file', () => {
  const inventory = loadSkillSqlInventory(path.resolve(__dirname, '../../..'));
  const entries = Object.entries(inventory.skills);
  assert.ok(entries.length > 0);
  for (const [name, entry] of entries) {
    assert.ok(entry.source_file.startsWith(`${inventory.layout.skills_root}/`), `${name}: ${entry.source_file}`);
  }
});

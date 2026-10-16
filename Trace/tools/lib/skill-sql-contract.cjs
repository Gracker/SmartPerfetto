// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

// The SQL contract of each built-in Skill, read from the committed
// Trace/skill-sql.inventory.json. The backend generates it with the readers
// the runtime and the validator use (backend/src/services/skillEngine/
// skillSqlInventory.ts: executableSqlUnits, sqlScopeDeclarationError,
// boundSqlPlaceholders, the structural SQL readers, SKILL_LAYOUT), and
// `validate:skills` fails when it is stale. This file only reads it: it keeps
// no SQL parser, unit walk or scope check of its own, so the tooling runs on a
// clean checkout without the TypeScript build.

const fs = require('node:fs');
const path = require('node:path');

const INVENTORY_FILE = 'Trace/skill-sql.inventory.json';
const INVENTORY_SCHEMA_VERSION = 1;

function loadSkillSqlInventory(repoRoot) {
  const filePath = path.join(repoRoot, INVENTORY_FILE);
  let inventory;
  try {
    inventory = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${INVENTORY_FILE} is missing or invalid (run: npm --prefix backend run generate:skill-sql-inventory): ${error.message}`);
  }
  if (inventory?.schemaVersion !== INVENTORY_SCHEMA_VERSION || !inventory.skills || !inventory.layout) {
    throw new Error(`${INVENTORY_FILE} has an unsupported schema; run: npm --prefix backend run generate:skill-sql-inventory`);
  }
  return inventory;
}

/**
 * The contract the corpus checks of one inventory entry: the SQL the executor
 * runs as written (root SQL, or each SQL step at any depth with its top-level
 * step), its hashes and result columns, and which conditional SQL the corpus
 * may force (read-only, every placeholder resolvable) or must leave to its
 * production branch.
 */
function skillSqlContract(entry) {
  const units = Array.isArray(entry?.units) ? entry.units : [];
  const rootUnit = units.find((unit) => unit.id === 'root');
  const sqlSteps = units.filter((unit) => unit !== rootUnit).map((unit) => ({
    id: unit.id ?? undefined,
    topLevelIndex: unit.top_level_index,
    hasCondition: unit.has_condition === true,
    forceable: unit.forceable === true,
    requiredColumns: unit.required_columns,
  }));
  const conditional = (forceable) => sqlSteps
    .filter((step) => step.hasCondition && step.forceable === forceable)
    .map((step) => step.id)
    .filter(Boolean);
  const topLevelIndexes = sqlSteps.map((step) => step.topLevelIndex);
  return {
    hasRootSql: Boolean(rootUnit),
    hasStepSql: sqlSteps.length > 0,
    unexecutedSql: entry?.unexecuted_sql === true,
    topLevelStepIds: Array.isArray(entry?.top_level_steps) ? entry.top_level_steps : [],
    sqlSteps,
    sqlIds: [...(rootUnit ? ['root'] : []), ...sqlSteps.map((step) => step.id).filter(Boolean)],
    sqlSourceSteps: units.map((unit) => ({
      id: unit.id ?? undefined,
      sha256: unit.sha256,
      requiredColumns: unit.required_columns,
    })),
    declaredModules: Array.isArray(entry?.declared_modules) ? entry.declared_modules : [],
    forcedSqlStepIds: conditional(true),
    conditionOnlySqlStepIds: conditional(false),
    lastSqlTopLevelIndex: topLevelIndexes.length > 0 ? Math.max(...topLevelIndexes) : -1,
  };
}

module.exports = {INVENTORY_FILE, loadSkillSqlInventory, skillSqlContract};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {isReadOnlySql, skillSqlContract} = require('../lib/skill-sql-contract.cjs');

test('root atomic SQL is executable instead of definition-only', () => {
  const contract = skillSqlContract({type: 'atomic', sql: 'SELECT 1'});
  assert.equal(contract.hasRootSql, true);
  assert.deepEqual(contract.sqlIds, ['root']);
  assert.deepEqual(contract.forcedSqlStepIds, []);
});

test('conditional probes include only read-only SQL and recurse into nested steps', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [
      {id: 'setup', type: 'atomic', sql: 'SELECT 1'},
      {
        id: 'parallel',
        type: 'parallel',
        steps: [
          {id: 'read_branch', type: 'atomic', condition: 'enabled', sql: 'WITH x AS (SELECT 1) SELECT * FROM x'},
          {id: 'write_branch', type: 'atomic', condition: 'replace', sql: 'DROP VIEW IF EXISTS x'},
        ],
      },
    ],
  });

  assert.deepEqual(contract.sqlIds, ['setup', 'read_branch', 'write_branch']);
  assert.deepEqual(contract.forcedSqlStepIds, ['read_branch']);
  assert.deepEqual(contract.conditionOnlySqlStepIds, ['write_branch']);
  assert.equal(contract.lastSqlTopLevelIndex, 1);
});

test('metadata-only definitions have no executable SQL contract', () => {
  const contract = skillSqlContract({type: 'pipeline_definition'});
  assert.equal(contract.hasRootSql, false);
  assert.deepEqual(contract.steps, []);
  assert.deepEqual(contract.sqlIds, []);
});

test('forces read-only SQL when its context is produced by an earlier step', () => {
  const contract = skillSqlContract({
    type: 'composite',
    inputs: [{name: 'limit', type: 'integer'}],
    steps: [
      {id: 'summary', type: 'atomic', sql: 'SELECT 1 AS value', save_as: 'summary'},
      {
        id: 'dependent_query',
        type: 'atomic',
        condition: 'summary.data.length > 0',
        sql: 'SELECT * FROM (${summary}) LIMIT ${limit}',
      },
    ],
  });
  assert.deepEqual(contract.forcedSqlStepIds, ['dependent_query']);
  assert.deepEqual(contract.conditionOnlySqlStepIds, []);
});

test('does not force conditional SQL with unresolved context', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [{
      id: 'dependent_query',
      type: 'atomic',
      condition: 'summary.data.length > 0',
      sql: 'SELECT * FROM (${summary.data[0].query})',
    }],
  });
  assert.deepEqual(contract.forcedSqlStepIds, []);
  assert.deepEqual(contract.conditionOnlySqlStepIds, ['dependent_query']);
});

test('does not classify data-changing CTE statements as read-only', () => {
  assert.equal(isReadOnlySql('WITH doomed AS (SELECT id FROM x) DELETE FROM x WHERE id IN doomed'), false);
  assert.equal(isReadOnlySql('WITH rows AS (SELECT 1) SELECT * FROM rows'), true);
});

test('keeps root and step SQL visible so hybrid definitions can be rejected', () => {
  const contract = skillSqlContract({
    type: 'atomic',
    sql: 'SELECT 1',
    steps: [{id: 'hidden_step', type: 'atomic', sql: 'SELECT 2'}],
  });
  assert.equal(contract.hasRootSql, true);
  assert.equal(contract.hasStepSql, true);
  assert.deepEqual(contract.sqlIds, ['root', 'hidden_step']);
});

test('records exact SQL hashes, declared modules, and result columns from source', () => {
  const rootSql = 'SELECT 1 AS status';
  const contract = skillSqlContract({
    type: 'atomic',
    prerequisites: {modules: ['android.frames.timeline']},
    display: {
      columns: [
        {name: 'status', type: 'number'},
        {name: 'label', type: 'string'},
      ],
    },
    sql: rootSql,
  });

  assert.deepEqual(contract.declaredModules, ['android.frames.timeline']);
  assert.deepEqual(contract.sqlSourceSteps, [{
    id: 'root',
    sha256: crypto.createHash('sha256').update(rootSql).digest('hex'),
    requiredColumns: ['status', 'label'],
  }]);
});

test('derives result columns from the outer SQL projection when display metadata is absent', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [{
      id: 'summary',
      type: 'atomic',
      sql: `
        WITH source AS (
          SELECT id, value FROM counter
        )
        SELECT
          source.id,
          ROUND(AVG(value), 2) AS avg_value,
          COUNT(*) call_count,
          'stable' AS status
        FROM source
        GROUP BY source.id
      `,
    }],
  });

  assert.deepEqual(
    contract.sqlSourceSteps[0].requiredColumns,
    ['id', 'avg_value', 'call_count', 'status'],
  );
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace/skill-sql.inventory.json is the Trace corpus tooling's only view of
 * Skill SQL. These cases were the tooling's own tests when it re-derived the
 * contract with private copies; they now hold the readers the runtime uses.
 */

import crypto from 'crypto';
import fs from 'fs';
import yaml from 'js-yaml';
import { describe, expect, it } from '@jest/globals';
import { executableSqlUnits } from '../processScopeSql';
import { builtInSkillsDir } from '../skillFragments';
import { listSkillFiles } from '../skillLayout';
import { skillSqlInventoryEntry, type SkillSqlInventorySkill } from '../skillSqlInventory';
import { sqlIsReadOnly, sqlResultColumns } from '../sqlStructure';
import { withStepFragments } from '../../../../tests/helpers/skillFragmentSql';

const EFFECTIVE = 'fragments/effective_target_processes.sql';
const fragments = new Map([[EFFECTIVE, 'effective_target_processes AS (SELECT upid FROM process WHERE upid = ${__process_scope.upid})']]);
const entry = (definition: Record<string, unknown>): SkillSqlInventorySkill =>
  skillSqlInventoryEntry(definition, { file: 'backend/skills/atomic/x.skill.yaml', text: 'name: x\n' }, fragments);
/** The step ids the corpus may force, and the conditional ones it must leave to their branch. */
const conditional = (skill: SkillSqlInventorySkill) => ({
  forced: skill.units.filter(unit => unit.has_condition && unit.forceable).map(unit => unit.id),
  conditionOnly: skill.units.filter(unit => unit.has_condition && !unit.forceable).map(unit => unit.id),
});

describe('Skill SQL inventory', () => {
  it('lists root SQL as the root unit, and a metadata-only Skill as no SQL', () => {
    expect(entry({ type: 'atomic', sql: 'SELECT 1' }).units.map(unit => unit.id)).toEqual(['root']);
    const metadata = entry({ type: 'pipeline_definition' });
    expect(metadata).toMatchObject({ execution: 'none', top_level_steps: [], units: [], unexecuted_sql: false });
  });

  it('forces only read-only conditional SQL, at any depth, under its top-level step', () => {
    const skill = entry({
      type: 'composite',
      steps: [
        { id: 'setup', type: 'atomic', sql: 'SELECT 1' },
        { id: 'parallel', type: 'parallel', steps: [
          { id: 'read_branch', type: 'atomic', condition: 'enabled', sql: 'WITH x AS (SELECT 1) SELECT * FROM x' },
          { id: 'write_branch', type: 'atomic', condition: 'replace', sql: 'DROP VIEW IF EXISTS x' },
        ] },
      ],
    });
    expect(skill.units.map(unit => [unit.id, unit.top_level_index])).toEqual([['setup', 0], ['read_branch', 1], ['write_branch', 1]]);
    expect(conditional(skill)).toEqual({ forced: ['read_branch'], conditionOnly: ['write_branch'] });
  });

  it('forces SQL whose placeholders read an input or an earlier step, and no other', () => {
    const dependent = (sql: string) => entry({
      type: 'composite', inputs: [{ name: 'limit', type: 'integer' }],
      steps: [
        { id: 'summary', type: 'atomic', sql: 'SELECT 1 AS value', save_as: 'summary' },
        { id: 'dependent_query', type: 'atomic', condition: 'summary.data.length > 0', sql },
      ],
    });
    expect(conditional(dependent('SELECT * FROM (${summary}) LIMIT ${limit}')).forced).toEqual(['dependent_query']);
    expect(conditional(dependent('SELECT * FROM (${later.data[0].query})')).conditionOnly).toEqual(['dependent_query']);
    // A placeholder in a comment is never bound.
    expect(conditional(dependent('SELECT 1 -- ${later}')).forced).toEqual(['dependent_query']);
  });

  it('forces the trusted UPID only under a declaration that binds it', () => {
    const steps = [
      { id: 'metadata', type: 'atomic', condition: 'false', process_scope: { role: 'identity_metadata' },
        sql: 'SELECT ${__process_scope.upid} AS selected_upid' },
      { id: 'native', type: 'atomic', condition: 'false', process_scope: { role: 'target', binding: 'native_upid' },
        sql: 'SELECT * FROM process WHERE upid = ${__process_scope.upid}' },
      { id: 'fragment', type: 'atomic', condition: 'false',
        process_scope: { role: 'target', binding: 'effective_target_processes' }, sql_fragments: [EFFECTIVE],
        sql: 'SELECT * FROM effective_target_processes WHERE upid = ${__process_scope.upid}' },
      { id: 'fallback', type: 'atomic', condition: 'false',
        process_scope: { role: 'identity_metadata', exact_unavailable: 'No exact frame evidence' },
        sql: 'SELECT ${__process_scope.upid} IS NULL AS global_request' },
    ];
    expect(conditional(entry({ type: 'composite', steps }))).toEqual({ forced: steps.map(step => step.id), conditionOnly: [] });

    for (const process_scope of [undefined, {}, [], { role: 'unknown' }, { role: 'target' },
      { role: 'target', binding: 'unknown' }, { role: 'target', binding: 'effective_target_processes' },
      { role: 'identity_metadata', binding: 'native_upid' }, { role: 'identity_metadata', verified: true },
      { role: 'identity_metadata', exact_unavailable: '' }, { role: 'identity_metadata', context_fields: { target: ['upid'] } }]) {
      const skill = entry({ type: 'composite', inputs: [{ name: '__process_scope', type: 'object' }],
        steps: [{ id: 'setup', type: 'atomic', sql: 'SELECT 42 AS upid', save_as: '__process_scope' },
          { id: 'scope_query', type: 'atomic', condition: 'false', ...(process_scope === undefined ? {} : { process_scope }),
            sql: 'SELECT ${__process_scope.upid} AS selected_upid' }] });
      expect([process_scope, conditional(skill)]).toEqual([process_scope, { forced: [], conditionOnly: ['scope_query'] }]);
    }
    for (const token of ['${__process_scope}', '${__process_scope.other}', '${__process_scope[upid]}',
      '${__process_scope.upid|42}', '${ __process_scope.upid }']) {
      const skill = entry({ type: 'composite', steps: [{ id: 'query', type: 'atomic', condition: 'false',
        process_scope: { role: 'identity_metadata' }, sql: `SELECT ${token}` }] });
      expect([token, conditional(skill).forced]).toEqual([token, []]);
    }
    const write = entry({ type: 'composite', steps: [{ id: 'write', type: 'atomic', condition: 'false',
      process_scope: { role: 'target', binding: 'native_upid' }, sql: 'DELETE FROM process WHERE upid = ${__process_scope.upid}' }] });
    expect(conditional(write).conditionOnly).toEqual(['write']);
  });

  it('marks SQL the executor never runs instead of listing it', () => {
    const hybrid = entry({ type: 'atomic', sql: 'SELECT 1', steps: [{ id: 'hidden_step', type: 'atomic', sql: 'SELECT 2' }] });
    expect(hybrid.units.map(unit => unit.id)).toEqual(['root']);
    expect(hybrid.unexecuted_sql).toBe(true);
    expect(entry({ type: 'composite', sql: 'SELECT 1', steps: [{ id: 's', type: 'atomic', sql: 'SELECT 2' }] }).unexecuted_sql).toBe(true);
  });

  it('records exact SQL hashes, declared modules, the source hash and result columns', () => {
    const rootSql = 'SELECT 1 AS status';
    const skill = skillSqlInventoryEntry({
      type: 'atomic', prerequisites: { modules: ['android.frames.timeline', 'android.frames.timeline'] },
      display: { columns: [{ name: 'status', type: 'number' }, { name: 'label', type: 'string' }] }, sql: rootSql,
    }, { file: 'backend/skills/atomic/x.skill.yaml', text: 'name: x\r\nsql: y\r\n' }, fragments);
    expect(skill.declared_modules).toEqual(['android.frames.timeline']);
    expect(skill.source_sha256).toBe(crypto.createHash('sha256').update('name: x\nsql: y\n').digest('hex'));
    expect(skill.units[0]).toMatchObject({
      id: 'root', at: 'sql', sha256: crypto.createHash('sha256').update(rootSql).digest('hex'), required_columns: ['status', 'label'],
    });
  });
});

describe('structural SQL readers the inventory uses', () => {
  it('reads result columns from the outer projection', () => {
    expect(sqlResultColumns(`
      WITH source AS (
        SELECT id, value FROM counter
      )
      SELECT
        source.id,
        ROUND(AVG(value), 2) AS avg_value,
        COUNT(*) call_count,
        'stable' AS status,
        CASE WHEN value > 0 THEN 1 END,
        *
      FROM source
      GROUP BY source.id
    `)).toEqual(['id', 'avg_value', 'call_count', 'status']);
    // A comment before a column is no part of its name.
    expect(sqlResultColumns(`SELECT a,
      -- the limit track does the work; "no limit" is missing evidence.
      ds.has_max_limit_data
    FROM ds`)).toEqual(['a', 'has_max_limit_data']);
    expect(sqlResultColumns('SELECT "Count" AS "Count", MixedCase FROM t')).toEqual(['Count', 'MixedCase']);
    expect(sqlResultColumns('DROP VIEW x')).toEqual([]);
  });

  it('reads SQL as read-only by its code, not its literals or comments', () => {
    expect(sqlIsReadOnly('WITH doomed AS (SELECT id FROM x) DELETE FROM x WHERE id IN doomed')).toBe(false);
    expect(sqlIsReadOnly('WITH rows AS (SELECT 1) SELECT * FROM rows')).toBe(true);
    expect(sqlIsReadOnly('INCLUDE PERFETTO MODULE android.startup;\nINCLUDE PERFETTO MODULE x;\nSELECT 1')).toBe(true);
    expect(sqlIsReadOnly('CREATE PERFETTO TABLE t AS SELECT 1')).toBe(false);
    expect(sqlIsReadOnly('SELECT 1; DROP TABLE x')).toBe(false);
    // A label naming a phase is no UPDATE statement.
    expect(sqlIsReadOnly("SELECT CASE WHEN name GLOB '*updateTexImage*' THEN 'Update Texture' END AS phase FROM slice")).toBe(true);
    expect(sqlIsReadOnly('SELECT 1 /* DELETE later */')).toBe(true);
  });

  it('reads replace() as the string function and the REPLACE statement as a write', () => {
    expect(sqlIsReadOnly("SELECT REPLACE(name, 'a', 'b') FROM t")).toBe(true);
    expect(sqlIsReadOnly("SELECT substr(replace /* call */ (name, '/', ' '), 1, 4) AS owner FROM t")).toBe(true);
    expect(sqlIsReadOnly('WITH x AS (SELECT 1 AS a) REPLACE INTO t SELECT a FROM x')).toBe(false);
    // A replace() call inside the statement clears no REPLACE statement.
    expect(sqlIsReadOnly("SELECT 1; REPLACE INTO t(a) VALUES (replace('x', 'y', 'z'))")).toBe(false);
    expect(sqlIsReadOnly('SELECT 1; INSERT OR REPLACE INTO t(a) VALUES (1)')).toBe(false);
    expect(sqlIsReadOnly('CREATE OR REPLACE PERFETTO TABLE t AS SELECT 1')).toBe(false);
    // Only REPLACE names a function: a parenthesized operand clears no other writing word.
    expect(sqlIsReadOnly("SELECT 1; ATTACH ('other.db') AS other")).toBe(false);
    // Conservative: a writing word as a bare name still reads as the statement.
    expect(sqlIsReadOnly('SELECT replace FROM t')).toBe(false);
  });

  it('reads Perfetto functions that define objects or run metric SQL as writes', () => {
    expect(sqlIsReadOnly("SELECT RUN_METRIC('android/android_startup.sql')")).toBe(false);
    expect(sqlIsReadOnly("SELECT CREATE_FUNCTION('f(x INT)', 'INT', 'SELECT $x')")).toBe(false);
    expect(sqlIsReadOnly("SELECT CREATE_VIEW_FUNCTION('v(x INT)', 'y INT', 'SELECT $x AS y')")).toBe(false);
    expect(sqlIsReadOnly("SELECT 1 -- RUN_METRIC('x.sql') is not code")).toBe(true);
  });

  it('reads every built-in Skill SQL unit the same with its fragments as written', () => {
    // The inventory and the scope-isolation probe judge SQL as written: each
    // fragment is a bare CTE body placed inside that statement's WITH.
    const differing = listSkillFiles(builtInSkillsDir(), { includeCustom: true }).flatMap(({ path: file }) => {
      const definition = yaml.load(fs.readFileSync(file, 'utf8')) as any;
      return executableSqlUnits(definition).flatMap(({ path: unitPath, source }) => {
        if (typeof source.sql !== 'string' || !Array.isArray(source.sql_fragments) || source.sql_fragments.length === 0) return [];
        return sqlIsReadOnly(withStepFragments(source.sql, source.sql_fragments)) === sqlIsReadOnly(source.sql) ? [] : [`${definition.name}:${unitPath}`];
      });
    });
    expect(differing).toEqual([]);
  });
});

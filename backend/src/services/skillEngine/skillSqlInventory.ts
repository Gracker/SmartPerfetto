// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Trace/skill-sql.inventory.json: the SQL every built-in Skill runs as written,
// read by the Trace corpus tooling (Trace/tools/lib/skill-sql-contract.cjs),
// which runs without the TypeScript build. Each fact comes from the reader
// the runtime and the validator use, so the tooling keeps no private copy:
// the units from executableSqlUnits, the scope declaration from
// sqlScopeDeclarationError, placeholders from boundSqlPlaceholders, result
// columns and read-only SQL from the structural SQL readers, what earlier
// steps record from recordedStepNames, the layout from SKILL_LAYOUT.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {executableSqlUnits, EXACT_UPID_TOKEN, sqlScopeDeclarationError} from './processScopeSql';
import {recordedStepNames} from './skillValidator';
import {listSkillFiles, SKILL_LAYOUT} from './skillLayout';
import {skillExecution, stepNodesOf} from './skillSteps';
import {boundSqlPlaceholders} from './sqlTemplate';
import {sqlIsReadOnly, sqlResultColumns} from './sqlStructure';

export const SKILL_SQL_INVENTORY_SCHEMA_VERSION = 1;

/** One SQL source a Skill runs as written (no exact_sql: an exact run is bound by its own corpus expectation). */
export interface SkillSqlInventoryUnit {
  /** `root` for an atomic Skill's root SQL, else the step's id, or null for a step without one. */
  id: string | null;
  /** Where the SQL is written: `sql`, `steps[0].sql`, `steps[2].else.sql`. */
  at: string;
  /** The top-level step it is or sits under; null for root SQL. */
  top_level_index: number | null;
  sha256: string;
  /** The display columns it declares, else the columns its first query names. */
  required_columns: string[];
  /** Whether the step has its own `condition`. */
  has_condition: boolean;
  read_only: boolean;
  /** The distinct placeholders it binds, as written (boundSqlPlaceholders: comments excluded). */
  placeholders: string[];
  /** Whether its process_scope declaration binds what it claims (sqlScopeDeclarationError); null without one. */
  process_scope_valid: boolean | null;
  /**
   * Whether the Trace corpus may run it with its condition forced: it only
   * reads, and every placeholder reads a Skill input, what an earlier
   * top-level step recorded, or the trusted UPID under a valid declaration.
   */
  forceable: boolean;
}

export interface SkillSqlInventorySkill {
  source_file: string;
  /**
   * SHA-256 of the file text it was generated from, line endings normalized:
   * the tooling refuses an inventory a Skill edit has made stale.
   */
  source_sha256: string;
  type: string | null;
  /** What the executor runs of it (skillExecution). */
  execution: 'root' | 'steps' | 'none';
  declared_modules: string[];
  /** The id of each top-level step, in order (null for one without an id). */
  top_level_steps: Array<string | null>;
  /** SQL written where the executor never runs it (the validator's sql_not_executed). */
  unexecuted_sql: boolean;
  units: SkillSqlInventoryUnit[];
}

export interface SkillSqlInventory {
  schemaVersion: typeof SKILL_SQL_INVENTORY_SCHEMA_VERSION;
  source: string;
  /** The Skill directory layout (SKILL_LAYOUT), for tooling that cannot import it. */
  layout: {skills_root: string} & typeof SKILL_LAYOUT;
  skills: Record<string, SkillSqlInventorySkill>;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const nonEmptySql = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function displayColumns(display: unknown): string[] {
  const columns = display && typeof display === 'object' ? (display as {columns?: unknown}).columns : undefined;
  if (!Array.isArray(columns)) return [];
  return [...new Set(columns.map(column => column?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim() !== ''))];
}

/** The root a placeholder path reads (`rows` of `rows.data[0].x`), or null when it is no simple path. */
function placeholderRoot(placeholderPath: string): string | null {
  return /^([A-Za-z_][A-Za-z0-9_]*)(?:[.[?]|$)/.exec(placeholderPath)?.[1] ?? null;
}

/** The inventory entry of one parsed Skill definition. */
export function skillSqlInventoryEntry(
  definition: any,
  source: {file: string; text: string},
  fragments: ReadonlyMap<string, string>,
): SkillSqlInventorySkill {
  const execution = skillExecution(definition);
  const inputs = new Set<string>((Array.isArray(definition?.inputs) ? definition.inputs : [])
    .map((input: any) => input?.name).filter((name: unknown): name is string => typeof name === 'string' && name !== ''));
  const tops = stepNodesOf(definition, {topLevelOnly: true});
  // What the top-level steps before each one recorded (the executor's recordStepResult).
  const recordedBefore = tops.map((_, index) => new Set(tops.slice(0, index).flatMap(top => recordedStepNames(top.node))));
  const topIndexOf = new Map(stepNodesOf(definition).map(step => [step.node, step.topLevelIndex ?? null]));
  const units = executableSqlUnits(definition)
    .filter(unit => unit.variant === 'named' && nonEmptySql(unit.source.sql))
    .map((unit): SkillSqlInventoryUnit => {
      const sql = unit.source.sql as string;
      const root = unit.node === definition;
      const topLevelIndex = root ? null : topIndexOf.get(unit.node) ?? null;
      const bound = boundSqlPlaceholders(sql);
      const processScopeValid = unit.source.process_scope === undefined
        ? null : sqlScopeDeclarationError(unit.source, fragments) === undefined;
      const available = topLevelIndex === null ? new Set<string>() : recordedBefore[topLevelIndex];
      const readOnly = sqlIsReadOnly(sql);
      const forceable = readOnly && bound.every(({match, path: placeholderPath}) => {
        const name = placeholderRoot(placeholderPath);
        return name === '__process_scope'
          ? match === EXACT_UPID_TOKEN && processScopeValid === true
          : name !== null && (inputs.has(name) || available.has(name));
      });
      const declared = displayColumns(unit.node.display);
      return {
        id: root ? 'root' : typeof unit.node.id === 'string' && unit.node.id ? unit.node.id : null,
        at: unit.sqlAt,
        top_level_index: topLevelIndex,
        sha256: sha256(sql),
        required_columns: declared.length > 0 ? declared : sqlResultColumns(sql),
        has_condition: typeof unit.node.condition === 'string' && unit.node.condition !== '',
        read_only: readOnly,
        placeholders: [...new Set(bound.map(({match}) => match))],
        process_scope_valid: processScopeValid,
        forceable,
      };
    });
  const rootSql = nonEmptySql(definition?.sql);
  const stepSql = stepNodesOf(definition).some(step => nonEmptySql(step.node.sql));
  return {
    source_file: source.file,
    source_sha256: sha256(source.text.replace(/\r\n/g, '\n')),
    type: typeof definition?.type === 'string' ? definition.type : null,
    execution,
    declared_modules: [...new Set((Array.isArray(definition?.prerequisites?.modules) ? definition.prerequisites.modules : [])
      .filter((name: unknown): name is string => typeof name === 'string' && name.trim() !== ''))].sort() as string[],
    top_level_steps: tops.filter(top => top.at.startsWith('steps[')).map(top => typeof top.node.id === 'string' ? top.node.id : null),
    unexecuted_sql: (rootSql && execution !== 'root') || (stepSql && execution !== 'steps'),
    units,
  };
}

/**
 * The inventory of the built-in Skills under `skillsDir` (as the loader reads
 * the built-in root), each file parsed as written; `repoRoot` makes source
 * paths repository-relative.
 */
export function buildSkillSqlInventory(input: {
  repoRoot: string;
  skillsDir: string;
  fragments: ReadonlyMap<string, string>;
}): SkillSqlInventory {
  const relative = (file: string) => path.relative(input.repoRoot, file).split(path.sep).join('/');
  const entries = listSkillFiles(input.skillsDir, {includeCustom: true}).flatMap(({path: file}) => {
    const text = fs.readFileSync(file, 'utf8');
    const definition = yaml.load(text) as any;
    return typeof definition?.name === 'string' && definition.name
      ? [[definition.name, skillSqlInventoryEntry(definition, {file: relative(file), text}, input.fragments)] as const] : [];
  });
  const duplicate = entries.find(([name], index) => entries.findIndex(([other]) => other === name) !== index);
  if (duplicate) throw new Error(`Two Skill files declare ${duplicate[0]}`);
  return {
    schemaVersion: SKILL_SQL_INVENTORY_SCHEMA_VERSION,
    source: 'backend/src/services/skillEngine/skillSqlInventory.ts',
    layout: {skills_root: relative(input.skillsDir), ...SKILL_LAYOUT},
    skills: Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right))),
  };
}

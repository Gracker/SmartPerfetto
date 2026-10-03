// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillDefinition, SqlProcessScopeDeclaration, ExactSqlSource } from './types';
import { skillExecution, stepNodesOf, type StepNode } from './skillSteps';

export const EFFECTIVE_TARGET_FRAGMENT = 'fragments/effective_target_processes.sql';
export const EXACT_UPID_TOKEN = '${__process_scope.upid}';

export interface ScopedSqlSource {
  sql?: string;
  sql_fragments?: string[];
  process_scope?: SqlProcessScopeDeclaration;
  exact_sql?: ExactSqlSource;
}

const SCOPE_ROLES: readonly string[] = ['target', 'global_context', 'peer_context', 'identity_metadata'];
const CONTEXT_ROLES: readonly string[] = ['global_context', 'peer_context', 'identity_metadata'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/**
 * Why `value` is not a process_scope declaration, judged on the declaration
 * alone: its closed keys and types, its role, its context fields, an authored
 * exact_unavailable reason, and no target binding on context evidence.
 * Whether the SQL beside it binds what it claims is sqlScopeDeclarationError's
 * further question.
 */
export function processScopeDeclarationError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'SQL has no process_scope declaration';
  if (typeof value.role !== 'string' || !SCOPE_ROLES.includes(value.role)) return 'Unknown process_scope role';
  if (!hasOnlyKeys(value, ['role', 'binding', 'context_fields', 'exact_unavailable', 'limitations'])
    || (value.binding !== undefined && value.binding !== 'native_upid' && value.binding !== 'effective_target_processes')
    || (value.limitations !== undefined && !isStringArray(value.limitations))) {
    return 'Invalid process_scope declaration';
  }
  if (value.exact_unavailable !== undefined
    && (typeof value.exact_unavailable !== 'string' || !value.exact_unavailable.trim())) {
    return 'exact_unavailable requires an authored reason';
  }
  if (value.context_fields !== undefined && (!isRecord(value.context_fields)
    || Object.entries(value.context_fields).some(([role, fields]) => !CONTEXT_ROLES.includes(role)
      || !Array.isArray(fields) || fields.some(field => typeof field !== 'string' || !field.trim())))) {
    return 'Invalid process_scope context_fields declaration';
  }
  if (CONTEXT_ROLES.includes(value.role) && value.binding) return 'Context evidence cannot claim a target UPID binding';
  return undefined;
}

function isProcessScopeDeclaration(value: unknown): value is SqlProcessScopeDeclaration {
  return processScopeDeclarationError(value) === undefined;
}

/** Whether `value` has the shape of an exact_sql override: SQL, its fragments and its own process_scope. */
export function isExactSqlSource(value: unknown): value is ExactSqlSource {
  return isRecord(value)
    && hasOnlyKeys(value, ['sql', 'sql_fragments', 'process_scope'])
    && typeof value.sql === 'string' && value.sql.trim().length > 0
    && (value.sql_fragments === undefined || isStringArray(value.sql_fragments))
    && isProcessScopeDeclaration(value.process_scope);
}

export function selectProcessScopeSql(source: ScopedSqlSource, exact: boolean): ScopedSqlSource {
  const run = sqlRunBy(source, exact ? 'exact' : 'named');
  if (!run) throw new Error('Invalid exact_sql override; refusing the named SQL fallback');
  return run;
}

/** How SQL runs: as written, or under an exact process scope, with each exact_sql in its place. */
export type SqlVariant = 'named' | 'exact';

/** One SQL source a Skill can execute: the SQL beside a step (or the Skill's root), or its exact_sql. */
export interface ExecutableSqlUnit {
  /** The step the SQL belongs to, or the Skill itself for its root SQL. */
  node: Record<string, any>;
  /** How a finding names it: `root` or the step's name (StepNode), with `.exact_sql` for an override. */
  path: string;
  /** Where its SQL is written: `sql`, `exact_sql.sql`, `steps[0].sql`, `steps[2].else.exact_sql.sql`. */
  sqlAt: string;
  variant: SqlVariant;
  source: ScopedSqlSource;
  /** Whether it may not run when the Skill runs (StepNode.guarded). */
  guarded: boolean;
}

/**
 * Every SQL source the executor runs of a Skill (skillSteps.skillExecution),
 * from the one walk every check shares: an atomic Skill's root SQL, or else
 * each atomic step at any depth (nested steps and inline conditional branches,
 * stepNodesOf; a step without an id by its position), each with the SQL it
 * runs as written and, when it declares one, its exact_sql as written (valid
 * or not: the checks that report on it need to see it). An exact run executes
 * `sqlRunBy(node, 'exact')`. SQL the executor never runs is no unit: the
 * validator rejects it (sql_not_executed).
 */
export function executableSqlUnits(skill: unknown): ExecutableSqlUnit[] {
  const execution = skillExecution(skill);
  const nodes: StepNode[] = execution === 'root' ? [{node: skill, at: '', name: 'root', guarded: false}]
    : execution === 'steps' ? stepNodesOf(skill).filter(({node}) => node.type === 'atomic') : [];
  return nodes.flatMap(({node, at, name, guarded}): ExecutableSqlUnit[] => {
    const prefix = at ? `${at}.` : '';
    return [
      {node, path: name, sqlAt: `${prefix}sql`, variant: 'named', source: node, guarded},
      ...(isRecord(node.exact_sql) ? [{
        node, path: `${name}.exact_sql`, sqlAt: `${prefix}exact_sql.sql`,
        variant: 'exact' as const, source: node.exact_sql as ScopedSqlSource, guarded,
      }] : []),
    ];
  });
}

/**
 * The SQL `node` runs in `variant` (selectProcessScopeSql): itself, or under an
 * exact scope a valid exact_sql; an invalid exact_sql runs nothing.
 */
export function sqlRunBy(node: ScopedSqlSource, variant: SqlVariant): ScopedSqlSource | undefined {
  if (variant === 'named' || node.exact_sql === undefined) return node;
  return isExactSqlSource(node.exact_sql) ? node.exact_sql : undefined;
}

export function sqlScopeDeclarationError(
  source: ScopedSqlSource,
  fragments: ReadonlyMap<string, string>,
): string | undefined {
  const declaration = source.process_scope;
  if (!isProcessScopeDeclaration(declaration)) return processScopeDeclarationError(declaration);
  if (declaration.exact_unavailable !== undefined) return undefined;
  const paths = source.sql_fragments || [];
  for (const path of paths) {
    if (!fragments.has(path)) return `Required SQL fragment is missing: ${path}`;
  }
  if (CONTEXT_ROLES.includes(declaration.role)) return undefined;
  const executableSql = [source.sql || '', ...paths.map(path => fragments.get(path) || '')]
    .join('\n').replace(/--[^\n\r]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g, ' ');
  if (declaration.binding === 'native_upid') {
    return executableSql.includes(EXACT_UPID_TOKEN)
      ? undefined : 'native_upid SQL must bind the trusted __process_scope.upid';
  }
  if (declaration.binding === 'effective_target_processes') {
    if (!paths.includes(EFFECTIVE_TARGET_FRAGMENT)) return 'Target SQL must include effective_target_processes.sql';
    if (!executableSql.includes(EXACT_UPID_TOKEN)) return 'Target fragment is missing its trusted UPID binding';
    const consumerSql = [source.sql || '', ...paths.filter(path => path !== EFFECTIVE_TARGET_FRAGMENT)
      .map(path => fragments.get(path) || '')].join('\n').replace(/--[^\n\r]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g, ' ');
    return /\b(?:FROM|JOIN)\s+effective_target_processes\b/i.test(consumerSql)
      ? undefined : 'Target SQL does not consume effective_target_processes';
  }
  return 'Target SQL has no supported exact UPID binding';
}

/** Same dependency closure is used for execution admission and capability catalogs. */
export function getExactProcessScopeSupport(
  skill: SkillDefinition,
  registry: ReadonlyMap<string, SkillDefinition>,
  fragments: ReadonlyMap<string, string>,
  visiting = new Set<string>(),
): { supported: boolean; reason?: string; partial?: boolean; limitations?: string[] } {
  if (!skill.sql && !skill.steps?.length) return { supported: false, reason: `Skill has no executable SQL or steps: ${skill.name}` };
  if (visiting.has(skill.name)) return { supported: false, reason: `Cyclic Skill dependency: ${skill.name}` };
  const next = new Set(visiting).add(skill.name);
  const limitations = new Set<string>();
  // The Skill's own SQL, as an exact run executes it.
  for (const unit of executableSqlUnits(skill)) {
    if (unit.variant !== 'named' || typeof unit.source.sql !== 'string') continue;
    const where = unit.path === 'root' ? skill.name : `${skill.name}.${unit.path}`;
    const selected = sqlRunBy(unit.source, 'exact');
    if (!selected) return { supported: false, reason: `${where}: Invalid exact_sql override; refusing the named SQL fallback` };
    const reason = sqlScopeDeclarationError(selected, fragments);
    if (reason) return { supported: false, reason: `${where}: ${reason}` };
    if (selected.process_scope?.exact_unavailable) limitations.add(selected.process_scope.exact_unavailable);
    for (const limitation of selected.process_scope?.limitations || []) limitations.add(limitation);
  }
  // The Skills it runs, and the steps no exact run can take.
  const inspect = (node: any, path: string): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const referenced = node.item_skill || node.skill;
    if (typeof referenced === 'string') {
      const child = registry.get(referenced);
      if (!child) return `${path}: Skill dependency is missing: ${referenced}`;
      const support = getExactProcessScopeSupport(child, registry, fragments, next);
      if (!support.supported) return support.reason;
      support.limitations?.forEach(reason => limitations.add(reason));
    }
    if (node.type === 'pipeline' || node.type === 'comparison') return `${path}: exact UPID execution is not declared for ${node.type}`;
    for (const child of node.steps || []) {
      const reason = inspect(child, `${path}.${child.id}`);
      if (reason) return reason;
    }
    for (const branch of node.conditions || []) {
      const branchNode = typeof branch.then === 'string' ? { skill: branch.then } : branch.then;
      const reason = inspect(branchNode, `${path}.then`);
      if (reason) return reason;
    }
    return inspect(typeof node.else === 'string' ? { skill: node.else } : node.else, `${path}.else`);
  };
  const reason = inspect(skill, skill.name);
  return reason ? { supported: false, reason } : { supported: true,
    ...(limitations.size ? { partial: true, limitations: [...limitations] } : {}) };
}

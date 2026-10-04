// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {boundSqlPlaceholders} from './sqlTemplate';
import {executableSqlUnits} from './processScopeSql';

/**
 * A Skill's SQL may read an earlier step's saved result by path. When that
 * result has no row, this executor binds the path as '' inside a string and
 * NULL elsewhere, and the step runs; the public Perfetto-Skills runtime treats
 * a path without `|default` as a result dependency and skips the step. Every
 * such read therefore says which it means: an explicit `|default` (the step
 * runs without the row, on both runtimes), or a step `condition` that is false
 * without the row, through a top-level conjunct `<result>.data?.length > 0`
 * (the step does not run without it, on both runtimes). Mentioning the result
 * is not enough: `cov.data[0]?.x !== 1` is true when `cov` has no row.
 *
 * Out of scope: a bare relation (`${name}`), which is not a path; nested
 * steps, which the public runtime does not execute; SQL fragments, which the
 * public exporter expands before it computes dependencies and which read no
 * saved result today; a child Skill reading its parent's results, which both
 * runtimes pass down; and Skill-reference `params`, which both runtimes
 * evaluate as expressions rather than bind as SQL.
 */

export interface UndecidedResultPathRead {
  /** `steps[i].sql` or `steps[i].exact_sql.sql`. */
  path: string;
  stepId: string;
  placeholder: string;
}

/**
 * The top-level operands of `operator` in a JS expression, outside brackets
 * and strings, or undefined when an operator binding looser than it sits at
 * the top level (`||` for `&&`, and `??` or a ternary for either): the
 * operands then do not combine through `operator` alone. (A step condition is
 * a JS expression on both runtimes; the words AND/OR are a syntax error there,
 * so they combine nothing.)
 */
export function topLevelOperands(expr: string, operator: '&&' | '||'): string[] | undefined {
  const parts: string[] = [];
  let from = 0;
  let operatorTail = false;
  let looser = false;
  scanOutsideStrings(expr, (i, depth) => {
    const c = expr[i];
    if (depth > 0 || '([{)]}'.includes(c)) return;
    if (operatorTail) {
      operatorTail = false;
    } else if (expr.startsWith(operator, i)) {
      parts.push(expr.slice(from, i));
      from = i + 2;
      operatorTail = true;
    } else if ((operator === '&&' && expr.startsWith('||', i)) || (c === '?' && expr[i + 1] !== '.')) {
      looser = true;
      return true;
    }
  });
  return looser ? undefined : [...parts, expr.slice(from)].map(part => part.trim());
}

/**
 * Calls `visit` for each character of a JS expression outside its string
 * literals, with the bracket depth before that character; stops when `visit`
 * returns true.
 */
export function scanOutsideStrings(expr: string, visit: (index: number, depth: number) => boolean | void): void {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (visit(i, depth)) return;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
}

/** Whether `condition` is false whenever the result saved under one of `names` has no row. */
function requiresRows(condition: unknown, names: readonly string[]): boolean {
  if (typeof condition !== 'string') return false;
  const guards = new Set(names.flatMap(name =>
    ['.data.length>0', '.data?.length>0', '?.data.length>0', '?.data?.length>0'].map(tail => name + tail)));
  // A disjunction, nullish fallback or ternary can be true without the row.
  return (topLevelOperands(condition, '&&') ?? []).some(conjunct => guards.has(conjunct.replace(/\s+/g, '')));
}

/** Path reads of earlier top-level results that declare neither a default nor a guarding condition. */
export function undecidedResultPathReads(skill: {steps?: readonly unknown[]}): UndecidedResultPathRead[] {
  const found: UndecidedResultPathRead[] = [];
  // Each earlier step's result is readable under its id and its save_as.
  const producers = new Map<string, readonly string[]>();
  // The shared SQL units (processScopeSql.ts), of the top-level steps the public runtime runs.
  const units = executableSqlUnits(skill);
  for (const raw of skill.steps ?? []) {
    const step = (raw ?? {}) as {id?: unknown; save_as?: unknown; condition?: unknown};
    const sites = units.filter(unit => unit.node === raw).map(unit => [unit.sqlAt, unit.source.sql] as const);
    for (const [path, sql] of sites) {
      if (typeof sql !== 'string') continue;
      for (const placeholder of boundSqlPlaceholders(sql)) {
        const root = placeholder.path.split(/[.[]/)[0];
        const names = producers.get(root);
        if (names && placeholder.path !== root && placeholder.defaultValue === undefined
            && !requiresRows(step.condition, names)) {
          found.push({path, stepId: String(step.id), placeholder: placeholder.match});
        }
      }
    }
    const names = [step.id, step.save_as].filter((name): name is string => typeof name === 'string' && name !== '');
    for (const name of names) producers.set(name, names);
  }
  return found;
}

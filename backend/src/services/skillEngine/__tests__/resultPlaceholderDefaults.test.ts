// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {substituteSqlPlaceholders} from '../sqlTemplate';
import {skillDocuments} from '../../../../tests/helpers/skillRuleHarness';

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
 * steps and SQL fragments, where no Skill reads a saved result today; and
 * Skill-reference `params`, which both runtimes evaluate as expressions rather
 * than bind as SQL.
 */

interface UndecidedRead { site: string; placeholder: string }

/** The top-level `&&` operands of `expr`; none when it is not a plain conjunction. */
function topLevelConjuncts(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (depth === 0 && expr.startsWith('&&', i)) {
      parts.push(expr.slice(from, i));
      from = i + 2;
      i++;
    } else if (depth === 0 && (expr.startsWith('||', i) || (c === '?' && expr[i + 1] !== '.'))) {
      // A disjunction, nullish fallback or ternary can be true without the row.
      return [];
    }
  }
  return [...parts, expr.slice(from)].map(part => part.trim());
}

/** Whether `condition` is false whenever the result saved under one of `names` has no row. */
function requiresRows(condition: unknown, names: string[]): boolean {
  if (typeof condition !== 'string') return false;
  return topLevelConjuncts(condition).some(conjunct =>
    names.some(name => new RegExp(`^${name}(\\?)?\\.data(\\?)?\\.length\\s*>\\s*0$`).test(conjunct)));
}

/** Path reads of earlier results in `skill` that declare neither a default nor a guarding condition. */
function undecidedResultReads(skill: any): UndecidedRead[] {
  const found: UndecidedRead[] = [];
  const producers = new Map<string, any>();
  for (const step of skill?.steps ?? []) {
    for (const sql of [step?.sql, step?.exact_sql?.sql]) {
      if (typeof sql !== 'string') continue;
      substituteSqlPlaceholders(sql, placeholder => {
        const root = placeholder.path.split(/[.[]/)[0];
        const producer = producers.get(root);
        if (producer && placeholder.path !== root && placeholder.defaultValue === undefined
            && !requiresRows(step.condition, [producer.id, producer.save_as].filter(Boolean))) {
          found.push({site: `${skill.name}/${step.id}`, placeholder: placeholder.match});
        }
        return placeholder.match;
      });
    }
    for (const name of [step?.id, step?.save_as].filter(Boolean)) producers.set(name, step);
  }
  return found;
}

describe('result placeholder defaults', () => {
  it('gives every path read of an earlier result a default or a guarding condition', () => {
    const undecided = skillDocuments().flatMap(({file, skill}) =>
      undecidedResultReads(skill).map(read => `${file}: ${read.site} ${read.placeholder}`));
    expect(undecided).toEqual([]);
  });

  it('flags only an undecided path read', () => {
    const skill = {name: 'probe', steps: [
      {id: 'probe_step', type: 'atomic', sql: 'SELECT 1 AS status', save_as: 'cov'},
      {id: 'bare', type: 'atomic', sql: "SELECT '${cov.data[0].status}' AS s, ${cov.data[0].ratio} AS r"},
      {id: 'defaulted', type: 'atomic', sql: "SELECT '${cov.data[0].status|unknown}' AS s, ${cov.data[0].ratio|NULL} AS r"},
      {id: 'guarded', type: 'atomic', condition: "x === 'a||b' && cov.data?.length > 0", sql: "SELECT '${cov.data[0].status}' AS s"},
      {id: 'guarded_by_id', type: 'atomic', condition: '(a || b) && probe_step.data.length > 0', sql: 'SELECT ${cov.data[0].ratio} AS r'},
      // Naming the producer as a property or a string is not reading it, and a
      // condition that is true without its rows does not guard the read.
      {id: 'mentioned', type: 'atomic', condition: "other.data?.some(r => r.cov === 'cov')", sql: 'SELECT ${cov.data[0].ratio} AS r'},
      {id: 'true_when_empty', type: 'atomic', condition: 'cov.data[0]?.ratio !== 1', sql: 'SELECT ${cov.data[0].ratio} AS r'},
      {id: 'disjunct', type: 'atomic', condition: 'cov.data?.length > 0 || x', sql: 'SELECT ${cov.data[0].ratio} AS r'},
      {id: 'exact', type: 'atomic', sql: 'SELECT 1', exact_sql: {sql: 'SELECT ${cov.data[0].ratio} AS r'}},
      {id: 'relation', type: 'atomic', sql: 'SELECT * FROM ${cov}'},
      {id: 'comment', type: 'atomic', sql: '-- ${cov.data[0].status}\nSELECT 1'},
      {id: 'input', type: 'atomic', sql: 'SELECT ${start_ts} AS ts'},
    ]};
    expect(undecidedResultReads(skill)).toEqual([
      {site: 'probe/bare', placeholder: '${cov.data[0].status}'},
      {site: 'probe/bare', placeholder: '${cov.data[0].ratio}'},
      {site: 'probe/mentioned', placeholder: '${cov.data[0].ratio}'},
      {site: 'probe/true_when_empty', placeholder: '${cov.data[0].ratio}'},
      {site: 'probe/disjunct', placeholder: '${cov.data[0].ratio}'},
      {site: 'probe/exact', placeholder: '${cov.data[0].ratio}'},
    ]);
  });
});

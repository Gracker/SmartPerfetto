// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {undecidedResultPathReads} from '../resultPathReads';
import {skillDocuments} from '../../../../tests/helpers/skillRuleHarness';

// The rule and its reasons live in resultPathReads.ts; the in-process
// validator enforces it on every Skill (validate:skills) and overlay.
describe('saved-result path reads', () => {
  it('flags only an undecided path read', () => {
    const skill = {name: 'probe', type: 'composite', steps: [
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
      // A placeholder the executor refuses to bind is still a read to judge.
      {id: 'unbindable', type: 'atomic', sql: 'SELECT "${cov.data[0].status}" AS s'},
    ]};
    expect(undecidedResultPathReads(skill).map(read => `${read.stepId} ${read.path} ${read.placeholder}`)).toEqual([
      'bare steps[1].sql ${cov.data[0].status}',
      'bare steps[1].sql ${cov.data[0].ratio}',
      'mentioned steps[5].sql ${cov.data[0].ratio}',
      'true_when_empty steps[6].sql ${cov.data[0].ratio}',
      'disjunct steps[7].sql ${cov.data[0].ratio}',
      'exact steps[8].exact_sql.sql ${cov.data[0].ratio}',
      'unbindable steps[12].sql ${cov.data[0].status}',
    ]);
  });

  it('takes an overlay step name as text, never as a pattern', () => {
    // A name with regex syntax neither throws nor guards a read it does not name.
    const skill = {type: 'composite', steps: [
      {id: 'cov', type: 'atomic', sql: 'SELECT 1 AS x'},
      {id: 'a(b', type: 'atomic', condition: 'a(b.data?.length > 0', sql: 'SELECT ${cov.data[0].x} AS x'},
      {id: 'c.v', type: 'atomic', sql: 'SELECT 1 AS x'},
      {id: 'wildcard', type: 'atomic', condition: 'cxv.data?.length > 0', sql: 'SELECT ${cov.data[0].x} AS x'},
    ]};
    expect(undecidedResultPathReads(skill).map(read => read.stepId)).toEqual(['a(b', 'wildcard']);
  });

  it('holds every shipped Skill to the rule', () => {
    expect(skillDocuments().flatMap(({file, skill}) =>
      undecidedResultPathReads(skill).map(read => `${file}: ${read.path} ${read.placeholder}`))).toEqual([]);
  });

  it('reads a result only after the step that saves it', () => {
    const skill = {type: 'composite', steps: [
      {id: 'early', type: 'atomic', sql: 'SELECT ${late.data[0].x} AS x'},
      {id: 'late', type: 'atomic', sql: 'SELECT 1 AS x'},
    ]};
    expect(undecidedResultPathReads(skill)).toEqual([]);
  });
});

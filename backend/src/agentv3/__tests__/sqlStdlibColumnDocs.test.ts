// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {PerfettoSqlDocsAsset} from '../../services/perfettoSqlDocs';
import {STDLIB_COLUMN_DOC_LIMITS, StdlibColumnDocMemory} from '../sqlStdlibColumnDocs';

const relation = (name: string, module: string, columns: Array<[string, string, string?]>, pkg = module.split('.')[0]) => ({
  id: `stdlib.${module}.${name}`, name, type: 'table' as const, category: pkg, module, package: pkg,
  description: name, columns: columns.map(([column, description, type]) => ({name: column, description, ...(type ? {type} : {})})),
});

const docs: PerfettoSqlDocsAsset = {
  version: 1,
  modules: [],
  symbolToModule: {},
  entries: [
    relation('android_anrs', 'android.anrs', [
      ['process_name', 'Name of the process that triggered the ANR.', 'STRING'],
      ['ts', 'Timestamp of the ANR.', 'TIMESTAMP'],
      ['timer_delay', 'The duration between the timer expiration event and the anr counter event', 'LONG'],
      ['anr_dur_ms', 'Duration of the ANR', 'LONG'],
    ]),
    relation('wide_table', 'test.wide', Array.from({length: STDLIB_COLUMN_DOC_LIMITS.columns + 6},
      (_, index) => [`c${index}`, `${'x'.repeat(STDLIB_COLUMN_DOC_LIMITS.descriptionChars + 50)} ${index}`] as [string, string])),
    relation('slice', 'prelude', [['ts', 'Built-in slice start.']], 'prelude'),
  ],
};

const anrColumns = ['process_name', 'ts', 'timer_delay', 'anr_dur_ms'];
// A fresh run: nothing has been documented yet.
const stdlibColumnDocsForResult = (sql: string, columns: string[], asset?: PerfettoSqlDocsAsset) =>
  asset ? new StdlibColumnDocMemory().notesFor(sql, columns, asset) : new StdlibColumnDocMemory().notesFor(sql, columns);

describe('StdlibColumnDocMemory.notesFor on a fresh run', () => {
  it('documents direct column projections of a documented stdlib relation', () => {
    const notes = stdlibColumnDocsForResult('SELECT timer_delay, ts FROM android_anrs WHERE ts > 0 ORDER BY ts LIMIT 3',
      ['timer_delay', 'ts'], docs);
    expect(notes).toEqual({source: 'perfetto_stdlib_docs', relation: 'android_anrs', module: 'android.anrs', columns: [
      {column: 'timer_delay', type: 'LONG', description: 'The duration between the timer expiration event and the anr counter event'},
      {column: 'ts', type: 'TIMESTAMP', description: 'Timestamp of the ANR.'},
    ]});
  });

  it('documents every column of a star projection after an include prelude', () => {
    const notes = stdlibColumnDocsForResult(
      'INCLUDE PERFETTO MODULE android.anrs;\n/* any */ INCLUDE PERFETTO MODULE android.*;\n-- all ANRs\nSELECT * FROM android_anrs',
      anrColumns, docs);
    expect(notes?.columns.map(note => note.column)).toEqual(anrColumns);
  });

  it('maps an alias to its source column and never documents a scalar slot', () => {
    const notes = stdlibColumnDocsForResult(
      'SELECT a.timer_delay AS delay_ns, a.anr_dur_ms * 1000000 AS timer_delay FROM android_anrs a',
      ['delay_ns', 'timer_delay'], docs);
    expect(notes?.columns).toEqual([{column: 'delay_ns', sourceColumn: 'timer_delay', type: 'LONG',
      description: 'The duration between the timer expiration event and the anr counter event'}]);
  });

  it.each([
    ['a scalar-only result', 'SELECT timer_delay / 1e6 AS timer_delay FROM android_anrs', ['timer_delay']],
    ['a join', 'SELECT a.timer_delay FROM android_anrs a JOIN process p USING (upid)', ['timer_delay']],
    ['an aggregate', 'SELECT MAX(timer_delay) AS timer_delay FROM android_anrs', ['timer_delay']],
    ['a grouped read', 'SELECT process_name FROM android_anrs GROUP BY process_name', ['process_name']],
    ['a CTE', 'WITH x AS (SELECT * FROM android_anrs) SELECT timer_delay FROM x', ['timer_delay']],
    ['an undocumented relation', 'SELECT timer_delay FROM my_anrs', ['timer_delay']],
    ['a prelude built-in', 'SELECT ts FROM slice', ['ts']],
    ['a star whose output differs from the documented schema', 'SELECT * FROM android_anrs', ['process_name', 'ts']],
  ])('gives no notes for %s', (_label, sql, columns) => {
    expect(stdlibColumnDocsForResult(sql, columns, docs)).toBeUndefined();
  });

  it('reads the generated docs asset by default', () => {
    const notes = stdlibColumnDocsForResult('SELECT timer_delay FROM android_anrs', ['timer_delay']);
    expect(notes?.module).toBe('android.anrs');
    expect(notes?.columns[0].description).toMatch(/timer expiration/);
  });
});

describe('StdlibColumnDocMemory', () => {
  it('emits each relation.column once and keeps bounded-out notes eligible', () => {
    const memory = new StdlibColumnDocMemory();
    const wide = Array.from({length: STDLIB_COLUMN_DOC_LIMITS.columns + 6}, (_, index) => `c${index}`);
    const first = memory.notesFor('SELECT * FROM wide_table', wide, docs);
    expect(first?.columns).toHaveLength(STDLIB_COLUMN_DOC_LIMITS.columns);
    expect(first?.omittedColumns).toBe(6);
    expect(first?.columns.every(note => note.description.length <= STDLIB_COLUMN_DOC_LIMITS.descriptionChars)).toBe(true);
    const second = memory.notesFor('SELECT * FROM wide_table', wide, docs);
    expect(second?.columns.map(note => note.column)).toEqual(wide.slice(STDLIB_COLUMN_DOC_LIMITS.columns));
    expect(second).not.toHaveProperty('omittedColumns');
    expect(memory.notesFor('SELECT * FROM wide_table', wide, docs)).toBeUndefined();
  });

  it('treats an aliased read of an emitted column as already documented', () => {
    const memory = new StdlibColumnDocMemory();
    expect(memory.notesFor('SELECT timer_delay FROM android_anrs', ['timer_delay'], docs)).toBeDefined();
    expect(memory.notesFor('SELECT timer_delay AS d FROM android_anrs', ['d'], docs)).toBeUndefined();
    expect(memory.notesFor('SELECT ts, timer_delay FROM android_anrs', ['ts', 'timer_delay'], docs)
      ?.columns.map(note => note.column)).toEqual(['ts']);
  });
});

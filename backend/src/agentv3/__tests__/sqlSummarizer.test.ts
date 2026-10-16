// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {summarizeSqlResult} from '../sqlSummarizer';

describe('SQL summary sample rows', () => {
  it('prints each interest-ordered sample with its original row index', () => {
    const rows = Array.from({length: 30}, (_, index) => [index, (index * 7) % 30]);
    const summary = summarizeSqlResult(['id', 'dur'], rows);
    expect(summary.sampleRows).toHaveLength(10);
    summary.sampleRows.forEach(sample => expect(sample.values).toBe(rows[sample.rowIndex]));
    // Interest order: the first sample is the largest dur, not row 0.
    expect(summary.sampleRows[0]).toEqual({rowIndex: 17, values: [17, 29]});
    expect(summary.rowShape).toBe('indexed_rows@1');
    expect(summary).not.toHaveProperty('sampleRowIndices');
  });

  it('keeps the probe shape: a later main-thread row sorted behind a busier row keeps its own index', () => {
    // ORDER BY is_main_thread DESC, slice_count DESC puts the main thread at row
    // 0; the summary re-sorts by slice_count, so its position is no longer 0.
    const rows = [['main', 1, 40], ['HeapTaskDaemon', 0, 90],
      ...Array.from({length: 13}, (_, index) => [`worker-${index}`, 0, 10 - index])];
    const summary = summarizeSqlResult(['thread_name', 'is_main_thread', 'slice_count'], rows);
    expect(summary.sampleRows.slice(0, 2)).toEqual([
      {rowIndex: 1, values: ['HeapTaskDaemon', 0, 90]},
      {rowIndex: 0, values: ['main', 1, 40]},
    ]);
  });

  it('indexes every row in order when all rows fit, and evenly spaced rows without an interest column', () => {
    expect(summarizeSqlResult(['name'], [['a'], ['b']]).sampleRows)
      .toEqual([{rowIndex: 0, values: ['a']}, {rowIndex: 1, values: ['b']}]);
    const spaced = summarizeSqlResult(['name'], Array.from({length: 40}, (_, index) => [`n${index}`]));
    expect(spaced.sampleRows.map(sample => sample.rowIndex)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
    spaced.sampleRows.forEach(sample => expect(sample.values).toEqual([`n${sample.rowIndex}`]));
  });
});

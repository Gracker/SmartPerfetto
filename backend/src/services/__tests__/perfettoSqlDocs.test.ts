// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  clearPerfettoSqlDocsCache,
  listPerfettoSqlModuleDocs,
  loadPerfettoSqlDocsAsset,
  moduleCoveredByPerfettoSqlLineage,
  perfettoRelationColumns,
  searchPerfettoSqlDocs,
} from '../perfettoSqlDocs';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {parseRuntimeRevision} = require('../../../scripts/perfetto-runtime-source.cjs');

// The asset must be generated from the exact runtime revision in the pin.
const pinnedRevision: string = parseRuntimeRevision(
  fs.readFileSync(path.resolve(__dirname, '../../../../scripts/trace-processor-pin.env'), 'utf8'),
);

describe('perfettoSqlDocs', () => {
  beforeEach(() => {
    clearPerfettoSqlDocsCache();
  });

  it('loads the upstream stdlib_docs-backed asset', () => {
    const asset = loadPerfettoSqlDocsAsset();

    expect(asset?.version).toBe(1);
    expect(asset?.stats?.moduleCount).toBeGreaterThan(200);
    expect(asset?.stats?.entryCount).toBeGreaterThan(350);
    expect(asset?.generatedFrom).toBe(pinnedRevision);
    expect(asset?.sourceDocs).toBe(
      `git:${pinnedRevision}:src/trace_processor/perfetto_sql/stdlib`,
    );
    expect(asset?.sourceDocsMode).toBe('runtime-revision-source-generator');
  });

  it('returns rich docs for stdlib tables', () => {
    const results = searchPerfettoSqlDocs('android_frames', { limit: 5 });
    const frameTable = results.find(result => result.entry.name === 'android_frames');

    expect(frameTable?.entry.module).toBe('android.frames.timeline');
    expect(frameTable?.entry.include).toBe('INCLUDE PERFETTO MODULE android.frames.timeline;');
    expect(frameTable?.entry.columns?.some(col =>
      col.name === 'frame_id' && col.description?.toLowerCase().includes('frame')
    )).toBe(true);
    expect(frameTable?.entry.transitiveIncludes).toEqual(
      expect.arrayContaining(['slices.with_context']),
    );
  });

  it('indexes macros and parameters from stdlib_docs.json', () => {
    const results = searchPerfettoSqlDocs('wattson_threads_aggregation', { limit: 5 });
    const macro = results.find(result => result.entry.name === 'wattson_threads_aggregation');

    expect(macro?.entry.type).toBe('macro');
    expect(macro?.entry.module).toBe('wattson.aggregation');
    expect(macro?.entry.params?.some(param => param.name === 'window_table')).toBe(true);
  });

  it('exposes module include closure for validator coverage', () => {
    const modules = listPerfettoSqlModuleDocs('android.frames');
    const timeline = modules.find(mod => mod.module === 'android.frames.timeline');

    expect(timeline?.includes).toEqual(
      expect.arrayContaining(['slices.with_context', 'android.frames.timeline_maxsdk28']),
    );
    expect(timeline?.transitiveIncludes).toEqual(
      expect.arrayContaining(['slices.with_context']),
    );
    expect(moduleCoveredByPerfettoSqlLineage('slices.with_context', 'android.frames.timeline')).toBe(true);
  });

  // processIdentity reads table columns from here to bind a bare column as SQLite does.
  it('lists the columns of prelude and stdlib tables by name', () => {
    expect(perfettoRelationColumns('process')).toEqual(expect.any(Set));
    expect([...perfettoRelationColumns('process')!]).toEqual(expect.arrayContaining(['upid', 'pid', 'name', 'cmdline']));
    expect(perfettoRelationColumns('THREAD')?.has('name')).toBe(true);
    expect(perfettoRelationColumns('thread')?.has('app')).toBe(false);
    expect(perfettoRelationColumns('android_frames')?.has('frame_id')).toBe(true);
    expect(perfettoRelationColumns('no_such_table')).toBeUndefined();
  });
});

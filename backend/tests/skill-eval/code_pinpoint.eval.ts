// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, describe, expect, it} from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import {createSkillEvaluator, getTestTracePath, SkillEvaluator} from './runner';

const HOT_SLICE_COLUMNS = [
  'slice_id',
  'ts',
  'dur_ms',
  'upid',
  'utid',
  'process_name',
  'thread_name',
  'slice_name',
  'anchor_kind',
  'source_query_hint',
] as const;

const NATIVE_SYMBOL_COLUMNS = [
  'function_name',
  'module_name',
  'build_id',
  'sample_count',
] as const;

function loadHotSlicesSql(): string {
  const source = yaml.load(fs.readFileSync(
    path.resolve(process.cwd(), 'skills/composite/code_pinpoint.skill.yaml'),
    'utf8',
  )) as any;
  return source.steps.find((step: any) => step.id === 'hot_slices').sql;
}

function renderHotSlicesSql(
  packageName: string,
  startTs: number | null = null,
  endTs: number | null = null,
): string {
  return loadHotSlicesSql()
    .split('${package}').join(packageName.split("'").join("''"))
    .split('${start_ts}').join(startTs === null ? 'NULL' : String(startTs))
    .split('${end_ts}').join(endTs === null ? 'NULL' : String(endTs));
}

function objectRows(result: {columns: string[]; rows: unknown[][]; error?: string}): any[] {
  expect(result.error).toBeUndefined();
  return result.rows.map(row => Object.fromEntries(
    result.columns.map((column, index) => [column, row[index]]),
  ));
}

describe('code_pinpoint real Heavy trace semantics', () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('code_pinpoint');
    await evaluator.loadTrace(getTestTracePath('android-startup-heavy'));
  }, 60_000);

  afterAll(async () => {
    await evaluator?.cleanup();
  });

  it('keeps the historical ChaosTask evidence as a stable trace-derived app anchor', async () => {
    const result = await evaluator.executeStep('hot_slices', {
      package: 'com.example.launch.aosp.heavy',
      start_ts: 564_166_760_908_543,
      end_ts: 564_166_774_418_230,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.data[0] ?? {})).toEqual(HOT_SLICE_COLUMNS);
    expect(result.data).toContainEqual({
      slice_id: 11_879,
      ts: 564_166_760_908_543,
      dur_ms: 13.51,
      upid: 948,
      utid: 948,
      process_name: 'com.example.launch.aosp.heavy',
      thread_name: 'unch.aosp.heavy',
      slice_name: 'ChaosTask',
      anchor_kind: 'app_trace_label',
      source_query_hint: 'ChaosTask',
    });
  }, 60_000);
});

describe('code_pinpoint constructed trace semantics', () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('code_pinpoint');
    await evaluator.loadTrace('Trace/.generated/constructed/framework-pipelines/trace.pftrace');
  }, 60_000);

  afterAll(async () => {
    await evaluator?.cleanup();
  });

  it('returns only the exact package and fully-contained window with deterministic anchors', async () => {
    const result = await evaluator.executeStep('hot_slices', {
      package: 'com.smartperfetto.fixture',
    });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(1);
    expect(result.data.every(row =>
      row.process_name === 'com.smartperfetto.fixture'
      || row.process_name.startsWith('com.smartperfetto.fixture:'),
    )).toBe(true);
    expect(Object.keys(result.data[0] ?? {})).toEqual(HOT_SLICE_COLUMNS);

    const chaosTask = result.data.find(row => row.slice_name === 'ChaosTask');
    expect(chaosTask).toEqual(expect.objectContaining({
      slice_id: 117_886,
      ts: 564_168_077_532_370,
      dur_ms: 80,
      upid: 1_006,
      utid: 8_523,
      process_name: 'com.smartperfetto.fixture',
      thread_name: 'main',
      anchor_kind: 'app_trace_label',
      source_query_hint: 'ChaosTask',
    }));

    const clipped = await evaluator.executeStep('hot_slices', {
      package: 'com.smartperfetto.fixture',
      start_ts: chaosTask.ts + 1,
      end_ts: chaosTask.ts + 80_000_000,
    });
    expect(clipped.data.some(row => row.slice_id === chaosTask.slice_id)).toBe(false);

  }, 60_000);

  it('applies the bounded main-thread app-label policy without fixture special cases', async () => {
    const expected = new Map<string, 'app_trace_label' | 'generic_anchor_only'>([
      ['ChaosTask', 'app_trace_label'],
      ['StartupLoadMarker', 'app_trace_label'],
      ['WorkerLoadMarker', 'app_trace_label'],
      ['Flutter::BeginFrame', 'generic_anchor_only'],
      ['RN::FabricCommit', 'generic_anchor_only'],
      ['WebView::DrawFun', 'generic_anchor_only'],
      ['Choreographer#doFrame', 'generic_anchor_only'],
      ['FabricMount::executeMount', 'generic_anchor_only'],
      ['DrawFrame', 'generic_anchor_only'],
      ['generic trace span', 'generic_anchor_only'],
      ['Lcom/smartperfetto/fixture/Marker;', 'generic_anchor_only'],
      ['lowercaseLabel', 'generic_anchor_only'],
    ]);
    const quotedNames = [...expected.keys()].map(name => `'${name.split("'").join("''")}'`).join(',');
    const witnessRows = objectRows(await evaluator.executeSQL(`
      INCLUDE PERFETTO MODULE slices.with_context;
      SELECT id, ts, dur, name, thread_name, is_main_thread
      FROM thread_slice
      WHERE (
        process_name = 'com.smartperfetto.fixture'
        OR process_name = 'com.smartperfetto.fixture:worker'
      )
        AND name IN (${quotedNames})
      ORDER BY ts, id
    `));

    for (const [sliceName, expectedKind] of expected) {
      const witnesses = witnessRows.filter(row => row.name === sliceName);
      const witness = sliceName === 'DrawFrame'
        ? witnesses.find(row => row.is_main_thread === 0)
        : witnesses[0];
      expect(witness).toBeDefined();
      const rows = objectRows(await evaluator.executeSQL(renderHotSlicesSql(
        'com.smartperfetto.fixture',
        Number(witness.ts),
        Number(witness.ts) + Number(witness.dur),
      )));
      const classified = rows.find(row => row.slice_id === witness.id);
      expect(classified).toEqual(expect.objectContaining({
        slice_name: sliceName,
        anchor_kind: expectedKind,
        source_query_hint: expectedKind === 'app_trace_label' ? sliceName : null,
      }));
    }
  }, 60_000);

  it('treats package metacharacters literally instead of as GLOB syntax', async () => {
    const rows = objectRows(await evaluator.executeSQL(
      renderHotSlicesSql('com.smartperfetto.fixtur?'),
    ));
    expect(rows).toEqual([]);
  }, 60_000);

  it('resolves scoped sampled functions instead of a global frame inventory', async () => {
    const result = await evaluator.executeStep('native_symbols', {
      package: 'com.smartperfetto.fixture',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.data[0] ?? {})).toEqual(NATIVE_SYMBOL_COLUMNS);
    expect(result.data).toContainEqual({
      function_name: 'SmartPerfettoFrameworkHotFunction',
      module_name: '/libsmartperfetto_framework_fixture.so',
      build_id: '',
      sample_count: 12,
    });

    const outsideWindow = await evaluator.executeStep('native_symbols', {
      package: 'com.smartperfetto.fixture',
      end_ts: 564_168_277_532_369,
    });
    expect(outsideWindow.data).toEqual([]);
  }, 60_000);

  it('declares typed synthesis and the explicit no-symbol-data status token', () => {
    const source = yaml.load(fs.readFileSync(
      path.resolve(process.cwd(), 'skills/composite/code_pinpoint.skill.yaml'),
      'utf8',
    )) as any;
    const hotSlices = source.steps.find((step: any) => step.id === 'hot_slices');
    const nativeSymbols = source.steps.find((step: any) => step.id === 'native_symbols');

    expect(hotSlices.display.columns.map((column: any) => column.name)).toEqual(HOT_SLICE_COLUMNS);
    expect(hotSlices.synthesize.fields.map((field: any) => field.key)).toEqual([
      'slice_name',
      'anchor_kind',
      'source_query_hint',
    ]);
    expect(nativeSymbols.display.columns.map((column: any) => column.name)).toEqual(NATIVE_SYMBOL_COLUMNS);
    expect(nativeSymbols.on_empty).toContain('no_symbol_data');
    expect(nativeSymbols.synthesize.fields.map((field: any) => field.key)).toEqual([
      'function_name',
      'module_name',
      'build_id',
      'sample_count',
    ]);
  });
});

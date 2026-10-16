// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {RuntimePerformanceModelCallReceiptV1} from '../../agentRuntime/runtimePerformance';
import {
  assessDeliveryCallBudget,
  defaultDeliveryCallEstimateMs,
  recordRuntimeCallStatsFromManifest,
  RUNTIME_CALL_STATS_JOURNAL,
  RUNTIME_CALL_STATS_SNAPSHOT,
  RuntimeCallStatsStore,
} from '../runtimeCallStats';

const ORIGIN = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-pro';

function call(durationMs: number, overrides: Partial<RuntimePerformanceModelCallReceiptV1> = {}): RuntimePerformanceModelCallReceiptV1 {
  return {purpose: 'review', providerOrigin: ORIGIN, model: MODEL, inputBytesBucket: 'le32k',
    startOffsetMs: 0, durationMs, outcome: 'ok', ...overrides};
}

describe('runtime call stats journal and budget', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-call-stats-')); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  const budget = (store: RuntimeCallStatsStore | null, remainingMs: number, extra: Record<string, unknown> = {}) =>
    assessDeliveryCallBudget({providerOrigin: `${ORIGIN}/v1`, model: MODEL, purpose: 'review', inputBytes: 1024,
      remainingMs, store, ...extra});

  it('journals only completed delivery calls with a known origin, model and input size', () => {
    const store = new RuntimeCallStatsStore(dir);
    const written = store.appendModelCalls([
      call(10_000),
      call(20_000, {outcome: 'error'}),
      call(30_000, {outcome: 'cancelled'}),
      call(40_000, {purpose: 'answer_turn'}),
      call(50_000, {purpose: 'classification'}),
      call(60_000, {providerOrigin: undefined}),
      call(70_000, {inputBytesBucket: undefined}),
      call(80_000, {purpose: 'declaration_repair'}),
    ]);
    expect(written).toBe(2);
    const lines = fs.readFileSync(path.join(dir, RUNTIME_CALL_STATS_JOURNAL), 'utf8').trim().split('\n');
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {schemaVersion: 'runtime_call_stats_entry@1', providerOrigin: ORIGIN, model: MODEL, purpose: 'review',
        inputBytesBucket: 'le32k', durationMs: 10_000},
      expect.objectContaining({purpose: 'declaration_repair', durationMs: 80_000}),
    ]);
  });

  it('estimates the nearest-rank p75 per key once enough samples exist, and writes a snapshot', () => {
    const store = new RuntimeCallStatsStore(dir);
    store.appendModelCalls([call(10_000), call(20_000)]);
    expect(budget(store, 1_000)).toMatchObject({source: 'default', diagnostic: 'no_samples',
      estimateMs: defaultDeliveryCallEstimateMs(ORIGIN), decision: 'skip'});
    store.appendModelCalls([call(30_000), call(40_000)]);
    expect(budget(store, 30_000)).toEqual({purpose: 'review', decision: 'dispatch', source: 'stats',
      estimateMs: 30_000, remainingMs: 30_000});
    expect(budget(store, 29_999)).toMatchObject({decision: 'skip', source: 'stats'});
    // Another key (bucket) has no samples of its own.
    expect(assessDeliveryCallBudget({providerOrigin: ORIGIN, model: MODEL, purpose: 'review', inputBytes: 200 * 1024,
      remainingMs: 1_000_000, store})).toMatchObject({source: 'default', diagnostic: 'no_samples'});
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_CALL_STATS_SNAPSHOT), 'utf8'));
    expect(snapshot.entries).toEqual([expect.objectContaining({purpose: 'review', p75Ms: 30_000, samples: 4})]);
    // A fresh reader of the same directory uses the snapshot without changing it.
    expect(budget(new RuntimeCallStatsStore(dir), 30_000)).toMatchObject({source: 'stats', estimateMs: 30_000});
  });

  it('sees appends from concurrent writers on the same journal', () => {
    const left = new RuntimeCallStatsStore(dir);
    const right = new RuntimeCallStatsStore(dir);
    expect(budget(left, 1).source).toBe('default');
    for (let index = 0; index < 20; index++) (index % 2 ? left : right).appendModelCalls([call(1_000 * (index + 1))]);
    const lines = fs.readFileSync(path.join(dir, RUNTIME_CALL_STATS_JOURNAL), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.every(line => JSON.parse(line).schemaVersion === 'runtime_call_stats_entry@1')).toBe(true);
    expect(budget(left, 0).estimateMs).toBe(15_000);
    expect(budget(right, 0).estimateMs).toBe(15_000);
  });

  it('rotates a large journal and keeps reading both files', () => {
    const store = new RuntimeCallStatsStore(dir, {maxJournalBytes: 200});
    store.appendModelCalls([call(1_000), call(2_000)]);
    store.appendModelCalls([call(3_000)]);
    expect(fs.existsSync(path.join(dir, `${RUNTIME_CALL_STATS_JOURNAL}.1`))).toBe(true);
    expect(budget(store, 0)).toMatchObject({source: 'stats', estimateMs: 3_000});
  });

  it('fails open to the default on torn lines and an unreadable snapshot, never throwing', () => {
    const journal = path.join(dir, RUNTIME_CALL_STATS_JOURNAL);
    fs.writeFileSync(journal, '{"schemaVersion":"runtime_call_stats_entry@1","provider\nnot json\n');
    fs.writeFileSync(path.join(dir, RUNTIME_CALL_STATS_SNAPSHOT), '{broken');
    const store = new RuntimeCallStatsStore(dir);
    expect(budget(store, 0)).toMatchObject({source: 'default', diagnostic: 'stats_unreadable', decision: 'skip'});
    store.appendModelCalls([call(5_000), call(6_000), call(7_000)]);
    expect(budget(store, 7_000)).toMatchObject({source: 'stats', estimateMs: 7_000, decision: 'dispatch'});
  });

  it('closes a line a crashed writer left open before appending', () => {
    const journal = path.join(dir, RUNTIME_CALL_STATS_JOURNAL);
    fs.writeFileSync(journal, '{"schemaVersion":"runtime_call_stats_entry@1","provid');
    const store = new RuntimeCallStatsStore(dir);
    store.appendModelCalls([call(1_000), call(2_000), call(3_000)]);
    expect(budget(store, 0)).toMatchObject({source: 'stats', estimateMs: 3_000});
  });

  it('marks the CLI estimate as not configured and keeps per-provider defaults', () => {
    expect(budget(null, 0)).toMatchObject({source: 'default', diagnostic: 'stats_not_configured',
      estimateMs: 120_000, decision: 'skip'});
    expect(assessDeliveryCallBudget({providerOrigin: 'https://api.z.ai/api/paas/v4', purpose: 'review', inputBytes: 1,
      remainingMs: 150_000, store: null})).toMatchObject({estimateMs: 180_000, decision: 'skip'});
    expect(assessDeliveryCallBudget({purpose: 'declaration_repair', inputBytes: 1, remainingMs: 90_000, store: null}))
      .toMatchObject({estimateMs: 90_000, decision: 'dispatch'});
  });

  it('dispatches a fail-open call whatever the estimate', () => {
    expect(budget(null, 0, {failOpen: true})).toMatchObject({decision: 'dispatch', estimateMs: 120_000});
  });

  it('appends a sealed manifest only through a configured store', () => {
    const store = new RuntimeCallStatsStore(dir);
    recordRuntimeCallStatsFromManifest({performance: {schemaVersion: 1, phases: [], tools: [], sql: [],
      modelCalls: [call(1_000)]}}, store);
    recordRuntimeCallStatsFromManifest({performance: {schemaVersion: 1, phases: [], tools: [], sql: [],
      modelCalls: [call(1_000)]}}, undefined);
    recordRuntimeCallStatsFromManifest({}, store);
    expect(fs.readFileSync(path.join(dir, RUNTIME_CALL_STATS_JOURNAL), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

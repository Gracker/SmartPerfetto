// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {once} from 'events';
import {collectAgentSseOracleEvidence, parseAgentSseExpectation} from '../verifyAgentSseScrolling';
import {TraceProcessorService} from '../../services/traceProcessorService';
import {TraceProcessorFactory} from '../../services/workingTraceProcessor';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorLeases} from '../../services/analysisRunTraceProcessorLease';
import {getTraceProcessorLeaseStore, setTraceProcessorLeaseStoreForTests} from '../../services/traceProcessorLeaseStore';
import {getPortPool} from '../../services/portPool';
import {resolveCapabilityTraceProcessorIdentity} from '../../services/capabilityManifestRuntimeIdentity';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../middleware/auth';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';

jest.setTimeout(120_000);
const scope = {tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_DEV_USER_ID};
const wrapper = require(path.resolve(__dirname, '../../../scripts/run-deepseek-agent-e2e.cjs'));

function expectation() {
  const query = wrapper.semanticDeltaQueries().find((item: {kind: string}) => item.kind === 'quantitative-only');
  const args: string[] = wrapper.semanticConditionArgs(query, 'A0', 'unused-oracle-report.json', 60_000);
  return parseAgentSseExpectation(JSON.parse(args[args.indexOf('--expectation-json') + 1]));
}

async function withLoadedTrace(
  operation: (service: TraceProcessorService, traceId: string) => Promise<void>,
  options: {taintShared?: boolean} = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-native-oracle-'));
  const changes = {[ENTERPRISE_FEATURE_FLAG_ENV]: 'false', SMARTPERFETTO_ENTERPRISE_DB_PATH: path.join(root, 'enterprise.sqlite'),
    SMARTPERFETTO_DATA_DIR: path.join(root, 'data'), UPLOAD_DIR: path.join(root, 'uploads')};
  const previous = new Map(Object.keys(changes).map(key => [key, process.env[key]]));
  let service: TraceProcessorService | undefined;
  try {
    Object.assign(process.env, changes);
    service = new TraceProcessorService(path.join(root, 'uploads', 'traces'));
    const traceId = await service.loadTraceFromFilePath(path.resolve(process.cwd(),
      '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace'));
    expect(service.getTrace(traceId)?.status).toBe('ready');
    // This state follows actual loading/metadata SQL, without seeding a policy or witness:
    // loading issues only pure reads, so the shared instance stays eligible for sharing.
    expect(service.getRunningNativeProcessorObservation(traceId)).toMatchObject({status: 'trusted', nativeSchemaEligible: true, analysisRunPrivate: false});
    if (options.taintShared) {
      // An ordinary stdlib INCLUDE on the shared instance, as analysis prefetch performs.
      await service.query(traceId, 'INCLUDE PERFETTO MODULE android.startup.startups');
      expect(service.getRunningNativeProcessorObservation(traceId)).toMatchObject({status: 'tainted', analysisRunPrivate: false});
    }
    await operation(service, traceId);
  } finally {
    jest.restoreAllMocks();
    if (service) service.cleanupProcessorsForTraces(service.getAllTraces().map(trace => trace.id));
    getTraceProcessorLeaseStore().close();
    setTraceProcessorLeaseStoreForTests(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, {recursive: true, force: true});
  }
}

function expectReleased(group: AnalysisRunTraceProcessorLeases) {
  expect(group.entries).toHaveLength(1);
  const entry = group.entries[0];
  const key = `${entry.context.traceId}:lease:${entry.lease.id}`;
  expect(getTraceProcessorLeaseStore().getLeaseById(scope, entry.lease.id)).toMatchObject({state: 'released', holderCount: 0});
  expect(TraceProcessorFactory.get(key)).toBeUndefined();
  expect(getPortPool().getStats().allocations.some(allocation => allocation.traceId === key)).toBe(false);
}

describe('real native oracle lease lifecycle', () => {
  it('binds the synthetic source marker to exact thread-state and first-frame boundaries', async () => {
    await withLoadedTrace(async (service, traceId) => {
      const result = await service.query(traceId, `
        WITH target AS (
          SELECT s.ts AS start_ts, s.ts + s.dur AS end_ts, s.dur, t.utid, t.name AS thread_name,
                 p.upid, p.name AS process_name
          FROM slice s JOIN thread_track tt ON tt.id = s.track_id
          JOIN thread t USING (utid) JOIN process p USING (upid)
          WHERE s.name = 'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy'
        ), first_frame AS (
          SELECT s.ts, s.ts + s.dur AS end_ts, s.dur, t.utid, p.upid
          FROM slice s JOIN thread_track tt ON tt.id = s.track_id
          JOIN thread t USING (utid) JOIN process p USING (upid)
          WHERE s.name = 'StartupHooks.onFirstFrame#synthetic-first-frame-boundary'
        ), state_totals AS (
          SELECT SUM(MIN(st.ts + st.dur, target.end_ts) - MAX(st.ts, target.start_ts)) AS covered_ns,
                 SUM(CASE WHEN st.state = 'Running' THEN
                   MIN(st.ts + st.dur, target.end_ts) - MAX(st.ts, target.start_ts) ELSE 0 END) AS running_ns,
                 SUM(CASE WHEN st.state = 'D' THEN
                   MIN(st.ts + st.dur, target.end_ts) - MAX(st.ts, target.start_ts) ELSE 0 END) AS d_ns
          FROM target JOIN thread_state st ON st.utid = target.utid
          WHERE st.dur >= 0 AND st.ts < target.end_ts AND st.ts + st.dur > target.start_ts
        ), first_frame_state AS (
          SELECT SUM(MIN(st.ts + st.dur, first_frame.end_ts) - MAX(st.ts, first_frame.ts)) AS running_ns
          FROM first_frame JOIN thread_state st ON st.utid = first_frame.utid
          WHERE st.state = 'Running' AND st.dur >= 0 AND st.ts < first_frame.end_ts
            AND st.ts + st.dur > first_frame.ts
        )
        SELECT target.dur, target.process_name, target.thread_name, state_totals.covered_ns,
               state_totals.running_ns, state_totals.d_ns, first_frame.ts - target.end_ts,
               first_frame_state.running_ns,
               (SELECT COUNT(*) FROM slice s JOIN thread_track tt ON tt.id = s.track_id
                 JOIN thread t USING (utid) JOIN process p USING (upid)
                 WHERE s.name = 'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy'
                   AND p.name = 'com.example.androidappdemo') AS base_marker_count,
               target.utid = first_frame.utid AND target.upid = first_frame.upid AS same_actor
        FROM target, first_frame, state_totals, first_frame_state`);

      expect(result.rows).toEqual([[
        42_000_000, 'com.smartperfetto.fixture', 'main', 42_000_000, 22_000_000, 20_000_000,
        38_000_000, 1_000_000, 0, 1,
      ]]);
    });
  });

  it('queries two actual native processors under one pair lease without crossing side pins', async () => {
    await withLoadedTrace(async (service, traceId) => {
      const referenceTraceId = await service.loadTraceFromFilePath(path.resolve(process.cwd(), '../Trace/real/android-startup-light/trace.pftrace'));
      const sql = 'SELECT id AS row_id, dur FROM slice WHERE dur >= 0 ORDER BY id LIMIT 1';
      const expected = parseAgentSseExpectation({schemaVersion: 1, intent: {taskKind: 'comparison'}, facts:
        ['current', 'reference'].map(traceSide => ({id: `${traceSide}_duration`, kind: 'numeric', columns: ['dur'], unit: 'ns',
          verification: 'proved', oracle: {sql, column: 'dur', unit: 'ns', traceSide,
            anchorMatch: {nativeRow: {relation: 'slice', idColumn: 'id', oracleColumn: 'row_id'}}}}))});
      let owned: AnalysisRunTraceProcessorLeases | undefined;
      const prepare = jest.fn(async (input: Parameters<typeof prepareAnalysisRunTraceProcessorLeases>[0]) => {
        owned = await prepareAnalysisRunTraceProcessorLeases(input); return owned;
      });
      const query = jest.spyOn(service, 'query');
      const result = await collectAgentSseOracleEvidence({service, traceId, referenceTraceId, expectation: expected, scope,
        deadlineMs: Date.now() + 90_000}, {prepareLeases: prepare});
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(owned!.entries.map(entry => entry.side)).toEqual(['current', 'reference']);
      expect(result.schemas.current_duration.traceId).toBe(traceId);
      expect(result.schemas.reference_duration.traceId).toBe(referenceTraceId);
      expect(query.mock.calls.filter(call => call[1] === sql).map(call => call[0])).toEqual([traceId, referenceTraceId]);
      expect(result.rows.current_duration).toHaveLength(1);
      expect(result.rows.reference_duration).toHaveLength(1);
      // Both freshly loaded sides are still trusted, so the pair runs on their shared
      // processors; a released shared lease idles for the viewer instead of draining.
      for (const entry of owned!.entries) {
        expect(entry).toMatchObject({privateProcessor: false, context: {mode: 'shared'}});
        expect(getTraceProcessorLeaseStore().getLeaseById(scope, entry.lease.id)).toMatchObject({state: 'idle', holderCount: 0});
      }
    });
  });

  it('loads a tainted shared instance, uses one real isolated group for the original JOIN, and releases it', async () => {
    await withLoadedTrace(async (service, traceId) => {
      const shared = service.getRunningNativeProcessorObservation(traceId)!;
      let owned: AnalysisRunTraceProcessorLeases | undefined;
      let released: Promise<unknown> | undefined;
      const prepare = jest.fn(async (input: Parameters<typeof prepareAnalysisRunTraceProcessorLeases>[0]) => {
        owned = await prepareAnalysisRunTraceProcessorLeases(input);
        expect(owned.entries[0]).toMatchObject({privateProcessor: true, context: {mode: 'isolated'}});
        released = once(getPortPool(), 'released', {signal: AbortSignal.timeout(10_000)});
        return owned;
      });
      const query = jest.spyOn(service, 'query');
      const expected = expectation();
      const result = await collectAgentSseOracleEvidence({service, traceId, expectation: expected, scope, deadlineMs: Date.now() + 90_000},
        {prepareLeases: prepare});
      await released;
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][1]).toBe(expected.facts[0].oracle!.sql);
      expect(result.rows.source_marker_duration).toEqual([expect.objectContaining({duration_ns: 42_000_000, row_id: expect.any(Number)})]);
      expect(result.schemas.source_marker_duration).toMatchObject({traceId, relation: 'slice', idColumn: 'id', schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)});
      expectReleased(owned!);
      expect(service.getRunningNativeProcessorObservation(traceId)?.instanceToken).toBe(shared.instanceToken);
      expect(service.getRunningNativeProcessorObservation(traceId)?.status).toBe('tainted');
    }, {taintShared: true});
  });

  it('cancels and releases the real private group when the post-query pin check exceeds the original deadline', async () => {
    await withLoadedTrace(async (service, traceId) => {
      let owned: AnalysisRunTraceProcessorLeases | undefined;
      let released: Promise<unknown> | undefined;
      let queryCompleted = false;
      let completeLateIdentity: (() => void) | undefined;
      const originalQuery = service.query;
      const query = jest.spyOn(service, 'query').mockImplementation(function(this: TraceProcessorService, ...args) {
        const promise = Reflect.apply(originalQuery, this, args) as ReturnType<TraceProcessorService['query']>;
        void promise.then(() => {queryCompleted = true;}, () => undefined);
        return promise;
      });
      const prepare = jest.fn(async (input: Parameters<typeof prepareAnalysisRunTraceProcessorLeases>[0]) => {
        owned = await prepareAnalysisRunTraceProcessorLeases(input);
        released = once(getPortPool(), 'released', {signal: AbortSignal.timeout(30_000)});
        return owned;
      });
      try {
        await expect(collectAgentSseOracleEvidence({service, traceId, expectation: expectation(), scope, deadlineMs: Date.now() + 20_000}, {
          prepareLeases: prepare,
          resolveIdentity: async input => {
            const actual = await resolveCapabilityTraceProcessorIdentity(input);
            if (!queryCompleted) return actual;
            return new Promise(resolve => {completeLateIdentity = () => resolve(actual);});
          },
        })).rejects.toMatchObject({name: 'TimeoutError'});
        completeLateIdentity?.();
        await released;
        expect(queryCompleted).toBe(true);
        expect(query).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expectReleased(owned!);
      } finally {completeLateIdentity?.(); owned?.release();}
    }, {taintShared: true});
  });
});

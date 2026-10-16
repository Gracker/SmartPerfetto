// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Registered drill-down parameter resolution, as used by the MCP drill-down path.
 */

import Database from 'better-sqlite3';
import {resolveRegisteredDrillDownSkillParams} from '../drillDownEntityResolver';
import {createEffectiveProcessScope} from '../../../services/processIdentity/effectiveProcessScope';

describe('resolveRegisteredDrillDownSkillParams', () => {
  test('preserves parameters for external skills outside the drill-down registry', async () => {
    const query = jest.fn();
    const params = {
      frameId: 'vendor-frame',
      startTs: '10',
      endTs: '20',
    };

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId: 'external_workspace_skill',
      params,
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(result).toEqual({params, enriched: false});
    expect(result.params).not.toBe(params);
    expect(query).not.toHaveBeenCalled();
  });

  test('resolves a frame_ts-only frame drill-down to one complete interval', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['match_count', 'frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'jank_type'],
      rows: [[1, '8032532', '74829612835103', '74829621168436', '8333333', 'com.example.app', 'App Deadline Missed']],
    });

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '74829612835103', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.enriched).toBe(true);
    expect(result.params).toEqual(expect.objectContaining({
      frame_id: '8032532',
      frame_ts: '74829612835103',
      start_ts: '74829612835103',
      end_ts: '74829621168436',
      process_name: 'com.example.app',
    }));
    expect(result.resolution).toMatchObject({
      entityType: 'frame',
      resolvedEntityId: '8032532',
      resolveSource: 'actual_frame_ts',
    });
  });

  test('fails closed when frame_id and frame_ts resolve to different frames', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['frame_id', 'start_ts', 'end_ts', 'process_name', 'jank_type'],
      rows: [['8032532', '100', '200', 'com.example.app', 'App Deadline Missed']],
    });

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {
        frame_id: '8032532',
        frame_ts: '101',
        process_name: 'com.example.app',
      },
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/frame_ts conflicts with the resolved frame interval/i);
  });

  test('fails closed when jank_frame_detail has no frame entity or interval', async () => {
    const query = jest.fn();

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/requires an entity id, frame timestamp, or complete start_ts\/end_ts interval/i);
    expect(query).not.toHaveBeenCalled();
  });

  test.each([
    'jank_frame_detail',
    'frame_blocking_calls',
    'blocking_chain_analysis',
  ])('accepts a complete explicit interval for %s without an entity lookup', async skillId => {
    const query = jest.fn();
    const params = {process_name: 'com.example.app', start_ts: '100', end_ts: '200'};

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId,
      params,
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(result).toEqual({
      params: {process_name: 'com.example.app', start_ts: '100', end_ts: '200'},
      enriched: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test('fails closed when frame_ts resolves to more than one process-scoped frame', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['match_count', 'frame_id', 'start_ts', 'end_ts', 'process_name'],
      rows: [[2, '8032532', '100', '200', 'com.example.app']],
    });

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '100', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/unique frame interval/i);
  });

  test('fails closed when frame_ts does not resolve to a frame', async () => {
    const query = jest.fn().mockResolvedValue({columns: [], rows: []});

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '100', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/unable to resolve/i);
  });
});

describe('drill-down exact process identity', () => {
  it('enriches only startups owned by the exact UPID while preserving named and unscoped lookups', async () => {
    const db = new Database(':memory:');
    const scope = createEffectiveProcessScope('trace', 'current', {upid: 42}, {
      status: 'verified', upids: [42], confidenceScore: 100, evidenceSources: ['upid'], warnings: [],
      candidates: [{rank: 1, confidenceScore: 100, upid: 42, processName: 'com.example'}],
    });
    try {
      db.exec(`
        CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT, startup_type TEXT);
        CREATE TABLE android_startup_time_to_display(startup_id INTEGER, time_to_initial_display INTEGER, time_to_full_display INTEGER);
        CREATE TABLE android_startup_processes(startup_id INTEGER, upid INTEGER);
        INSERT INTO android_startups VALUES
          (12, 100, 20, 'com.example', 'cold'),
          (13, 200, 30, 'com.example', 'warm'),
          (14, 300, 40, 'com.example:child', 'cold'),
          (15, 400, 50, 'com.example.similar', 'cold');
        INSERT INTO android_startup_processes VALUES (12,42), (13,43), (14,44), (15,45);
      `);
      const query = jest.fn(async (_traceId: string, sql: string) => {
        const statement = db.prepare<[], unknown[]>(sql);
        return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
      });
      const resolve = (startupId: number, processScope = scope, packageName = 'com.example') =>
        resolveRegisteredDrillDownSkillParams({skillId: 'startup_detail',
          params: {startup_id: startupId, package: packageName}, traceId: 'trace',
          traceProcessorService: {query}, processScope});

      const exact = await resolve(12);
      expect(exact.params).toMatchObject({startup_id: '12', start_ts: 100, end_ts: 120});
      for (const startupId of [13, 14, 15]) {
        await expect(resolve(startupId)).rejects.toThrow('Unable to resolve a complete startup interval');
      }

      const namedScope = createEffectiveProcessScope('trace', 'current', {requestedName: 'com.example'});
      for (const [startupId, startTs, endTs] of [[12, 100, 120], [13, 200, 230], [14, 300, 340]]) {
        const named = await resolve(startupId, namedScope);
        expect(named.params).toMatchObject({start_ts: startTs, end_ts: endTs});
      }
      await expect(resolve(15, namedScope)).rejects.toThrow('Unable to resolve a complete startup interval');

      const unscoped = await resolveRegisteredDrillDownSkillParams({skillId: 'startup_detail',
        params: {startup_id: 15}, traceId: 'trace', traceProcessorService: {query}});
      expect(unscoped.params).toMatchObject({startup_id: '15', start_ts: 400, end_ts: 450});
      for (const [, sql] of query.mock.calls) {
        expect(sql).not.toMatch(/\$(?:process_name|upid|startup_id)\b/);
      }
    } finally {
      db.close();
    }
  });

  it('resolves the frame inside the trusted UPID and rejects cross-trace reuse before querying', async () => {
    const db = new Database(':memory:');
    const scope = createEffectiveProcessScope('trace', 'current', { upid: 42 }, {
      status: 'verified', upids: [42], confidenceScore: 100, evidenceSources: ['upid'], warnings: [],
      candidates: [{ rank: 1, confidenceScore: 100, upid: 42, processName: 'com.example' }],
    });
    try {
      db.exec(`CREATE TABLE process(upid INTEGER, name TEXT);
        CREATE TABLE actual_frame_timeline_slice(upid INTEGER, display_frame_token INTEGER,
          surface_frame_token INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT, layer_name TEXT);
        INSERT INTO process VALUES (42,'com.example'),(43,'com.example');
        INSERT INTO actual_frame_timeline_slice VALUES (42,7,NULL,100,20,'None','same'),
          (43,7,NULL,10,900,'None','same');`);
      const query = jest.fn(async (_trace: string, sql: string) => {
        const statement = db.prepare<[], unknown[]>(sql);
        return { columns: statement.columns().map(column => column.name), rows: statement.raw().all() };
      });
      const result = await resolveRegisteredDrillDownSkillParams({ skillId: 'frame_blocking_calls',
        params: { frame_id: 7 }, traceId: 'trace', traceProcessorService: { query }, processScope: scope });
      expect(result.params).toMatchObject({ start_ts: 100, end_ts: 120 });
      expect(result.resolution?.row.upid).toBe(42);
      await expect(resolveRegisteredDrillDownSkillParams({ skillId: 'frame_blocking_calls',
        params: { frame_id: 7 }, traceId: 'reference', traceProcessorService: { query }, processScope: scope }))
        .rejects.toThrow('different trace/side');
      expect(query).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});

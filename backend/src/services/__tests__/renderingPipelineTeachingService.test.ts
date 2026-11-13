// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { RenderingPipelineTeachingService } from '../renderingPipelineTeachingService';

const mockExecute = jest.fn<(...args: any[]) => any>();
const mockRegisterSkills = jest.fn();

jest.mock('../skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: jest.fn(async () => {}),
  skillRegistry: {
    getAllSkills: jest.fn(() => []),
  },
}));

jest.mock('../skillEngine/skillExecutor', () => ({
  SkillExecutor: jest.fn().mockImplementation(() => ({
    registerSkills: mockRegisterSkills,
    execute: mockExecute,
  })),
}));

function buildSkillResult(): any {
  return {
    skillId: 'rendering_pipeline_detection',
    skillName: 'rendering_pipeline_detection',
    success: true,
    displayResults: [],
    diagnostics: [],
    rawResults: {
      subvariants: {
        stepId: 'subvariants',
        stepType: 'atomic',
        success: true,
        data: [{
          buffer_mode: 'BLAST',
          flutter_engine: 'N/A',
          webview_mode: 'N/A',
          game_engine: 'N/A',
        }],
      },
      pipeline_bundle: {
        stepId: 'pipeline_bundle',
        stepType: 'pipeline',
        success: true,
        data: {
          detection: {
            detected: true,
            primaryPipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
            primaryRenderingTypeId: 'S02_AOSP_STANDARD',
            primaryConfidence: 0.92,
            candidates: [
              { id: 'ANDROID_VIEW_STANDARD_BLAST', confidence: 0.92 },
            ],
            renderingTypeCandidates: [
              { id: 'S02_AOSP_STANDARD', confidence: 0.92 },
            ],
            relatedRenderingTypes: [{
              id: 'S06_MULTI_WINDOW',
              confidence: 0.81,
              docPath: 'skills/pipelines/index.yaml#rendering_types.S06_MULTI_WINDOW',
            }],
            features: [{ name: 'has_draw_frame', detected: true }],
            traceRequirementsMissing: [],
          },
          teachingContent: {
            title: 'S02 AOSP 标准类型',
            summary: 'Standard HWUI path.',
            mermaidBlocks: [],
            threadRoles: [],
            keySlices: ['Choreographer#doFrame', 'DrawFrame'],
            docPath: 'skills/pipelines/index.yaml#rendering_types.S02_AOSP_STANDARD',
          },
          pinInstructions: [{
            pattern: '^main',
            matchBy: 'name',
            priority: 1,
            reason: 'App main thread',
          }],
          activeRenderingProcesses: [{
            upid: 10,
            processName: 'com.demo',
            frameCount: 30,
            renderThreadTid: 1234,
          }],
          docPath: 'skills/pipelines/index.yaml#rendering_types.S02_AOSP_STANDARD',
        },
      },
    },
    executionTimeMs: 10,
  };
}

describe('RenderingPipelineTeachingService', () => {
  it('observes device functor and SurfaceTexture names without including a similar package', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER, name TEXT);
        CREATE TABLE thread(utid INTEGER, upid INTEGER, name TEXT);
        CREATE TABLE thread_track(id INTEGER, utid INTEGER);
        CREATE TABLE slice(id INTEGER, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
        INSERT INTO process VALUES (1,'com.demo'), (2,'com.demo:renderer'), (3,'com.demo.extra');
        INSERT INTO thread VALUES (11,1,'RenderThread'),(12,2,'RenderThread'),(13,3,'RenderThread');
        INSERT INTO thread_track VALUES (101,11),(102,12),(103,13);
        INSERT INTO slice VALUES
          (1,101,100,10,'WebViewFunctor::drawVk'),
          (2,102,110,10,'DrawFn_DrawVk'),
          (3,101,120,10,'ASurfaceTexture_dequeueBuffer'),
          (4,103,130,10,'WebViewFunctor::drawVk'),
          (5,101,200,10,'WebViewFunctor::drawVk'),
          (6,101,140,-1,'WebViewFunctor::drawVk');
      `);
      const processor = {query: async (_traceId: string, sql: string) => {
        const query = db.prepare(sql);
        return {columns: query.columns().map((column) => column.name), rows: query.raw().all(), durationMs: 0};
      }};
      const service = new RenderingPipelineTeachingService(processor as any);
      const events = await (service as any).queryObservedEventRows('trace', [], 'com.demo',
        {startTs: 100, endTs: 200});
      expect(events.map((event: {name: string}) => event.name)).toEqual([
        'WebViewFunctor::drawVk', 'DrawFn_DrawVk', 'ASurfaceTexture_dequeueBuffer',
      ]);
      expect(events.every((event: {upid: number}) => event.upid === 1 || event.upid === 2)).toBe(true);
    } finally {
      db.close();
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue(buildSkillResult());
  });

  it('builds the v2 teaching contract from pipeline_bundle and observed slice rows', async () => {
    const traceProcessorService = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('root_events(event_id')) {
          // The RenderThread event overlaps its Running row most.
          return {
            columns: ['event_id', 'lane_id', 'thread_state_id', 'ts', 'dur', 'utid', 'state', 'thread_name', 'process_name'],
            rows: [
              ['event-2-3000', 'render_thread_com_demo_renderthread', 501, 2500, 700_000, 22, 'Running', 'RenderThread', 'com.demo'],
            ],
            durationMs: 1,
          };
        }
        if (sql.includes('WITH target AS')) {
          // The engine's direct-waker lookup (L2) for that row.
          return {
            columns: ['target_id', 'target_ts', 'waker_utid', 'waker_id', 'irq_context', 'waker_state', 'waker_cpu',
              'waker_tid', 'waker_thread_name', 'waker_process_name'],
            rows: [[501, 2500, 21, 500, 0, 'Running', 3, 100, 'main', 'com.demo']],
            durationMs: 1,
          };
        }
        if (sql.includes('INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice')) {
          return { columns: [], rows: [], durationMs: 1 };
        }
        if (sql.includes('FROM _critical_path_stack')) {
          // The engine's stack query (L1); the root's own rows are filtered in SQL.
          return {
            columns: ['id', 'ts', 'dur', 'utid', 'name', 'table_name', 'segment_rank', 'tid', 'upid', 'thread_name', 'process_name'],
            rows: [
              [610, 2200, 500_000, 21, 'blocking thread_state:Running', 'thread_state', 1, 100, 10, 'main', 'com.demo'],
              [611, 2200, 500_000, 21, 'Choreographer#doFrame', 'slice', 1, 100, 10, 'main', 'com.demo'],
            ],
            durationMs: 1,
          };
        }
        return {
          columns: [
            'ts',
            'dur',
            'name',
            'track_id',
            'utid',
            'upid',
            'thread_name',
            'process_name',
            'stage',
          ],
          rows: [
            [1000, 2_000_000, 'Choreographer#doFrame', 7, 21, 10, 'main', 'com.demo', 'app_frame'],
            [3000, 1_500_000, 'DrawFrame', 8, 22, 10, 'RenderThread', 'com.demo', 'render_thread'],
          ],
          durationMs: 1,
        };
      }),
    };

    const service = new RenderingPipelineTeachingService(traceProcessorService as any);
    const response = await service.analyze({
      traceId: 'trace-1',
      packageName: 'com.demo',
      visibleWindow: { startTs: 0, endTs: 10_000 },
    });

    expect(mockExecute).toHaveBeenCalledWith('rendering_pipeline_detection', 'trace-1', {
      package: 'com.demo',
    });
    expect(response).toEqual(expect.objectContaining({
      success: true,
      schemaVersion: 'teaching.pipeline.v2',
      teaching: expect.objectContaining({
        title: 'S02 AOSP 标准类型',
      }),
      teachingContent: expect.objectContaining({
        title: 'S02 AOSP 标准类型',
      }),
      pinInstructions: expect.any(Array),
      activeRenderingProcesses: expect.any(Array),
    }));
    expect(response.detection).toEqual(expect.objectContaining({
      primaryPipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      primaryRenderingTypeId: 'S02_AOSP_STANDARD',
      renderingType: {
        id: 'S02_AOSP_STANDARD',
        docPath: 'skills/pipelines/index.yaml#rendering_types.S02_AOSP_STANDARD',
      },
      renderingTypeCandidates: [
        { id: 'S02_AOSP_STANDARD', confidence: 0.92 },
      ],
      relatedRenderingTypes: [{
        id: 'S06_MULTI_WINDOW',
        confidence: 0.81,
        docPath: 'skills/pipelines/index.yaml#rendering_types.S06_MULTI_WINDOW',
      }],
      primary_pipeline: {
        id: 'ANDROID_VIEW_STANDARD_BLAST',
        confidence: 0.92,
      },
      trace_requirements_missing: [],
    }));
    expect(response.observedFlow?.context.timeRange).toEqual({
      startTs: 0,
      endTs: 10000,
      source: 'visible_window',
    });
    expect(response.observedFlow?.events).toHaveLength(2);
    expect(response.observedFlow?.lanes.map((lane) => lane.role)).toEqual(
      expect.arrayContaining(['app', 'render_thread'])
    );
    expect(response.pinPlan).toEqual(expect.objectContaining({
      status: 'planned',
      expectedLaneIds: expect.any(Array),
    }));
    expect(response.overlayPlan).toEqual(expect.objectContaining({
      status: 'ready',
      skillId: 'pipeline_key_slices_overlay',
      eventIds: expect.arrayContaining(['event-1-1000', 'event-2-3000']),
    }));
    expect(response.observedFlow?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'wakes_to',
          evidenceSource: 'thread_state_waker_id',
        }),
        expect.objectContaining({
          relation: 'critical_path_to',
          evidenceSource: 'official_critical_path_stack',
        }),
      ])
    );
    expect(response.observedFlow?.criticalTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'direct_wakeup',
          rootEventId: 'event-2-3000',
          waker: expect.objectContaining({
            threadName: 'main',
            processName: 'com.demo',
          }),
        }),
        expect.objectContaining({
          kind: 'critical_path_segment',
          evidenceSource: 'official_critical_path_stack',
          name: 'Choreographer#doFrame',
          threadStateId: 610,
          state: 'Running',
        }),
      ])
    );
    // The waker comes from the engine's wakeup-row lookup of the selected row,
    // never from waker_id on the Running row itself.
    const calls = (traceProcessorService.query as jest.Mock).mock.calls.map((call) => call[1] as string);
    const wakerSql = calls.filter((sql) => sql.includes('WITH target AS'));
    expect(wakerSql).toHaveLength(1);
    expect(wakerSql.every((sql) => sql.includes('WHERE id = 501'))).toBe(true);
    expect(wakerSql[0]).toContain('adj.ts + adj.dur = target.ts');
    expect(calls.find((sql) => sql.includes('root_events(event_id'))).not.toContain('waker');
    expect(response.observedFlow?.criticalTasks?.find((task) => task.kind === 'direct_wakeup')).toMatchObject({
      threadStateId: 501,
      state: 'Running',
      waker: {threadStateId: 500, utid: 21, threadName: 'main', irqContext: false, kind: 'thread'},
    });
    const observedSql = (traceProcessorService.query as jest.Mock).mock.calls
      .map((call) => call[1] as string)
      .find((sql) => sql.includes('FROM slice s')) as string;
    expect(observedSql).toContain("s.name LIKE '%Choreographer%'");
    expect(observedSql).not.toContain("OR lower(t.name) = 'main'");
    expect(observedSql).not.toContain("OR t.name = 'RenderThread'");
  });

  it('expands zero-duration selection context instead of producing an empty time window', async () => {
    const traceProcessorService = {
      query: jest.fn(async () => ({
        columns: ['ts', 'dur', 'name', 'track_id', 'utid', 'upid', 'thread_name', 'process_name', 'stage'],
        rows: [],
        durationMs: 1,
      })),
    };

    const service = new RenderingPipelineTeachingService(traceProcessorService as any);
    const response = await service.analyze({
      traceId: 'trace-1',
      packageName: 'com.demo',
      selectionContext: { kind: 'track_event', ts: 1_000, dur: 0 },
      visibleWindow: { startTs: 0, endTs: 10_000 },
    });

    expect(response.observedFlow?.context.timeRange).toEqual({
      startTs: 1_000,
      endTs: 50_001_000,
      source: 'selection',
    });
    const observedSql = (traceProcessorService.query as jest.Mock).mock.calls[0][1] as string;
    expect(observedSql).toContain('s.ts >= 1000 AND s.ts < 50001000');
  });

  it('does not infer frame handoffs from overlapping events or candidate pipeline roles', async () => {
    const skillResult = buildSkillResult();
    skillResult.rawResults.pipeline_bundle.data.detection.candidates.push({
      id: 'WEBVIEW_TEXTUREVIEW_CUSTOM',
      confidence: 0.74,
    });
    skillResult.rawResults.pipeline_bundle.data.detection.features.push({
      name: 'WEBVIEW_TEXTUREVIEW',
      detected: true,
    });
    mockExecute.mockResolvedValue(skillResult);

    const traceProcessorService = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (
          sql.includes('root_events(event_id') ||
          sql.includes('INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice') ||
          sql.includes('FROM _critical_path_stack')
        ) {
          return { columns: [], rows: [], durationMs: 1 };
        }
        return {
          columns: [
            'ts',
            'dur',
            'name',
            'track_id',
            'utid',
            'upid',
            'thread_name',
            'process_name',
            'stage',
          ],
          rows: [
            [1000, 2_000_000, 'Choreographer#doFrame', 7, 21, 10, 'main', 'com.demo', 'app_frame'],
            [3000, 1_500_000, 'DrawFrame', 8, 22, 10, 'RenderThread', 'com.demo', 'render_thread'],
          ],
          durationMs: 1,
        };
      }),
    };

    const service = new RenderingPipelineTeachingService(traceProcessorService as any);
    const response = await service.analyze({
      traceId: 'trace-1',
      packageName: 'com.demo',
      visibleWindow: { startTs: 0, endTs: 10_000 },
    });

    // Even overlapping main/RT slices do not identify a buffer handoff.
    expect(response.observedFlow?.dependencies).toEqual([]);

    const producerLane = response.observedFlow?.lanes.find((lane) => lane.role === 'producer');
    expect(producerLane).toBeDefined();
    expect(response.observedFlow?.dependencies).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toLaneId: producerLane?.id,
        }),
      ])
    );
  });
});

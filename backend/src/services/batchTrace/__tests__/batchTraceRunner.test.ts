// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DataEnvelope } from '../../../types/dataContract';
import { SkillRegistry } from '../../skillEngine/skillLoader';
import type { SkillExecutionResult } from '../../skillEngine/types';
import type { TraceProcessorService } from '../../traceProcessorService';
import type { TraceProcessorLeaseStore } from '../../traceProcessorLeaseStore';
import { runBatchSkill } from '../batchTraceRunner';
import type {
  TraceSummaryExecutionV1,
  TraceSummaryMetricResultV1,
} from '../../traceSummaryExecutor';
import {unavailableTraceSummaryV1} from '../../traceSummaryExecutor';
import type {ManagedTraceSummaryRunner} from '../../managedTraceSummary';
import type {TraceSummaryMetricDefinitionV1} from '../../traceSummarySpecRegistry';

let executeMock: jest.MockedFunction<(skillId: string, traceId: string, params: Record<string, unknown>) => Promise<SkillExecutionResult>>;
let toDataEnvelopesMock: jest.MockedFunction<(result: SkillExecutionResult) => DataEnvelope[]>;

jest.mock('../../skillEngine/skillExecutor', () => ({
  createSkillExecutor: () => ({
    setFragmentRegistry: jest.fn(),
    registerSkills: jest.fn(),
    execute: executeMock,
  }),
  SkillExecutor: {
    toDataEnvelopes: (result: SkillExecutionResult) => toDataEnvelopesMock(result),
  },
}));

function registry(type: 'atomic' | 'comparison' = 'atomic', batchAnalysis = false): SkillRegistry {
  const skillRegistry = new SkillRegistry();
  skillRegistry.upsertSkill({
    name: 'startup_analysis',
    version: '1',
    type: batchAnalysis ? 'composite' : type,
    meta: {
      display_name: 'Startup',
      description: 'Startup',
    },
    ...(batchAnalysis ? {
      steps: [{id: 'dominator_paths', type: 'atomic', sql: 'select 1'}],
      batch_analysis: {
        operation: 'heap_path_cluster',
        source_step: 'dominator_paths',
        output_contract: 'HeapPathClusterAnalysisV1',
        per_trace_row_limit: 500,
        total_row_limit: 5000,
        required_columns: [
          'upid', 'process_name', 'graph_sample_ts', 'path', 'class_name',
          'root_type', 'self_count', 'retained_count', 'self_size_bytes',
          'retained_size_bytes',
        ],
      },
    } : {sql: 'select 1'}),
  });
  return skillRegistry;
}

function traceProcessor(): TraceProcessorService {
  return {
    loadTraceFromFilePath: jest.fn(async (tracePath: string) => `trace-${tracePath}`),
    getOrLoadTrace: jest.fn(async (traceId: string) => ({
      id: traceId,
      filename: `${traceId}.trace`,
      size: 10,
      uploadTime: new Date(),
      status: 'ready',
    })),
    ensureProcessorForLease: jest.fn(async () => ({})),
    runWithLease: jest.fn(async (_context, fn: () => Promise<SkillExecutionResult>) => fn()),
    cleanupProcessorsForTraces: jest.fn(() => 1),
  } as unknown as TraceProcessorService;
}

function leaseStore(): TraceProcessorLeaseStore {
  return {
    acquireHolder: jest.fn(() => ({
      id: 'lease-1',
      tenantId: 'cli',
      workspaceId: 'local',
      traceId: 'trace-a',
      mode: 'shared',
      state: 'ready',
      rssBytes: null,
      heartbeatAt: null,
      expiresAt: null,
      holderCount: 1,
      holders: [],
    })),
    releaseHolder: jest.fn(),
    markStarting: jest.fn(),
    markReady: jest.fn(),
  } as unknown as TraceProcessorLeaseStore;
}

function envelope(): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'startup_analysis',
      timestamp: 1,
      skillId: 'startup_analysis',
      stepId: 'overview',
      evidenceRefId: 'ev-1',
    },
    data: { columns: ['total_ms'], rows: [[42]] },
    display: {
      layer: 'overview',
      format: 'table',
      title: 'Overview',
      level: 'key',
    },
  };
}

beforeEach(() => {
  executeMock = jest.fn(async () => ({
    skillId: 'startup_analysis',
    skillName: 'Startup',
    success: true,
    displayResults: [],
    diagnostics: [],
    executionTimeMs: 5,
  }));
  toDataEnvelopesMock = jest.fn(() => [envelope()]);
});

describe('runBatchSkill', () => {
  it('adds canonical summary metrics and aggregates missing rows without zero filling', async () => {
    const summaries = new Map<string, TraceSummaryExecutionV1>([
      ['trace-a.pftrace', readySummary(697, 21)],
      ['trace-b.pftrace', readySummary(undefined, undefined)],
    ]);
    const run = await runBatchSkill({
      surface: 'cli', skillId: 'startup_analysis',
      traceInputs: [
        {ordinal: 0, source: 'local_path', tracePath: 'a.pftrace'},
        {ordinal: 1, source: 'local_path', tracePath: 'b.pftrace'},
      ],
    }, {
      traceProcessor: traceProcessor(), registry: registry(),
      traceSummaryRunner: async (_service, traceId) => summaries.get(traceId)!,
    });

    expect(run.perTrace[0].traceSummary).toEqual(expect.objectContaining({status: 'ready'}));
    expect(run.perTrace[0].metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: 'smartperfetto_frame_timeline_jank_count', numericValue: 21}),
    ]));
    expect(run.perTrace[1].metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'smartperfetto_frame_timeline_jank_count', value: null,
        missingReason: 'trace_summary:no_rows',
      }),
    ]));
    expect(run.aggregate?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'smartperfetto_frame_timeline_jank_count', count: 1, missingCount: 1,
        min: 21, max: 21,
      }),
    ]));
  });

  it('runs every trace through a batch lease and records per-trace metrics', async () => {
    const tp = traceProcessor();
    const leases = leaseStore();
    const seen: number[] = [];
    const traceSummaryRunner: ManagedTraceSummaryRunner = jest.fn(async (_service, _traceId, _side, options) => {
      expect(options).toEqual(expect.objectContaining({
        leaseId: 'lease-1', leaseMode: 'shared',
      }));
      return unavailableTraceSummaryV1('trace_processor_session_unavailable');
    });

    const run = await runBatchSkill({
      scope: { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      surface: 'cli',
      skillId: 'startup_analysis',
      traceInputs: [
        { ordinal: 0, source: 'local_path', tracePath: 'a.pftrace' },
        { ordinal: 1, source: 'local_path', tracePath: 'b.pftrace' },
      ],
      onTraceResult: result => seen.push(result.ordinal),
    }, {
      traceProcessor: tp,
      registry: registry(),
      leaseStore: leases,
      traceSummaryRunner,
    });

    expect(run.status).toBe('completed');
    expect(run.perTrace.map(result => result.ordinal)).toEqual([0, 1]);
    expect(run.perTrace[0].metrics[0]).toMatchObject({ key: 'startup.total_ms', numericValue: 42 });
    expect(seen.sort()).toEqual([0, 1]);
    expect(leases.acquireHolder).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', workspaceId: 'workspace-a' }),
      expect.any(String),
      expect.objectContaining({ holderType: 'batch_trace_run' }),
      { mode: 'shared' },
    );
    expect(tp.cleanupProcessorsForTraces).toHaveBeenCalledWith(expect.arrayContaining([
      'trace-a.pftrace',
      'trace-b.pftrace',
    ]));
    expect(traceSummaryRunner).toHaveBeenCalledTimes(2);
  });

  it('rejects comparison skills before loading traces', async () => {
    const tp = traceProcessor();

    await expect(runBatchSkill({
      surface: 'cli',
      skillId: 'startup_analysis',
      traceInputs: [{ ordinal: 0, source: 'local_path', tracePath: 'a.pftrace' }],
    }, {
      traceProcessor: tp,
      registry: registry('comparison'),
      leaseStore: leaseStore(),
    })).rejects.toThrow('unsupported_batch_skill_type:comparison');
    expect(tp.loadTraceFromFilePath).not.toHaveBeenCalled();
  });

  it('runs a declared post-processor while leaving non-batch Skills unchanged', async () => {
    executeMock = jest.fn(async (_skillId, traceId) => ({
      skillId: 'startup_analysis',
      skillName: 'Heap paths',
      success: true,
      displayResults: [],
      diagnostics: [],
      executionTimeMs: 5,
      traceId,
    } as SkillExecutionResult));
    toDataEnvelopesMock = jest.fn((result) => {
      const traceId = String((result as SkillExecutionResult & {traceId: string}).traceId);
      const leaked = traceId.includes('a.pftrace') || traceId.includes('b.pftrace');
      return [{
        ...envelope(),
        meta: {...envelope().meta, stepId: 'dominator_paths'},
        data: {
          columns: [
            'upid', 'process_name', 'graph_sample_ts', 'path', 'class_name',
            'root_type', 'self_count', 'retained_count', 'self_size_bytes',
            'retained_size_bytes',
          ],
          rows: [[
            1,
            'app',
            traceId,
            leaked
              ? '[ROOT_JNI_GLOBAL] Root [1] -> LeakedActivity [1]'
              : '[ROOT_JAVA_FRAME] Thread [1] -> BitmapCache [1]',
            leaked ? 'LeakedActivity' : 'BitmapCache',
            leaked ? 'ROOT_JNI_GLOBAL' : 'ROOT_JAVA_FRAME',
            1,
            2,
            128,
            leaked ? 4000 : 9000,
          ]],
        },
      }];
    });
    const inputs = ['a.pftrace', 'b.pftrace', 'c.pftrace', 'd.pftrace']
      .map((tracePath, ordinal) => ({ordinal, source: 'local_path' as const, tracePath}));

    const batchRun = await runBatchSkill({
      surface: 'cli',
      skillId: 'startup_analysis',
      traceInputs: inputs,
    }, {traceProcessor: traceProcessor(), registry: registry('atomic', true)});
    const ordinaryRun = await runBatchSkill({
      surface: 'cli',
      skillId: 'startup_analysis',
      traceInputs: inputs.slice(0, 1),
    }, {traceProcessor: traceProcessor(), registry: registry()});

    expect(batchRun.domainAnalysis).toMatchObject({
      operation: 'heap_path_cluster',
      evidence: {rowCount: 4},
      result: {status: 'completed', selectedK: 2},
    });
    expect(ordinaryRun.domainAnalysis).toBeUndefined();
  });
});

function readySummary(total: number | undefined, jank: number | undefined): TraceSummaryExecutionV1 {
  const definitions: TraceSummaryMetricDefinitionV1[] = [
    {id: 'smartperfetto_trace_duration_ns', dimensions: [], valueColumn: 'duration_ns', unit: 'TIME_NANOS',
      polarity: 'NOT_APPLICABLE', dimensionUniqueness: 'UNIQUE'},
    {id: 'smartperfetto_frame_timeline_total_count', dimensions: [], valueColumn: 'total_count', unit: 'COUNT',
      polarity: 'NOT_APPLICABLE', dimensionUniqueness: 'UNIQUE'},
    {id: 'smartperfetto_frame_timeline_jank_count', dimensions: [], valueColumn: 'jank_count', unit: 'COUNT',
      polarity: 'LOWER_IS_BETTER', dimensionUniqueness: 'UNIQUE'},
  ];
  const values = new Map<string, number | undefined>([
    ['smartperfetto_trace_duration_ns', 100],
    ['smartperfetto_frame_timeline_total_count', total],
    ['smartperfetto_frame_timeline_jank_count', jank],
  ]);
  const metrics: TraceSummaryMetricResultV1[] = definitions.map(definition => {
    const value = values.get(definition.id);
    return value === undefined
      ? {...definition, status: 'missing', missingReason: 'no_rows'}
      : {...definition, status: 'available', value};
  });
  return {
    schemaVersion: 'trace_summary_execution@1', status: 'ready',
    spec: {schemaVersion: 'trace_summary_spec@1', id: 'smartperfetto.core.v1', digestSha256: 'a'.repeat(64),
      metricIds: definitions.map(item => item.id), metrics: definitions},
    trace: {fingerprintSha256: 'b'.repeat(64), fingerprintKind: 'trace_bytes_sha256', traceSide: 'current'},
    traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64)},
    resultDigestSha256: 'd'.repeat(64), metrics, durationMs: 1,
  };
}

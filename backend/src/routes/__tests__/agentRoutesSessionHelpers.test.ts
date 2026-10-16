// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { resolveSessionArchitectureType } from '../agentRoutes';
import { buildTraceContextDataEnvelopes } from '../../agentRuntime/traceContextEvidence';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('agentRoutes session architecture', () => {
  it('resolves architecture type from the orchestrator cache with unknown fallback', () => {
    expect(
      resolveSessionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ type: 'android' })),
        },
      } as any, 'trace-1'),
    ).toBe('android');

    expect(
      resolveSessionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ name: 'missing-type' })),
        },
      } as any, 'trace-1'),
    ).toBe('unknown');

    expect(resolveSessionArchitectureType({ orchestrator: {} } as any, 'trace-1')).toBe('unknown');
  });
});

describe('agentRoutes frontend traceContext envelopes', () => {
  it('converts frontend pre-query datasets into SQL result envelopes for persistence and replay', () => {
    const envelopes = buildTraceContextDataEnvelopes([
      {
        label: 'thread states in range',
        columns: ['thread_name', 'state', 'total_ms'],
        rows: [
          ['RenderThread', 'Running', 12.5],
          ['main', 'R', 4.2],
        ],
      },
    ], 'trace-fast-1');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].meta.type).toBe('sql_result');
    expect(envelopes[0].meta.source).toBe('frontend_trace_context');
    expect(envelopes[0].meta.traceId).toBe('trace-fast-1');
    expect(envelopes[0].meta.evidenceRefId).toMatch(/^data:frontend_prequery:current:/);
    expect(envelopes[0].meta.sourceToolCallId).toMatch(/^frontend-prequery:/);
    expect(envelopes[0].meta.intent).toBe('frontend_prequeried_trace_context');
    expect(envelopes[0].display.title).toBe('thread states in range');
    expect(envelopes[0].display.format).toBe('table');
    expect(envelopes[0].data).toEqual({
      columns: ['thread_name', 'state', 'total_ms'],
      rows: [
        ['RenderThread', 'Running', 12.5],
        ['main', 'R', 4.2],
      ],
    });
  });

  it('uses stable hashes and skips empty frontend pre-query datasets', () => {
    const datasets = [
      {
        label: 'running threads in range',
        columns: ['thread_name', 'running_ms'],
        rows: [['main', 9.1]],
      },
      {
        label: 'empty',
        columns: ['name'],
        rows: [],
      },
    ];

    const first = buildTraceContextDataEnvelopes(datasets, 'trace-fast-1');
    const second = buildTraceContextDataEnvelopes(datasets, 'trace-fast-1');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].meta.queryHash).toBe(second[0].meta.queryHash);
    expect(first[0].meta.evidenceRefId).toBe(second[0].meta.evidenceRefId);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {resolveTraceCase} from '../../utils/traceCorpus';
import {
  executeManagedTraceSummaryV1,
  type ManagedTraceSummaryExecutor,
  type ManagedTraceSummarySource,
} from '../managedTraceSummary';
import {TraceProcessorService} from '../traceProcessorService';

describe('managedTraceSummary', () => {
  it('passes the active path, port, and exact running binary selection to the executor', async () => {
    const source: ManagedTraceSummarySource = {
      getRunningTraceSummaryInput: (_traceId, options) => {
        expect(options).toEqual({leaseId: 'lease-a', leaseMode: 'shared'});
        return {
        source: 'local_file',
        tracePath: '/private/trace.pftrace',
        port: 9876,
        binarySelection: {
          source: 'local_binary', selectedPath: '/private/trace_processor_shell', selectionOrigin: 'env_override',
        },
        };
      },
    };
    const executor: ManagedTraceSummaryExecutor = async (input, dependencies) => {
      expect(input).toEqual({
        tracePath: '/private/trace.pftrace', traceSide: 'reference', remotePort: 9876,
      });
      expect(dependencies?.binarySelection).toEqual(expect.objectContaining({selectionOrigin: 'env_override'}));
      return {
        schemaVersion: 'trace_summary_execution@1', status: 'unavailable',
        spec: {schemaVersion: 'trace_summary_spec@1', id: 'smartperfetto.core.v1', digestSha256: 'a'.repeat(64), metricIds: [], metrics: []},
        reason: 'trace_identity_unavailable',
      };
    };

    const result = await executeManagedTraceSummaryV1(
      source,
      'trace-a',
      'reference',
      {executor},
      {leaseId: 'lease-a', leaseMode: 'shared'},
    );
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it.each([
    ['external', {source: 'external_rpc'} as const, 'external_rpc_unsupported'],
    ['missing', undefined, 'trace_source_unavailable'],
  ])('returns a path-free unavailable attestation for %s source', async (_name, managed, reason) => {
    const source: ManagedTraceSummarySource = {getRunningTraceSummaryInput: () => managed};
    const result = await executeManagedTraceSummaryV1(source, 'trace-a', 'current');
    expect(result).toEqual(expect.objectContaining({status: 'unavailable', reason}));
  });

  it('executes against the already loaded real warm session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-managed-summary-'));
    const service = new TraceProcessorService(root);
    let traceId = '';
    try {
      traceId = await service.loadTraceFromFilePath(resolveTraceCase('android-scroll-customer'));
      const result = await executeManagedTraceSummaryV1(service, traceId, 'current');
      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.metrics).toEqual(expect.arrayContaining([
          expect.objectContaining({id: 'smartperfetto_frame_timeline_total_count', value: 697}),
          expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', value: 21}),
        ]));
      }
    } finally {
      if (traceId) await service.deleteTrace(traceId);
      fs.rmSync(root, {recursive: true, force: true});
    }
  }, 240_000);
});

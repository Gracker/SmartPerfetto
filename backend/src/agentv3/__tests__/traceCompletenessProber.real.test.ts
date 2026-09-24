// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Real-trace gate for the completeness prober. The pinned trace_processor_shell
// loads a canonical trace whose monitor contention and input events live only in
// stdlib views; before the registry declared their modules, the probe read
// sqlite_master without INCLUDEing them and told the model the tables did not
// exist. `npm run test:analysis-accuracy` materializes the trace first.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import {randomUUID} from 'crypto';
import {WorkingTraceProcessor} from '../../services/workingTraceProcessor';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {resolveTraceCase} from '../../utils/traceCorpus';
import {
  CAPABILITY_REGISTRY,
  clearTraceCompletenessProbeCache,
  probeTraceCompleteness,
} from '../traceCompletenessProber';

jest.setTimeout(120_000);
const processors: WorkingTraceProcessor[] = [];
afterEach(() => {
  clearTraceCompletenessProbeCache();
  for (const processor of processors.splice(0)) processor.destroy();
});

/** Only the query surface the probe reads; identity stays unavailable (cache bypass). */
function serviceFor(processor: WorkingTraceProcessor): TraceProcessorService {
  return {
    query: (_traceId: string, sql: string, options?: Parameters<WorkingTraceProcessor['query']>[1]) =>
      processor.query(sql, options),
    queryBounded: (_traceId: string, sql: string, options: any) => (processor as any).queryBounded(sql, options),
    getTraceSourceKind: () => undefined,
    getTrace: () => undefined,
    getRunningCapabilityTraceProcessorInput: () => undefined,
  } as unknown as TraceProcessorService;
}

describe('trace completeness probe on the pinned trace processor', () => {
  it('finds stdlib-view capabilities that exist only after their module is included', async () => {
    const tracePath = resolveTraceCase('launch_light.pftrace');
    if (!fs.existsSync(tracePath)) {
      throw new Error(`launch_light.pftrace is not materialized at ${tracePath}; run npm run trace:materialize`);
    }
    const traceId = `completeness-real-${randomUUID()}`;
    const processor = new WorkingTraceProcessor(traceId, tracePath);
    processors.push(processor);
    await processor.initialize();

    const result = await probeTraceCompleteness(serviceFor(processor), traceId, 'STANDARD');

    const available = result.available.map(cap => cap.id);
    expect(available).toEqual(expect.arrayContaining(['lock_contention', 'input_latency']));
    // Every module-backed view exists once included; what remains missing is
    // empty, never "table does not exist", and nothing was left unprobed.
    const moduleBacked = new Set(CAPABILITY_REGISTRY
      .filter(cap => (cap.requiredModules ?? []).length > 0)
      .map(cap => cap.id));
    for (const cap of result.missingConfig) {
      expect(cap.reasonCode).toBeUndefined();
      if (moduleBacked.has(cap.id)) expect(cap.rowEstimate).toBe(0);
    }
  });
});

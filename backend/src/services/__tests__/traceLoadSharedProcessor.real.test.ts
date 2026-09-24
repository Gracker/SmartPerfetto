// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import {TraceProcessorService, TRACE_LOAD_METADATA_SQL} from '../traceProcessorService';
import {TraceProcessorFactory, WorkingTraceProcessor} from '../workingTraceProcessor';
import {prepareAnalysisRunTraceProcessorLeases} from '../analysisRunTraceProcessorLease';
import {getTraceProcessorLeaseStore, setTraceProcessorLeaseStoreForTests} from '../traceProcessorLeaseStore';
import {analyzeRawSqlDirectProjection} from '../evidence/rawSqlDirectProjection';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../middleware/auth';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';

jest.setTimeout(120_000);
const scope = {tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_DEV_USER_ID};
const FIXTURE = path.resolve(process.cwd(), '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace');

describe('trace loading keeps the shared processor shareable', () => {
  it('sends only SQL inside the pure-read grammar', () => {
    expect(analyzeRawSqlDirectProjection(TRACE_LOAD_METADATA_SQL)).toMatchObject({pureRead: true, relation: {name: 'slice'}});
  });

  it('runs a loaded local trace on its one shared processor instead of reloading it privately', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-shared-load-'));
    const changes = {[ENTERPRISE_FEATURE_FLAG_ENV]: 'false', SMARTPERFETTO_ENTERPRISE_DB_PATH: path.join(root, 'enterprise.sqlite'),
      SMARTPERFETTO_DATA_DIR: path.join(root, 'data'), UPLOAD_DIR: path.join(root, 'uploads')};
    const previous = new Map(Object.keys(changes).map(key => [key, process.env[key]]));
    let service: TraceProcessorService | undefined;
    try {
      Object.assign(process.env, changes);
      service = new TraceProcessorService(path.join(root, 'uploads', 'traces'));
      // The CLI analyze path: load the file, then prepare the run's processor leases.
      const traceId = await service.loadTraceFromFilePath(FIXTURE);
      const trace = service.getTrace(traceId);
      expect(trace?.status).toBe('ready');
      expect(trace?.metadata?.numEvents).toBeGreaterThan(0);
      expect(service.getAnalysisRunProcessorPolicy(traceId)).toEqual({
        sourceKind: 'local_file', requiresIsolation: false, reason: 'trusted',
      });
      const shared = TraceProcessorFactory.get(traceId) as WorkingTraceProcessor;
      expect(shared).toBeInstanceOf(WorkingTraceProcessor);

      // Successive runs share it while it stays trusted.
      for (let run = 0; run < 2; run++) {
        const controller = new AbortController();
        const leases = await prepareAnalysisRunTraceProcessorLeases({service, scope, runId: randomUUID(), sessionId: randomUUID(),
          currentTraceId: traceId, signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted()});
        try {
          expect(leases.entries).toHaveLength(1);
          expect(leases.entries[0]).toMatchObject({privateProcessor: false, integrityIsolation: false, context: {mode: 'shared'}});
          expect(TraceProcessorFactory.getStats().count).toBe(1);
          const rows = await leases.run(() => service!.query(traceId, 'SELECT COUNT(*) AS n FROM slice'));
          expect(rows.rows[0][0]).toBe(trace?.metadata?.numEvents);
        } finally {
          leases.release();
        }
        expect(TraceProcessorFactory.getStats().count).toBe(1);
        expect(TraceProcessorFactory.get(traceId)).toBe(shared);
        expect(shared.status).toBe('ready');
      }
      expect(service.getRunningNativeProcessorObservation(traceId)?.status).toBe('trusted');
    } finally {
      if (service) service.cleanupProcessorsForTraces(service.getAllTraces().map(trace => trace.id));
      TraceProcessorFactory.cleanup();
      getTraceProcessorLeaseStore().close();
      setTraceProcessorLeaseStoreForTests(null);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(root, {recursive: true, force: true});
    }
  });
});

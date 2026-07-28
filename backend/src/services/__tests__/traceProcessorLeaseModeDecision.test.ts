// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildTraceProcessorLeaseModeDecision,
  decideTraceProcessorLeaseMode,
} from '../traceProcessorLeaseModeDecision';
import type { TraceProcessorLeaseRecord } from '../traceProcessorLeaseStore';
import type { TraceProcessorRuntimeStats } from '../workingTraceProcessor';

function baseProcessor(traceId = 'trace-a'): TraceProcessorRuntimeStats {
  return {
    kind: 'owned_process',
    processorId: 'processor-a',
    traceId,
    status: 'ready',
    activeQueries: 0,
    httpPort: 9123,
    rssBytes: 128,
    rssSampleSource: 'ps',
    sqlWorker: {
      running: false,
      queuedP0: 0,
      queuedP1: 0,
      queuedP2: 0,
      usesWorkerThread: true,
    },
  };
}

function sharedFrontendLease(heartbeatAt: number): TraceProcessorLeaseRecord {
  return {
    id: 'lease-shared',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: 'trace-a',
    mode: 'shared',
    state: 'active',
    rssBytes: null,
    heartbeatAt,
    expiresAt: heartbeatAt + 60_000,
    holderCount: 1,
    holders: [{
      id: 'holder-a',
      leaseId: 'lease-shared',
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
      heartbeatAt,
      expiresAt: heartbeatAt + 60_000,
      createdAt: heartbeatAt,
      metadata: null,
    }],
  };
}

describe('trace processor lease mode decision', () => {
  it('keeps frontend and manual holders shared', () => {
    expect(decideTraceProcessorLeaseMode({
      holderType: 'frontend_http_rpc',
      analysisMode: 'full',
      sharedQueueLength: 10,
    })).toMatchObject({
      mode: 'shared',
      reason: 'frontend_interactive',
    });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'manual_register',
      requestedMode: 'isolated',
    })).toMatchObject({
      mode: 'shared',
      reason: 'manual_register',
    });
  });

  it('honors explicit isolation for independent frontend RPC viewers', () => {
    expect(decideTraceProcessorLeaseMode({
      holderType: 'frontend_http_rpc',
      requestedMode: 'isolated',
      quotaAvailableForNewLeaseBytes: 1,
      estimatedNewLeaseRssBytes: 2,
    })).toMatchObject({
      mode: 'isolated',
      reason: 'requested_isolated',
    });
  });

  it('isolates full analysis, reports, slow SQL, heavy skills, and backlog', () => {
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      analysisMode: 'full',
    })).toMatchObject({ mode: 'isolated', reason: 'full_analysis' });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'report_generation',
    })).toMatchObject({ mode: 'isolated', reason: 'report_generation' });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      estimatedSqlMs: 5_001,
    })).toMatchObject({ mode: 'isolated', reason: 'estimated_slow_query' });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      heavySkill: true,
    })).toMatchObject({ mode: 'isolated', reason: 'heavy_skill' });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      sharedQueueLength: 6,
    })).toMatchObject({ mode: 'isolated', reason: 'shared_queue_backlog' });
  });

  it('keeps work shared when quota cannot admit another processor', () => {
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      analysisMode: 'full',
      quotaAvailableForNewLeaseBytes: 128,
      estimatedNewLeaseRssBytes: 256,
    })).toMatchObject({
      mode: 'shared',
      reason: 'quota_low_shared',
    });
  });

  it('builds runtime signals from active frontend holders and worker queues', () => {
    const processors = [baseProcessor()];
    processors[0].sqlWorker = {
      running: true,
      queuedP0: 2,
      queuedP1: 3,
      queuedP2: 1,
      usesWorkerThread: true,
    };

    const decision = buildTraceProcessorLeaseModeDecision({
      traceId: 'trace-a',
      holderType: 'agent_run',
      leases: [sharedFrontendLease(10_000)],
      processors,
      now: 20_000,
    });

    expect(decision).toMatchObject({
      mode: 'isolated',
      reason: 'shared_queue_backlog',
      signals: {
        sharedQueueLength: 6,
        frontendActive: true,
      },
    });
  });

  it('defaults fast mode and short work to shared', () => {
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      analysisMode: 'fast',
    })).toMatchObject({ mode: 'shared', reason: 'fast_mode' });
    expect(decideTraceProcessorLeaseMode({
      holderType: 'agent_run',
      estimatedSqlMs: 100,
    })).toMatchObject({ mode: 'shared', reason: 'default_shared' });
  });
});

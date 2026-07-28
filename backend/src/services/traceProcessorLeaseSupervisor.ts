// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseStore,
  type TraceProcessorLeaseSweepResult,
} from './traceProcessorLeaseStore';
import {
  getTraceProcessorService,
  type TraceProcessorService,
} from './traceProcessorService';

export interface TraceProcessorLeaseSupervisorHandle {
  runOnce(now?: number): TraceProcessorLeaseSweepResult;
  stop(): void;
}

export function startTraceProcessorLeaseSupervisor(options: {
  intervalMs?: number;
  store?: TraceProcessorLeaseStore;
  service?: TraceProcessorService;
} = {}): TraceProcessorLeaseSupervisorHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  const runOnce = (now = Date.now()): TraceProcessorLeaseSweepResult => {
    const store = options.store ?? getTraceProcessorLeaseStore();
    const service = options.service ?? getTraceProcessorService();
    const result = store.sweepExpired(now);
    for (const lease of result.releasedLeases) {
      service.cleanupLeaseProcessor(lease.traceId, lease.id, lease.mode);
    }
    return result;
  };

  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (error) {
      console.warn('[TraceProcessorLeaseSupervisor] Sweep failed:', error);
    }
  }, intervalMs);
  timer.unref();

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}

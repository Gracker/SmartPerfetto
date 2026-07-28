// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  isTraceProcessorEvictionCandidate,
  resolveTraceProcessorStartupTimeoutMs,
  WorkingTraceProcessor,
} from '../workingTraceProcessor';

const GIB = 1024 * 1024 * 1024;
const config = {
  startupTimeoutMs: 30_000,
  startupTimeoutPerGiBMs: 120_000,
  startupTimeoutMaxMs: 900_000,
};

describe('resolveTraceProcessorStartupTimeoutMs', () => {
  it('keeps a configured minimum for small traces', () => {
    expect(resolveTraceProcessorStartupTimeoutMs(0, {
      ...config,
      startupTimeoutPerGiBMs: 10_000,
    })).toBe(30_000);
  });

  it('allows ten minutes for a 5 GiB trace', () => {
    expect(resolveTraceProcessorStartupTimeoutMs(5 * GIB, config)).toBe(600_000);
  });

  it('caps very large trace startup waits', () => {
    expect(resolveTraceProcessorStartupTimeoutMs(20 * GIB, config)).toBe(900_000);
  });
});

describe('trace processor eviction', () => {
  function processor(leaseId?: string, activeQueries = 0): WorkingTraceProcessor {
    const value = Object.create(WorkingTraceProcessor.prototype);
    Object.defineProperty(value, 'activeQueries', {value: activeQueries});
    value.getRuntimeStats = () => ({leaseId}) as any;
    return value;
  }

  it('never evicts a lease-backed viewer solely because SQL is idle', () => {
    expect(isTraceProcessorEvictionCandidate(processor('lease-viewer'))).toBe(false);
    expect(isTraceProcessorEvictionCandidate(processor(), true)).toBe(false);
  });

  it('still evicts an unleased idle processor', () => {
    expect(isTraceProcessorEvictionCandidate(processor())).toBe(true);
    expect(isTraceProcessorEvictionCandidate(processor(undefined, 1))).toBe(false);
  });
});

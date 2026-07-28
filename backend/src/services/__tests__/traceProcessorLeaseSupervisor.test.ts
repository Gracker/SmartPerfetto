// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {startTraceProcessorLeaseSupervisor} from '../traceProcessorLeaseSupervisor';

describe('TraceProcessorLeaseSupervisor', () => {
  it('destroys exactly the processors returned by the lease sweep', () => {
    const store = {
      sweepExpired: jest.fn(() => ({
        holdersRemoved: 2,
        leasesReleased: 2,
        releasedLeases: [
          {
            id: 'lease-a',
            tenantId: 'tenant-a',
            workspaceId: 'workspace-a',
            traceId: 'trace-a',
            mode: 'isolated' as const,
          },
          {
            id: 'lease-b',
            tenantId: 'tenant-a',
            workspaceId: 'workspace-a',
            traceId: 'trace-b',
            mode: 'shared' as const,
          },
        ],
      })),
    };
    const service = {
      cleanupLeaseProcessor: jest.fn(),
    };
    const handle = startTraceProcessorLeaseSupervisor({
      intervalMs: 60_000,
      store: store as any,
      service: service as any,
    });

    const result = handle.runOnce(1234);
    handle.stop();

    expect(store.sweepExpired).toHaveBeenCalledWith(1234);
    expect(result.leasesReleased).toBe(2);
    expect(service.cleanupLeaseProcessor).toHaveBeenNthCalledWith(
      1,
      'trace-a',
      'lease-a',
      'isolated',
    );
    expect(service.cleanupLeaseProcessor).toHaveBeenNthCalledWith(
      2,
      'trace-b',
      'lease-b',
      'shared',
    );
  });
});

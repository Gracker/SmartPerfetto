// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  ScopedLeaseLostError,
  ScopedOutbox,
  type ScopedLeaseFence,
} from '../scopedOutbox';

describe('ScopedOutbox', () => {
  it('requires one active fenced row for renew and terminal writes', () => {
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
    let active: ScopedLeaseFence | null = null;
    let state = 'pending';
    const outbox = new ScopedOutbox({
      claim: input => {
        if (active || state !== 'pending') return {changes: 0};
        active = {
          scope,
          jobId: 'job-1',
          owner: input.owner,
          token: input.token,
          leaseUntil: input.leaseUntil,
        };
        return {
          changes: 1,
          job: {id: 'job-1'},
          scope,
          jobId: 'job-1',
        };
      },
      assertActive: (fence, now) =>
        matches(active, fence, now) ? 1 : 0,
      renew: (fence, now, leaseUntil) => {
        if (!matches(active, fence, now)) return 0;
        active = {...fence, leaseUntil};
        return 1;
      },
      complete: (fence, _input, now) => {
        if (!matches(active, fence, now)) return 0;
        state = 'done';
        active = null;
        return 1;
      },
      fail: (fence, _input, now) => {
        if (!matches(active, fence, now)) return 0;
        active = null;
        return 1;
      },
      release: (fence, now) => {
        if (!matches(active, fence, now)) return 0;
        active = null;
        return 1;
      },
    }, () => 'token-a');

    const lease = outbox.claim({
      scope,
      owner: 'worker-a',
      leaseDurationMs: 10,
      maxAttempts: 3,
      now: 100,
    })!;
    const renewed = outbox.renew(lease.fence, 20, 105);
    expect(renewed.leaseUntil).toBe(125);
    expect(() => outbox.complete({
      ...lease.fence,
      token: 'stale-token',
    }, {}, 111))
      .toThrow(ScopedLeaseLostError);
    outbox.complete(renewed, {}, 111);
    expect(state).toBe('done');
    expect(() => outbox.release(renewed, 112))
      .toThrow(ScopedLeaseLostError);
  });
});

function matches(
  active: ScopedLeaseFence | null,
  fence: ScopedLeaseFence,
  now: number,
): boolean {
  return !!active &&
    active.scope.tenantId === fence.scope.tenantId &&
    active.scope.workspaceId === fence.scope.workspaceId &&
    active.jobId === fence.jobId &&
    active.owner === fence.owner &&
    active.token === fence.token &&
    active.leaseUntil > now;
}

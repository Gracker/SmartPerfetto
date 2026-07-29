// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {RunManifestScope} from '../../types/selfEvolution';

export interface ScopedLeaseFence {
  scope: RunManifestScope;
  jobId: string;
  owner: string;
  token: string;
  leaseUntil: number;
}

export interface ScopedClaimAdapterResult<TJob> {
  changes: number;
  job?: TJob;
  scope?: RunManifestScope;
  jobId?: string;
}

export interface ScopedOutboxAdapter<TJob, TComplete, TFailure> {
  claim(input: {
    scope?: RunManifestScope;
    jobId?: string;
    owner: string;
    token: string;
    now: number;
    leaseUntil: number;
    maxAttempts: number;
  }): ScopedClaimAdapterResult<TJob>;
  assertActive(fence: ScopedLeaseFence, now: number): number;
  renew(fence: ScopedLeaseFence, now: number, leaseUntil: number): number;
  complete(
    fence: ScopedLeaseFence,
    input: TComplete,
    now: number,
  ): number;
  fail(
    fence: ScopedLeaseFence,
    input: TFailure,
    now: number,
  ): number;
  release(fence: ScopedLeaseFence, now: number): number;
}

export interface ScopedLease<TJob> {
  job: TJob;
  fence: ScopedLeaseFence;
}

export class ScopedLeaseLostError extends Error {
  constructor(
    readonly operation: 'assert' | 'renew' | 'complete' | 'fail' | 'release',
    readonly fence: ScopedLeaseFence,
  ) {
    super(`scoped_outbox_lease_lost:${operation}:${fence.jobId}`);
    this.name = 'ScopedLeaseLostError';
  }
}

/**
 * Shared lease/fencing state machine.
 *
 * Domain adapters own table layouts and payload serialization. This class
 * owns the concurrency contract: every terminal operation is scoped, fenced,
 * unexpired, and must affect exactly one row.
 */
export class ScopedOutbox<TJob, TComplete, TFailure> {
  constructor(
    private readonly adapter: ScopedOutboxAdapter<TJob, TComplete, TFailure>,
    private readonly tokenFactory: () => string = randomUUID,
  ) {}

  claim(input: {
    scope?: RunManifestScope;
    jobId?: string;
    owner: string;
    leaseDurationMs: number;
    maxAttempts: number;
    now?: number;
  }): ScopedLease<TJob> | null {
    const now = input.now ?? Date.now();
    if (typeof input.owner !== 'string' || !input.owner.trim()) {
      throw new Error('scoped_outbox_owner_required');
    }
    const owner = input.owner.trim();
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error('scoped_outbox_lease_duration_invalid');
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
      throw new Error('scoped_outbox_max_attempts_invalid');
    }
    const token = this.tokenFactory();
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('scoped_outbox_token_invalid');
    }
    const leaseUntil = now + input.leaseDurationMs;
    const claimed = this.adapter.claim({
      scope: input.scope ? {...input.scope} : undefined,
      jobId: input.jobId,
      owner,
      token,
      now,
      leaseUntil,
      maxAttempts: input.maxAttempts,
    });
    if (claimed.changes === 0) return null;
    if (
      claimed.changes !== 1 ||
      !claimed.job ||
      !claimed.scope ||
      typeof claimed.scope.tenantId !== 'string' ||
      !claimed.scope.tenantId.trim() ||
      typeof claimed.scope.workspaceId !== 'string' ||
      !claimed.scope.workspaceId.trim() ||
      typeof claimed.jobId !== 'string' ||
      !claimed.jobId.trim() ||
      (
        input.scope &&
        (
          input.scope.tenantId !== claimed.scope.tenantId ||
          input.scope.workspaceId !== claimed.scope.workspaceId
        )
      )
    ) {
      throw new Error('scoped_outbox_claim_contract_invalid');
    }
    return {
      job: claimed.job,
      fence: {
        scope: {...claimed.scope},
        jobId: claimed.jobId,
        owner,
        token,
        leaseUntil,
      },
    };
  }

  assertActive(fence: ScopedLeaseFence, now: number = Date.now()): void {
    this.requireOne('assert', fence, this.adapter.assertActive(fence, now));
  }

  renew(
    fence: ScopedLeaseFence,
    leaseDurationMs: number,
    now: number = Date.now(),
  ): ScopedLeaseFence {
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error('scoped_outbox_lease_duration_invalid');
    }
    const leaseUntil = now + leaseDurationMs;
    this.requireOne(
      'renew',
      fence,
      this.adapter.renew(fence, now, leaseUntil),
    );
    return {...fence, leaseUntil};
  }

  complete(
    fence: ScopedLeaseFence,
    input: TComplete,
    now: number = Date.now(),
  ): void {
    this.requireOne(
      'complete',
      fence,
      this.adapter.complete(fence, input, now),
    );
  }

  fail(
    fence: ScopedLeaseFence,
    input: TFailure,
    now: number = Date.now(),
  ): void {
    this.requireOne(
      'fail',
      fence,
      this.adapter.fail(fence, input, now),
    );
  }

  release(fence: ScopedLeaseFence, now: number = Date.now()): void {
    this.requireOne(
      'release',
      fence,
      this.adapter.release(fence, now),
    );
  }

  private requireOne(
    operation: ScopedLeaseLostError['operation'],
    fence: ScopedLeaseFence,
    changes: number,
  ): void {
    if (changes !== 1) throw new ScopedLeaseLostError(operation, fence);
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  openSupersedeStore,
  injectionWeightForSupersede,
  type SupersedeStoreHandle,
  __testing,
} from '../supersedeStore';

describe('supersedeStore', () => {
  let store: SupersedeStoreHandle;

  beforeEach(() => {
    store = openSupersedeStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  function newMarker(hash = 'h_default') {
    return store.createPendingReview({
      failureModeHash: hash,
      strategyFile: 'scrolling.strategy.md',
      strategyContentHash: 'cont_v1',
      patchFingerprint: 'patch_v1',
      phaseHintId: 'phase_2_6',
    });
  }

  describe('migrations + schema', () => {
    it('applies version 1 on open', () => {
      expect(store.schemaVersion()).toBeGreaterThan(0);
    });

    it('reflects defaults from __testing', () => {
      expect(__testing.DEFAULT_OBSERVATION_DAYS).toBe(7);
      expect(__testing.DEFAULT_OBSERVATION_COUNT_TARGET).toBe(5);
    });
  });

  describe('createPendingReview', () => {
    it('inserts a marker and returns it', () => {
      const marker = newMarker();
      expect(marker).not.toBeNull();
      expect(marker!.state).toBe('pending_review');
      expect(marker!.failureModeHash).toBe('h_default');
    });

    it('rejects a duplicate hash already in an active state', () => {
      newMarker('h_dup');
      const second = newMarker('h_dup');
      expect(second).toBeNull();
    });

    it('allows a new pending marker once a previous one is rejected', () => {
      const first = newMarker('h_recycle');
      expect(first).not.toBeNull();
      store.markRejected('h_recycle');
      const second = newMarker('h_recycle');
      expect(second).not.toBeNull();
    });
  });

  describe('startCanaryObservation', () => {
    it('promotes pending_review → active_canary and stamps observation start', () => {
      newMarker('h_canary');
      const promoted = store.startCanaryObservation({
        failureModeHash: 'h_canary',
        gitCommit: 'abc123',
      });
      expect(promoted).not.toBeNull();
      expect(promoted!.state).toBe('active_canary');
      expect(promoted!.gitCommit).toBe('abc123');
      expect(promoted!.observationStartedAt).toBeGreaterThan(0);
    });

    it('returns null when no pending_review marker exists', () => {
      const promoted = store.startCanaryObservation({ failureModeHash: 'never_seen' });
      expect(promoted).toBeNull();
    });
  });

  describe('recordObservation', () => {
    it('increments observation_count and stays canary until both windows hit', () => {
      newMarker('h_obs');
      const start = store.startCanaryObservation({ failureModeHash: 'h_obs' });
      expect(start!.state).toBe('active_canary');

      // Three observations, all within the 7-day window — still canary.
      for (let i = 0; i < 3; i++) {
        const updated = store.recordObservation('h_obs', start!.observationStartedAt! + 1000);
        expect(updated!.state).toBe('active_canary');
      }
    });

    it('promotes to active once both observation_count_target AND observation_days are met', () => {
      newMarker('h_promote');
      const start = store.startCanaryObservation({ failureModeHash: 'h_promote' });
      const sevenDaysLater = start!.observationStartedAt! + 8 * 24 * 60 * 60 * 1000;
      // 5 observations across the 7-day window
      let last = null;
      for (let i = 0; i < 5; i++) {
        last = store.recordObservation('h_promote', sevenDaysLater);
      }
      expect(last!.state).toBe('active');
    });

    it('returns null for hashes without an active_canary marker', () => {
      expect(store.recordObservation('not_present')).toBeNull();
    });
  });

  describe('recordRecurrence', () => {
    it('flips active_canary → failed', () => {
      newMarker('h_rec');
      store.startCanaryObservation({ failureModeHash: 'h_rec' });
      const failed = store.recordRecurrence('h_rec');
      expect(failed!.state).toBe('failed');
      expect(failed!.recurrenceCount).toBe(1);
    });

    it('returns null when there is no active_canary marker', () => {
      expect(store.recordRecurrence('nothing_here')).toBeNull();
    });

    it('refuses to flip a marker already in `active`', () => {
      newMarker('h_active');
      const start = store.startCanaryObservation({ failureModeHash: 'h_active' });
      const t = start!.observationStartedAt! + 8 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 5; i++) store.recordObservation('h_active', t);
      const after = store.findActiveByHash('h_active');
      expect(after!.state).toBe('active');
      expect(store.recordRecurrence('h_active')).toBeNull();
    });
  });

  describe('drift / revert / reject transitions', () => {
    it('markDrifted flips active_canary or active to drifted', () => {
      newMarker('h_drift');
      store.startCanaryObservation({ failureModeHash: 'h_drift' });
      const drifted = store.markDrifted('h_drift');
      expect(drifted!.state).toBe('drifted');
    });

    it('markReverted flips drifted/active/active_canary to reverted', () => {
      newMarker('h_rev');
      store.startCanaryObservation({ failureModeHash: 'h_rev' });
      store.markDrifted('h_rev');
      const reverted = store.markReverted('h_rev');
      expect(reverted!.state).toBe('reverted');
    });

    it('markRejected flips pending_review to rejected', () => {
      newMarker('h_rej');
      const rejected = store.markRejected('h_rej');
      expect(rejected!.state).toBe('rejected');
    });

    it('refuses to reject after canary started', () => {
      newMarker('h_late');
      store.startCanaryObservation({ failureModeHash: 'h_late' });
      expect(store.markRejected('h_late')).toBeNull();
    });
  });

  describe('countByState', () => {
    it('returns a complete histogram across all states', () => {
      newMarker('a');
      newMarker('b');
      store.startCanaryObservation({ failureModeHash: 'b' });
      const histogram = store.countByState();
      expect(histogram.pending_review).toBe(1);
      expect(histogram.active_canary).toBe(1);
      expect(histogram.active).toBe(0);
    });
  });
});

describe('injectionWeightForSupersede', () => {
  it.each([
    [null, 1.0],
    [{ state: 'active' as const }, 0.1],
    [{ state: 'active_canary' as const }, 0.5],
    [{ state: 'drifted' as const }, 0.5],
    [{ state: 'pending_review' as const }, 1.0],
    [{ state: 'failed' as const }, 1.0],
    [{ state: 'rejected' as const }, 1.0],
    [{ state: 'reverted' as const }, 1.0],
  ])('weight for %p is %p', (markerLike, expected) => {
    const marker = markerLike === null ? null : ({ ...markerLike } as never);
    expect(injectionWeightForSupersede(marker)).toBe(expected);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import {
  computeStrategyContentHash,
  RunSnapshotRegistry,
} from '../strategyFingerprint';
import { getRegisteredScenes, getStrategyContent, invalidateStrategyCache } from '../../strategyLoader';
import { canonicalContentHash } from '../../../services/selfEvolution/canonicalJson';
import * as runManifestLifecycle from '../../../services/selfEvolution/runManifestLifecycle';

describe('RunSnapshotRegistry', () => {
  it('returns undefined when nothing has been captured', () => {
    const r = new RunSnapshotRegistry();
    expect(r.get('sess-1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('captures a snapshot keyed on sessionId', () => {
    const r = new RunSnapshotRegistry();
    const snap = r.capture('sess-1', 'general');
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.sceneType).toBe('general');
    expect(snap.fingerprint.appliedAt).toBeGreaterThan(0);
    expect(r.get('sess-1')).toBeDefined();
    expect(r.size()).toBe(1);
  });

  it('release() removes the snapshot', () => {
    const r = new RunSnapshotRegistry();
    r.capture('sess-1', 'general');
    r.release('sess-1');
    expect(r.get('sess-1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('records the scene strategy id and content hash in the run manifest', () => {
    const recordScene = jest.fn();
    const sink = jest.spyOn(runManifestLifecycle, 'currentRunManifestAttributionSink')
      .mockReturnValue({recordScene} as never);
    try {
      const snap = new RunSnapshotRegistry().capture('sess-1', 'scrolling');
      expect(snap.strategyContent).toBe(getStrategyContent('scrolling'));
      expect(recordScene).toHaveBeenCalledWith({
        sceneType: 'scrolling',
        strategyId: 'scrolling',
        strategyContentHash: canonicalContentHash(snap.strategyContent!),
      });
    } finally {
      sink.mockRestore();
    }
  });

  it('re-capture refreshes the snapshot in place (multi-turn)', () => {
    const r = new RunSnapshotRegistry();
    const first = r.capture('sess-1', 'general');
    const second = r.capture('sess-1', 'general');
    expect(r.size()).toBe(1);
    expect(second.fingerprint.appliedAt).toBeGreaterThanOrEqual(first.fingerprint.appliedAt);
  });
});

/**
 * Regression for Codex F.6: previously `strategyFilePath(scene)` joined
 * `${scene}.strategy.md`, which silently produced an empty content hash
 * for scenes whose file basename uses a hyphen (touch_tracking,
 * scroll_response). The loader now exposes the real source path; this
 * test exercises the real on-disk strategies (no mock).
 */
describe('computeStrategyContentHash resolves real source path', () => {
  beforeAll(() => invalidateStrategyCache());

  it('returns a 64-char hex hash for every registered scene', () => {
    const scenes = getRegisteredScenes().map(s => s.scene);
    expect(scenes.length).toBeGreaterThanOrEqual(12);
    for (const scene of scenes) {
      expect(computeStrategyContentHash(scene)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('resolves underscore scene ids whose file basename uses a hyphen', () => {
    expect(computeStrategyContentHash('touch_tracking')).toMatch(/^[a-f0-9]{64}$/);
    expect(computeStrategyContentHash('scroll_response')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns empty string for unknown scenes', () => {
    expect(computeStrategyContentHash('this-scene-does-not-exist')).toBe('');
  });
});

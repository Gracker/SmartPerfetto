// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Strategy version fingerprinting + per-run snapshot freezing.
 *
 * `strategyContentHash` identifies the strategy version a run used. The
 * `RunSnapshotRegistry` ensures an in-flight analysis sees a frozen version of
 * its scene's strategy — `invalidateStrategyCache()` must never half-update an
 * analysis mid-flight — and capturing reads the content through
 * `getStrategyContent`, which records the scene's `strategyId` and
 * `strategyContentHash` in the run's manifest.
 *
 * See docs/architecture/self-improving-design.md "组件级 Review 与 Patch 边界".
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getStrategyContent,
  getStrategyFilePath,
} from '../strategyLoader';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import {currentEffectiveRuntimeRegistrySnapshot, type ReadonlyStrategyRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';

const STRATEGIES_DIR = path.resolve(__dirname, '..', '..', '..', 'strategies');

export interface StrategyVersionFingerprint {
  strategyFile: string;
  strategyContentHash: string;
  /** Commit on `main` where this version was last observed. */
  gitCommit?: string;
  appliedAt: number;
}

/**
 * Frozen view of a scene's strategy, captured at analyze() start and released
 * on completion.
 */
export interface RunSnapshot {
  readonly sessionId: string;
  readonly sceneType: string;
  readonly overlayGeneration: string;
  readonly registryFingerprint?: string;
  readonly strategyContent: string | undefined;
  readonly fingerprint: Readonly<StrategyVersionFingerprint>;
}

/**
 * Resolve the strategy file path through the loader's registry rather than
 * naively joining `${scene}.strategy.md`. Compound scene ids use underscores
 * (`touch_tracking`) while their file basenames use hyphens
 * (`touch-tracking.strategy.md`); the naive form silently returned an empty
 * hash for those scenes. Falls back to the legacy join for unknown scenes
 * so misconfigured tests still get a deterministic-looking path.
 */
function strategyFilePath(scene: string): string {
  return getStrategyFilePath(scene) ?? path.join(STRATEGIES_DIR, `${scene}.strategy.md`);
}

/**
 * Stable sha256 of the strategy file content. Returns empty string if the
 * file is missing — callers should treat that as "no fingerprint" rather
 * than blow up the analysis path.
 */
export function computeStrategyContentHash(scene: string): string {
  const file = strategyFilePath(scene);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Per-session snapshot store. Implemented as a class so a test can spin up
 * a fresh instance instead of leaning on a module-level singleton.
 *
 * Production code should use the exported `runSnapshots` instance.
 */
export class RunSnapshotRegistry {
  private snapshots = new Map<string, RunSnapshot>();

  capture(sessionId: string, sceneType: string, strategyRegistry?: ReadonlyStrategyRegistrySnapshot): RunSnapshot {
    // Re-capturing for the same session is allowed (multi-turn) and simply
    // refreshes the snapshot — the new values reflect any hot-reloads that
    // happened between turns, which is the desired behaviour: the freeze
    // boundary is the per-turn analyze() call.
    const registrySnapshot = currentEffectiveRuntimeRegistrySnapshot();
    const registry = strategyRegistry ?? registrySnapshot?.strategyRegistry;
    const overlayGeneration = registry?.overlayGeneration ?? registrySnapshot?.overlayGeneration ?? 'builtin';
    const existing = this.snapshots.get(sessionId);
    if (
      existing
      && existing.sceneType === sceneType
      && existing.overlayGeneration === overlayGeneration
      && existing.registryFingerprint === registry?.registryFingerprint
    ) {
      return existing;
    }
    const strategyContent = getStrategyContent(sceneType, registry);
    const strategyContentHash = registry
      ? canonicalContentHash(strategyContent ?? '')
      : computeStrategyContentHash(sceneType);
    const fingerprint: StrategyVersionFingerprint = {
      strategyFile: `${sceneType}.strategy.md`,
      strategyContentHash,
      appliedAt: Date.now(),
    };
    const snapshot: RunSnapshot = Object.freeze({
      sessionId,
      sceneType,
      overlayGeneration,
      ...(registry ? {registryFingerprint: registry.registryFingerprint} : {}),
      strategyContent,
      fingerprint: Object.freeze(fingerprint),
    });
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  release(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  get(sessionId: string): RunSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  /** Number of active snapshots — surfaced for the monitoring PR. */
  size(): number {
    return this.snapshots.size;
  }
}

/** Process-wide snapshot store. Tests should construct their own instance. */
export const runSnapshots = new RunSnapshotRegistry();

/** @internal Test seam. */
export const __testing = { strategyFilePath, STRATEGIES_DIR };

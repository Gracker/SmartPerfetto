// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Strategy version fingerprinting + per-run snapshot freezing.
 *
 * Two kinds of fingerprint cooperate so PR9b's supersede markers survive
 * sloppy real-world edits:
 *
 *   1. `strategyContentHash` — sha256 of the entire strategy file. Cheap to
 *      compute, but too coarse to use alone: a typo fix in an unrelated
 *      paragraph would invalidate every supersede marker pinned to the file.
 *   2. `patchFingerprint` — a hash over the normalized form of a single
 *      phase_hints entry (id + sorted keywords + constraints + critical
 *      tools). Drift detection on the patch fingerprint tells us whether the
 *      *patched* hint is still in place even if the whole file changed.
 *
 * The §11.2 three-tier drift rule:
 *   - file hash changed, patch fingerprint still present → stay `active`
 *   - patch fingerprint changed → `drifted` (×0.5 injection weight)
 *   - phase_hints entry deleted entirely → `reverted` (restore to ×1.0)
 *
 * The `RunSnapshotRegistry` ensures an in-flight analysis sees a frozen
 * version of its scene's strategy + phase_hints — `invalidateStrategyCache()`
 * must never half-update an analysis mid-flight.
 *
 * See docs/architecture/self-improving-design.md "组件级 Review 与 Patch 边界".
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getStrategyContent,
  getPhaseHints,
  getStrategyFilePath,
  type PhaseHint,
} from '../strategyLoader';
import { computeHintFingerprint } from './hintFingerprint';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import {currentEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';

const STRATEGIES_DIR = path.resolve(__dirname, '..', '..', '..', 'strategies');

export interface StrategyVersionFingerprint {
  strategyFile: string;
  strategyContentHash: string;
  /**
   * Hash of the targeted phase_hints entry's normalized form. Empty string
   * for fingerprints that don't pin a specific hint (e.g., scene-level
   * fingerprints used during snapshot capture).
   */
  patchFingerprint: string;
  /** Optional: id of the targeted phase_hints entry (for human auditing). */
  phaseHintId?: string;
  /** Commit on `main` where this version was last observed. */
  gitCommit?: string;
  appliedAt: number;
}

/**
 * Frozen view of a scene's strategy + phase hints, captured at analyze()
 * start and released on completion.
 */
export interface RunSnapshot {
  readonly sessionId: string;
  readonly sceneType: string;
  readonly overlayGeneration: string;
  readonly strategyContent: string | undefined;
  readonly phaseHints: readonly PhaseHint[];
  readonly fingerprint: Readonly<StrategyVersionFingerprint>;
}

export type DriftStatus =
  | 'none'                 // hashes match exactly
  | 'whole_file_only'      // file hash differs but patch fingerprint still present
  | 'patch_changed'        // the targeted phase_hint differs in normalized form
  | 'patch_deleted';       // the targeted phase_hint id is no longer present

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
 * Hash a phase_hints entry by its shared canonical form. Sorted keys +
 * lower-case strings + array sort keep the hash stable across cosmetic
 * reordering of the same content.
 *
 * Intentionally excludes `id` (it is derived from the fingerprint —
 * including it would be circular) so that a freshly-rendered auto-patch
 * by `phaseHintsRenderer` produces the *same* fingerprint that
 * `detectDrift` computes off the on-disk hint after the patch lands.
 */
export function computePatchFingerprint(hint: PhaseHint): string {
  return computeHintFingerprint({
    keywords: hint.keywords || [],
    constraints: hint.constraints || '',
    criticalTools: hint.criticalTools || [],
    critical: hint.critical === true,
  });
}

/**
 * Compare a stored fingerprint against the current on-disk state and report
 * which drift tier we're in. Pure function — does not mutate anything.
 */
export function detectDrift(input: {
  fingerprint: StrategyVersionFingerprint;
  currentHints: ReadonlyArray<PhaseHint>;
  currentContentHash: string;
}): DriftStatus {
  if (
    input.fingerprint.strategyContentHash === input.currentContentHash &&
    input.fingerprint.patchFingerprint === '' // scene-level fingerprint
  ) {
    return 'none';
  }
  if (input.fingerprint.patchFingerprint === '') {
    return input.fingerprint.strategyContentHash === input.currentContentHash ? 'none' : 'whole_file_only';
  }
  const pinnedId = input.fingerprint.phaseHintId;
  const pinnedHint = pinnedId
    ? input.currentHints.find(h => h.id === pinnedId)
    : input.currentHints.find(h => computePatchFingerprint(h) === input.fingerprint.patchFingerprint);
  if (!pinnedHint) return 'patch_deleted';
  const currentPatchHash = computePatchFingerprint(pinnedHint);
  if (currentPatchHash === input.fingerprint.patchFingerprint) {
    return input.fingerprint.strategyContentHash === input.currentContentHash ? 'none' : 'whole_file_only';
  }
  return 'patch_changed';
}

/**
 * Per-session snapshot store. Implemented as a class so a test can spin up
 * a fresh instance instead of leaning on a module-level singleton.
 *
 * Production code should use the exported `runSnapshots` instance.
 */
export class RunSnapshotRegistry {
  private snapshots = new Map<string, RunSnapshot>();

  capture(sessionId: string, sceneType: string): RunSnapshot {
    // Re-capturing for the same session is allowed (multi-turn) and simply
    // refreshes the snapshot — the new values reflect any hot-reloads that
    // happened between turns, which is the desired behaviour: the freeze
    // boundary is the per-turn analyze() call.
    const registrySnapshot = currentEffectiveRuntimeRegistrySnapshot();
    const overlayGeneration = registrySnapshot?.overlayGeneration ?? 'builtin';
    const existing = this.snapshots.get(sessionId);
    if (
      existing
      && existing.sceneType === sceneType
      && existing.overlayGeneration === overlayGeneration
    ) {
      return existing;
    }
    const strategyContent = getStrategyContent(sceneType);
    const phaseHints = Object.freeze([...getPhaseHints(sceneType)]);
    const strategyContentHash = registrySnapshot
      ? canonicalContentHash(strategyContent ?? '')
      : computeStrategyContentHash(sceneType);
    const fingerprint: StrategyVersionFingerprint = {
      strategyFile: `${sceneType}.strategy.md`,
      strategyContentHash,
      patchFingerprint: '', // scene-level snapshot pins nothing in particular
      appliedAt: Date.now(),
    };
    const snapshot: RunSnapshot = Object.freeze({
      sessionId,
      sceneType,
      overlayGeneration,
      strategyContent,
      phaseHints,
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

export const __testing = { strategyFilePath, STRATEGIES_DIR };

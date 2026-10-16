// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisContextSelection} from '../resolvedAnalysisContext';
import {
  analysisHasPrivateContext,
  privateContextRestrictsAudience,
  type AnalysisPrivateContextMarker,
} from './analysisPrivateContext';

/**
 * Cross-session learning (pattern memory, SQL fix pairs) is read by every run
 * of a workspace, other users' included. An entry may be read only when the
 * run that wrote it is proven public, and nothing that survives from before
 * this stamp proves that: merges refreshed timestamps and overwrote
 * provenance, and run markers did not exist yet. So an entry without a valid
 * stamp is never read, merged into or exported; it ages out with its TTL.
 */
export interface LearningAdmission {
  version: 1;
  basis: 'public_run';
  runId: string;
  admittedAt: number;
}

declare const issuedBrand: unique symbol;
/** Only withDurableLearningPermission issues one; a literal does not type-check. */
export interface DurableLearningPermission {
  readonly runId: string;
  readonly [issuedBrand]: true;
}

const permissionKey = Symbol('durableLearningPermission');
// Resolving a grant and stamping an entry both accept only a permission object
// issued here; a copy, a forged object or one rebuilt from JSON is not in it.
const issuedPermissions = new WeakSet<object>();

function isIssuedPermission(value: unknown): value is DurableLearningPermission {
  return typeof value === 'object' && value !== null && issuedPermissions.has(value);
}

/**
 * Granted by the product at dispatch to the run these options carry, from
 * that run's own marker fixed at admission; only an explicit public marker
 * grants it. Internal options spreads keep the grant, while JSON and forged
 * objects cannot create one.
 */
export function withDurableLearningPermission<T extends {runId?: string}>(
  options: T,
  privateContext: AnalysisPrivateContextMarker | undefined,
): T {
  if (!options.runId || privateContextRestrictsAudience(privateContext)) return options;
  const permission = Object.freeze({runId: options.runId});
  issuedPermissions.add(permission);
  return {...options, [permissionKey]: permission};
}

/**
 * A run learns only under a grant issued for that very run, and only while
 * its selection is public. A grant copied into another run's options, a
 * missing run id, or a selection that turned private all deny.
 */
export function resolveDurableLearningPermission(
  options: AnalysisContextSelection & {runId?: string},
): DurableLearningPermission | undefined {
  if (!Object.prototype.hasOwnProperty.call(options, permissionKey)) return undefined;
  const permission = (options as {[permissionKey]?: unknown})[permissionKey];
  if (!isIssuedPermission(permission) || permission.runId !== options.runId) return undefined;
  return analysisHasPrivateContext(options) ? undefined : permission;
}

/**
 * The stamp a learning store writes into an entry it saves, only under a
 * permission this module issued; anything else yields no stamp, so nothing is
 * saved.
 */
export function admitLearnedEntry(
  permission: DurableLearningPermission | undefined,
  now = Date.now(),
): LearningAdmission | undefined {
  if (!isIssuedPermission(permission)) return undefined;
  return {version: 1, basis: 'public_run', runId: permission.runId, admittedAt: now};
}

function isLearningAdmission(value: unknown): value is LearningAdmission {
  if (!value || typeof value !== 'object') return false;
  const {version, basis, runId, admittedAt} = value as Partial<LearningAdmission>;
  return version === 1 && basis === 'public_run' && typeof runId === 'string' && runId.length > 0 &&
    typeof admittedAt === 'number' && Number.isFinite(admittedAt);
}

/** The one test reads, merges, eviction and exports apply to a learned entry. */
export function isAdmittedLearning(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' &&
    isLearningAdmission((entry as {learningAdmission?: unknown}).learningAdmission);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {copyScopeProvenance, type EvidenceScopeProvenanceV1, type IdentityResolutionV1} from '../../types/identityContract';

export function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The row-level half of a target identity binding: whether one row's `upid`
 * may sit under the scoped target. A row without the column leaves the scope
 * declaration as the only authority; any other value, `null` included, must be
 * the single exact upid when there is one and a resolved process. Built once
 * per citation so a whole result is checked row by row with one predicate.
 */
export function targetRowUpidPredicate(provenance: EvidenceScopeProvenanceV1 | undefined,
  resolution: IdentityResolutionV1 | undefined): (upid: unknown) => boolean {
  const exact = new Set((provenance?.entries ?? [])
    .filter(entry => entry.role === 'target' && entry.scope.mode === 'exact_upid')
    .map(entry => entry.scope.upid));
  const processes = new Set((resolution?.processes ?? []).map(process => process.upid));
  return upid => {
    if (upid === undefined) return true;
    const value = toNumber(upid);
    return (exact.size !== 1 || exact.has(value)) && value !== undefined && processes.has(value);
  };
}

/** Whether a scope binds a target identity at all: some target entry is process scoped. */
export function scopeRequiresTargetIdentity(provenance: EvidenceScopeProvenanceV1 | undefined): boolean {
  return provenance?.entries.some(entry => entry.role === 'target' && entry.scope.mode !== 'unscoped') === true;
}

/**
 * The predicate every row of a whole-result citation must pass before that
 * citation binds the target identity, or undefined when it binds none (no
 * valid scope requiring a target, or no resolution to bind it to). The read
 * view and the direct envelope path both decide eligibility here.
 */
export function wholeResultRowPredicate(meta: {scopeProvenance?: unknown; identityResolution?: IdentityResolutionV1}):
  ((upid: unknown) => boolean) | undefined {
  if (!meta.identityResolution || meta.scopeProvenance === undefined) return undefined;
  const scope = copyScopeProvenance(meta.scopeProvenance);
  return scope && !scope.invalid && scopeRequiresTargetIdentity(scope)
    ? targetRowUpidPredicate(scope, meta.identityResolution)
    : undefined;
}

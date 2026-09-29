// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Which `backend/skills/vendors/<id>` override a resolved trace vendor
 * suggests for a Skill. The resolver only reports the device (OEM, SoC, OS);
 * the lookup order and the choice of override are Skill-engine policy.
 */

import {isOemVendor, type TraceVendorResolution} from '../traceVendor/traceVendorResolver';
import type {VendorOverride} from './skillLoader';

export interface VendorOverrideHint {
  vendor: string;
  displayName?: string;
  additionalStepIds: string[];
}

/**
 * Override directory ids to try, OEM first, then SoC. A trace whose scopes
 * resolve to different devices suggests none.
 */
export function vendorOverrideLookupOrder(
  resolution: Pick<TraceVendorResolution, 'vendor' | 'soc' | 'evidence'>,
): string[] {
  if (resolution.evidence.scopeConflict) return [];
  const ids: string[] = [];
  if (isOemVendor(resolution.vendor)) ids.push(resolution.vendor);
  if (resolution.soc !== 'unknown') ids.push(resolution.soc);
  return ids;
}

function stepId(step: unknown): string | undefined {
  if (!step || typeof step !== 'object') return undefined;
  const {id, name} = step as {id?: unknown; name?: unknown};
  if (typeof id === 'string' && id) return id;
  return typeof name === 'string' && name ? name : undefined;
}

/** The first override in lookup order that adds steps to this Skill. */
export function selectVendorOverride(
  registry: {getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined},
  skillId: string,
  resolution: TraceVendorResolution | undefined,
): VendorOverrideHint | undefined {
  if (!resolution) return undefined;
  for (const vendorId of vendorOverrideLookupOrder(resolution)) {
    const override = registry.getVendorOverride(skillId, vendorId);
    if (!override || override.additionalSteps.length === 0) continue;
    return {
      vendor: override.vendor,
      displayName: override.displayName,
      additionalStepIds: override.additionalSteps
        .map(stepId)
        .filter((id): id is string => id !== undefined),
    };
  }
  return undefined;
}

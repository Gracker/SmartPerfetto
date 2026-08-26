// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import type {CodebaseConsentGrant, CodebaseRef} from './codebaseRegistry';
import {
  LEGACY_SOURCE_EXTENSIONS,
  buildSourceSelectionIR,
  sourceExtensionsForKind,
  sourceSelectionAdmits,
  sourceSelectionForRef,
} from './sourceSelectionPolicy';

export function legacyConsentGrant(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
): CodebaseConsentGrant {
  const legacy = new Set<string>(LEGACY_SOURCE_EXTENSIONS);
  return {
    revision: 1,
    grantedAt: ref.consent.consentedAt,
    grantedBy: ref.consent.consentedBy,
    extensions: sourceExtensionsForKind(ref.kind).filter(extension => legacy.has(extension)),
    includePrefixes: [...(ref.pathFilters ?? [])],
    excludeGlobs: [...(ref.excludeGlobs ?? [])],
  };
}

export function effectiveConsentGrant(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
): CodebaseConsentGrant {
  return ref.consent.grant ?? legacyConsentGrant(ref);
}

export function sourcePathAllowedForProvider(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
  relativePath: string,
): boolean {
  if (!ref.consent.sendToProvider) return false;
  const selection = sourceSelectionForRef(ref);
  if (!sourceSelectionAdmits(selection, relativePath)) return false;
  const grant = effectiveConsentGrant(ref);
  const grantPolicy = buildSourceSelectionIR({
    kind: ref.kind,
    includePrefixes: grant.includePrefixes,
    excludeGlobs: grant.excludeGlobs,
  });
  const extension = path.posix.extname(relativePath.replace(/\\/g, '/'));
  return grant.extensions.includes(extension) && sourceSelectionAdmits(grantPolicy, relativePath);
}

export function availableNotConsentedExtensions(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
): string[] {
  const granted = new Set(effectiveConsentGrant(ref).extensions);
  return sourceExtensionsForKind(ref.kind)
    .filter(extension => !granted.has(extension))
    .sort();
}

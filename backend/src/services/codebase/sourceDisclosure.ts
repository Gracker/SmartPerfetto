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
  sourceSelectionCanDescend,
  sourceSelectionForRef,
  type SourceSelectionIR,
} from './sourceSelectionPolicy';

type SourceProviderRef = Pick<
  CodebaseRef,
  'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'
>;

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
  ref: SourceProviderRef,
): CodebaseConsentGrant {
  return ref.consent.grant ?? legacyConsentGrant(ref);
}

function providerGrantPolicy(ref: SourceProviderRef, grant = effectiveConsentGrant(ref)): SourceSelectionIR {
  return buildSourceSelectionIR({
    kind: ref.kind,
    includePrefixes: grant.includePrefixes,
    excludeGlobs: grant.excludeGlobs,
  });
}

/** Whether any file the provider-send grant covers can lie under a relative directory. */
export function sourceProviderGrantCanDescend(
  ref: SourceProviderRef,
  relativeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ref.consent.sendToProvider &&
    sourceSelectionCanDescend(providerGrantPolicy(ref), relativeDirectory, platform);
}

export function createSourceProviderPathPredicate(
  ref: SourceProviderRef,
  platform: NodeJS.Platform = process.platform,
  selection: SourceSelectionIR = sourceSelectionForRef(ref),
): (relativePath: string) => boolean {
  if (!ref.consent.sendToProvider) return () => false;
  const grant = effectiveConsentGrant(ref);
  const grantPolicy = providerGrantPolicy(ref, grant);
  const comparable = (value: string): string => platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  const grantedExtensions = new Set(grant.extensions.map(comparable));
  return relativePath => {
    if (!sourceSelectionAdmits(selection, relativePath, platform)) return false;
    const extension = comparable(path.posix.extname(relativePath.replace(/\\/g, '/')));
    return grantedExtensions.has(extension) &&
      sourceSelectionAdmits(grantPolicy, relativePath, platform);
  };
}

export function sourcePathAllowedForProvider(
  ref: SourceProviderRef,
  relativePath: string,
): boolean {
  return createSourceProviderPathPredicate(ref)(relativePath);
}

export function availableNotConsentedExtensions(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
): string[] {
  const granted = new Set(effectiveConsentGrant(ref).extensions);
  return sourceExtensionsForKind(ref.kind)
    .filter(extension => !granted.has(extension))
    .sort();
}

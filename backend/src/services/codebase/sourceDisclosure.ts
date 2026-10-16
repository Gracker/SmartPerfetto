// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
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

/** Whether a grant names exactly a canonical path selection: the one grant-equality test. */
export function grantMatchesSelection(
  grant: Pick<CodebaseConsentGrant, 'includePrefixes' | 'excludeGlobs'>,
  selection: Pick<SourceSelectionIR, 'includePrefixes' | 'excludeGlobs'>,
): boolean {
  const same = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  return same(grant.includePrefixes, selection.includePrefixes) &&
    same(grant.excludeGlobs, selection.excludeGlobs);
}

/**
 * What the combined consent action discloses and grants: the canonical
 * include prefixes and exclusions of the current selection and every language
 * this kind admits, with the token that names exactly this disclosure (the
 * selection revision and a digest of the three lists). A caller shows these
 * lists and grants with their token; `authorizeContent` grants the lists of
 * the disclosure whose token it was given, so what is shown is what is
 * granted. A selection edit or a language a newer version adds changes the
 * token; the order of the lists does not.
 */
export interface ContentDisclosure {
  token: string;
  includePrefixes: string[];
  excludeGlobs: string[];
  extensions: string[];
}

export function contentDisclosure(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'selectionPolicyRevision'>,
  selection: SourceSelectionIR = sourceSelectionForRef(ref),
): ContentDisclosure {
  const includePrefixes = [...selection.includePrefixes];
  const excludeGlobs = [...selection.excludeGlobs];
  // The kind's own order, as a grant stores it; the digest is order-free.
  const extensions = [...sourceExtensionsForKind(ref.kind)];
  const digest = createHash('sha256').update(JSON.stringify({
    kind: ref.kind,
    includePrefixes,
    excludeGlobs,
    extensions: [...extensions].sort(),
  })).digest('hex').slice(0, 16);
  return {token: `cd1:${ref.selectionPolicyRevision ?? 1}:${digest}`, includePrefixes, excludeGlobs, extensions};
}

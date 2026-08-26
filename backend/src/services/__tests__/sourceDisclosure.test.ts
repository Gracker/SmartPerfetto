// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {CodebaseRef} from '../codebase/codebaseRegistry';
import {
  availableNotConsentedExtensions,
  sourcePathAllowedForProvider,
} from '../codebase/sourceDisclosure';

const ref: CodebaseRef = {
  codebaseId: 'cb-app',
  kind: 'app_source',
  displayName: 'App',
  rootPath: '/repo',
  rootRealpath: '/repo',
  pathFilters: ['app'],
  excludeGlobs: ['**/generated/**'],
  selectionPolicyRevision: 1,
  consent: {
    sendToProvider: true,
    consentedAt: 1,
    consentedBy: 'user',
    consentHash: 'legacy',
    grant: {
      revision: 1,
      grantedAt: 1,
      grantedBy: 'user',
      extensions: ['.java', '.kt'],
      includePrefixes: ['app'],
      excludeGlobs: ['**/generated/**'],
    },
  },
  indexGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe('source disclosure scope', () => {
  it('intersects the live selection policy with the frozen consent grant', () => {
    expect(sourcePathAllowedForProvider(ref, 'app/src/Main.kt')).toBe(true);
    expect(sourcePathAllowedForProvider(ref, 'app/src/main.dart')).toBe(false);
    expect(sourcePathAllowedForProvider(ref, 'app/generated/Main.kt')).toBe(false);
    expect(sourcePathAllowedForProvider(ref, 'tools/Main.kt')).toBe(false);
    expect(availableNotConsentedExtensions(ref)).toEqual(expect.arrayContaining(['.dart', '.ts', '.tsx']));
  });
});

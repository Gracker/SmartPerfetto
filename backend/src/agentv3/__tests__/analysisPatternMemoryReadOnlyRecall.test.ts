// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Pins the contract that the recall path (`matchNegativePatterns` →
 * `getSupersedeWeight`) routes through `openSupersedeStoreReadOnly`
 * and never the writable factory. The recall path backs the
 * `recall_patterns` MCP tool, so any silent mkdir/migration here
 * would break public-readonly classification. Also pins the
 * cold-start retry behaviour: a null return from the read-only
 * adapter (DB file not yet created) must not permanently disable the
 * recall path.
 */

import {jest} from '@jest/globals';

const SEEDED_NEGATIVE = JSON.stringify([
  {
    id: 'neg-m1b-test',
    traceFeatures: ['arch:Standard', 'scene:scrolling', 'cat:GPU'],
    sceneType: 'scrolling',
    failedApproaches: [
      {type: 'sql', approach: 'naive_join', reason: 'Cartesian blowup on large traces'},
    ],
    architectureType: 'Standard',
    createdAt: Date.now(),
    matchCount: 0,
    status: 'confirmed',
    failureModeHash: 'h_m1b_invariant_test',
  },
]);

// fs.readFileSync is non-configurable on modern Node, so jest.spyOn
// cannot redefine it. A module-level mock substitutes the whole module
// before any importer (including analysisPatternMemory) binds it.
// We delegate every call to the real fs except the negative patterns
// path so the rest of the codebase keeps working unchanged.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    __esModule: true,
    default: actual,
    readFileSync: jest.fn((filePath: unknown, options: unknown) => {
      if (
        typeof filePath === 'string' &&
        filePath.endsWith('analysis_negative_patterns.json')
      ) {
        return SEEDED_NEGATIVE;
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(filePath, options);
    }),
    existsSync: jest.fn((filePath: unknown) => {
      if (
        typeof filePath === 'string' &&
        filePath.endsWith('analysis_negative_patterns.json')
      ) {
        return true;
      }
      return (actual.existsSync as (p: unknown) => boolean)(filePath);
    }),
  };
});

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import * as supersedeStore from '../selfImprove/supersedeStore';
import {
  matchNegativePatterns,
  resetSupersedeHandlesForTesting,
  setSupersedeStoreForTesting,
} from '../analysisPatternMemory';

const FAKE_HANDLE = {
  findActiveByHash: jest.fn(() => null),
  close: jest.fn(),
} as unknown as supersedeStore.SupersedeStoreReadHandle;

describe('analysisPatternMemory recall path — read-only invariant', () => {
  let writeSpy: jest.SpiedFunction<typeof supersedeStore.openSupersedeStore>;
  let readSpy: jest.SpiedFunction<typeof supersedeStore.openSupersedeStoreReadOnly>;

  beforeEach(() => {
    resetSupersedeHandlesForTesting();
    jest.clearAllMocks();
    writeSpy = jest.spyOn(supersedeStore, 'openSupersedeStore');
    readSpy = jest.spyOn(supersedeStore, 'openSupersedeStoreReadOnly');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    readSpy.mockRestore();
    setSupersedeStoreForTesting(null);
  });

  it('routes recall through openSupersedeStoreReadOnly, never the writable factory', () => {
    readSpy.mockReturnValue(null);

    const matches = matchNegativePatterns([
      'arch:Standard',
      'scene:scrolling',
      'cat:GPU',
    ]);

    expect(matches.length).toBeGreaterThan(0);
    expect(readSpy).toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('retries the read-only adapter when the DB file is missing on first call', () => {
    readSpy.mockReturnValueOnce(null).mockReturnValue(FAKE_HANDLE);

    matchNegativePatterns(['arch:Standard', 'scene:scrolling']);
    matchNegativePatterns(['arch:Standard', 'scene:scrolling']);

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(FAKE_HANDLE.close).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('opens a fresh snapshot so marker changes are visible in the same process', () => {
    const firstHandle = {
      findActiveByHash: jest.fn(() => null),
      close: jest.fn(),
    } as unknown as supersedeStore.SupersedeStoreReadHandle;
    const activeHandle = {
      findActiveByHash: jest.fn(() => ({state: 'active'})),
      close: jest.fn(),
    } as unknown as supersedeStore.SupersedeStoreReadHandle;
    readSpy
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(activeHandle);

    const beforePromotion = matchNegativePatterns([
      'arch:Standard',
      'scene:scrolling',
      'cat:GPU',
    ]);
    const afterPromotion = matchNegativePatterns([
      'arch:Standard',
      'scene:scrolling',
      'cat:GPU',
    ]);

    expect(beforePromotion).toHaveLength(1);
    expect(afterPromotion).toHaveLength(0);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(firstHandle.close).toHaveBeenCalledTimes(1);
    expect(activeHandle.close).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

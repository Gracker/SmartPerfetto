// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {ApplicationBuildIdentity} from '../../applicationUpdate/types';
import {
  loadLastReconciledBuildIdentity,
  saveLastReconciledBuildIdentity,
} from '../buildIdentityStore';

const identity: ApplicationBuildIdentity = {
  distribution: 'portable',
  channel: 'stable',
  version: '1.2.3',
  commit: 'a'.repeat(40),
  target: {os: 'darwin', arch: 'arm64', id: 'macos-arm64'},
  signingMode: 'macos-developer-id-notarized',
};

describe('last reconciled build identity store', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-build-identity-'));
    filePath = path.join(root, 'nested', 'last_identity.json');
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function persistence(state: 'available' | 'unavailable' = 'available') {
    return {
      persistence: state,
      ...(state === 'unavailable'
        ? {reason: 'external_data_dir_not_configured' as const}
        : {}),
      configured: state === 'available',
      writable: true,
      outsidePackage: true,
      externalMount: false,
      dataRoot: root,
      packageRoot: path.join(root, 'package'),
      checkedAt: 1,
    } as const;
  }

  it('returns missing without creating a directory or file', () => {
    expect(loadLastReconciledBuildIdentity({filePath})).toBeNull();
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);
  });

  it('atomically saves and strictly reloads schema v1', () => {
    const saved = saveLastReconciledBuildIdentity(identity, {
      filePath,
      reconciledAt: '2026-07-28T01:02:03.000Z',
      persistence: persistence(),
    });
    expect(saved).toEqual({
      schemaVersion: 1,
      lastReconciledBuildIdentity: identity,
      reconciledAt: '2026-07-28T01:02:03.000Z',
    });
    expect(loadLastReconciledBuildIdentity({filePath})).toEqual(saved);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.tmp.')))
      .toEqual([]);
  });

  it('refuses to write when persistence is unavailable', () => {
    expect(() => saveLastReconciledBuildIdentity(identity, {
      filePath,
      persistence: persistence('unavailable'),
    })).toThrow('self_evolution_persistence_unavailable');
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);
  });

  it('rejects malformed, unknown-schema, and open-ended records', () => {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    for (const value of [
      '{bad json',
      JSON.stringify({
        schemaVersion: 2,
        lastReconciledBuildIdentity: identity,
        reconciledAt: '2026-07-28T01:02:03.000Z',
      }),
      JSON.stringify({
        schemaVersion: 1,
        lastReconciledBuildIdentity: identity,
        reconciledAt: '2026-07-28T01:02:03.000Z',
        unexpected: true,
      }),
      JSON.stringify({
        schemaVersion: 1,
        lastReconciledBuildIdentity: {
          ...identity,
          commit: 'unknown',
        },
        reconciledAt: '2026-07-28T01:02:03.000Z',
      }),
      JSON.stringify({
        schemaVersion: 1,
        lastReconciledBuildIdentity: {
          ...identity,
          distribution: 'source',
          signingMode: 'source-checkout',
          commit: undefined,
        },
        reconciledAt: '2026-07-28T01:02:03.000Z',
      }),
    ]) {
      fs.writeFileSync(filePath, value);
      expect(() => loadLastReconciledBuildIdentity({filePath})).toThrow();
    }
  });
});

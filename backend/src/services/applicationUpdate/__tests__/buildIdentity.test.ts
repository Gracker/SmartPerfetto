// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import packageJson from '../../../../package.json';
import {
  applicationUpdateCacheKey,
  portableTargetId,
  resolveApplicationBuildIdentity,
} from '../buildIdentity';

describe('application build identity', () => {
  it('uses the package version and validates environment dimensions', () => {
    const identity = resolveApplicationBuildIdentity({
      SMARTPERFETTO_DISTRIBUTION: 'docker',
      SMARTPERFETTO_UPDATE_CHANNEL: 'nightly',
      SMARTPERFETTO_BUILD_COMMIT: 'a'.repeat(40),
      SMARTPERFETTO_PACKAGE_TARGET: 'linux-x64',
      SMARTPERFETTO_PACKAGE_TARGET_OS: 'linux',
      SMARTPERFETTO_PACKAGE_TARGET_ARCH: 'x64',
      SMARTPERFETTO_SIGNING_MODE: 'container',
      SMARTPERFETTO_VERSION: '99.99.99',
    } as NodeJS.ProcessEnv);

    expect(identity).toMatchObject({
      distribution: 'docker',
      channel: 'nightly',
      version: packageJson.version,
      commit: 'a'.repeat(40),
      target: {id: 'linux-x64', os: 'linux', arch: 'x64'},
      signingMode: 'container',
    });
  });

  it('falls back to safe source defaults for invalid environment values', () => {
    expect(resolveApplicationBuildIdentity({
      SMARTPERFETTO_DISTRIBUTION: 'unknown',
      SMARTPERFETTO_UPDATE_CHANNEL: 'preview',
      SMARTPERFETTO_SIGNING_MODE: 'remote',
    } as NodeJS.ProcessEnv)).toMatchObject({
      distribution: 'source',
      channel: 'stable',
      signingMode: 'source-checkout',
    });
  });

  it('partitions cache keys and maps supported portable targets', () => {
    const identity = resolveApplicationBuildIdentity({}, {
      distribution: 'portable',
      channel: 'stable',
      target: {os: 'darwin', arch: 'arm64', id: 'macos-arm64'},
      signingMode: 'macos-adhoc',
    });
    expect(applicationUpdateCacheKey(identity))
      .toBe('portable-stable-macos-arm64');
    expect(portableTargetId({os: 'windows', arch: 'amd64'}))
      .toBe('windows-x64');
    expect(portableTargetId({os: 'freebsd', arch: 'arm64'}))
      .toBeUndefined();
  });
});

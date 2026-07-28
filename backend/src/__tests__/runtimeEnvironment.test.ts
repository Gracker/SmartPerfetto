// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {configureRuntimeEnvironment} from '../runtimeEnvironment';

describe('configureRuntimeEnvironment', () => {
  let root: string;
  let envFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-runtime-env-'));
    envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, [
      'PORT=9999',
      'SMARTPERFETTO_BACKEND_DATA_DIR=/dotenv/data',
      'SMARTPERFETTO_PACKAGE_ROOT=/dotenv/package',
      'SMARTPERFETTO_DISTRIBUTION=source',
      `SMARTPERFETTO_BUILD_COMMIT=${'b'.repeat(40)}`,
      'SELF_EVOLUTION_ENABLED=1',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('preserves launcher-owned ports and runtime identity across dotenv', () => {
    const env: NodeJS.ProcessEnv = {
      SMARTPERFETTO_ENV_FILE: envFile,
      SMARTPERFETTO_LOCK_SERVICE_PORTS: '1',
      SMARTPERFETTO_LOCK_RUNTIME_IDENTITY: '1',
      PORT: '3000',
      SMARTPERFETTO_BACKEND_DATA_DIR: '/launcher/data',
      SMARTPERFETTO_PACKAGE_ROOT: '/launcher/package',
      SMARTPERFETTO_DISTRIBUTION: 'portable',
      SMARTPERFETTO_BUILD_COMMIT: 'a'.repeat(40),
    };

    configureRuntimeEnvironment(env);

    expect(env).toMatchObject({
      PORT: '3000',
      SMARTPERFETTO_BACKEND_DATA_DIR: '/launcher/data',
      SMARTPERFETTO_PACKAGE_ROOT: '/launcher/package',
      SMARTPERFETTO_DISTRIBUTION: 'portable',
      SMARTPERFETTO_BUILD_COMMIT: 'a'.repeat(40),
      SELF_EVOLUTION_ENABLED: '1',
    });
  });

  it('allows dotenv to provide a source data directory absent from the launcher', () => {
    const env: NodeJS.ProcessEnv = {
      SMARTPERFETTO_ENV_FILE: envFile,
      SMARTPERFETTO_LOCK_RUNTIME_IDENTITY: '1',
      SMARTPERFETTO_PACKAGE_ROOT: '/launcher/package',
      SMARTPERFETTO_DISTRIBUTION: 'source',
      SMARTPERFETTO_BUILD_COMMIT: 'a'.repeat(40),
    };

    configureRuntimeEnvironment(env);

    expect(env.SMARTPERFETTO_BACKEND_DATA_DIR).toBe('/dotenv/data');
    expect(env.SMARTPERFETTO_PACKAGE_ROOT).toBe('/launcher/package');
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {resolveApplicationBuildIdentity} from '../../services/applicationUpdate/buildIdentity';
import {probeSelfEvolutionPersistence} from '../../services/selfEvolution/persistenceCapability';

describe('CLI bootstrap runtime storage', () => {
  const originalCwd = process.cwd();
  const originalEnv = {...process.env};
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-bootstrap-'));
    delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
    delete process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
    delete process.env.SMARTPERFETTO_PACKAGE_ROOT;
    delete process.env.SMARTPERFETTO_DISTRIBUTION;
    process.env.SMARTPERFETTO_HOME = tempDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('keeps mutable backend state under CLI home instead of the installed package', () => {
    const {bootstrap} = require('../bootstrap') as typeof import('../bootstrap');
    const result = bootstrap();

    expect(result.paths.home).toBe(tempDir);
    expect(process.env.SMARTPERFETTO_BACKEND_DATA_DIR).toBe(path.join(tempDir, 'runtime', 'data'));
    expect(process.env.SMARTPERFETTO_BACKEND_LOG_DIR).toBe(path.join(tempDir, 'runtime', 'logs'));
    expect(process.env.SMARTPERFETTO_PACKAGE_ROOT).toBe(
      path.resolve(__dirname, '..', '..', '..'),
    );
    expect(process.env.SMARTPERFETTO_DISTRIBUTION).toBe('npm');
    expect(resolveApplicationBuildIdentity()).toMatchObject({
      distribution: 'npm',
      signingMode: 'npm-registry',
    });
    expect(probeSelfEvolutionPersistence({mountPoints: []})).toMatchObject({
      persistence: 'available',
      configured: true,
      outsidePackage: true,
      writable: true,
    });
  });

  it('preserves explicit package identity overrides', () => {
    process.env.SMARTPERFETTO_PACKAGE_ROOT = '/configured/package';
    process.env.SMARTPERFETTO_DISTRIBUTION = 'portable';

    const {bootstrap} = require('../bootstrap') as typeof import('../bootstrap');
    bootstrap();

    expect(process.env.SMARTPERFETTO_PACKAGE_ROOT).toBe('/configured/package');
    expect(process.env.SMARTPERFETTO_DISTRIBUTION).toBe('portable');
  });
});

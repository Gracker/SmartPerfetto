// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  __testing,
  probeSelfEvolutionPersistence,
} from '../persistenceCapability';

describe('probeSelfEvolutionPersistence', () => {
  let root: string;
  let packageRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-self-evolution-probe-'));
    packageRoot = path.join(root, 'package');
    fs.mkdirSync(packageRoot);
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function probe(
    dataRoot: string,
    configured = true,
    mountPoints: readonly string[] = [],
    distribution = 'source',
  ) {
    return probeSelfEvolutionPersistence({
      env: configured
        ? {
            SMARTPERFETTO_BACKEND_DATA_DIR: dataRoot,
            SMARTPERFETTO_DISTRIBUTION: distribution,
          }
        : {},
      packageRoot,
      dataRoot,
      mountPoints,
      now: () => 123,
    });
  }

  it('accepts portable default and npm-style configured roots outside the package', () => {
    for (const name of ['portable-default', 'npm-cli']) {
      const result = probe(path.join(root, name));
      expect(result).toMatchObject({
        persistence: 'available',
        configured: true,
        writable: true,
        outsidePackage: true,
      });
    }
  });

  it('fails closed for SMARTPERFETTO_PORTABLE_MODE-style package-local data', () => {
    const result = probe(path.join(packageRoot, 'data'));
    expect(result).toMatchObject({
      persistence: 'unavailable',
      reason: 'data_root_inside_package',
      writable: true,
      outsidePackage: false,
      externalMount: false,
    });
  });

  it('fails closed for an explicitly configured source directory inside the repo', () => {
    const result = probe(path.join(packageRoot, 'runtime-data'));
    expect(result).toMatchObject({
      persistence: 'unavailable',
      reason: 'data_root_inside_package',
      outsidePackage: false,
    });
  });

  it('distinguishes a Docker named volume from bare docker-run package storage', () => {
    const dataRoot = path.join(packageRoot, 'backend', 'runtime-data');
    const bare = probe(dataRoot);
    expect(bare).toMatchObject({
      persistence: 'unavailable',
      reason: 'data_root_inside_package',
    });

    const compose = probe(dataRoot, true, [dataRoot]);
    expect(compose).toMatchObject({
      persistence: 'available',
      outsidePackage: false,
      externalMount: true,
    });
  });

  it('requires a durable mount for Docker even when the configured path is outside the package', () => {
    const dataRoot = path.join(root, 'docker-data');
    const bare = probe(dataRoot, true, [], 'docker');
    expect(bare).toMatchObject({
      persistence: 'unavailable',
      reason: 'docker_data_root_not_mounted',
      outsidePackage: true,
      externalMount: false,
    });

    const volume = probe(dataRoot, true, [dataRoot], 'docker');
    expect(volume).toMatchObject({
      persistence: 'available',
      outsidePackage: true,
      externalMount: true,
    });
  });

  it('does not count the container root filesystem as a Docker data volume', () => {
    const dataRoot = path.join(root, 'docker-data');
    const result = probe(dataRoot, true, [path.parse(dataRoot).root], 'docker');
    expect(result).toMatchObject({
      persistence: 'unavailable',
      reason: 'docker_data_root_not_mounted',
      externalMount: false,
    });
  });

  it('does not accept tmpfs or ramfs as durable Linux mount boundaries', () => {
    expect(__testing.persistentMountPoint(
      '36 25 0:32 / /app/backend/runtime-data rw - tmpfs tmpfs rw',
    )).toBeNull();
    expect(__testing.persistentMountPoint(
      '37 25 0:33 / /app/backend/runtime-data rw - ext4 /dev/vda1 rw',
    )).toBe('/app/backend/runtime-data');
  });

  it('does not treat the source fallback as an explicitly configured external directory', () => {
    const result = probe(path.join(root, 'source-fallback'), false);
    expect(result).toMatchObject({
      persistence: 'unavailable',
      reason: 'external_data_dir_not_configured',
      writable: true,
      outsidePackage: true,
    });
  });

  it('reports a failed real write probe and leaves no probe artifact', () => {
    const dataRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(dataRoot, 'occupied');
    const result = probe(dataRoot);
    expect(result).toMatchObject({
      persistence: 'unavailable',
      reason: 'data_root_not_writable',
      writable: false,
    });
    expect(fs.readdirSync(root).some((name) => name.includes('write-probe'))).toBe(false);
  });
});

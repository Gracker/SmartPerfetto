// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {
  hasConfiguredUserDataRoot,
  resolveUserDataRoot,
} from '../../runtimePaths';
import type {
  SelfEvolutionPersistenceCapability,
  SelfEvolutionPersistenceUnavailableReason,
} from '../../types/selfEvolution';

export interface ProbeSelfEvolutionPersistenceOptions {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  dataRoot?: string;
  homeDir?: string;
  mountPoints?: readonly string[];
  now?: () => number;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? 'unknown_error';
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

const NON_DURABLE_FILESYSTEMS = new Set(['ramfs', 'tmpfs']);

function persistentMountPoint(line: string): string | null {
  const separator = line.indexOf(' - ');
  if (separator < 0) return null;
  const fields = line.slice(0, separator).split(' ');
  const filesystemType = line.slice(separator + 3).split(' ')[0];
  if (fields.length < 5 || NON_DURABLE_FILESYSTEMS.has(filesystemType)) {
    return null;
  }
  return decodeMountInfoPath(fields[4]);
}

function readLinuxMountPoints(): string[] {
  if (process.platform !== 'linux') return [];
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const mountPoint = persistentMountPoint(line);
        return mountPoint ? [mountPoint] : [];
      });
  } catch {
    return [];
  }
}

function hasDurableMountBoundary(
  packageRoot: string,
  dataRoot: string,
  mountPoints: readonly string[],
): boolean {
  return mountPoints.some((mountPoint) => {
    let resolvedMount = path.resolve(mountPoint);
    try {
      resolvedMount = fs.realpathSync.native(resolvedMount);
    } catch {
      // A disappeared mount cannot establish persistence.
    }
    const filesystemRoot = path.parse(resolvedMount).root;
    const dataOutsidePackage = !isWithin(packageRoot, dataRoot);
    return (
      resolvedMount !== packageRoot &&
      resolvedMount !== filesystemRoot &&
      (dataOutsidePackage || isWithin(packageRoot, resolvedMount)) &&
      isWithin(resolvedMount, dataRoot)
    );
  });
}

function unavailable(
  base: Omit<SelfEvolutionPersistenceCapability, 'persistence' | 'reason'>,
  reason: SelfEvolutionPersistenceUnavailableReason,
  probeErrorCode?: string,
): SelfEvolutionPersistenceCapability {
  return {
    ...base,
    persistence: 'unavailable',
    reason,
    ...(probeErrorCode ? {errorCode: probeErrorCode} : {}),
  };
}

export function probeSelfEvolutionPersistence(
  options: ProbeSelfEvolutionPersistenceOptions = {},
): SelfEvolutionPersistenceCapability {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const distribution = env.SMARTPERFETTO_DISTRIBUTION
    ?.trim()
    .toLowerCase();
  const configured = hasConfiguredUserDataRoot(env);
  const requestedDataRoot = path.resolve(
    options.dataRoot ?? resolveUserDataRoot(env, options.homeDir),
  );
  const requestedPackageRoot = path.resolve(
    options.packageRoot ?? env.SMARTPERFETTO_PACKAGE_ROOT?.trim() ?? process.cwd(),
  );
  const base = {
    configured,
    writable: false,
    outsidePackage: false,
    externalMount: false,
    dataRoot: requestedDataRoot,
    packageRoot: requestedPackageRoot,
    checkedAt: now(),
  };

  const probePath = path.join(
    requestedDataRoot,
    `.self-evolution-write-probe-${process.pid}-${now()}`,
  );
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(requestedDataRoot, {recursive: true, mode: 0o700});
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, 'self-evolution-persistence-probe\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort cleanup after a failed capability probe.
      }
    }
    try {
      if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
    } catch {
      // The failure remains fail-closed and is surfaced through errorCode.
    }
    return unavailable(base, 'data_root_not_writable', errorCode(error));
  }

  let dataRoot: string;
  let packageRoot: string;
  try {
    dataRoot = fs.realpathSync.native(requestedDataRoot);
    packageRoot = fs.realpathSync.native(requestedPackageRoot);
  } catch (error) {
    return unavailable(
      {...base, writable: true},
      'package_root_unavailable',
      errorCode(error),
    );
  }

  const outsidePackage = !isWithin(packageRoot, dataRoot);
  const mountPoints = options.mountPoints ?? readLinuxMountPoints();
  let externalMount = hasDurableMountBoundary(
    packageRoot,
    dataRoot,
    mountPoints,
  );
  if (process.platform !== 'linux' && options.mountPoints === undefined) {
    try {
      externalMount ||= fs.statSync(packageRoot).dev !== fs.statSync(dataRoot).dev;
    } catch {
      // The explicit package/data containment checks remain fail-closed.
    }
  }

  const checked = {
    ...base,
    writable: true,
    outsidePackage,
    externalMount,
    dataRoot,
    packageRoot,
  };
  if (!configured) {
    return unavailable(checked, 'external_data_dir_not_configured');
  }
  if (!outsidePackage && !externalMount) {
    return unavailable(checked, 'data_root_inside_package');
  }
  if (distribution === 'docker' && !externalMount) {
    return unavailable(checked, 'docker_data_root_not_mounted');
  }
  return {
    ...checked,
    persistence: 'available',
  };
}

export const __testing = {
  NON_DURABLE_FILESYSTEMS,
  decodeMountInfoPath,
  hasDurableMountBoundary,
  isWithin,
  persistentMountPoint,
  readLinuxMountPoints,
};

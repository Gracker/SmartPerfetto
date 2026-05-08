// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

let cachedVersion: string | null = null;

export function getSmartPerfettoVersion(): string {
  if (cachedVersion) return cachedVersion;

  const packageJsonPath = findBackendPackageJson();
  if (!packageJsonPath) {
    cachedVersion = '0.0.0';
    return cachedVersion;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
    cachedVersion = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }

  return cachedVersion;
}

function findBackendPackageJson(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath) && isSmartPerfettoBackendPackage(packageJsonPath)) {
      return packageJsonPath;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isSmartPerfettoBackendPackage(packageJsonPath: string): boolean {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown };
    return packageJson.name === '@gracker/smartperfetto';
  } catch {
    return false;
  }
}

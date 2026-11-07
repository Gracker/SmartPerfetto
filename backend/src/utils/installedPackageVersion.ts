// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {readFileSync} from 'node:fs';
import {findPackageJSON} from 'node:module';
import {pathToFileURL} from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const cache = new Map<string, string>();

/**
 * The installed version of a package, read once per process from its own
 * package.json (CommonJS or ESM-only, regardless of its exports map); 'unknown'
 * when missing or not a semver.
 */
export function installedPackageVersion(specifier: string): string {
  let version = cache.get(specifier);
  if (version === undefined) {
    version = 'unknown';
    try {
      const file = findPackageJSON(specifier, pathToFileURL(__filename));
      const declared = file ? (JSON.parse(readFileSync(file, 'utf8')) as {version?: unknown}).version : undefined;
      if (typeof declared === 'string' && SEMVER.test(declared)) version = declared;
    } catch {
      // A missing installed identity stays unknown.
    }
    cache.set(specifier, version);
  }
  return version;
}

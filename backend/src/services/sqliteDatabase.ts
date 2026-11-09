// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import BetterSqlite3 from 'better-sqlite3';

/**
 * The one way production code opens SQLite. npm 12 no longer runs a
 * dependency's install script by default, which leaves better-sqlite3 without
 * its compiled addon, so the npm package carries one per platform. An addon the
 * install did build always wins: source, Docker and portable keep theirs.
 */
const PREBUILT_ROOT = path.resolve(__dirname, '../../prebuilts/better-sqlite3');

export function bundledSqliteBinding(
  installedBindingExists: boolean,
  runtime: {modules: string; platform: string; arch: string} =
  {modules: process.versions.modules, platform: process.platform, arch: process.arch},
  fileExists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  if (installedBindingExists) return undefined;
  const candidate = path.join(PREBUILT_ROOT, `node-v${runtime.modules}-${runtime.platform}-${runtime.arch}`, 'better_sqlite3.node');
  return fileExists(candidate) ? candidate : undefined;
}

function installedBindingExists(): boolean {
  try {
    const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
    return fs.existsSync(path.join(packageRoot, 'build', 'Release', 'better_sqlite3.node'));
  } catch {
    return false;
  }
}

const NATIVE_BINDING = bundledSqliteBinding(installedBindingExists());

const Database = new Proxy(BetterSqlite3, {
  construct(target, args: [string?, BetterSqlite3.Options?], newTarget) {
    const [filename, options] = args;
    const binding = options?.nativeBinding ?? NATIVE_BINDING;
    return Reflect.construct(target, [filename, binding ? {...options, nativeBinding: binding} : options], newTarget);
  },
}) as typeof BetterSqlite3;

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = BetterSqlite3.Database;
  export type Statement<BindParameters extends unknown[] = unknown[], Result = unknown> =
    BetterSqlite3.Statement<BindParameters, Result>;
  export type RunResult = BetterSqlite3.RunResult;
}

export default Database;

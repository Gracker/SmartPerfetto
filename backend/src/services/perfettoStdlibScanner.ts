// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Perfetto Stdlib Module Scanner
 *
 * Scans the Perfetto stdlib directory to extract all available module names.
 * Module names are derived from the file path relative to the stdlib root.
 *
 * For example:
 *   android/binder.sql -> "android.binder"
 *   android/frames/timeline.sql -> "android.frames.timeline"
 *   viz/summary/processes.sql -> "viz.summary.processes"
 */

import * as fs from 'fs';
import * as path from 'path';

// Path to the Perfetto stdlib directory
// From backend/src/services/ -> ../../../perfetto/src/trace_processor/perfetto_sql/stdlib
export const STDLIB_PATH = path.resolve(
  __dirname,
  '../../../perfetto/src/trace_processor/perfetto_sql/stdlib'
);

export const STDLIB_PRELUDE_DIR = 'prelude';

// Directories to exclude from scanning
// - prelude: Automatically loaded by Perfetto, should not be manually included
const EXCLUDED_DIRS = new Set(['prelude']);

/**
 * Walk the stdlib directory tree and invoke `callback` for each `.sql`
 * file. Returns the absolute file path plus the path relative to
 * `STDLIB_PATH` (with native separators) so callers can derive their own
 * naming scheme. Shared between the module-name scanner here and
 * `sqlIncludeInjector` which needs to read SQL contents.
 */
export function walkStdlibSqlFiles(
  callback: (absPath: string, relPath: string) => void,
  options: { includePrelude?: boolean } = {},
): void {
  if (!fs.existsSync(STDLIB_PATH)) return;
  const includePrelude = options.includePrelude ?? false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!includePrelude && entry.name === STDLIB_PRELUDE_DIR) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.sql')) {
        callback(abs, path.relative(STDLIB_PATH, abs));
      }
    }
  };
  walk(STDLIB_PATH);
}

/**
 * Recursively scans a directory for SQL files and extracts module names.
 *
 * @param dir - The directory to scan
 * @param prefix - The module name prefix (e.g., "android" or "android.frames")
 * @returns Array of module names
 */
function scanDirectory(dir: string, prefix: string = ''): string[] {
  const modules: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryName = entry.name;

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (EXCLUDED_DIRS.has(entryName)) {
          continue;
        }

        // Recursively scan subdirectories
        const newPrefix = prefix ? `${prefix}.${entryName}` : entryName;
        const subModules = scanDirectory(path.join(dir, entryName), newPrefix);
        modules.push(...subModules);
      } else if (entryName.endsWith('.sql')) {
        // Extract module name from file name (remove .sql extension)
        const moduleName = entryName.slice(0, -4);
        const fullModuleName = prefix ? `${prefix}.${moduleName}` : moduleName;
        modules.push(fullModuleName);
      }
    }
  } catch (error: any) {
    console.error(`[StdlibScanner] Error scanning directory ${dir}:`, error.message);
  }

  return modules;
}

/**
 * Scans the Perfetto stdlib directory and returns all available module names.
 *
 * @returns Array of module names (e.g., ["android.binder", "android.frames.timeline", ...])
 */
export function scanPerfettoStdlibModules(): string[] {
  if (!fs.existsSync(STDLIB_PATH)) {
    console.warn(`[StdlibScanner] Stdlib path not found: ${STDLIB_PATH}`);
    return [];
  }

  const startTime = Date.now();
  const modules = scanDirectory(STDLIB_PATH);
  const elapsed = Date.now() - startTime;

  console.log(
    `[StdlibScanner] Scanned ${modules.length} modules in ${elapsed}ms from ${STDLIB_PATH}`
  );

  return modules;
}

// Cache the module list to avoid repeated filesystem scans
let cachedModules: string[] | null = null;

/**
 * Gets the list of Perfetto stdlib modules, caching the result.
 * The first call triggers a filesystem scan; subsequent calls return the cached list.
 *
 * @returns Array of module names
 */
export function getPerfettoStdlibModules(): string[] {
  if (cachedModules === null) {
    cachedModules = scanPerfettoStdlibModules();
    console.log(`[StdlibScanner] Cached ${cachedModules.length} Perfetto stdlib modules`);
  }
  return cachedModules;
}

/**
 * Clears the cached module list, forcing a rescan on next access.
 * Useful for testing or when the stdlib files may have changed.
 */
export function clearModuleCache(): void {
  cachedModules = null;
}

/**
 * Groups modules by their top-level namespace for logging purposes.
 *
 * @param modules - Array of module names
 * @returns Object mapping namespace to count
 */
export function groupModulesByNamespace(modules: string[]): Record<string, number> {
  const groups: Record<string, number> = {};

  for (const module of modules) {
    const namespace = module.split('.')[0];
    groups[namespace] = (groups[namespace] || 0) + 1;
  }

  return groups;
}
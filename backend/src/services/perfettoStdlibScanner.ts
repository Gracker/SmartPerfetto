// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Perfetto Stdlib Module Scanner
 *
 * Exposes the Perfetto stdlib inventory used by agent tools and SQL
 * auto-INCLUDE injection.
 *
 * Published/runtime builds use backend/data/perfettoStdlibSymbols.json so npm
 * and Docker users do not need the perfetto submodule. Source checkouts can
 * still scan the live stdlib tree, and PERFETTO_STDLIB_PATH can override it for
 * maintainer debugging.
 *
 * For example:
 *   android/binder.sql -> "android.binder"
 *   android/frames/timeline.sql -> "android.frames.timeline"
 *   viz/summary/processes.sql -> "viz.summary.processes"
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PerfettoStdlibSymbolAsset {
  version: number;
  generatedAt?: string;
  generatedFrom?: string;
  sourcePath?: string;
  modules: string[];
  tableToModule: Record<string, string>;
  builtins: string[];
}

export interface PerfettoStdlibSymbolIndex {
  tableToModule: Map<string, string>;
  builtins: Set<string>;
  source: 'asset' | 'source' | 'empty';
}

// Path to the Perfetto stdlib directory.
//
// Source checkout:
//   backend/src/services -> ../../../perfetto/src/trace_processor/perfetto_sql/stdlib
// Legacy packaged npm CLI:
//   backend/dist/services -> ../perfetto-stdlib
//
// Keep this as a runtime getter so explicit environment overrides work even when
// the CLI loads .env after importing service modules.
export function getPerfettoStdlibPath(): string {
  const override = process.env.PERFETTO_STDLIB_PATH;
  if (override && override.trim()) return path.resolve(override);

  const packagedPath = path.resolve(__dirname, '../perfetto-stdlib');
  if (fs.existsSync(packagedPath)) return packagedPath;

  return path.resolve(
    __dirname,
    '../../../perfetto/src/trace_processor/perfetto_sql/stdlib',
  );
}

// Backward-compatible export for diagnostics. Runtime code should call
// getPerfettoStdlibPath() so env overrides and packaged assets are honored.
export const STDLIB_PATH = getPerfettoStdlibPath();

export const STDLIB_PRELUDE_DIR = 'prelude';

// Directories to exclude from scanning
// - prelude: Automatically loaded by Perfetto, should not be manually included
const EXCLUDED_DIRS = new Set(['prelude']);

// Match a stdlib symbol declaration: `CREATE [OR REPLACE] PERFETTO
// (TABLE|VIEW|FUNCTION|MACRO) <name>`. Anchored at the start of a line
// (after optional whitespace) and requires the `PERFETTO` keyword, which
// excludes inline-comment text and trace_processor-internal `CREATE TABLE _foo`
// helpers. INDEX is not a queryable name, so it is excluded.
const CREATE_REGEX =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PERFETTO\s+(?:TABLE|VIEW|FUNCTION|MACRO)\s+([A-Za-z_][A-Za-z0-9_]*)/gim;

function isInternalSymbol(name: string): boolean {
  return name.startsWith('_');
}

function relPathToModulePath(relPath: string): string {
  // e.g. "slices/self_dur.sql" -> "slices.self_dur"
  return relPath.replace(/\\/g, '/').replace(/\.sql$/, '').replace(/\//g, '.');
}

function parseSymbols(sql: string): string[] {
  const out: string[] = [];
  for (const match of sql.matchAll(CREATE_REGEX)) {
    const name = match[1];
    if (!isInternalSymbol(name)) out.push(name.toLowerCase());
  }
  return out;
}

function hasStdlibPathOverride(): boolean {
  return Boolean(process.env.PERFETTO_STDLIB_PATH?.trim());
}

export function getPerfettoStdlibSymbolAssetPath(): string {
  // Works from both backend/src/services (tsx) and backend/dist/services.
  return path.resolve(__dirname, '../../data/perfettoStdlibSymbols.json');
}

function loadPackagedStdlibSymbolAsset(): PerfettoStdlibSymbolAsset | null {
  const assetPath = getPerfettoStdlibSymbolAssetPath();
  if (!fs.existsSync(assetPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(assetPath, 'utf-8')) as Partial<PerfettoStdlibSymbolAsset>;
    if (
      parsed.version !== 1
      || !Array.isArray(parsed.modules)
      || !parsed.tableToModule
      || typeof parsed.tableToModule !== 'object'
      || !Array.isArray(parsed.builtins)
    ) {
      console.warn(`[StdlibScanner] Ignoring invalid stdlib symbol asset: ${assetPath}`);
      return null;
    }

    return {
      version: parsed.version,
      generatedAt: parsed.generatedAt,
      generatedFrom: parsed.generatedFrom,
      sourcePath: parsed.sourcePath,
      modules: parsed.modules,
      tableToModule: parsed.tableToModule as Record<string, string>,
      builtins: parsed.builtins,
    };
  } catch (error: any) {
    console.warn(`[StdlibScanner] Failed to read stdlib symbol asset ${assetPath}: ${error.message}`);
    return null;
  }
}

/**
 * Walk the stdlib directory tree and invoke `callback` for each `.sql`
 * file. Returns the absolute file path plus the path relative to
 * the resolved stdlib path (with native separators) so callers can derive their own
 * naming scheme. Shared between the module-name scanner here and
 * `sqlIncludeInjector` which needs to read SQL contents.
 */
export function walkStdlibSqlFiles(
  callback: (absPath: string, relPath: string) => void,
  options: { includePrelude?: boolean } = {},
): void {
  const stdlibPath = getPerfettoStdlibPath();
  if (!fs.existsSync(stdlibPath)) return;
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
        callback(abs, path.relative(stdlibPath, abs));
      }
    }
  };
  walk(stdlibPath);
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
  const stdlibPath = getPerfettoStdlibPath();
  if (!fs.existsSync(stdlibPath)) {
    console.warn(`[StdlibScanner] Stdlib path not found: ${stdlibPath}`);
    return [];
  }

  const startTime = Date.now();
  const modules = scanDirectory(stdlibPath);
  const elapsed = Date.now() - startTime;

  console.log(
    `[StdlibScanner] Scanned ${modules.length} modules in ${elapsed}ms from ${stdlibPath}`
  );

  return modules;
}

/**
 * Scans the live Perfetto stdlib source tree and extracts the full symbol
 * inventory used by sqlIncludeInjector. Runtime builds should prefer the
 * packaged JSON asset via getPerfettoStdlibSymbolIndex().
 */
export function scanPerfettoStdlibSymbolIndex(): PerfettoStdlibSymbolIndex {
  const tableToModule = new Map<string, string>();
  const builtins = new Set<string>();

  const stdlibPath = getPerfettoStdlibPath();
  if (!fs.existsSync(stdlibPath)) {
    console.warn(`[StdlibScanner] Stdlib path not found: ${stdlibPath}`);
    return { tableToModule, builtins, source: 'empty' };
  }

  const startTime = Date.now();
  walkStdlibSqlFiles((abs, rel) => {
    const isPrelude = rel.replace(/\\/g, '/').split('/')[0] === STDLIB_PRELUDE_DIR;
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      return;
    }

    const symbols = parseSymbols(content);
    if (symbols.length === 0) return;
    if (isPrelude) {
      for (const sym of symbols) builtins.add(sym);
      return;
    }

    const modulePath = relPathToModulePath(rel);
    for (const sym of symbols) {
      // First-writer wins. Stdlib should not double-define names; if it does,
      // the first parsed file owns the name.
      if (!tableToModule.has(sym)) tableToModule.set(sym, modulePath);
    }
  }, { includePrelude: true });

  const elapsed = Date.now() - startTime;
  console.log(
    `[StdlibScanner] Indexed ${tableToModule.size} stdlib symbols + ` +
    `${builtins.size} prelude builtins in ${elapsed}ms from ${stdlibPath}`
  );

  return { tableToModule, builtins, source: 'source' };
}

// Cache the module list to avoid repeated filesystem scans
let cachedModules: string[] | null = null;
let cachedSymbolIndex: PerfettoStdlibSymbolIndex | null = null;

/**
 * Gets the list of Perfetto stdlib modules, caching the result.
 * Runtime builds prefer the packaged symbol asset; source scanning is a fallback.
 *
 * @returns Array of module names
 */
export function getPerfettoStdlibModules(): string[] {
  if (cachedModules === null) {
    const asset = hasStdlibPathOverride() ? null : loadPackagedStdlibSymbolAsset();
    cachedModules = asset
      ? [...asset.modules].sort()
      : scanPerfettoStdlibModules();

    const source = asset ? 'asset' : 'source';
    console.log(`[StdlibScanner] Cached ${cachedModules.length} Perfetto stdlib modules from ${source}`);
  }
  return cachedModules;
}

/**
 * Gets the stdlib symbol index used for raw SQL auto-INCLUDE injection.
 * Runtime builds prefer the packaged asset so npm/Docker do not need the
 * perfetto submodule. PERFETTO_STDLIB_PATH forces live source scanning.
 */
export function getPerfettoStdlibSymbolIndex(): PerfettoStdlibSymbolIndex {
  if (cachedSymbolIndex) return cachedSymbolIndex;

  const asset = hasStdlibPathOverride() ? null : loadPackagedStdlibSymbolAsset();
  if (asset) {
    cachedSymbolIndex = {
      tableToModule: new Map(
        Object.entries(asset.tableToModule).map(([name, module]) => [name.toLowerCase(), module]),
      ),
      builtins: new Set(asset.builtins.map(name => name.toLowerCase())),
      source: 'asset',
    };
    console.log(
      `[StdlibScanner] Loaded ${cachedSymbolIndex.tableToModule.size} stdlib symbols + ` +
      `${cachedSymbolIndex.builtins.size} prelude builtins from asset`
    );
    return cachedSymbolIndex;
  }

  cachedSymbolIndex = scanPerfettoStdlibSymbolIndex();
  return cachedSymbolIndex;
}

/**
 * Clears the cached module list, forcing a rescan on next access.
 * Useful for testing or when the stdlib files may have changed.
 */
export function clearModuleCache(): void {
  cachedModules = null;
  cachedSymbolIndex = null;
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

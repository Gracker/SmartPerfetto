#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reports backend modules that only their own tests import.
 *
 * This is the mirror of `check-test-registration.mjs`. That check asks which
 * suites the gate cannot run; this one asks which modules the product no
 * longer runs while a registered suite still tests them. Both failures look
 * identical from `verify:pr` — everything green — and the second is the more
 * misleading, because a passing suite reads as proof that the behaviour works.
 *
 * `phaseHintMatcher.ts` sat in that state for over a week with 17 passing
 * tests after the commit that replaced prescribed plans removed its only call
 * site. The strategy field it served kept accepting authored content, and
 * Self-Evolution kept proposing patches to it, with no runtime effect.
 *
 * Deliberate exemptions:
 *   - re-export shims kept so documented import paths keep working
 *   - entrypoints a script or bin invokes rather than imports
 * A module is matched by its own source path, never by basename: a registered
 * *test* path in package.json would otherwise make its dead subject look alive,
 * which is exactly how the original instance stayed hidden.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(REPO_ROOT, 'backend');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'orphaned-modules-baseline.json');

/** A file this small that only re-exports is a compatibility shim, not logic. */
const SHIM_MAX_LINES = 12;

const isTestPath = path => path.includes('__tests__/') || path.endsWith('.test.ts');

/**
 * Only `src`, matching `listTestFiles`. Vendored trees and agent-runtime
 * working directories carry their own test files and would otherwise dominate
 * the report with dependencies this repository does not own.
 */
export function listModules(backendDir = BACKEND) {
  const modules = [];
  function visit(relative) {
    for (const entry of readdirSync(join(backendDir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        modules.push(path);
      }
    }
  }
  visit('src');
  return modules.sort();
}

/**
 * Relative specifiers only: a package import cannot reach a repository module.
 * `import\s+` covers side-effect imports (`import './envEntry';`), whose module
 * is used for what it does on evaluation rather than for a binding.
 */
const IMPORT_RE = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;

function resolve(fromFile, specifier, moduleSet) {
  const base = join(dirname(fromFile), specifier).replace(/\\/g, '/');
  for (const candidate of [base, `${base}/index`]) {
    for (const suffix of ['.ts', '']) {
      const path = `${candidate}${suffix}`;
      if (moduleSet.has(path)) return path;
      if (moduleSet.has(`${candidate}.ts`)) return `${candidate}.ts`;
    }
  }
  return undefined;
}

export function findOrphans(modules, scripts, backendDir = BACKEND) {
  const moduleSet = new Set(modules);
  const productionImporters = new Map();
  const testImporters = new Map();
  for (const module of modules) {
    const source = readFileSync(join(backendDir, module), 'utf8');
    const fromTest = isTestPath(module);
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolve(module, match[1], moduleSet);
      if (!target || target === module) continue;
      const bucket = fromTest ? testImporters : productionImporters;
      bucket.set(target, (bucket.get(target) ?? 0) + 1);
    }
  }
  // Match the module's own path, not its basename: a test path in a script
  // body must never vouch for the module it tests.
  const scriptBodies = Object.values(scripts).join(' ');
  const invokedByScript = module => scriptBodies.includes(module);

  return modules.filter(module => {
    if (isTestPath(module)) return false;
    if (productionImporters.get(module)) return false;
    if (!testImporters.get(module)) return false;
    if (invokedByScript(module)) return false;
    if (module.startsWith('src/scripts/') || module.endsWith('Cli.ts')) return false;
    const lines = readFileSync(join(backendDir, module), 'utf8').split('\n').length;
    if (lines <= SHIM_MAX_LINES) return false;
    return true;
  });
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { orphaned: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, 'update-baseline': { type: 'boolean', default: false } },
    strict: false,
  });

  const scripts = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')).scripts ?? {};
  const modules = listModules();
  const orphans = findOrphans(modules, scripts);

  if (values['update-baseline']) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      note: 'Backend modules only their own tests import. Each entry is behaviour the product does not run while a suite still vouches for it. Shrink this list; do not grow it.',
      generated: new Date().toISOString().slice(0, 10),
      orphaned: orphans,
    }, null, 2)}\n`);
    console.log(`Baseline updated: ${orphans.length} orphaned modules recorded.`);
    return 0;
  }

  const baseline = new Set(readBaseline().orphaned ?? []);
  const newlyOrphaned = orphans.filter(module => !baseline.has(module));
  const revived = Array.from(baseline).filter(module => !orphans.includes(module));

  if (values.json) {
    console.log(JSON.stringify({ totalModules: modules.length, orphaned: orphans.length, newlyOrphaned, baselineEntriesNowImported: revived }, null, 2));
  } else {
    console.log(`Backend modules: ${modules.length} total, ${orphans.length} imported only by their own tests.`);
    if (revived.length > 0) console.log(`\n${revived.length} baseline entries are imported again. Run with --update-baseline to record the progress.`);
    if (newlyOrphaned.length > 0) {
      console.log('\nThese modules are new debt — production no longer imports them, but a suite still tests them:');
      for (const module of newlyOrphaned) console.log(`  backend/${module}`);
      console.log('\nEither restore the call site, or delete the module and its suite.');
      console.log('A green suite over an unreachable module reports behaviour the product does not have.');
    }
  }

  return newlyOrphaned.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reports backend modules the product no longer runs.
 *
 * This is the mirror of `check-test-registration.mjs`. That check asks which
 * suites the gate cannot run; this one asks which modules the product no
 * longer runs while a registered suite may still test them. Both failures look
 * identical from `verify:pr` — everything green — and the second is the more
 * misleading, because a passing suite reads as proof that the behaviour works.
 *
 * `phaseHintMatcher.ts` sat in that state for over a week with 17 passing
 * tests after the commit that replaced prescribed plans removed its only call
 * site. The strategy field it served kept accepting authored content, and
 * Self-Evolution kept proposing patches to it, with no runtime effect.
 *
 * A module is orphaned when no live module imports it. That covers three
 * shapes, and the first alone hid the other two:
 *   - imported only by tests;
 *   - imported by nothing at all;
 *   - imported only by other orphans. An importer count cannot see this: a
 *     dead root keeps its whole subtree looking alive, and a suite over any
 *     module in that subtree still passes.
 * Liveness is reachability from the entrypoints, so modules that only import
 * each other in a cycle are orphaned too.
 *
 * Entrypoints: modules a `backend/package.json` script or bin, or tooling
 * under `backend/scripts/`, names by path (a `dist/<path>.js` command names
 * `src/<path>.ts`), and modules that tooling imports. Nothing is an
 * entrypoint by where it lives: an unregistered script under `src/scripts/`
 * is dead and keeps everything it imports looking alive. Harnesses and
 * helpers under `backend/tests/` count as tests. A sibling that names
 * `<stem>.js` or `<stem>.ts` (a worker or child process loaded by path) is
 * treated as importing that module, so a dead loader does not keep it alive.
 * Re-export shims (short files of nothing but `export ... from`) kept so
 * documented import paths keep working are never reported, but only a live
 * shim keeps its target alive.
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
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const RE_EXPORT_RE = /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g;
const isShim = source => source.split('\n').length <= SHIM_MAX_LINES
  && source.replace(COMMENT_RE, '').replace(RE_EXPORT_RE, '').trim() === '';

const isTestPath = path => path.startsWith('tests/')
  || path.includes('__tests__/')
  || path.includes('__mocks__/')
  || path.endsWith('.test.ts');

function listFiles(backendDir, root, accept) {
  const files = [];
  function visit(relative) {
    for (const entry of readdirSync(join(backendDir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        visit(path);
      } else if (entry.isFile() && !entry.name.endsWith('.d.ts') && accept(entry.name)) {
        files.push(path);
      }
    }
  }
  if (existsSync(join(backendDir, root))) visit(root);
  return files.sort();
}

/**
 * Only `src`: a module under `tests/` is test support, not product code.
 * Vendored trees and agent-runtime working directories carry their own test
 * files and would otherwise dominate the report with dependencies this
 * repository does not own.
 */
export function listModules(backendDir = BACKEND) {
  return listFiles(backendDir, 'src', name => name.endsWith('.ts'));
}

/** Relative specifiers only: a package import cannot reach a repository module. */
const IMPORT_RE = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;

function resolve(fromFile, specifier, moduleSet) {
  const base = join(dirname(fromFile), specifier).replace(/\\/g, '/');
  return [base, `${base}.ts`, `${base}/index.ts`].find(path => moduleSet.has(path));
}

const append = (map, key, value) => {
  if (map.has(key)) map.get(key).push(value);
  else map.set(key, [value]);
};

/** A quoted `<stem>.js` / `<stem>.ts`: a sibling module loaded by path. */
const PATH_LOAD_RE = /['"]([^'"/\\]+)\.[jt]s['"]/g;

/** Expands a `dist/<path>.js` command to also name its `src/<path>.ts` source. */
const nameSources = text => text.replace(/\bdist\/([\w/.-]+)\.js\b/g, (command, path) => `${command} src/${path}.ts`);

/**
 * Walks the backend import graph from its entrypoints.
 *
 * `entrypoints` maps each module the product invokes rather than imports to
 * `{reason, via}`: `via` is the backend-relative file whose presence makes it
 * an entrypoint — the module itself, or the build-tooling file that imports
 * it. Live path-loaded modules are included too: nothing imports them, so a
 * symbol-level analysis must start from them as well.
 */
export function analyzeModuleGraph(modules, commands, backendDir = BACKEND) {
  const moduleSet = new Set(modules);
  const tooling = ['scripts', 'tests'].flatMap(root => listFiles(backendDir, root, name => /\.[cm]?[jt]s$/.test(name)));
  // Match the module's own path, not its basename: a test path in a script
  // body must never vouch for the module it tests.
  const namers = [
    { reason: 'named by a backend/package.json command', text: nameSources(commands.join(' ')) },
    ...tooling.filter(file => file.startsWith('scripts/')).map(file => ({
      reason: `named by backend/${file}`,
      text: nameSources(readFileSync(join(backendDir, file), 'utf8')),
    })),
  ];
  const entrypoints = new Map();
  for (const module of modules) {
    if (isTestPath(module)) continue;
    const namer = namers.find(({ text }) => text.includes(module));
    if (namer) entrypoints.set(module, { reason: namer.reason, via: module });
  }

  const importedBy = new Map();
  const imports = new Map();
  const pathLoadedBy = new Map();
  const testImported = new Set();
  const shims = new Set();
  for (const file of [...modules, ...tooling]) {
    const source = readFileSync(join(backendDir, file), 'utf8');
    const fromModule = moduleSet.has(file);
    if (fromModule && isShim(source)) shims.add(file);
    const targets = Array.from(source.matchAll(IMPORT_RE), match => resolve(file, match[1], moduleSet));
    if (fromModule && !isTestPath(file)) {
      for (const match of source.matchAll(PATH_LOAD_RE)) {
        const target = `${dirname(file)}/${match[1]}.ts`;
        targets.push(target);
        if (moduleSet.has(target) && target !== file) append(pathLoadedBy, target, file);
      }
    }
    for (const target of targets) {
      if (!target || target === file || !moduleSet.has(target)) continue;
      if (isTestPath(file)) testImported.add(target);
      else if (!fromModule) {
        if (!entrypoints.has(target)) entrypoints.set(target, { reason: `imported by backend/${file}`, via: file });
      } else {
        append(importedBy, target, file);
        append(imports, file, target);
      }
    }
  }

  const live = new Set(entrypoints.keys());
  for (const pending = [...live]; pending.length > 0;) {
    for (const target of imports.get(pending.pop()) ?? []) {
      if (!live.has(target)) { live.add(target); pending.push(target); }
    }
  }
  for (const [target, loaders] of pathLoadedBy) {
    const loader = loaders.find(file => live.has(file));
    if (loader && !entrypoints.has(target)) entrypoints.set(target, { reason: `loaded by path from backend/${loader}`, via: target });
  }

  return { entrypoints, live, importedBy, testImported, shims };
}

/**
 * Returns each orphaned module with the reason it is unreachable:
 * `tests-only`, `unreferenced`, or `orphaned-importers` (with `importers`).
 */
export function analyzeOrphans(modules, commands, backendDir = BACKEND) {
  const { live, importedBy, testImported, shims } = analyzeModuleGraph(modules, commands, backendDir);
  const report = new Map();
  for (const module of modules) {
    if (live.has(module) || isTestPath(module) || shims.has(module)) continue;
    const importers = Array.from(new Set(importedBy.get(module))).sort();
    if (importers.length > 0) report.set(module, { reason: 'orphaned-importers', importers });
    else report.set(module, { reason: testImported.has(module) ? 'tests-only' : 'unreferenced' });
  }
  return report;
}

const describe = ({ reason, importers }) => {
  if (reason === 'tests-only') return 'imported only by tests';
  if (reason === 'unreferenced') return 'imported by nothing';
  return `imported only by orphaned ${importers.map(path => `backend/${path}`).join(', ')}`;
};

/** The commands `backend/package.json` runs: its scripts and its bin targets. */
export function readEntrypointCommands(backendDir = BACKEND) {
  const manifest = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8'));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  return [...Object.values(manifest.scripts ?? {}), ...bins];
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { orphaned: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

/** `added`: findings outside the accepted baseline; `resolved`: baseline entries no longer found. */
export function compareWithBaseline(findings, baselineEntries) {
  const current = new Set(findings);
  const baseline = new Set(baselineEntries);
  return {
    added: findings.filter(entry => !baseline.has(entry)),
    resolved: baselineEntries.filter(entry => !current.has(entry)),
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, 'update-baseline': { type: 'boolean', default: false } },
    strict: false,
  });

  const modules = listModules();
  const report = analyzeOrphans(modules, readEntrypointCommands());
  const orphans = Array.from(report.keys());

  if (values['update-baseline']) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      note: 'Backend modules no live module imports: imported only by tests, by nothing, or only by other orphans. Each entry is behaviour the product does not run, and any suite over it vouches for nothing. Shrink this list; do not grow it.',
      generated: new Date().toISOString().slice(0, 10),
      orphaned: orphans,
    }, null, 2)}\n`);
    console.log(`Baseline updated: ${orphans.length} orphaned modules recorded.`);
    return 0;
  }

  const { added: newlyOrphaned, resolved: revived } = compareWithBaseline(orphans, readBaseline().orphaned ?? []);

  if (values.json) {
    console.log(JSON.stringify({ totalModules: modules.length, orphaned: orphans.length, newlyOrphaned, baselineEntriesNowImported: revived }, null, 2));
  } else {
    console.log(`Backend modules: ${modules.length} total, ${orphans.length} not imported by any live module.`);
    if (revived.length > 0) console.log(`\n${revived.length} baseline entries are imported again. Run with --update-baseline to record the progress.`);
    if (newlyOrphaned.length > 0) {
      console.log('\nThese modules are new debt — no live module imports them:');
      for (const module of newlyOrphaned) console.log(`  backend/${module} (${describe(report.get(module))})`);
      console.log('\nEither restore the call site, or delete the module and its suite.');
      console.log('A green suite over an unreachable module reports behaviour the product does not have.');
    }
  }

  return newlyOrphaned.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

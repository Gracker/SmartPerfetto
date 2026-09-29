#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reports backend exports that no production code uses.
 *
 * `check-orphaned-modules.mjs` judges reachability per module, so a module
 * that stays reachable for one symbol hides every other export it carries:
 * three runtimes imported `quickDirectResult` for a single counter while its
 * whole acknowledgement direct-answer chain had no production caller. The
 * manual fallback, `rg -w <symbol>`, is a text match and misses a dead export
 * whenever another file defines a same-named local — `createHypothesisId` and
 * `isStringArray` survived a sweep that way.
 *
 * This check resolves symbols through knip in production mode. Production
 * entries are the `!` patterns of the backend workspace in `knip.json`; they
 * must cover every entrypoint the orphan check derives, which this script
 * verifies before trusting the report. Tests are not production entries, so an
 * export only a test imports counts as unused. A use inside the declaring file
 * counts as a use (`ignoreExportsUsedInFile`): such an export is a test seam or
 * an over-broad `export`, not dead code. Exports of entry files and of modules
 * the orphan check already reports are outside this report.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeModuleGraph, compareWithBaseline, listModules, readEntrypointCommands } from './check-orphaned-modules.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'unused-exports-baseline.json');
const WORKSPACE = 'backend';

/**
 * Runs knip over `directory` and returns `path#name` for every unused export
 * and exported type, with paths relative to `workspace` when one is given.
 */
export function runKnip({ directory = REPO_ROOT, workspace = WORKSPACE } = {}) {
  const knipDir = join(REPO_ROOT, 'node_modules', 'knip');
  const { bin } = JSON.parse(readFileSync(join(knipDir, 'package.json'), 'utf8'));
  const args = [join(knipDir, bin.knip),
    '--production', '--include', 'exports,types', '--reporter', 'json',
    '--no-config-hints', '--no-progress'];
  if (workspace) args.push('--workspace', workspace);
  // `--directory` still resolves the configuration from the caller's cwd.
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // knip exits 1 when it reports issues and 2 when it fails itself.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`knip failed (exit ${result.status}): ${result.error ?? result.stderr}`);
  }
  return parseKnipReport(result.stdout, workspace);
}

export function parseKnipReport(stdout, workspace) {
  const prefix = workspace ? `${workspace}/` : '';
  const findings = new Set();
  for (const issue of JSON.parse(stdout).issues ?? []) {
    const file = issue.file.replace(/\\/g, '/');
    const path = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    for (const { name } of [...(issue.exports ?? []), ...(issue.types ?? [])]) findings.add(`${path}#${name}`);
  }
  return Array.from(findings).sort();
}

/**
 * Drift between knip.json's production entries and the orphan check's
 * entrypoints. `uncovered`: entrypoints whose `via` file no `!` pattern
 * matches; knip would read everything only they reach as unused. `stale`:
 * modules a `!` pattern matches that are not entrypoints, and exact paths that
 * no longer exist; knip would keep everything only they reach looking used.
 */
export function findEntryDrift(entrypoints, modules, knipConfig, workspace = WORKSPACE) {
  const globs = (knipConfig.workspaces?.[workspace]?.entry ?? [])
    .filter(pattern => pattern.endsWith('!'))
    .map(pattern => pattern.slice(0, -1));
  const vias = new Set(Array.from(entrypoints.values(), ({ via }) => via));
  const moduleSet = new Set(modules);
  return {
    uncovered: Array.from(entrypoints)
      .filter(([, { via }]) => !globs.some(glob => posix.matchesGlob(via, glob)))
      .map(([module, { reason }]) => ({ module, reason })),
    stale: [
      ...modules.filter(module => !entrypoints.has(module) && globs.some(glob => posix.matchesGlob(module, glob))),
      ...globs.filter(glob => !/[*?[{]/.test(glob) && !moduleSet.has(glob) && !vias.has(glob)),
    ],
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, 'update-baseline': { type: 'boolean', default: false } },
    strict: false,
  });

  const knipConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'knip.json'), 'utf8'));
  const modules = listModules();
  const { entrypoints } = analyzeModuleGraph(modules, readEntrypointCommands());
  const { uncovered, stale } = findEntryDrift(entrypoints, modules, knipConfig);
  if (uncovered.length > 0) {
    console.log('knip.json does not mark these backend entrypoints as production entries (`!`):');
    for (const { module, reason } of uncovered) console.log(`  backend/${module} (${reason})`);
    console.log('Add them to workspaces.backend.entry with a trailing `!`; otherwise everything only they use reads as unused.\n');
  }
  if (stale.length > 0) {
    console.log('knip.json marks these paths as production entries, but no command or tooling invokes them:');
    for (const path of stale) console.log(`  backend/${path}`);
    console.log('Remove them from workspaces.backend.entry; otherwise everything only they use reads as used.\n');
  }
  if (uncovered.length > 0 || stale.length > 0) return 1;

  const findings = runKnip();

  if (values['update-baseline']) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      note: 'Backend exports no production module uses, in or outside its own file: used only by tests, or by nothing, including barrel re-exports nothing imports through the barrel. Each entry is accepted debt, and a suite over it vouches for nothing the product does. Shrink this list; do not grow it.',
      generated: new Date().toISOString().slice(0, 10),
      unusedExports: findings,
    }, null, 2)}\n`);
    console.log(`Baseline updated: ${findings.length} unused exports recorded.`);
    return 0;
  }

  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).unusedExports ?? [] : [];
  const { added, resolved } = compareWithBaseline(findings, baseline);

  if (values.json) {
    console.log(JSON.stringify({ unused: findings.length, newlyUnused: added, baselineEntriesNowUsed: resolved }, null, 2));
  } else {
    console.log(`Backend exports: ${findings.length} not used by any production module.`);
    if (resolved.length > 0) console.log(`\n${resolved.length} baseline entries are used or gone. Run with --update-baseline to record the progress.`);
    if (added.length > 0) {
      console.log('\nThese exports are new debt — no production module uses them (tests do not count):');
      for (const entry of added) console.log(`  backend/${entry.replace('#', ': ')}`);
      console.log('\nDelete the export, and the symbol when nothing else in its file uses it.');
      console.log('A deliberate test seam into live code may be tagged `/** @internal */` instead.');
    }
  }

  return added.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

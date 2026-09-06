#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reports backend test files that no `test:*` / `verify:*` script can reach.
 *
 * Two repository facts make an unregistered suite invisible rather than merely
 * unrun: `tsconfig.json` excludes `**\/*.test.ts`, so `npm run typecheck` cannot
 * see a type break inside one, and the `test:*` scripts name their targets file
 * by file, so a new suite joins the gate only if someone remembers to add it.
 * A suite can therefore be broken for months while `verify:pr` stays green.
 *
 * This check does not try to register anything. It answers one question — which
 * suites is the gate unable to run — and ratchets: the current debt lives in a
 * committed baseline, and anything not in that baseline fails. Removing a file
 * from the baseline is how the debt shrinks; the check refuses to let it grow.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(REPO_ROOT, 'backend');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'test-registration-baseline.json');

/** Script name prefixes whose bodies can put a suite in front of Jest. */
const GATE_SCRIPT_PREFIXES = ['test:', 'verify:'];

/**
 * Every backend suite Jest could be pointed at.
 *
 * `_unittest.ts` is included because the frontend-style naming appears in
 * `src/tests/`; both suffixes are real suites the gate should be able to run.
 */
export function listTestFiles(backendDir = BACKEND) {
  const out = execFileSync(
    'find',
    ['src', '-name', '*.test.ts', '-o', '-name', '*_unittest.ts'],
    { cwd: backendDir, encoding: 'utf8' },
  );
  return out.split('\n').map(line => line.trim()).filter(Boolean).sort();
}

/**
 * What the gate scripts actually target.
 *
 * A script body names either a concrete `.ts` path or a directory prefix; both
 * are how Jest is pointed at suites here, so both count as reachable. Matching
 * on the full path rather than the basename keeps two same-named suites in
 * different directories from vouching for each other.
 */
export function collectGateTargets(scripts) {
  const files = new Set();
  const dirs = new Set();
  for (const [name, body] of Object.entries(scripts)) {
    if (!GATE_SCRIPT_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    for (const match of String(body).matchAll(/src\/[A-Za-z0-9_.\/-]+/g)) {
      const target = match[0];
      if (target.endsWith('.ts')) files.add(target);
      else dirs.add(target.replace(/\/+$/, ''));
    }
  }
  return { files, dirs };
}

export function findUnreachable(testFiles, { files, dirs }) {
  return testFiles.filter(file => {
    if (files.has(file)) return false;
    return !Array.from(dirs).some(dir => file === dir || file.startsWith(`${dir}/`));
  });
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { unregistered: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      'update-baseline': { type: 'boolean', default: false },
    },
    strict: false,
  });

  const scripts = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')).scripts ?? {};
  const testFiles = listTestFiles();
  const unreachable = findUnreachable(testFiles, collectGateTargets(scripts));

  if (values['update-baseline']) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({
        note: 'Backend suites no test:*/verify:* script can reach. Shrink this list; do not grow it. Regenerate only when deliberately accepting new debt.',
        generated: new Date().toISOString().slice(0, 10),
        unregistered: unreachable,
      }, null, 2)}\n`,
    );
    console.log(`Baseline updated: ${unreachable.length} unregistered suites recorded.`);
    return 0;
  }

  const baseline = new Set(readBaseline().unregistered ?? []);
  const newlyUnregistered = unreachable.filter(file => !baseline.has(file));
  const fixed = Array.from(baseline).filter(file => !unreachable.includes(file));

  if (values.json) {
    console.log(JSON.stringify({
      totalTestFiles: testFiles.length,
      reachable: testFiles.length - unreachable.length,
      unreachable: unreachable.length,
      newlyUnregistered,
      baselineEntriesNowRegistered: fixed,
    }, null, 2));
  } else {
    console.log(`Backend suites: ${testFiles.length} total, ${testFiles.length - unreachable.length} reachable from a gate script, ${unreachable.length} not.`);
    if (fixed.length > 0) {
      console.log(`\n${fixed.length} baseline entries are now registered. Run with --update-baseline to record the progress.`);
    }
    if (newlyUnregistered.length > 0) {
      console.log('\nThese suites are new debt — no gate script can run them:');
      for (const file of newlyUnregistered) console.log(`  backend/${file}`);
      console.log('\nRegister each in the matching test:* script (see .claude/rules/testing.md),');
      console.log('or add a directory-scoped test:<subsystem> script wired into test:gate.');
    }
  }

  return newlyUnregistered.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

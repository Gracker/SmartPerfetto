#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reports backend test files that `npm run verify:pr` cannot reach.
 *
 * Two repository facts make an unregistered suite invisible rather than merely
 * unrun: `tsconfig.json` excludes `**\/*.test.ts`, so `npm run typecheck` cannot
 * see a type break inside one, and the `test:*` scripts name their targets file
 * by file, so a new suite joins the gate only if someone remembers to add it.
 * A suite can therefore be broken for months while `verify:pr` stays green.
 *
 * This check does not try to register anything. It answers one question — which
 * suites is the gate unable to run — and ratchets against a committed baseline:
 * anything outside that baseline fails. The baseline is currently empty, so the
 * check is zero-tolerance; it exists so the check could be introduced without
 * failing on 237 files at once, not as a parking space for new debt.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(REPO_ROOT, 'backend');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'test-registration-baseline.json');

/** Script name prefixes whose bodies can put a suite in front of Jest. */
const GATE_SCRIPT_PREFIXES = ['test:', 'verify:'];

/**
 * The file names Jest treats as suites: `jest.config.js` matches
 * `(spec|test|eval).ts`, and `_unittest.ts` is the frontend-style naming in
 * `src/tests/`. An `.eval.ts` suite is as real as a `.test.ts` one.
 */
const SUITE_NAME = /(\.test|\.spec|\.eval|_unittest)\.ts$/;

/**
 * Every backend suite Jest could be pointed at, under `src/` and `tests/`;
 * both roots must exist. Non-suite `.ts` files under `__tests__/` (fixtures a
 * suite imports) match Jest's testMatch but are not suites: pointing Jest at
 * one fails with "must contain at least one test", so they are not listed.
 */
export function listTestFiles(backendDir = BACKEND) {
  const files = [];
  function visit(relative) {
    for (const entry of readdirSync(join(backendDir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(path);
      } else if (entry.isFile() && SUITE_NAME.test(entry.name)) {
        files.push(path);
      }
    }
  }
  visit('src');
  visit('tests');
  return files.sort();
}

/**
 * The backend scripts `npm run verify:pr` at the repository root runs, followed
 * through `npm run <name>` and `npm --prefix backend run <name>` references.
 * A `test:*` script nothing in that chain runs (`test:unit`, `test:integration`,
 * `test:skill-eval`) is not a gate: its suites can rot while the gate stays green.
 */
export function gateScriptNames(backendScripts, rootScripts, entry = 'verify:pr') {
  const packages = { root: rootScripts, backend: backendScripts };
  const reached = new Set();
  const missing = [];
  const pending = [['root', entry]];
  while (pending.length > 0) {
    const [where, name] = pending.pop();
    const key = `${where}:${name}`;
    if (reached.has(key)) continue;
    if (!Object.hasOwn(packages[where], name)) {
      missing.push(key);
      continue;
    }
    reached.add(key);
    // `cd backend && npm run x` runs the backend script for the rest of the
    // chain, until a `cd ..` returns to the root.
    // A directory outside both packages runs another package's scripts.
    let here = where;
    for (const command of commandsOf(packages[where][name])) {
      const cd = /^cd\s+(\S+)/.exec(command);
      if (cd) {
        here = packageAt(here, cd[1]);
        continue;
      }
      const run = parseNpmRun(command);
      const target = run && (run.prefix === undefined ? here : packageAt(here, run.prefix));
      if (target) pending.push([target, run.script]);
    }
  }
  if (missing.length > 0) throw new Error(`verify:pr runs scripts that do not exist: ${missing.join(', ')}`);
  return new Set([...reached].filter(key => key.startsWith('backend:')).map(key => key.slice('backend:'.length)));
}

/**
 * The package (`root` or `backend`) a directory names from the package `here`,
 * or undefined for any other directory or an unknown `here`.
 */
function packageAt(here, dir) {
  if (here === undefined) return undefined;
  const at = here === 'backend' ? ['backend'] : [];
  for (const part of dir.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') at.push(part);
    else if (at.pop() === undefined) return undefined;
  }
  const path = at.join('/');
  return path === '' ? 'root' : path === 'backend' ? 'backend' : undefined;
}

/**
 * The script an `npm run` / `npm test` command runs and its `--prefix`
 * directory, after leading environment assignments (`X=1 npm run a`), with
 * `--prefix` in either spelling and run flags such as `-s`, `--silent` or
 * `--if-present`; undefined for any other command.
 */
export function parseNpmRun(command) {
  const words = command.split(/\s+/);
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at++;
  if (words[at] !== 'npm') return undefined;
  let prefix;
  for (at++; at < words.length; at++) {
    const word = words[at];
    const option = /^--prefix(?:=(.*))?$/.exec(word);
    if (option) {
      prefix = option[1] ?? words[++at] ?? '';
      continue;
    }
    if (word.startsWith('-')) continue;
    const found = (script) => (prefix === undefined ? { script } : { prefix, script });
    if (word === 'test' || word === 't') return found('test');
    if (word !== 'run' && word !== 'run-script') return undefined;
    for (at++; at < words.length && words[at].startsWith('-'); at++);
    return words[at] ? found(words[at]) : undefined;
  }
  return undefined;
}

/** The commands of a script body, split on `&&`, `||` and `;`. */
function commandsOf(body) {
  return String(body).split(/&&|\|\||;/).map(command => command.trim()).filter(Boolean);
}

/**
 * What the gate scripts actually target.
 *
 * A script body names either a concrete `.ts` path or a directory prefix; both
 * are how Jest is pointed at suites here, so both count as reachable. Matching
 * on the full path rather than the basename keeps two same-named suites in
 * different directories from vouching for each other.
 */
export function collectGateTargets(scripts, gateNames) {
  const files = new Set();
  const dirs = new Set();
  for (const [name, body] of Object.entries(scripts)) {
    const isGate = gateNames ? gateNames.has(name) : GATE_SCRIPT_PREFIXES.some(prefix => name.startsWith(prefix));
    if (!isGate) continue;
    // Only a Jest command puts a suite in front of Jest; `tsc src/x.test.ts`
    // or `tsx tests/runner.ts` in the same chain does not.
    const jestCommands = commandsOf(body).filter(command => /(^|\s)(npx\s+)?jest(\s|$)/.test(command));
    for (const match of jestCommands.join(' ').matchAll(/(?<![\w/])(?:src|tests)\/[A-Za-z0-9_.\/-]+/g)) {
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
  const rootScripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {};
  const testFiles = listTestFiles();
  const unreachable = findUnreachable(testFiles, collectGateTargets(scripts, gateScriptNames(scripts, rootScripts)));

  if (values['update-baseline']) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({
        note: 'Backend suites npm run verify:pr cannot reach. Shrink this list; do not grow it. Regenerate only when deliberately accepting new debt.',
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
    console.log(`Backend suites: ${testFiles.length} total, ${testFiles.length - unreachable.length} reachable from verify:pr, ${unreachable.length} not.`);
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

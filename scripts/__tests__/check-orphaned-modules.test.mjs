// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { analyzeOrphans, listModules } from '../check-orphaned-modules.mjs';

/** Analyzes a throwaway backend tree built from `files`. */
function analyze(files, scripts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orphan-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return analyzeOrphans(listModules(root), scripts, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const longBody = extra => `${'// filler\n'.repeat(20)}${extra}`;
const orphans = report => Array.from(report.keys()).sort();

test('reports a module that only its own test imports', () => {
  const report = analyze({
    'src/live.ts': longBody('export const live = 1;\n'),
    'src/dead.ts': longBody('export const dead = 1;\n'),
    'src/app.ts': longBody("import {live} from './live';\nexport default live;\n"),
    'src/__tests__/dead.test.ts': "import {dead} from '../dead';\nexport default dead;\n",
    'src/__tests__/live.test.ts': "import {live} from '../live';\nexport default live;\n",
  }, { start: 'tsx src/app.ts' });
  assert.deepEqual(orphans(report), ['src/dead.ts']);
});

// The original instance hid exactly here: the dead module's *test* was
// registered in a gate script, so any basename match would have cleared it.
test('a registered test path does not vouch for the module it tests', () => {
  const report = analyze({
    'src/dead.ts': longBody('export const dead = 1;\n'),
    'src/__tests__/dead.test.ts': "import {dead} from '../dead';\nexport default dead;\n",
  }, { 'test:unit': 'jest src/__tests__/dead.test.ts' });
  assert.deepEqual(orphans(report), ['src/dead.ts']);
});

test('exempts re-export shims and script-invoked entrypoints', () => {
  const report = analyze({
    'src/shim.ts': "export * from './real';\n",
    'src/real.ts': longBody('export const real = 1;\n'),
    'src/entry.ts': longBody("import {real} from './real';\nexport const entry = real;\n"),
    'src/scripts/tool.ts': longBody('export const tool = 1;\n'),
    'src/__tests__/all.test.ts': "import '../shim';\nimport '../entry';\nimport '../scripts/tool';\nimport '../real';\n",
  }, { start: 'tsx src/entry.ts' });
  assert.deepEqual(orphans(report), []);
});

// Size alone does not make a shim: a short loader or helper is still logic.
test('only short files of nothing but re-exports count as shims', () => {
  const report = analyze({
    'src/shim.ts': "// compat path\nexport * from './real';\nexport type {Real} from './real';\n",
    'src/loader.ts': "require('./child.cjs');\n",
    'src/tiny.ts': 'export const tiny = 1;\n',
    'src/real.ts': longBody('export const real = 1;\n'),
    'src/app.ts': longBody("import {real} from './real';\nexport default real;\n"),
  }, { start: 'tsx src/app.ts' });
  assert.deepEqual(orphans(report), ['src/loader.ts', 'src/tiny.ts']);
});

// An importer count keeps a dead root's whole subtree alive: `leaf` has a
// production importer, but that importer is itself only reachable from tests.
test('reports modules imported only by other orphans, transitively', () => {
  const report = analyze({
    'src/app.ts': longBody("import {live} from './live';\nexport default live;\n"),
    'src/live.ts': longBody('export const live = 1;\n'),
    'src/deadRoot.ts': longBody("import {mid} from './mid';\nexport default mid;\n"),
    'src/mid.ts': longBody("import {leaf} from './leaf';\nexport const mid = leaf;\n"),
    'src/leaf.ts': longBody("import {live} from './live';\nexport const leaf = live;\n"),
    'src/__tests__/deadRoot.test.ts': "import '../deadRoot';\nimport '../app';\n",
  }, { start: 'tsx src/app.ts' });
  assert.deepEqual(orphans(report), ['src/deadRoot.ts', 'src/leaf.ts', 'src/mid.ts']);
  assert.deepEqual(report.get('src/deadRoot.ts'), { reason: 'tests-only' });
  assert.deepEqual(report.get('src/leaf.ts'), { reason: 'orphaned-importers', importers: ['src/mid.ts'] });
});

test('reports modules that only import each other in a cycle', () => {
  const report = analyze({
    'src/app.ts': longBody('export default 1;\n'),
    'src/ping.ts': longBody("import {pong} from './pong';\nexport const ping = pong;\n"),
    'src/pong.ts': longBody("import {ping} from './ping';\nexport const pong = ping;\n"),
  }, { start: 'tsx src/app.ts' });
  assert.deepEqual(orphans(report), ['src/ping.ts', 'src/pong.ts']);
});

test('reports modules nothing imports, including a dead barrel\'s targets', () => {
  const report = analyze({
    'src/unused.ts': longBody('export const unused = 1;\n'),
    'src/barrel/index.ts': "export * from './a';\nexport * from './b';\n",
    'src/barrel/a.ts': longBody('export const a = 1;\n'),
    'src/barrel/b.ts': longBody('export const b = 1;\n'),
    'src/app.ts': longBody("import {b} from './barrel/b';\nexport default b;\n"),
  }, { start: 'tsx src/app.ts' });
  // The barrel is a shim and is not reported itself, but it keeps nothing alive.
  assert.deepEqual(orphans(report), ['src/barrel/a.ts', 'src/unused.ts']);
  assert.deepEqual(report.get('src/unused.ts'), { reason: 'unreferenced' });
});

test('path-loaded workers, build tooling and test harnesses are classified by their role', () => {
  const report = analyze({
    'src/pool.ts': longBody("const entry = path.join(__dirname, 'worker.js');\nexport default entry;\n"),
    'src/worker.ts': longBody("import {helper} from './helper';\nexport default helper;\n"),
    'src/helper.ts': longBody('export const helper = 1;\n'),
    'src/deadPool.ts': longBody("const entry = path.join(__dirname, 'deadWorker.ts');\nexport default entry;\n"),
    'src/deadWorker.ts': longBody('export default 1;\n'),
    'src/generated.ts': longBody('export const generated = 1;\n'),
    'src/harnessOnly.ts': longBody('export const harnessOnly = 1;\n'),
    'scripts/generate.ts': "import {generated} from '../src/generated';\nconsole.log(generated);\n",
    'tests/eval/runner.ts': "import {harnessOnly} from '../../src/harnessOnly';\nconsole.log(harnessOnly);\n",
  }, { start: 'tsx src/pool.ts' });
  assert.deepEqual(orphans(report), ['src/deadPool.ts', 'src/deadWorker.ts', 'src/harnessOnly.ts']);
  assert.deepEqual(report.get('src/harnessOnly.ts'), { reason: 'tests-only' });
  assert.deepEqual(report.get('src/deadWorker.ts'), { reason: 'orphaned-importers', importers: ['src/deadPool.ts'] });
});

test('can be imported without a script path in argv', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../check-orphaned-modules.mjs', import.meta.url).href)});`]);
  assert.equal(result.status, 0, result.stderr.toString());
});

test('the repository stays at or below its recorded baseline', () => {
  const baseline = JSON.parse(readFileSync(new URL('../orphaned-modules-baseline.json', import.meta.url), 'utf8'));
  const scripts = JSON.parse(readFileSync(new URL('../../backend/package.json', import.meta.url), 'utf8')).scripts;
  const added = orphans(analyzeOrphans(listModules(), scripts)).filter(module => !baseline.orphaned.includes(module));
  assert.deepEqual(added, [], `new orphaned modules: ${added.join(', ')}`);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { findOrphans, listModules } from '../check-orphaned-modules.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'orphan-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const longBody = extra => `${'// filler\n'.repeat(20)}${extra}`;

test('reports a module that only its own test imports', () => {
  const root = fixture({
    'src/live.ts': longBody('export const live = 1;\n'),
    'src/dead.ts': longBody('export const dead = 1;\n'),
    'src/app.ts': longBody("import {live} from './live';\nexport default live;\n"),
    'src/__tests__/dead.test.ts': "import {dead} from '../dead';\nexport default dead;\n",
    'src/__tests__/live.test.ts': "import {live} from '../live';\nexport default live;\n",
  });
  try {
    assert.deepEqual(findOrphans(listModules(root), {}, root), ['src/dead.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a side-effect import is a production import', () => {
  const root = fixture({
    'src/envEntry.ts': longBody('process.env.READY = "1";\n'),
    'src/bin.ts': longBody("import './envEntry';\n"),
    'src/__tests__/envEntry.test.ts': "require('../envEntry');\n",
  });
  try {
    assert.deepEqual(findOrphans(listModules(root), {}, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The original instance hid exactly here: the dead module's *test* was
// registered in a gate script, so any basename match would have cleared it.
test('a registered test path does not vouch for the module it tests', () => {
  const root = fixture({
    'src/dead.ts': longBody('export const dead = 1;\n'),
    'src/__tests__/dead.test.ts': "import {dead} from '../dead';\nexport default dead;\n",
  });
  const scripts = { 'test:unit': 'jest src/__tests__/dead.test.ts' };
  try {
    assert.deepEqual(findOrphans(listModules(root), scripts, root), ['src/dead.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exempts re-export shims and script-invoked entrypoints', () => {
  const root = fixture({
    'src/shim.ts': "export * from './real';\n",
    'src/real.ts': longBody('export const real = 1;\n'),
    'src/entry.ts': longBody('export const entry = 1;\n'),
    'src/scripts/tool.ts': longBody('export const tool = 1;\n'),
    'src/__tests__/all.test.ts': "import '../shim';\nimport '../entry';\nimport '../scripts/tool';\nimport '../real';\n",
  });
  const scripts = { start: 'tsx src/entry.ts' };
  try {
    assert.deepEqual(findOrphans(listModules(root), scripts, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the repository stays at or below its recorded baseline', async () => {
  const { readFileSync } = await import('node:fs');
  const baseline = JSON.parse(readFileSync(new URL('../orphaned-modules-baseline.json', import.meta.url), 'utf8'));
  const scripts = JSON.parse(readFileSync(new URL('../../backend/package.json', import.meta.url), 'utf8')).scripts;
  const orphans = findOrphans(listModules(), scripts);
  const added = orphans.filter(module => !baseline.orphaned.includes(module));
  assert.deepEqual(added, [], `new orphaned modules: ${added.join(', ')}`);
});

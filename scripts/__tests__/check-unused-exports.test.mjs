// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { findEntryDrift, parseKnipReport, runKnip } from '../check-unused-exports.mjs';

/** Runs the real knip over a throwaway project built from `files`. */
function knipFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'unused-exports-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return runKnip({ directory: root, workspace: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// The 2026-09-29 sweep missed `createHypothesisId` and `isStringArray` because
// `rg -w` also matched a same-named local elsewhere. The gate must resolve the
// symbol, and must treat a test import as no production use.
test('reports exports only tests use, even when another file has a same-named local', () => {
  const findings = knipFixture({
    'package.json': '{"name":"fixture","private":true}',
    'knip.json': JSON.stringify({
      entry: ['src/app.ts!', 'src/**/__tests__/**/*.ts'],
      project: ['src/**/*.ts!'],
      ignoreExportsUsedInFile: true,
    }),
    'src/lib.ts': [
      'export function used() { return 1; }',
      'export function deadButTested() { return 2; }',
      'export const inFile = 3;',
      'export const viaInFile = inFile + 1;',
      '/** @internal */',
      'export function taggedSeam() { return 4; }',
      'export type DeadType = { a: number };',
      'export interface SignatureType { b: number }',
      'export function takesSignature(value: SignatureType) { return value.b; }',
      '',
    ].join('\n'),
    'src/other.ts': "function deadButTested() { return 'local'; }\nexport const other = deadButTested();\n",
    'src/app.ts': "import { used, viaInFile, takesSignature } from './lib';\nimport { other } from './other';\n"
      + 'console.log(used(), viaInFile, other, takesSignature({ b: 1 }));\n',
    'src/__tests__/lib.test.ts': "import { deadButTested, taggedSeam } from '../lib';\nconsole.log(deadButTested(), taggedSeam());\n",
  });
  assert.deepEqual(findings, ['src/lib.ts#DeadType', 'src/lib.ts#deadButTested']);
});

test('parses knip JSON into workspace-relative, deduplicated keys', () => {
  const stdout = JSON.stringify({
    issues: [
      { file: 'backend\\src\\b.ts', exports: [{ name: 'Same' }], types: [{ name: 'Same' }], dependencies: [] },
      { file: 'backend/src/a.ts', exports: [{ name: 'z' }, { name: 'a' }] },
      { file: 'backend/src/c.ts', exports: [], types: [] },
    ],
  });
  assert.deepEqual(parseKnipReport(stdout, 'backend'), ['src/a.ts#a', 'src/a.ts#z', 'src/b.ts#Same']);
});

test('production entries must be exactly the entrypoints', () => {
  const entrypoints = new Map([
    ['src/index.ts', { reason: 'named by a backend/package.json command', via: 'src/index.ts' }],
    ['src/generated.ts', { reason: 'imported by backend/scripts/gen.ts', via: 'scripts/gen.ts' }],
    ['src/worker.ts', { reason: 'loaded by path from backend/src/pool.ts', via: 'src/worker.ts' }],
    ['src/devOnly.ts', { reason: 'named by a backend/package.json command', via: 'src/devOnly.ts' }],
  ]);
  const modules = ['src/index.ts', 'src/generated.ts', 'src/worker.ts', 'src/devOnly.ts', 'src/scripts/helper.ts'];
  const config = { workspaces: { backend: { entry: [
    'package.json', 'src/index.ts!', 'scripts/**/*.ts!', 'src/worker.ts!',
    // A pattern without `!` is not a production entry.
    'src/devOnly.ts',
    // Location makes nothing an entrypoint: this also matches a helper.
    'src/scripts/**/*.ts!',
    // A deleted script's entry would keep what it alone used looking used.
    'src/removedScript.ts!',
  ] } } };
  assert.deepEqual(findEntryDrift(entrypoints, modules, config), {
    uncovered: [{ module: 'src/devOnly.ts', reason: 'named by a backend/package.json command' }],
    stale: ['src/scripts/helper.ts', 'src/removedScript.ts'],
  });
});

test('can be imported without a script path in argv', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../check-unused-exports.mjs', import.meta.url).href)});`]);
  assert.equal(result.status, 0, result.stderr.toString());
});

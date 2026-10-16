// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  collectGateTargets,
  findUnreachable,
  gateScriptNames,
  listTestFiles,
  parseNpmRun,
} from '../check-test-registration.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('suite discovery uses regular files and stable portable paths', t => {
  const backend = mkdtempSync(join(tmpdir(), 'test-registration-'));
  t.after(() => rmSync(backend, { recursive: true, force: true }));
  mkdirSync(join(backend, 'src', 'nested space', 'decoy.test.ts'), { recursive: true });
  mkdirSync(join(backend, 'tests'), { recursive: true });
  writeFileSync(join(backend, 'src', 'z.test.ts'), '');
  writeFileSync(join(backend, 'src', 'nested space', 'a_unittest.ts'), '');
  writeFileSync(join(backend, 'src', 'nested space', 'decoy.test.ts', 'inner.test.ts'), '');
  writeFileSync(join(backend, 'src', 'ignored.ts'), '');
  assert.deepEqual(listTestFiles(backend), [
    'src/nested space/a_unittest.ts',
    'src/nested space/decoy.test.ts/inner.test.ts',
    'src/z.test.ts',
  ]);
});

test('suite discovery covers tests/ and every name Jest runs as a suite', t => {
  const backend = mkdtempSync(join(tmpdir(), 'test-registration-tests-'));
  t.after(() => rmSync(backend, { recursive: true, force: true }));
  mkdirSync(join(backend, 'src'), { recursive: true });
  mkdirSync(join(backend, 'tests', 'skill-eval'), { recursive: true });
  mkdirSync(join(backend, 'tests', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(backend, 'tests', 'skill-eval', 'anr.eval.ts'), '');
  writeFileSync(join(backend, 'tests', 'skill-eval', 'runner.ts'), '');
  writeFileSync(join(backend, 'tests', 'node_modules', 'pkg', 'x.test.ts'), '');
  writeFileSync(join(backend, 'src', 'a.spec.ts'), '');
  assert.deepEqual(listTestFiles(backend), ['src/a.spec.ts', 'tests/skill-eval/anr.eval.ts']);
});

test('only scripts verify:pr runs are gates', () => {
  const root = {'verify:pr': 'npm run test:governance && npm --prefix backend run verify:pr', 'test:governance': 'node x.mjs'};
  const backend = {
    'verify:pr': 'npm run validate:skills && npm run test:gate',
    'test:gate': 'npm run -s test:core && npm run test:analysis-accuracy',
    'test:core': 'jest src/a/__tests__/core.test.ts',
    'test:analysis-accuracy': 'npm run trace:materialize && jest tests/skill-eval/batch.eval.ts',
    'trace:materialize': 'node materialize.cjs',
    'validate:skills': 'tsx src/cli/index.ts validate',
    'test:unit': 'jest src/tests',
  };
  const gates = gateScriptNames(backend, root);
  assert.deepEqual([...gates].sort(), ['test:analysis-accuracy', 'test:core', 'test:gate', 'trace:materialize', 'validate:skills', 'verify:pr']);
  const targets = collectGateTargets(backend, gates);
  assert.deepEqual(
    findUnreachable(['src/a/__tests__/core.test.ts', 'tests/skill-eval/batch.eval.ts', 'src/tests/b.test.ts'], targets),
    ['src/tests/b.test.ts'],
  );
});

test('a script chain names only Jest commands, through cd backend and npm test', () => {
  const root = {'verify:pr': 'cd backend && npm run check && npm test'};
  const backend = {
    check: 'tsc -p tsconfig.json src/a/__tests__/typed.test.ts && npx jest src/a/__tests__/run.test.ts',
    test: 'jest tests/skill-eval/x.eval.ts && tsx tests/runner.ts',
  };
  const targets = collectGateTargets(backend, gateScriptNames(backend, root));
  assert.deepEqual(
    findUnreachable(['src/a/__tests__/typed.test.ts', 'src/a/__tests__/run.test.ts', 'tests/skill-eval/x.eval.ts'], targets),
    ['src/a/__tests__/typed.test.ts'],
  );
});

test('npm run is read in every spelling the scripts may use', () => {
  const cases = [
    ['npm run test:core', { script: 'test:core' }],
    ['npm run -s test:core', { script: 'test:core' }],
    ['npm run --silent test:core', { script: 'test:core' }],
    ['npm --prefix backend run verify:pr', { prefix: 'backend', script: 'verify:pr' }],
    ['npm --prefix=backend run verify:pr', { prefix: 'backend', script: 'verify:pr' }],
    ['npm --prefix ./backend run verify:pr', { prefix: './backend', script: 'verify:pr' }],
    ['NODE_OPTIONS=--max-old-space-size=4096 X=1 npm run test:core', { script: 'test:core' }],
    ['npm test', { script: 'test' }],
    ['npm --prefix backend test', { prefix: 'backend', script: 'test' }],
    ['npx jest src/x.test.ts', undefined],
    ['npm ci', undefined],
  ];
  for (const [command, expected] of cases) assert.deepEqual(parseNpmRun(command), expected, command);
});

test('cd and --prefix resolve from the package a command runs in', () => {
  const root = {
    'verify:pr': 'cd backend && npm run a && cd .. && npm run b && cd backend && npm --prefix .. run d',
    b: 'npm --prefix=backend run c',
    d: 'npm --prefix ./backend/ run e',
    // Another package's scripts are not ours, whatever their names.
    x: 'cd scripts && npm run a',
  };
  const backend = {
    a: 'jest src/a.test.ts', c: 'jest src/c.test.ts', e: 'jest src/e.test.ts',
    f: 'npm --prefix scripts run g', g: 'jest src/g.test.ts',
  };
  assert.deepEqual([...gateScriptNames(backend, root)].sort(), ['a', 'c', 'e']);
  assert.deepEqual([...gateScriptNames(backend, {'verify:pr': 'npm --prefix backend run f'})].sort(), ['f']);
});

test('a chain that runs a script no package defines is an error', () => {
  assert.throws(() => gateScriptNames({}, {'verify:pr': 'npm --prefix backend run test:gone'}),
    /verify:pr runs scripts that do not exist: backend:test:gone/);
});

test('suite discovery fails when the source root cannot be read', t => {
  const backend = mkdtempSync(join(tmpdir(), 'test-registration-missing-'));
  t.after(() => rmSync(backend, { recursive: true, force: true }));
  assert.throws(() => listTestFiles(backend), { code: 'ENOENT' });
});

test('a suite named in a test:* script counts as reachable', () => {
  const targets = collectGateTargets({
    'test:core': 'jest --runInBand src/services/__tests__/alpha.test.ts',
  });
  assert.deepEqual(findUnreachable(['src/services/__tests__/alpha.test.ts'], targets), []);
});

test('a suite covered by a directory-scoped script counts as reachable', () => {
  const targets = collectGateTargets({
    'test:self-evolution': 'jest --runInBand src/services/selfEvolution',
  });
  assert.deepEqual(
    findUnreachable(['src/services/selfEvolution/__tests__/beta.test.ts'], targets),
    [],
  );
});

test('a suite named by no gate script is reported', () => {
  const targets = collectGateTargets({
    'test:core': 'jest --runInBand src/services/__tests__/alpha.test.ts',
  });
  assert.deepEqual(
    findUnreachable(['src/services/__tests__/orphan.test.ts'], targets),
    ['src/services/__tests__/orphan.test.ts'],
  );
});

test('a same-named suite in another directory does not vouch for an orphan', () => {
  // Matching on basename would let `a/x.test.ts` silently cover `b/x.test.ts`,
  // which is exactly how an unregistered suite hides.
  const targets = collectGateTargets({
    'test:core': 'jest --runInBand src/a/__tests__/x.test.ts',
  });
  assert.deepEqual(
    findUnreachable(['src/b/__tests__/x.test.ts'], targets),
    ['src/b/__tests__/x.test.ts'],
  );
});

test('only test:*/verify:* script bodies are consulted', () => {
  const targets = collectGateTargets({
    build: 'tsc -p tsconfig.json src/services/__tests__/alpha.test.ts',
  });
  assert.deepEqual(
    findUnreachable(['src/services/__tests__/alpha.test.ts'], targets),
    ['src/services/__tests__/alpha.test.ts'],
  );
});

test('the committed baseline still matches the repository', () => {
  // A baseline that drifts is worse than none: it would silently absolve a
  // suite that was deleted and a new one that took its path.
  const baseline = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts', 'test-registration-baseline.json'), 'utf8'),
  );
  const scripts = JSON.parse(
    readFileSync(join(REPO_ROOT, 'backend', 'package.json'), 'utf8'),
  ).scripts;
  const rootScripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  const unreachable = findUnreachable(listTestFiles(), collectGateTargets(scripts, gateScriptNames(scripts, rootScripts)));

  const newDebt = unreachable.filter(file => !baseline.unregistered.includes(file));
  assert.deepEqual(newDebt, [], 'new unregistered suites must be registered, not baselined');
});

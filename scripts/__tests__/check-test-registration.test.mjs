// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  collectGateTargets,
  findUnreachable,
  listTestFiles,
} from '../check-test-registration.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  const unreachable = findUnreachable(listTestFiles(), collectGateTargets(scripts));

  const newDebt = unreachable.filter(file => !baseline.unregistered.includes(file));
  assert.deepEqual(newDebt, [], 'new unregistered suites must be registered, not baselined');
});

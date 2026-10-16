// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {load} from 'js-yaml';

const require = createRequire(import.meta.url);
const {changedPaths, classifyChangedPaths} = require('../ci-change-scope.cjs');
const root = resolve(import.meta.dirname, '../..');
const workflow = load(readFileSync(join(root, '.github/workflows/backend-agent-regression-gate.yml'), 'utf8'));

test('ordinary report and documentation edits need only the default Linux checks', () => {
  assert.deepEqual(classifyChangedPaths(['backend/src/services/htmlReportGenerator.ts', 'README.md']),
    {platform: false, docker: false, rust: false});
});

test('native dependencies and launchers retain hosted platform coverage', () => {
  for (const file of ['backend/package-lock.json', 'start.sh', 'scripts/portable-launcher/main.go',
    'backend/src/runtimePaths.ts', 'backend/src/services/providerManager/localSecretStore.ts',
    'backend/src/agentRuntime/runtimeHealth.ts', 'backend/src/services/startupCleanupPolicy.ts',
    'backend/src/cli-user/services/traceProcessorInstaller.ts',
    'backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts', 'perfetto']) {
    assert.equal(classifyChangedPaths([file]).platform, true, file);
  }
  for (const file of ['Dockerfile', 'rust/flamegraph-analyzer/src/main.rs', 'frontend/v1/frontend_bundle.js',
    'backend/public/assistant-shell/app.js', 'backend/scripts/copy-runtime-assets.cjs',
    'scripts/trace-processor-pin.env', 'backend/package-lock.json']) {
    assert.equal(classifyChangedPaths([file]).docker, true, file);
  }
  assert.equal(classifyChangedPaths(['rust/flamegraph-analyzer/Cargo.lock']).rust, true);
  assert.equal(classifyChangedPaths(['package.json']).rust, true);
  assert.deepEqual(classifyChangedPaths(['.github/ci-scopes.json']), {platform: true, docker: true, rust: true});
});

test('manual and first-push runs conservatively select every environment', () => {
  assert.equal(changedPaths('workflow_dispatch', {}, () => assert.fail('manual run needs no diff')), null);
  assert.equal(changedPaths('push', {before: '0'.repeat(40)}, () => assert.fail('first push needs no diff')), null);
  assert.deepEqual(classifyChangedPaths([], true), {platform: true, docker: true, rust: true});
});

test('a PR diff uses its merge tree and includes both sides of a rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartperfetto-ci-scope-'));
  const git = args => execFileSync('git', args, {cwd: dir, encoding: 'utf8'});
  const commit = message => git(['-c', 'user.name=CI', '-c', 'user.email=ci@example.com', 'commit', '-qm', message]);
  try {
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'Dockerfile'), 'base\n');
    git(['add', '.']); commit('base');
    git(['checkout', '-qb', 'feature']);
    git(['mv', 'Dockerfile', 'README.md']); commit('rename');
    git(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'unrelated.txt'), 'target-only\n');
    git(['add', '.']); commit('target update');
    git(['-c', 'user.name=CI', '-c', 'user.email=ci@example.com', 'merge', '--no-ff', '-qm', 'test merge', 'feature']);
    const files = changedPaths('pull_request', {}, git);
    assert.deepEqual(files.sort(), ['Dockerfile', 'README.md']);
    assert.equal(classifyChangedPaths(files).docker, true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('multi-commit pushes fetch a missing base and fail closed when it cannot be read', () => {
  const before = 'a'.repeat(40);
  const calls = [];
  const files = changedPaths('push', {before}, args => {
    calls.push(args);
    if (args[0] === 'cat-file') throw new Error('shallow history');
    return args[0] === 'diff' ? 'Dockerfile\0old name.txt\0' : '';
  });
  assert.deepEqual(files, ['Dockerfile', 'old name.txt']);
  assert.deepEqual(calls[1], ['fetch', '--no-tags', '--depth=1', 'origin', before]);
  assert.throws(() => changedPaths('push', {before}, () => {throw new Error('unavailable base');}), /unavailable base/);
  assert.throws(() => changedPaths('push', {before: '--bad-ref'}, () => assert.fail('invalid ref')), /Missing push base/);
});

test('default backend CI avoids the full fixture gate but the local gate keeps every suite', () => {
  const scripts = require('../../backend/package.json').scripts;
  assert.match(scripts['verify:ci'], /typecheck.*build.*test:ci/);
  assert.doesNotMatch(scripts['test:ci'], /test:gate|test:analysis-accuracy|trace:|test:architecture/);
  assert.match(scripts['test:ci'], /test:ci-privacy.*test:auth.*test:core/);
  assert.match(scripts['verify:pr'], /test:gate/);
  assert.match(scripts['test:gate'], /test:analysis-accuracy.*test:architecture.*trace:sql-regression.*test:scene-trace-regression/);
  assert.match(scripts['test:architecture'], /npm run test:secret-patterns:performance/);
  assert.match(scripts['test:secret-patterns:performance'], /secretPatterns\.performance\.test\.ts/);
  assert.doesNotMatch(scripts['test:ci-privacy'], /secretPatterns\.performance/);
  const steps = workflow.jobs.backend.steps;
  assert.equal(steps.find(step => step.run === 'npm --prefix backend run verify:ci').if, '${{ !inputs.full }}');
  assert.equal(steps.find(step => step.run === 'npm --prefix backend run verify:pr').if, 'inputs.full');
  assert.equal(workflow.jobs['trace-corpus'].if, 'inputs.full');
  assert.deepEqual(workflow.jobs['cross-platform-contracts'].strategy.matrix.os, ['macos-latest', 'windows-latest']);
  assert.equal(workflow.jobs['cross-platform-contracts'].if, "needs.scope.outputs.platform == 'true'");
  assert.equal(workflow.jobs['docker-smoke'].if, "needs.scope.outputs.docker == 'true'");
  assert.equal(workflow.on.pull_request, null);
  assert.equal(workflow.on.workflow_dispatch.inputs.full.default, false);
  const docker = load(readFileSync(join(root, '.github/workflows/docker-publish.yml'), 'utf8'));
  const publishing = docker.jobs['quality-gate'].steps;
  assert.equal(publishing.find(step => step.run === 'cd backend && npm run verify:pr').if,
    "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(publishing.find(step => step.run === 'npm --prefix backend run verify:ci').if,
    "${{ !startsWith(github.ref, 'refs/tags/v') }}");
});

test('the stable gate rejects failed, cancelled and skipped mandatory jobs', () => {
  const gate = workflow.jobs.gate;
  assert.equal(gate.if, '${{ always() }}');
  assert.ok(gate.needs.includes('scope'));
  const script = gate.steps[0].run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const run = jobs => spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: {...process.env, NEEDS_JSON: JSON.stringify(jobs)},
  });
  const passed = Object.fromEntries(gate.needs.map(name => [name, {
    result: ['scope', 'quality', 'backend'].includes(name) ? 'success' : 'skipped',
  }]));
  assert.equal(run(passed).status, 0);
  for (const [name, result] of [['backend', 'failure'], ['quality', 'skipped'], ['scope', 'cancelled'],
    ['docker-smoke', 'failure'], ['cross-platform-contracts', 'cancelled']]) {
    assert.equal(run({...passed, [name]: {result}}).status, 1, `${name}: ${result}`);
  }
});

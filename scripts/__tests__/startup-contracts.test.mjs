// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('source launchers share ownership-aware lifecycle semantics', () => {
  const lifecycle = read('scripts/service-lifecycle.sh');
  assert.doesNotMatch(lifecycle, /^[^#\n]*\bwait -n\b/m);
  assert.match(lifecycle, /start_identity/);
  assert.match(lifecycle, /generation/);
  assert.match(lifecycle, /Refusing to stop an unowned listener/);

  for (const scriptPath of [
    'start.sh',
    'scripts/start-dev.sh',
    'scripts/restart-backend.sh',
    'scripts/stop-dev.sh',
  ]) {
    const script = read(scriptPath);
    assert.match(script, /service-lifecycle\.sh/);
    assert.doesNotMatch(script, /kill_processes_on_port/);
    assert.doesNotMatch(script, /pkill -f/);
  }

  const restartBackend = read('scripts/restart-backend.sh');
  assert.match(restartBackend, /launch-detached\.mjs/);
});

test('dev launcher uses canonical dependencies and a complete UI/WASM build', () => {
  const script = read('scripts/start-dev.sh');
  assert.match(script, /tools\/install-build-deps --ui/);
  assert.match(script, /PERFETTO_NODE" ui\/build\.mjs 2>&1/);
  assert.doesNotMatch(script, /ui\/build\.mjs[^\n]*--only-wasm-memory64/);
  assert.doesNotMatch(script, /ui\/build\.mjs[^\n]*--no-depscheck/);
  assert.doesNotMatch(script, /ui\/build\.mjs[^\n]*--no-wasm/);
  assert.doesNotMatch(script, /git checkout origin\/main/);
  assert.doesNotMatch(script, /^\s*npm run generate:frontend-types/m);
});

test('Docker image and both compose paths require backend and frontend health', () => {
  for (const file of ['Dockerfile', 'docker-compose.yml', 'docker-compose.hub.yml']) {
    const contents = read(file);
    assert.match(contents, /SMARTPERFETTO_BACKEND_PORT/);
    assert.match(contents, /\/health/);
    assert.match(contents, /SMARTPERFETTO_FRONTEND_PORT/);
  }

  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /tini/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/app\/docker-entrypoint\.sh"\]/);

  const entrypoint = read('scripts/docker-entrypoint.sh');
  assert.match(entrypoint, /wait_for_service[\s\S]*Backend/);
  assert.match(entrypoint, /wait_for_service[\s\S]*Frontend/);
  assert.match(entrypoint, /FRONTEND_PORT}\/health/);
  assert.match(entrypoint, /SMARTPERFETTO_BIND_HOST="\$\{SMARTPERFETTO_BIND_HOST:-0\.0\.0\.0\}"/);
  assert.match(entrypoint, /SMARTPERFETTO_FRONTEND_BIND_HOST="\$\{SMARTPERFETTO_FRONTEND_BIND_HOST:-0\.0\.0\.0\}"/);
  assert.doesNotMatch(entrypoint, /health\.aiEngine|const ai = health\.aiEngine/);

  for (const composePath of ['docker-compose.yml', 'docker-compose.hub.yml']) {
    const compose = read(composePath);
    assert.match(compose, /SMARTPERFETTO_BIND_HOST=0\.0\.0\.0/);
    assert.match(compose, /SMARTPERFETTO_FRONTEND_BIND_HOST=0\.0\.0\.0/);
    assert.equal(
      compose.match(/\$\{SMARTPERFETTO_PUBLISH_HOST:-127\.0\.0\.1\}/g)?.length,
      2,
      `${composePath} must publish both host ports on IPv4 loopback by default`,
    );
  }

  for (const file of [
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.hub.yml',
    'scripts/docker-entrypoint.sh',
  ]) {
    const contents = read(file);
    assert.match(contents, /http:\/\/127\.0\.0\.1:[^ \n"]+\/health/);
    assert.doesNotMatch(contents, /http:\/\/localhost:[^ \n"]+\/health/);
  }
});

test('source readiness and default browser URLs use explicit IPv4 loopback', () => {
  const ports = read('scripts/service-ports.sh');
  assert.match(ports, /smartperfetto_loopback_url/);
  assert.match(ports, /http:\/\/127\.0\.0\.1/);
  assert.match(ports, /BACKEND_HEALTH_URL/);
  assert.match(ports, /FRONTEND_HEALTH_URL/);
  assert.match(ports, /BACKEND_URL=.*smartperfetto_loopback_url/);
  assert.match(ports, /FRONTEND_URL=.*FRONTEND_LOOPBACK_URL/);
  assert.doesNotMatch(ports, /http:\/\/localhost/);

  for (const scriptPath of [
    'start.sh',
    'scripts/start-dev.sh',
    'scripts/restart-backend.sh',
  ]) {
    const script = read(scriptPath);
    assert.doesNotMatch(script, /http:\/\/localhost:\$BACKEND_PORT\/health/);
  }

  const start = read('start.sh');
  assert.match(start, /open "\$FRONTEND_URL"/);
  assert.match(start, /xdg-open "\$FRONTEND_URL"/);
});

test('launch surfaces expose package identity without bypassing persistence probing', () => {
  const start = read('start.sh');
  assert.match(start, /SMARTPERFETTO_PACKAGE_ROOT="\$PROJECT_ROOT"/);
  assert.match(start, /SMARTPERFETTO_BUILD_COMMIT="\$SOURCE_BUILD_COMMIT"/);
  assert.match(start, /SMARTPERFETTO_LOCK_RUNTIME_IDENTITY=1/);
  assert.doesNotMatch(start, /^\s*SMARTPERFETTO_BACKEND_DATA_DIR=/m);

  for (const launcher of [
    read('scripts/start-dev.sh'),
    read('scripts/restart-backend.sh'),
  ]) {
    assert.match(launcher, /smartperfetto_source_build_commit "\$PROJECT_ROOT"/);
    assert.match(launcher, /SMARTPERFETTO_PACKAGE_ROOT="\$PROJECT_ROOT"/);
    assert.match(launcher, /SMARTPERFETTO_BUILD_COMMIT="\$SOURCE_BUILD_COMMIT"/);
    assert.match(launcher, /SMARTPERFETTO_LOCK_RUNTIME_IDENTITY=1/);
  }

  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /ENV SMARTPERFETTO_PACKAGE_ROOT=\/app/);
  assert.match(dockerfile, /ENV SMARTPERFETTO_BACKEND_DATA_DIR=\/app\/backend\/runtime-data/);
  assert.match(dockerfile, /ENV SMARTPERFETTO_LOCK_RUNTIME_IDENTITY=1/);
  assert.match(
    read('docker-compose.hub.yml'),
    /runtime-data:\/app\/backend\/runtime-data/,
  );

  const portableLauncher = read('scripts/portable-launcher/main.go');
  assert.match(
    portableLauncher,
    /"SMARTPERFETTO_PACKAGE_ROOT":\s+layout\.packageRoot/,
  );
  assert.match(
    portableLauncher,
    /"SMARTPERFETTO_BACKEND_DATA_DIR":\s+backendDataDir/,
  );
  assert.match(
    portableLauncher,
    /"SMARTPERFETTO_LOCK_RUNTIME_IDENTITY":\s+"1"/,
  );

  const backendIndex = read('backend/src/index.ts');
  assert.ok(
    backendIndex.indexOf('initializeSelfEvolutionLifecycle()') <
      backendIndex.indexOf('startCaseEvolutionWorker()'),
    'self-evolution persistence/config lifecycle must initialize before optional workers',
  );
});

test('source build identity resolves the checked-out commit before stale env', () => {
  const expected = execFileSync(
    'git',
    ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'],
    {encoding: 'utf8'},
  ).trim();
  const actual = execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; smartperfetto_source_build_commit "$2"',
      'bash',
      path.join(repoRoot, 'scripts/node-env.sh'),
      repoRoot,
    ],
    {
      encoding: 'utf8',
      env: {...process.env, SMARTPERFETTO_BUILD_COMMIT: 'stale'},
    },
  ).trim();
  assert.equal(actual, expected);
});

test('backend predev delegates trace processor handling to the guarded installer', () => {
  const packageJson = JSON.parse(read('backend/package.json'));
  assert.equal(packageJson.scripts.predev, 'npm run trace-processor:ensure');
  assert.equal(packageJson.scripts['trace-processor:ensure'], 'node scripts/ensure-trace-processor.cjs');
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('Docker carries static backend surfaces and a host-independent OpenCode binary', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY backend\/public \.\/backend\/public/);
  assert.match(dockerfile, /COPY backend\/knowledge \.\/backend\/knowledge/);
  assert.match(dockerfile, /npm run knowledge-pack:fetch && npm run build/);
  assert.match(dockerfile, /opencode-linux-x64-baseline\/bin\/opencode/);
  assert.match(dockerfile, /opencode-linux-arm64\/bin\/opencode/);
  assert.match(dockerfile, /rm -f "\$OPENCODE_DEST"/);
  assert.match(dockerfile, /ln "\$OPENCODE_SOURCE" "\$OPENCODE_DEST"/);
  assert.match(dockerfile, /"\$OPENCODE_DEST" --version/);
});

test('npm and portable artifacts verify the same backend runtime surfaces', () => {
  const backendPackage = JSON.parse(readFileSync(join(root, 'backend/package.json'), 'utf8'));
  assert.ok(backendPackage.files.includes('public/**/*'));
  assert.ok(backendPackage.files.includes('knowledge/**/*'));

  const cliPackCheck = readFileSync(join(root, 'backend/scripts/check-cli-pack.cjs'), 'utf8');
  const portableVerifier = readFileSync(join(root, 'scripts/verify-portable-package.cjs'), 'utf8');
  for (const asset of [
    'public/assistant-shell/index.html',
    'public/admin-control-plane/index.html',
    'knowledge/android-internals-capability-map.yaml',
    'knowledge/aiw-pack/1.root.json',
    'knowledge/aiw-pack/knowledge-packs.lock.json',
  ]) {
    assert.match(cliPackCheck, new RegExp(asset.replaceAll('/', '\\/')));
    assert.match(portableVerifier, new RegExp(asset.replaceAll('/', '\\/')));
  }
  assert.equal(
    portableVerifier.match(/node_modules\/opencode-ai\/bin\/opencode\.exe/g)?.length,
    6,
  );
});

test('macOS packaging preserves and verifies JIT runtime entitlements', () => {
  const portableScript = readFileSync(join(root, 'scripts/package-portable.sh'), 'utf8');
  const portableVerifier = readFileSync(join(root, 'scripts/verify-portable-package.cjs'), 'utf8');

  assert.match(portableScript, /--preserve-metadata=identifier,entitlements/);
  assert.match(
    portableScript,
    /sign_args\+=\(--sign -\)[\s\S]*find-macho-files\.cjs" --null "\$app_dir\/Contents"/,
  );
  assert.doesNotMatch(portableScript, /codesign --force --deep/);
  for (const entitlement of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    assert.match(portableVerifier, new RegExp(entitlement.replaceAll('.', '\\.')));
  }
});

test('portable governance separates code impact from exact-archive release acceptance', () => {
  const agentGuide = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const claudeGuide = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  const productSurface = readFileSync(
    join(root, '.claude/rules/product-surface.md'),
    'utf8',
  );
  const releaseRules = readFileSync(join(root, '.claude/rules/release.md'), 'utf8');
  const testingRules = readFileSync(join(root, '.claude/rules/testing.md'), 'utf8');

  assert.equal(agentGuide, claudeGuide);
  assert.match(agentGuide, /startup\/readiness[\s\S]*portable-impacting work/);
  assert.match(productSurface, /## Portable Impact Triggers/);
  assert.match(
    productSurface,
    /public release gate, not a requirement for every intermediate\s+code edit/,
  );
  assert.match(releaseRules, /runtime-smoke and upload the same final archive bytes/);
  assert.match(releaseRules, /post-notarization, post-staple final zip/);
  assert.match(releaseRules, /Do not add JIT entitlements to arbitrary unsigned/);
  assert.match(testingRules, /## Exact Portable Archive Runtime Gate/);
  for (const contract of [
    'http://127.0.0.1:<port>/health',
    'minimal packaged `trace_processor_shell` operation',
    'verify child processes and listening ports are gone',
    'Gatekeeper must report `Notarized Developer ID`',
  ]) {
    assert.match(testingRules, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Docker CI smokes both static routes and the packaged OpenCode executable', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/backend-agent-regression-gate.yml'),
    'utf8',
  );
  assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:3000\/assistant-shell/);
  assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:3000\/admin-control-plane/);
  assert.match(workflow, /opencode-ai\/bin\/opencode\.exe --version/);
});

test('Docker publishing keeps stable and nightly tags separate', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/docker-publish.yml'),
    'utf8',
  );
  const compose = readFileSync(join(root, 'docker-compose.hub.yml'), 'utf8');
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

  assert.match(
    workflow,
    /type=raw,value=latest,enable=\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
  );
  assert.match(
    workflow,
    /type=raw,value=nightly,enable=\$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.match(
    workflow,
    /type=sha,prefix=sha-,enable=\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
  );
  assert.match(workflow, /SMARTPERFETTO_BUILD_COMMIT=\$\{\{ github\.sha \}\}/);
  assert.match(
    compose,
    /smartperfetto:\$\{SMARTPERFETTO_DOCKER_TAG:-latest\}/,
  );
  assert.match(compose, /runtime-data:\/app\/backend\/runtime-data/);
  assert.match(dockerfile, /SMARTPERFETTO_DISTRIBUTION=docker/);
  assert.match(
    dockerfile,
    /SMARTPERFETTO_BUILD_COMMIT=\$\{SMARTPERFETTO_BUILD_COMMIT\}/,
  );
});

test('backend gate installs every dependency tree consumed by verify:pr', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/backend-agent-regression-gate.yml'),
    'utf8',
  );
  const gate = workflow.slice(
    workflow.indexOf('  gate:'),
    workflow.indexOf('  cross-platform-contracts:'),
  );

  assert.match(
    gate,
    /cache-dependency-path: \|\s+package-lock\.json\s+backend\/package-lock\.json/,
  );
  assert.match(gate, /run: npm ci && npm --prefix backend ci/);
  assert.match(gate, /run: npm --prefix backend run verify:pr/);
});

test('manual Deepseek E2E can isolate the source and RAG context matrix', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/agent-deepseek-e2e.yml'),
    'utf8',
  );
  assert.match(workflow, /options:\s+[\s\S]*- context/);
  assert.match(workflow, /context\)\s+npm run verify:e2e:deepseek-context/);
});

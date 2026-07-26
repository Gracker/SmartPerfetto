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
  for (const entitlement of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    assert.match(portableVerifier, new RegExp(entitlement.replaceAll('.', '\\.')));
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

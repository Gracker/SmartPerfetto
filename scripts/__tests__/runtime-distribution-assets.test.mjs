// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
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
  for (const target of ['windows-x64', 'macos-arm64', 'linux-x64']) {
    assert.match(
      portableVerifier,
      new RegExp(
        `'${target}'[\\s\\S]*?required:[\\s\\S]*?node_modules\\/opencode-ai\\/bin\\/opencode\\.exe`,
      ),
    );
    assert.match(
      portableVerifier,
      new RegExp(
        `'${target}'[\\s\\S]*?required:[\\s\\S]*?node_modules\\/@earendil-works\\/pi-agent-core\\/dist\\/index\\.js[\\s\\S]*?node_modules\\/@earendil-works\\/pi-ai\\/dist\\/index\\.js`,
      ),
    );
  }
});

test('Pi provider-explicit runtime ships exact aligned optional dependencies and a real integration gate', () => {
  const backendPackage = JSON.parse(readFileSync(join(root, 'backend/package.json'), 'utf8'));
  assert.equal(
    backendPackage.optionalDependencies['@earendil-works/pi-agent-core'],
    '0.84.1',
  );
  assert.equal(
    backendPackage.optionalDependencies['@earendil-works/pi-ai'],
    '0.84.1',
  );
  assert.match(backendPackage.scripts['test:architecture'], /test:pi-provider-runtime/);

  const integrationGate = readFileSync(
    join(root, 'backend/scripts/check-pi-provider-runtime.cjs'),
    'utf8',
  );
  assert.match(integrationGate, /loadPiAgentCoreModule/);
  assert.match(integrationGate, /createPiAgentCoreProviderRuntime/);
  assert.match(integrationGate, /fauxToolCall/);
  assert.match(integrationGate, /abortAgent\.abort\(\)/);
  assert.match(integrationGate, /first-secret/);
  assert.match(integrationGate, /type: 'oauth'/);

  const cliE2e = readFileSync(join(root, 'backend/scripts/run-cli-e2e.cjs'), 'utf8');
  assert.match(cliE2e, /packed Pi runtime construction/);
  assert.match(cliE2e, /loadPiAgentCoreModule/);
  assert.match(cliE2e, /createPiAgentCoreProviderRuntime/);
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
    'Gatekeeper must report `Notarized Developer ID`',
  ]) {
    assert.match(testingRules, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(
    testingRules,
    /platform containment[\s\S]*verify child[\s\S]*processes and listening ports\s+are gone/,
  );
});

test('portable packaging has one launcher implementation and one target-native smoke contract', () => {
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const nodeRuntimePin = readFileSync(
    join(root, 'scripts/node-runtime-pin.env'),
    'utf8',
  );
  const portableScript = readFileSync(join(root, 'scripts/package-portable.sh'), 'utf8');
  const portableTarScript = readFileSync(
    join(root, 'scripts/create-portable-tar.sh'),
    'utf8',
  );
  const launcher = readFileSync(join(root, 'scripts/portable-launcher/main.go'), 'utf8');
  const windowsContainment = readFileSync(
    join(root, 'scripts/portable-launcher/process_containment_windows.go'),
    'utf8',
  );
  const smokeScript = readFileSync(join(root, 'scripts/smoke-portable-archive.cjs'), 'utf8');
  const portableVerifier = readFileSync(
    join(root, 'scripts/verify-portable-package.cjs'),
    'utf8',
  );
  const testingRules = readFileSync(join(root, '.claude/rules/testing.md'), 'utf8');

  assert.match(portableScript, /scripts\/portable-launcher/);
  assert.match(portableScript, /find "\$backend_dir\/node_modules" -type d -name \.bin/);
  assert.match(portableScript, /portable dependency tree contains an unexpected symlink/);
  assert.match(portableScript, /materialize_portable_links "\$resources_dir\/runtime\/node"/);
  assert.match(portableScript, /portable symlink escapes its payload root/);
  assert.match(portableScript, /sourceSha256: traceProcessorSourceSha256/);
  assert.match(portableScript, /WINDOWS_MINIMUM_SYSTEM_VERSION="10\.0"/);
  assert.match(portableScript, /node-runtime-pin\.env/);
  assert.match(
    portableScript,
    /write_readme[\s\\]*"\$package_dir"[\s\\]*"\$target"[\s\\]*"\$PACKAGE_VERSION"[\s\\]*"\$notarized"[\s\\]*"\$macos_minimum_system_version"/,
  );
  assert.match(gitignore, /!scripts\/node-runtime-pin\.env/);
  for (const key of [
    'NODE_RUNTIME_EXECUTABLE_SHA256_WINDOWS_X64',
    'NODE_RUNTIME_EXECUTABLE_SHA256_MACOS_ARM64',
    'NODE_RUNTIME_EXECUTABLE_SHA256_LINUX_X64',
  ]) {
    assert.match(nodeRuntimePin, new RegExp(`^${key}=[0-9a-f]{64}$`, 'm'));
  }
  assert.doesNotMatch(portableScript, /latest-v\$\{NODE_MAJOR\}/);
  assert.doesNotMatch(portableScript, /skip-backend-build/);
  assert.doesNotMatch(portableScript, /\$version[^\x00-\x7F]/);
  assert.match(portableScript, /prebuild\.name !== expected/);
  assert.match(portableScript, /sign_macos_payloads[\s\S]*packaged_tp_sha[\s\S]*sign_macos_container/);
  assert.match(portableScript, /archive_package_atomically/);
  assert.match(portableScript, /scripts\/create-portable-tar\.sh/);
  assert.match(portableTarScript, /COPYFILE_DISABLE=1 tar/);
  assert.match(portableTarScript, /--no-xattrs/);
  assert.match(portableTarScript, /-- "\$package_name"/);
  assert.match(portableScript, /notary_submission_path/);
  assert.match(
    portableScript,
    /notarize_macos_zip[\s\\]*"\$notary_submission_path"[\s\S]*rm -f "\$notary_submission_path" "\$asset_path"/,
  );
  assert.doesNotMatch(portableScript, /notarize_macos_zip "\$asset_path"/);
  assert.match(
    portableScript,
    /macOS notarization failed; no final release archive was created/,
  );
  assert.equal(existsSync(join(root, 'scripts/windows-launcher/main.go')), false);
  assert.match(launcher, /"SMARTPERFETTO_BIND_HOST":\s+ipv4LoopbackHost/);
  assert.match(launcher, /"SMARTPERFETTO_FRONTEND_BIND_HOST":\s+ipv4LoopbackHost/);
  assert.match(windowsContainment, /jobObjectLimitKillOnJobClose/);
  assert.match(windowsContainment, /assignProcessToJobObject/);
  assert.match(portableVerifier, /Windows portable manifest must require Windows 10/);
  assert.match(
    portableVerifier,
    /README-MACOS\.txt minimum system version does not match the package manifest/,
  );
  assert.match(portableVerifier, /inspectArchiveBudget\(assetPath, ext\)/);
  assert.match(smokeScript, /--non-interactive/);
  assert.match(smokeScript, /--shutdown-file/);
  assert.match(smokeScript, /--lifecycle-receipt/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:/);
  assert.match(smokeScript, /empty-trace\.pftrace/);
  assert.match(smokeScript, /'-Q'/);
  assert.match(smokeScript, /smartperfetto_smoke=1/);
  assert.match(testingRules, /scripts\/smoke-portable-archive\.cjs/);
});

test('frontend refresh rejects an incomplete build before modifying the committed target', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-frontend-refresh-'));
  t.after(() => rmSync(fixtureRoot, {recursive: true, force: true}));

  const distDir = join(fixtureRoot, 'dist');
  const versionDir = join(distDir, 'v-test');
  const frontendDir = join(fixtureRoot, 'frontend');
  mkdirSync(versionDir, {recursive: true});
  mkdirSync(frontendDir, {recursive: true});
  writeFileSync(join(distDir, 'index.html'), '<html></html>\n');
  writeFileSync(join(versionDir, 'manifest.json'), '{}\n');
  writeFileSync(join(frontendDir, 'sentinel.txt'), 'preserve me\n');

  const result = spawnSync('bash', [join(root, 'scripts/update-frontend.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SMARTPERFETTO_FRONTEND_DIST_DIR: distDir,
      SMARTPERFETTO_FRONTEND_DIR: frontendDir,
    },
  });

  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /frontend\.css/);
  assert.match(output, /cd perfetto && tools\/node ui\/build\.mjs/);
  assert.equal(readFileSync(join(frontendDir, 'sentinel.txt'), 'utf8'), 'preserve me\n');
  assert.equal(existsSync(join(frontendDir, 'index.html')), false);
});

test('frontend refresh derives top-level Syntaqlite assets from the same versioned build', {
  skip: spawnSync('rsync', ['--version']).status === 0 ? false : 'frontend refresh requires rsync',
}, (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-frontend-assets-'));
  t.after(() => rmSync(fixtureRoot, {recursive: true, force: true}));

  const distDir = join(fixtureRoot, 'dist');
  const versionDir = join(distDir, 'v-test');
  const versionAssetsDir = join(versionDir, 'assets');
  const frontendDir = join(fixtureRoot, 'frontend');
  const frontendAssetsDir = join(frontendDir, 'assets');
  mkdirSync(versionAssetsDir, {recursive: true});
  mkdirSync(frontendAssetsDir, {recursive: true});
  writeFileSync(join(distDir, 'index.html'), '<html><head></head></html>\n');
  writeFileSync(join(versionDir, 'frontend.css'), 'body {}\n');
  writeFileSync(join(versionDir, 'frontend_bundle.js'), 'const assets = [];\n');
  writeFileSync(join(versionDir, 'manifest.json'), '{}\n');
  writeFileSync(
    join(versionDir, 'engine_bundle.js'),
    `"trace_processor.wasm";${'x'.repeat(100_000)}`,
  );
  writeFileSync(join(versionDir, 'traceconv_bundle.js'), 'x'.repeat(100_001));

  const assets = [
    'syntaqlite-perfetto.wasm',
    'syntaqlite-runtime.js',
    'syntaqlite-runtime.wasm',
    'syntaqlite-sqlite.wasm',
  ];
  for (const asset of assets) {
    writeFileSync(join(versionAssetsDir, asset), `fresh-${asset}\n`);
    writeFileSync(join(frontendAssetsDir, asset), `stale-${asset}\n`);
  }

  const result = spawnSync('bash', [join(root, 'scripts/update-frontend.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SMARTPERFETTO_FRONTEND_DIST_DIR: distDir,
      SMARTPERFETTO_FRONTEND_DIR: frontendDir,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const asset of assets) {
    assert.equal(
      readFileSync(join(frontendAssetsDir, asset), 'utf8'),
      readFileSync(join(versionAssetsDir, asset), 'utf8'),
    );
  }
});

test('frontend refresh rejects missing Syntaqlite assets before modifying the target', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-frontend-assets-'));
  t.after(() => rmSync(fixtureRoot, {recursive: true, force: true}));

  const distDir = join(fixtureRoot, 'dist');
  const versionDir = join(distDir, 'v-test');
  const versionAssetsDir = join(versionDir, 'assets');
  const frontendDir = join(fixtureRoot, 'frontend');
  mkdirSync(versionAssetsDir, {recursive: true});
  mkdirSync(frontendDir, {recursive: true});
  writeFileSync(join(distDir, 'index.html'), '<html><head></head></html>\n');
  writeFileSync(join(versionDir, 'frontend.css'), 'body {}\n');
  writeFileSync(join(versionDir, 'frontend_bundle.js'), 'const assets = [];\n');
  writeFileSync(join(versionDir, 'manifest.json'), '{}\n');
  writeFileSync(
    join(versionDir, 'engine_bundle.js'),
    `"trace_processor.wasm";${'x'.repeat(100_000)}`,
  );
  writeFileSync(join(versionDir, 'traceconv_bundle.js'), 'x'.repeat(100_001));
  for (const asset of [
    'syntaqlite-perfetto.wasm',
    'syntaqlite-runtime.js',
    'syntaqlite-runtime.wasm',
  ]) {
    writeFileSync(join(versionAssetsDir, asset), `fresh-${asset}\n`);
  }
  writeFileSync(join(frontendDir, 'index.html'), 'preserve-index\n');
  writeFileSync(join(frontendDir, 'sentinel.txt'), 'preserve-sentinel\n');

  const result = spawnSync('bash', [join(root, 'scripts/update-frontend.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SMARTPERFETTO_FRONTEND_DIST_DIR: distDir,
      SMARTPERFETTO_FRONTEND_DIR: frontendDir,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /syntaqlite-sqlite\.wasm/);
  assert.equal(readFileSync(join(frontendDir, 'index.html'), 'utf8'), 'preserve-index\n');
  assert.equal(
    readFileSync(join(frontendDir, 'sentinel.txt'), 'utf8'),
    'preserve-sentinel\n',
  );
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

test('Windows cross-platform contracts build and inject the fixed Go gate helper', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/backend-agent-regression-gate.yml'),
    'utf8',
  );
  const crossPlatform = workflow.slice(
    workflow.indexOf('  cross-platform-contracts:'),
    workflow.indexOf('  trace-corpus:'),
  );

  assert.match(
    crossPlatform,
    /actions\/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7/,
  );
  assert.match(crossPlatform, /go-version: "1\.25\.0"/);
  assert.match(crossPlatform, /GO111MODULE: "off"[\s\S]*?go test \.\/scripts\/portable-health-probe/);
  assert.match(
    crossPlatform,
    /go build -trimpath '-ldflags=-s -w'[\s\S]*?\.\/scripts\/portable-health-probe/,
  );
  assert.equal(
    (
      crossPlatform.match(
        /SMARTPERFETTO_WINDOWS_GATE_HELPER_PATH: \$\{\{ runner\.temp \}\}\/smartperfetto-windows-gate-helper\.exe/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    crossPlatform,
    /Verify Windows cross-platform runtime contracts[\s\S]*?npm run test:governance/,
  );
  assert.match(
    crossPlatform,
    /Test and build the Windows portable launcher[\s\S]*?go test \.\/scripts\/portable-launcher[\s\S]*?go build[\s\S]*?\.\/scripts\/portable-launcher/,
  );
  assert.match(
    crossPlatform,
    /Test Windows Provider secret storage[\s\S]*?localSecretStore\.test\.ts/,
  );
  assert.doesNotMatch(crossPlatform, /upload-artifact/);
});

test('manual Deepseek E2E can isolate the source and RAG context matrix', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/agent-deepseek-e2e.yml'),
    'utf8',
  );
  assert.match(workflow, /options:\s+[\s\S]*- context/);
  assert.match(workflow, /context\)\s+npm run verify:e2e:deepseek-context/);
  assert.match(workflow, /timeout-minutes:\s*180/);
  const backendPackage = JSON.parse(
    readFileSync(join(root, 'backend/package.json'), 'utf8'),
  );
  for (const scriptName of [
    'verify:e2e:deepseek',
    'verify:e2e:deepseek-startup',
    'verify:e2e:deepseek-scrolling',
    'verify:e2e:deepseek-external-issue',
    'verify:e2e:deepseek-dual-trace',
    'verify:e2e:deepseek-context',
  ]) {
    assert.match(backendPackage.scripts[scriptName], /--runtime all-deepseek/);
  }
});

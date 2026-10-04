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
import {load as loadYaml} from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');

test('Docker carries static backend surfaces and a host-independent OpenCode binary', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY backend\/public \.\/backend\/public/);
  assert.match(dockerfile, /COPY backend\/knowledge \.\/backend\/knowledge/);
  assert.doesNotMatch(dockerfile, /knowledge-pack/);
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
    '0.85.1',
  );
  assert.equal(
    backendPackage.optionalDependencies['@earendil-works/pi-ai'],
    '0.85.1',
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

test('CLI E2E resolves a governed catalog trace without submodule test data', () => {
  const cliE2e = readFileSync(join(root, 'backend/scripts/run-cli-e2e.cjs'), 'utf8');
  assert.match(cliE2e, /Trace[\/\\]catalog\.json/);
  assert.match(cliE2e, /android-startup-heavy/);
  assert.doesNotMatch(cliE2e, /perfetto[\/\\]test[\/\\]data/);
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
  const productSurface = readFileSync(
    join(root, '.claude/rules/product-surface.md'),
    'utf8',
  );
  const releaseRules = readFileSync(join(root, '.claude/rules/release.md'), 'utf8');
  const testingRules = readFileSync(join(root, '.claude/rules/testing.md'), 'utf8');

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
  assert.ok(portableScript.includes('D:\\\\SmartPerfettoData'));
  assert.ok(portableScript.includes('%LOCALAPPDATA%\\\\SmartPerfetto'));
  assert.match(portableScript, /SMARTPERFETTO_PORTABLE_DATA_DIR/);
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
  assert.ok(portableVerifier.includes('D:\\\\SmartPerfettoData'));
  assert.match(portableVerifier, /SMARTPERFETTO_PORTABLE_DATA_DIR/);
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

test('npm trusted publishing isolates release packaging from the OIDC publish credential', () => {
  const workflowPath = join(root, '.github/workflows/npm-publish.yml');
  assert.equal(
    existsSync(workflowPath),
    true,
    'the npm trusted publishing workflow must exist',
  );

  const backendPackage = JSON.parse(
    readFileSync(join(root, 'backend/package.json'), 'utf8'),
  );
  assert.deepEqual(backendPackage.repository, {
    type: 'git',
    url: 'https://github.com/Gracker/SmartPerfetto',
  });

  const workflow = readFileSync(workflowPath, 'utf8');
  const {packageJob, publishJob, propagationJob, smokeJob} =
    splitNpmPublishJobs(workflow);

  assert.match(workflow, /release:\s+types:\s+\[published\]/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*?release_id:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(packageJob, /refs\/heads\/\$\{DEFAULT_BRANCH\}/);
  assert.match(packageJob, /merge-base --is-ancestor "\$\{RELEASE_SHA\}" origin\/main/);
  assert.ok(packageJob.includes('/^[0-9a-f]{40}$/.test(release.target_commitish'));
  assert.ok(packageJob.includes('/^v[0-9]+\\.[0-9]+\\.[0-9]+$/.test(release.tag_name'));
  assert.match(packageJob, /npm run version:sync -- --check/);
  assert.match(packageJob, /npm run cli:pack-check/);
  assert.match(packageJob, /npm run cli:e2e/);
  assert.match(packageJob, /npm pack --silent --pack-destination/);
  assert.match(packageJob, /readdirSync/);
  assert.match(packageJob, /files\.length !== 1/);
  assert.doesNotMatch(packageJob, /PACKAGE_FILE="\$\(npm pack/);
  assert.match(packageJob, /createHash\('sha512'\)/);
  assert.match(packageJob, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.doesNotMatch(packageJob, /id-token:\s*write/);

  assert.equal((workflow.match(/id-token:\s*write/g) || []).length, 1);
  assert.match(publishJob, /id-token:\s*write/);
  assert.match(
    publishJob,
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
  );
  assert.match(publishJob, /dist\.integrity/);
  assert.match(publishJob, /REGISTRY_INTEGRITY/);
  assert.match(publishJob, /PACKAGE_INTEGRITY/);
  assert.match(publishJob, /npm publish "\$\{PACKAGE_PATH\}" --access public/);
  assert.doesNotMatch(publishJob, /actions\/checkout|npm ci|npm run|scripts\//);
  // The OIDC window ends with the publish; registry propagation is awaited by a
  // credential-free job so a slow registry never holds or re-enters it.
  assert.doesNotMatch(publishJob, /Wait for matching registry integrity|sleep/);

  assert.match(propagationJob, /needs:\s+- package\s+- publish\n/);
  assert.match(propagationJob, /permissions:\s+contents: read\n/);
  assert.doesNotMatch(propagationJob, /id-token|actions\/checkout|secrets\./);
  assert.match(propagationJob, /NPM_CONFIG_USERCONFIG:\s*\/dev\/null/);
  assert.match(propagationJob, /REGISTRY_WAIT_SECONDS: 900\n/);
  assert.match(propagationJob, /timeout-minutes: 25\n/);
  assert.match(smokeJob, /needs:\s+- package\s+- propagation\n/);

  assert.match(smokeJob, /NPM_CONFIG_USERCONFIG:\s*\/dev\/null/);
  assert.match(smokeJob, /npm install --no-audit --no-fund "@gracker\/smartperfetto@\$\{VERSION\}"/);
  assert.match(smokeJob, /packageJson\.bin\[binName\]/);
  assert.match(smokeJob, /spawnSync\(\s+process\.execPath/);
  assert.ok(smokeJob.includes("['smp', ['--version']]"));
  assert.ok(smokeJob.includes("['smartperfetto', ['--help']]"));
  assert.ok(smokeJob.includes("['smp', ['doctor', '--format', 'json']]"));
  // Only doctor may exit 1 without credentials, and only for the default Claude
  // runtime missing credentials; its native binary stays a required package check.
  assert.ok(smokeJob.includes("new Set(['smp:doctor --format json'])"));
  assert.ok(smokeJob.includes('reportsFailureAsData.has(key) ? [0, 1] : [0]'));
  assert.match(smokeJob, /\.filter\(\(check\) => check\.status === 'error'\)/);
  assert.match(smokeJob, /doctor\.aiPolicy\?\.aiEnabled === true/);
  assert.match(smokeJob, /doctor\.runtime\?\.kind === 'claude-agent-sdk'/);
  assert.match(smokeJob, /doctor\.runtime\?\.source === 'default'/);
  assert.match(smokeJob, /doctor\.runtimeDiagnostics\?\.configured === false/);
  assert.match(smokeJob, /check\.name === 'runtime' && defaultRuntimeWithoutCredentials/);
  assert.match(smokeJob, /check\.name === 'claude_sdk_binary'/);
  assert.match(smokeJob, /doctorRun\.status !== \(doctor\.ok \? 0 : 1\)/);
  assert.doesNotMatch(smokeJob, /node_modules\/\.bin/);
  assert.doesNotMatch(smokeJob, /id-token:\s*write/);

  assert.doesNotMatch(
    workflow,
    /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|secrets\.|npm --prefix backend publish/,
  );
});

function splitNpmPublishJobs(workflow) {
  const starts = ['  package:', '  publish:', '  propagation:', '  smoke:'].map(
    (header) => workflow.indexOf(`\n${header}\n`),
  );
  starts.forEach((start, index) => {
    assert.ok(start > (index === 0 ? -1 : starts[index - 1]), 'npm publish job order');
  });
  const [packageJob, publishJob, propagationJob, smokeJob] = starts.map(
    (start, index) => workflow.slice(start, starts[index + 1]),
  );
  return {packageJob, publishJob, propagationJob, smokeJob};
}

let npmPublishWorkflow;
function loadNpmPublishWorkflow() {
  npmPublishWorkflow ??= loadYaml(
    readFileSync(join(root, '.github/workflows/npm-publish.yml'), 'utf8'),
  );
  return npmPublishWorkflow;
}

// Runs one registry step of npm-publish.yml with `npm view` replaying the
// queued responses in order (repeating the last) and `sleep` only recording.
// Both are shell functions defined ahead of the step, so no PATH lookup can
// reach the real npm, the public registry, or a real sleep.
function runRegistryStep(jobName, findStep, responses) {
  const workflow = loadNpmPublishWorkflow();
  const job = workflow.jobs[jobName];
  const step = job.steps.find(findStep);
  assert.ok(step?.run, `missing ${jobName} registry step`);

  const dir = mkdtempSync(join(tmpdir(), 'npm-registry-step-'));
  try {
    const replies = join(dir, 'replies');
    mkdirSync(replies);
    responses.forEach(({status, stdout = '', stderr = ''}, index) => {
      writeFileSync(join(replies, `${index}.out`), stdout);
      writeFileSync(join(replies, `${index}.err`), stderr);
      writeFileSync(join(replies, `${index}.status`), String(status));
    });
    const fakes = `npm() {
  local n
  n=$(cat "${dir}/count" 2>/dev/null || echo 0)
  echo $((n + 1)) > "${dir}/count"
  echo "$*" >> "${dir}/argv.log"
  [ "$n" -lt ${responses.length} ] || n=${responses.length - 1}
  cat "${replies}/$n.out"
  cat "${replies}/$n.err" >&2
  return "$(cat "${replies}/$n.status")"
}
sleep() { echo "$1" >> "${dir}/sleep.log"; }
`;
    writeFileSync(join(dir, 'step.sh'), fakes + step.run);
    writeFileSync(join(dir, 'github-output'), '');
    // GitHub runs a `run:` block without an explicit shell as `bash -e {0}`.
    const result = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: {
        ...workflow.env,
        ...job.env,
        GITHUB_OUTPUT: join(dir, 'github-output'),
        GITHUB_RUN_ID: '4242',
        PACKAGE_INTEGRITY: WAIT_INTEGRITY,
        PATH: process.env.PATH,
        RUNNER_TEMP: dir,
        VERSION: '9.9.9',
      },
    });
    const readLines = (name) => existsSync(join(dir, name))
      ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)
      : [];
    return {
      ...result,
      githubOutput: readLines('github-output'),
      npmCalls: readLines('argv.log'),
      sleeps: readLines('sleep.log').map(Number),
    };
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

const runRegistryWait = (responses) => runRegistryStep(
  'propagation',
  (step) => step.name === 'Wait for matching registry integrity',
  responses,
);
const runPublishPrecheck = (responses) => runRegistryStep(
  'publish',
  (step) => step.id === 'registry',
  responses,
);

// The registry steps run on ubuntu-24.04 only; Windows may resolve `bash` to WSL.
const REGISTRY_STEP_TEST = {
  skip: process.platform === 'win32' && 'npm-publish.yml runs these steps on Linux',
};
const WAIT_INTEGRITY = 'sha512-expected==';
const E404 = {
  status: 1,
  stdout: '{"error":{"code":"E404","summary":"No match found for version 9.9.9"}}\n',
  stderr: 'npm error code E404\n',
};
const MATCHING_OUTPUTS = [
  `"${WAIT_INTEGRITY}"\n`, // npm 11
  `[\n  "${WAIT_INTEGRITY}"\n]\n`, // npm 12
];
const UNRECOGNISED_OUTPUTS = ['{}\n', '[]\n', '["a","b"]\n', ''];

test('npm registry wait backs off until the matching integrity appears', REGISTRY_STEP_TEST, () => {
  const result = runRegistryWait([
    E404,
    E404,
    {status: 1, stderr: 'npm error code ECONNRESET\n'},
    E404,
    {status: 0, stdout: MATCHING_OUTPUTS[0]},
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.sleeps, [5, 10, 20, 30]);
  assert.equal(result.npmCalls.length, 5);
  assert.equal(result.npmCalls[0], 'view @gracker/smartperfetto@9.9.9 dist.integrity --json');
  assert.match(result.stderr, /ECONNRESET/);
});

test('npm registry reads accept npm 11 and npm 12 integrity output', REGISTRY_STEP_TEST, () => {
  for (const stdout of MATCHING_OUTPUTS) {
    const wait = runRegistryWait([{status: 0, stdout}]);
    assert.equal(wait.status, 0, wait.stderr);
    assert.deepEqual(wait.sleeps, []);
    const precheck = runPublishPrecheck([{status: 0, stdout}]);
    assert.equal(precheck.status, 0, precheck.stderr);
    assert.deepEqual(precheck.githubOutput, ['already_published=true']);
  }
});

test('npm registry reads fail on a different published integrity', REGISTRY_STEP_TEST, () => {
  for (const stdout of ['"sha512-other=="\n', '["sha512-other=="]\n']) {
    const wait = runRegistryWait([E404, {status: 0, stdout}]);
    assert.equal(wait.status, 1);
    assert.deepEqual(wait.sleeps, [5]);
    assert.equal(wait.npmCalls.length, 2);
    assert.match(wait.stderr, /Registry integrity mismatch/);
    const precheck = runPublishPrecheck([{status: 0, stdout}]);
    assert.equal(precheck.status, 1);
    assert.deepEqual(precheck.githubOutput, []);
    assert.match(precheck.stderr, /Registry integrity mismatch/);
  }
});

test('npm registry reads fail closed on unrecognised npm view output', REGISTRY_STEP_TEST, () => {
  for (const stdout of UNRECOGNISED_OUTPUTS) {
    const wait = runRegistryWait([{status: 0, stdout}]);
    assert.equal(wait.status, 1, `wait accepted ${JSON.stringify(stdout)}`);
    assert.deepEqual(wait.sleeps, []);
    const precheck = runPublishPrecheck([{status: 0, stdout}]);
    assert.equal(precheck.status, 1, `pre-check accepted ${JSON.stringify(stdout)}`);
    assert.deepEqual(precheck.githubOutput, []);
  }
});

test('npm publish pre-check publishes only an unknown version', REGISTRY_STEP_TEST, () => {
  const missing = runPublishPrecheck([E404]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(missing.githubOutput, ['already_published=false']);

  const broken = runPublishPrecheck([{status: 7, stderr: 'npm error code E403\n'}]);
  assert.equal(broken.status, 7);
  assert.deepEqual(broken.githubOutput, []);
  assert.match(broken.stderr, /E403/);
});

test('npm registry wait is bounded by its sleep budget', REGISTRY_STEP_TEST, () => {
  const result = runRegistryWait([E404]);
  const budget = Number(loadNpmPublishWorkflow().jobs.propagation.env.REGISTRY_WAIT_SECONDS);
  assert.equal(result.status, 1);
  assert.equal(result.sleeps.reduce((sum, value) => sum + value, 0), budget);
  assert.ok(result.sleeps.every((value) => value > 0 && value <= 30));
  // One final check runs after the last sleep.
  assert.equal(result.npmCalls.length, result.sleeps.length + 1);
  assert.match(result.stderr, new RegExp(`within ${budget}s`));
  assert.match(result.stderr, /gh run rerun 4242 --failed/);
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
    /- name: Checkout\s+uses: actions\/checkout@v7\s+with:\s+submodules: recursive/,
  );
  assert.match(
    crossPlatform,
    /Fetch Perfetto source identity history[\s\S]*?rev-parse --is-shallow-repository[\s\S]*?fetch --unshallow --tags origin/,
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

test('local Deepseek E2E owns the source and RAG context matrix', () => {
  assert.equal(
    existsSync(join(root, '.github/workflows/agent-deepseek-e2e.yml')),
    false,
  );
  const runner = readFileSync(
    join(root, 'backend/scripts/run-deepseek-agent-e2e.cjs'),
    'utf8',
  );
  assert.match(
    runner,
    /const CONTEXT_SUITE_NAMES = \['context-source', 'context-rag', 'context-combined'\]/,
  );
  assert.match(runner, /loadBackendEnv\(\)/);
  assert.match(runner, /require\('dotenv'\)\.config\(\{ path: envPath, quiet: true \}\)/);
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const {
  buildPlan,
  collect,
  runSmoke,
  validatePlanReleaseBinding,
} = require(join(root, 'scripts/portable-release-smoke-workflow.cjs'));
const {
  download,
} = require(join(root, 'scripts/download-portable-release-asset.cjs'));
const {
  readNodeRuntimePin,
} = require(join(root, 'scripts/verify-portable-package.cjs'));
const {
  validateArtifactMetadata,
  validateAttestation,
  validateRepository,
  validateRun,
  validateWorkflowContexts,
} = require(join(root, 'scripts/verify-portable-smoke-attestation.cjs'));

function git(cwd, args) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function releaseMetadata(commit, overrides = {}) {
  const version = '1.2.4';
  const names = [
    `smartperfetto-v${version}-windows-x64.zip`,
    `smartperfetto-v${version}-macos-arm64.zip`,
    `smartperfetto-v${version}-linux-x64.tar.gz`,
  ];
  return {
    id: 4242,
    draft: true,
    prerelease: false,
    tag_name: `v${version}`,
    target_commitish: commit,
    name: `SmartPerfetto v${version}`,
    assets: names.map((name, index) => ({
      id: 5000 + index,
      name,
      state: 'uploaded',
      size: 100 + index,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
    ...overrides,
  };
}

function writeReleaseFile(work, commit, overrides = {}) {
  const releaseFile = join(work, 'release.json');
  writeFileSync(releaseFile, `${JSON.stringify(releaseMetadata(commit, overrides))}\n`);
  return releaseFile;
}

function setupGitFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'smartperfetto-smoke-plan-'));
  writeFileSync(join(cwd, 'release-product.txt'), 'immutable release product\n');
  git(cwd, ['init', '--quiet']);
  git(cwd, ['config', 'user.name', 'Smoke Plan Test']);
  git(cwd, ['config', 'user.email', 'smoke-plan@example.invalid']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', 'release contract']);
  const releaseCommit = git(cwd, ['rev-parse', 'HEAD']);
  mkdirSync(join(cwd, 'scripts'), {recursive: true});
  writeFileSync(join(cwd, 'scripts/smoke-portable-archive.cjs'), "'use strict';\n");
  writeFileSync(join(cwd, 'scripts/verify-portable-smoke-evidence.cjs'), "'use strict';\n");
  writeFileSync(join(cwd, 'gate.txt'), 'gate\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', 'gate']);
  const gateCommit = git(cwd, ['rev-parse', 'HEAD']);
  return {cwd, gateCommit, releaseCommit};
}

test('plan binds a script-free release SHA and marks windows-linux as partial', () => {
  const fixture = setupGitFixture();
  assert.equal(
    git(fixture.cwd, ['ls-tree', '-r', '--name-only', fixture.releaseCommit]),
    'release-product.txt',
  );
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: '4242',
    repository: 'Gracker/SmartPerfetto',
    selection: 'windows-linux',
  });
  assert.equal(plan.release.commitResolution, 'draft-target-sha');
  assert.equal(plan.scope, 'partial');
  assert.equal(plan.publicReleaseEligible, false);
  assert.deepEqual(
    plan.matrix.include.map(entry => [entry.target, entry.runner]),
    [
      ['windows-x64', 'windows-2025'],
      ['linux-x64', 'ubuntu-24.04'],
    ],
  );
});

test('plan peels an existing tag and rejects changed or incomplete releases', () => {
  const fixture = setupGitFixture();
  git(fixture.cwd, ['tag', '-a', 'v1.2.4', fixture.releaseCommit, '-m', 'release']);
  const release = releaseMetadata(fixture.releaseCommit);
  const plan = buildPlan(release, {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'all',
  });
  assert.equal(plan.release.commitResolution, 'peeled-tag');
  assert.equal(plan.publicReleaseEligible, true);
  assert.throws(
    () => buildPlan({...release, draft: false, tag_name: 'v1.2.5'}, {
      cwd: fixture.cwd,
      gateSha: fixture.gateCommit,
      releaseId: 4242,
      repository: 'Gracker/SmartPerfetto',
      selection: 'all',
    }),
    /immutable draft|title must be|tag .* unavailable/,
  );
  assert.throws(
    () => buildPlan({...release, assets: release.assets.slice(0, 2)}, {
      cwd: fixture.cwd,
      gateSha: fixture.gateCommit,
      releaseId: 4242,
      repository: 'Gracker/SmartPerfetto',
      selection: 'all',
    }),
    /must contain exactly one/,
  );
});

test('release binding rejects asset replacement after planning', () => {
  const fixture = setupGitFixture();
  const release = releaseMetadata(fixture.releaseCommit);
  const plan = buildPlan(release, {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'windows-x64',
  });
  assert.equal(validatePlanReleaseBinding(plan, release, 'windows-x64').assetId, 5000);
  const replaced = structuredClone(release);
  replaced.assets[0].id = 9999;
  assert.throws(
    () => validatePlanReleaseBinding(plan, replaced, 'windows-x64'),
    /asset identity changed/,
  );
});

test('native download streams exact binary bytes and removes a digest mismatch', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'smartperfetto-download-'));
  const fakeBin = join(fixture, 'bin');
  mkdirSync(fakeBin);
  const bytes = Buffer.from([0, 255, 1, 2, 3, 10, 13]);
  const gh = join(fakeBin, process.platform === 'win32' ? 'gh.cmd' : 'gh');
  if (process.platform === 'win32') {
    writeFileSync(gh, `@node -e "process.stdout.write(Buffer.from([0,255,1,2,3,10,13]))"\r\n`);
  } else {
    writeFileSync(gh, '#!/bin/sh\nnode -e \'process.stdout.write(Buffer.from([0,255,1,2,3,10,13]))\'\n');
    chmodSync(gh, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  try {
    const output = join(fixture, 'asset.zip');
    download({
      repository: 'Gracker/SmartPerfetto',
      assetId: '123',
      assetName: 'asset.zip',
      assetSize: String(bytes.length),
      assetDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      output,
    });
    assert.deepEqual(readFileSync(output), bytes);
    assert.throws(
      () => download({
        repository: 'Gracker/SmartPerfetto',
        assetId: '123',
        assetName: 'bad.zip',
        assetSize: String(bytes.length),
        assetDigest: `sha256:${'0'.repeat(64)}`,
        output: join(fixture, 'bad.zip'),
      }),
      /downloaded bytes mismatch/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test('fixed gate smoke code runs without tokens and release code cannot execute', () => {
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-smoke-env-'));
  const releaseRoot = join(work, 'release');
  const gateRoot = join(work, 'gate');
  const evidenceRoot = join(work, 'evidence');
  const planFile = join(work, 'plan.json');
  const asset = join(work, 'asset.tar.gz');
  const releaseSentinel = join(work, 'release-code-executed');
  mkdirSync(join(releaseRoot, 'scripts'), {recursive: true});
  mkdirSync(join(gateRoot, 'scripts'), {recursive: true});
  writeFileSync(asset, 'archive bytes\n');
  writeFileSync(planFile, `${JSON.stringify({
    gateSha: 'b'.repeat(40),
    release: {version: '1.2.4', commit: 'a'.repeat(40)},
    matrix: {include: [{target: 'linux-x64'}]},
  })}\n`);
  writeFileSync(
    join(releaseRoot, 'scripts', 'smoke-portable-archive.cjs'),
    `'use strict';\nrequire('fs').writeFileSync(${JSON.stringify(releaseSentinel)}, 'executed');\n`,
  );
  writeFileSync(
    join(releaseRoot, 'scripts', 'verify-portable-smoke-evidence.cjs'),
    `'use strict';\nrequire('fs').writeFileSync(${JSON.stringify(releaseSentinel)}, 'executed');\n`,
  );
  writeFileSync(
    join(gateRoot, 'scripts', 'smoke-portable-archive.cjs'),
    `'use strict';
const fs = require('fs');
const path = require('path');
const output = process.argv[process.argv.indexOf('--output-dir') + 1];
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(path.join(output, 'received-env.json'), JSON.stringify({
  GH_TOKEN: process.env.GH_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN,
  GITHUB_ENV: process.env.GITHUB_ENV,
  GITHUB_PATH: process.env.GITHUB_PATH,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}));
`,
  );
  const keys = [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'NODE_OPTIONS',
    'OPENAI_API_KEY',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `${key}-secret`;
  try {
    runSmoke({
      plan: planFile,
      gateRoot,
      target: 'linux-x64',
      asset,
      evidenceRoot,
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  assert.deepEqual(
    JSON.parse(readFileSync(
      join(evidenceRoot, 'linux-x64', 'smoke', 'received-env.json'),
      'utf8',
    )),
    {},
  );
  assert.equal(existsSync(releaseSentinel), false);
});

test('collection preserves an explicit failed attestation when target evidence is missing', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'windows-x64',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-collect-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  assert.throws(
    () => collect({
      plan: planFile,
      releaseJson: releaseFile,
      artifactsRoot: work,
      workflow: 'Portable Exact Archive Smoke',
      repositoryId: '99',
      workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
      workflowSha: plan.gateSha,
      runId: '1234',
      runAttempt: '1',
      attestationOut: attestationFile,
    }),
    /did not produce verified evidence/,
  );
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'));
  assert.equal(attestation.success, false);
  assert.equal(attestation.publicReleaseEligible, false);
  assert.equal(attestation.targets[0].success, false);
});

function writeCollectedTarget(rootPath, plan, entry, run = {}, layout = 'multi') {
  const artifactRoot = layout === 'single'
    ? join(rootPath, entry.target)
    : join(
      rootPath,
      `portable-smoke-${plan.release.id}-${entry.target}`,
      entry.target,
    );
  const smokeRoot = join(artifactRoot, 'smoke');
  mkdirSync(smokeRoot, {recursive: true});
  const ports = {backend: 3100, frontend: 10100};
  const summaryValue = {
    schemaVersion: 2,
    success: true,
    asset: {
      name: entry.assetName,
      size: entry.assetSize,
      sha256: entry.assetDigest.slice('sha256:'.length),
    },
    target: entry.target,
    version: plan.release.version,
    commit: plan.release.commit,
    gitDirty: false,
    publicRelease: true,
    processTree: {
      enumerationSucceeded: true,
      failures: [],
      observedPids: [101, 102],
      samples: 4,
      survivingPids: [],
    },
    host: {platform: entry.platform, arch: entry.arch},
    healthProbe: entry.target === 'windows-x64'
      ? 'windows-go-net-http'
      : 'node-http',
    ports,
    health: {
      backend: {status: 'OK', version: plan.release.version},
      frontend: {status: 'OK', version: 'v57'},
    },
    runtimes: {
      node: {stdout: `v${readNodeRuntimePin(entry.target).version}`, stderr: ''},
      claude: {stdout: '1.0.0', stderr: ''},
      opencode: {stdout: '1.0.0', stderr: ''},
      traceProcessor: {stdout: 'smartperfetto_smoke\n1', stderr: ''},
      ...(entry.target === 'linux-x64'
        ? {libc: {stdout: '2.34', stderr: ''}}
        : {}),
      ...(entry.target === 'macos-arm64'
        ? {
            macosRelease: {
              codesign: {stdout: '', stderr: 'valid on disk'},
              gatekeeper: {
                stdout: '',
                stderr: 'accepted\nsource=Notarized Developer ID',
              },
              staple: {stdout: 'validate action worked', stderr: ''},
              notarytool: {
                schemaVersion: 1,
                status: 'Accepted',
                submissionId: '01234567-89ab-cdef-0123-456789abcdef',
              },
            },
          }
        : {}),
    },
    lifecycleReceipt: {
      schemaVersion: 2,
      version: plan.release.version,
      gitCommit: plan.release.commit,
      packageTarget: entry.target,
      containment: entry.target === 'windows-x64'
        ? 'windows-job-object'
        : 'service-process-groups',
      exitReason: 'shutdown-file',
      success: true,
      ports: {...ports, released: true},
      services: [
        {
          name: 'backend',
          pid: 101,
          gracefulRequested: true,
          escalated: false,
          result: {exitCode: 0, success: true},
        },
        {
          name: 'frontend',
          pid: 102,
          gracefulRequested: true,
          escalated: false,
          result: {exitCode: 0, success: true},
        },
      ],
      finishedAt: new Date().toISOString(),
    },
    finishedAt: new Date().toISOString(),
  };
  const summary = Buffer.from(`${JSON.stringify(summaryValue)}\n`);
  writeFileSync(join(smokeRoot, 'smoke-summary.json'), summary);
  writeFileSync(join(artifactRoot, 'workflow-context.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'prepared',
    repository: plan.repository,
    repositoryId: run.repositoryId ?? 99,
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: `${plan.repository}/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main`,
    workflowSha: plan.gateSha,
    runId: run.runId ?? 1234,
    runAttempt: 1,
    gateSha: plan.gateSha,
    selection: plan.selection,
    scope: plan.scope,
    release: plan.release,
    asset: entry,
    host: {
      platform: entry.platform,
      arch: entry.arch,
    },
  })}\n`);
}

test('successful partial collection uses the real artifact layout but emits no promotion evidence', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'windows-linux',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-collect-partial-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
    releaseJson: releaseFile,
    artifactsRoot: work,
    repositoryId: '99',
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
    workflowSha: plan.gateSha,
    runId: '1234',
    runAttempt: '1',
    attestationOut: attestationFile,
  });
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'));
  assert.equal(attestation.success, true);
  assert.equal(attestation.scope, 'partial');
  assert.equal(attestation.publicReleaseEligible, false);
  assert.equal(existsSync(join(work, 'promotion-evidence')), false);
});

test('single-target download-artifact layout remains a successful partial diagnostic', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'linux-x64',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-collect-single-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  writeCollectedTarget(work, plan, plan.matrix.include[0], {}, 'single');
  collect({
    plan: planFile,
    releaseJson: releaseFile,
    artifactsRoot: work,
    repositoryId: '99',
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
    workflowSha: plan.gateSha,
    runId: '1234',
    runAttempt: '1',
    attestationOut: attestationFile,
  });
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'));
  assert.equal(attestation.success, true);
  assert.equal(attestation.scope, 'partial');
  assert.equal(existsSync(join(work, 'promotion-evidence')), false);
});

test('fresh collection rejects a release asset replaced after the smoke plan', () => {
  const fixture = setupGitFixture();
  const release = releaseMetadata(fixture.releaseCommit);
  const plan = buildPlan(release, {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'linux-x64',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-collect-replaced-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit, {
    assets: release.assets.map((asset) => (
      asset.id === 5002 ? {...asset, id: 9999} : asset
    )),
  });
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  writeCollectedTarget(work, plan, plan.matrix.include[0], {}, 'single');
  assert.throws(
    () => collect({
      plan: planFile,
      releaseJson: releaseFile,
      artifactsRoot: work,
      repositoryId: '99',
      workflow: 'Portable Exact Archive Smoke',
      workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
      workflowSha: plan.gateSha,
      runId: '1234',
      runAttempt: '1',
      attestationOut: join(work, 'attestation.json'),
    }),
    /asset identity changed/,
  );
});

test('only a complete successful collection creates normalized promotion evidence', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'all',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-collect-all-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
    releaseJson: releaseFile,
    artifactsRoot: work,
    repositoryId: '99',
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
    workflowSha: plan.gateSha,
    runId: '1234',
    runAttempt: '1',
    attestationOut: attestationFile,
  });
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'));
  assert.equal(attestation.publicReleaseEligible, true);
  for (const entry of plan.matrix.include) {
    assert.equal(
      existsSync(join(work, 'promotion-evidence', entry.target, 'smoke-summary.json')),
      true,
    );
  }
});

function hostedExpectation(plan) {
  return {
    repository: plan.repository,
    repositoryId: 99,
    defaultBranch: 'main',
    releaseId: plan.release.id,
    runId: 1234,
    commit: plan.release.commit,
    gateSha: plan.gateSha,
    version: plan.release.version,
  };
}

function hostedRun(plan, overrides = {}) {
  return {
    id: 1234,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/portable-exact-archive-smoke.yml',
    head_sha: plan.gateSha,
    head_branch: 'main',
    repository: {
      id: 99,
      full_name: plan.repository,
    },
    ...overrides,
  };
}

test('hosted attestation validators bind complete scope, run identity, and artifact digest', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'all',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-attestation-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
    releaseJson: releaseFile,
    artifactsRoot: work,
    repositoryId: '99',
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
    workflowSha: plan.gateSha,
    runId: '1234',
    runAttempt: '1',
    attestationOut: attestationFile,
  });
  const attestation = JSON.parse(readFileSync(attestationFile, 'utf8'));
  assert.deepEqual(
    validateRepository({
      id: 99,
      full_name: plan.repository,
      default_branch: 'main',
    }, {repository: plan.repository}),
    {repositoryId: 99, defaultBranch: 'main'},
  );
  const expected = validateAttestation(attestation, hostedExpectation(plan));
  assert.equal(validateRun(hostedRun(plan), expected).id, 1234);
  assert.equal(
    validateArtifactMetadata({
      artifacts: [{
        id: 9876,
        name: 'portable-smoke-evidence-release-4242',
        expired: false,
        digest: `sha256:${'a'.repeat(64)}`,
        workflow_run: {id: 1234, head_sha: plan.gateSha},
      }],
    }, expected).id,
    9876,
  );

  assert.throws(
    () => validateAttestation({...attestation, scope: 'partial'}, hostedExpectation(plan)),
    /complete all-target/,
  );
  assert.throws(
    () => validateAttestation({
      ...attestation,
      workflowRef: `${plan.repository}/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/untrusted-feature`,
    }, hostedExpectation(plan)),
    /default branch/,
  );
  assert.throws(
    () => validateAttestation(
      {...attestation, gateSha: fixture.releaseCommit, workflowSha: fixture.releaseCommit},
      hostedExpectation(plan),
    ),
    /trusted gate identity/,
  );
  assert.throws(
    () => validateRun(hostedRun(plan, {run_attempt: 2}), expected),
    /run identity/,
  );
  assert.throws(
    () => validateRun(hostedRun(plan, {head_sha: fixture.releaseCommit}), expected),
    /run identity/,
  );
  assert.throws(
    () => validateArtifactMetadata({
      artifacts: [{
        id: 9876,
        name: 'portable-smoke-evidence-release-4242',
        expired: false,
        digest: 'sha256:missing',
        workflow_run: {id: 1234, head_sha: plan.gateSha},
      }],
    }, expected),
    /artifact identity/,
  );

  const localEvidence = join(work, 'local-evidence');
  cpSync(join(work, 'promotion-evidence'), localEvidence, {recursive: true});
  assert.doesNotThrow(() => validateWorkflowContexts(
    work,
    localEvidence,
    releaseMetadata(fixture.releaseCommit),
    attestation,
    expected,
  ));
  writeFileSync(
    join(localEvidence, 'linux-x64', 'smoke-summary.json'),
    '{"target":"linux-x64","success":false}\n',
  );
  assert.throws(
    () => validateWorkflowContexts(
      work,
      localEvidence,
      releaseMetadata(fixture.releaseCommit),
      attestation,
      expected,
    ),
    /differs from the digest-verified Actions artifact/,
  );
});

test('hosted verifier re-downloads and hashes the combined GitHub artifact', () => {
  const fixture = setupGitFixture();
  const plan = buildPlan(releaseMetadata(fixture.releaseCommit), {
    cwd: fixture.cwd,
    gateSha: fixture.gateCommit,
    releaseId: 4242,
    repository: 'Gracker/SmartPerfetto',
    selection: 'all',
  });
  const work = mkdtempSync(join(tmpdir(), 'smartperfetto-hosted-verifier-'));
  const planFile = join(work, 'plan.json');
  const releaseFile = writeReleaseFile(work, fixture.releaseCommit);
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
    releaseJson: releaseFile,
    artifactsRoot: work,
    repositoryId: '99',
    workflow: 'Portable Exact Archive Smoke',
    workflowRef: 'Gracker/SmartPerfetto/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/main',
    workflowSha: plan.gateSha,
    runId: '1234',
    runAttempt: '1',
    attestationOut: attestationFile,
  });

  const artifactZip = join(work, 'combined.zip');
  const zip = process.platform === 'win32'
    ? spawnSync(
      'tar',
      ['-a', '-cf', artifactZip, 'portable-smoke-attestation.json', 'promotion-evidence'],
      {cwd: work, encoding: 'utf8'},
    )
    : spawnSync(
      'zip',
      ['-qr', artifactZip, 'portable-smoke-attestation.json', 'promotion-evidence'],
      {cwd: work, encoding: 'utf8'},
    );
  assert.equal(zip.status, 0, zip.stderr);
  const artifactDigest = `sha256:${createHash('sha256').update(readFileSync(artifactZip)).digest('hex')}`;
  const fakeBin = join(work, 'bin');
  mkdirSync(fakeBin);
  const fakeGhScript = join(fakeBin, 'fake-gh.cjs');
  writeFileSync(fakeGhScript, `'use strict';
const fs = require('fs');
const endpoint = process.argv[3];
const run = {
  id: 1234,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  path: '.github/workflows/portable-exact-archive-smoke.yml',
  head_sha: process.env.FAKE_GATE_SHA,
  head_branch: 'main',
  repository: {id: 99, full_name: 'Gracker/SmartPerfetto'},
};
if (endpoint === 'repos/Gracker/SmartPerfetto/actions/runs/1234') {
  process.stdout.write(JSON.stringify(run));
} else if (endpoint === 'repos/Gracker/SmartPerfetto') {
  process.stdout.write(JSON.stringify({
    id: 99,
    full_name: 'Gracker/SmartPerfetto',
    default_branch: 'main',
  }));
} else if (endpoint === 'repos/Gracker/SmartPerfetto/actions/runs/1234/artifacts?per_page=100') {
  process.stdout.write(JSON.stringify({artifacts: [{
    id: 9876,
    name: 'portable-smoke-evidence-release-4242',
    expired: false,
    digest: process.env.FAKE_ARTIFACT_DIGEST,
    workflow_run: {id: 1234, head_sha: process.env.FAKE_GATE_SHA},
  }]}));
} else if (endpoint === 'repos/Gracker/SmartPerfetto/actions/artifacts/9876/zip') {
  process.stdout.write(fs.readFileSync(process.env.FAKE_ARTIFACT_ZIP));
} else {
  process.exit(2);
}
`);
  if (process.platform === 'win32') {
    writeFileSync(join(fakeBin, 'gh.cmd'), '@node "%~dp0fake-gh.cjs" %*\r\n');
  } else {
    const gh = join(fakeBin, 'gh');
    writeFileSync(gh, `#!/usr/bin/env node\nrequire('./fake-gh.cjs');\n`);
    chmodSync(gh, 0o755);
  }
  const verifierArgs = [
    join(root, 'scripts/verify-portable-smoke-attestation.cjs'),
    '--attestation', attestationFile,
    '--evidence-dir', join(work, 'promotion-evidence'),
    '--release-json', releaseFile,
    '--repository', plan.repository,
    '--release-id', String(plan.release.id),
    '--version', plan.release.version,
    '--commit', plan.release.commit,
    '--run-id', '1234',
    '--gate-sha', plan.gateSha,
  ];
  const verifierEnv = {
    ...process.env,
    PATH: `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    FAKE_ARTIFACT_ZIP: artifactZip,
    FAKE_ARTIFACT_DIGEST: artifactDigest,
    FAKE_GATE_SHA: plan.gateSha,
  };
  const success = spawnSync(process.execPath, verifierArgs, {
    cwd: root,
    encoding: 'utf8',
    env: verifierEnv,
  });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Hosted portable smoke attestation verified/);

  const mismatch = spawnSync(process.execPath, verifierArgs, {
    cwd: root,
    encoding: 'utf8',
    env: {...verifierEnv, FAKE_ARTIFACT_DIGEST: `sha256:${'0'.repeat(64)}`},
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /downloaded combined artifact does not match/);
});

test('workflow fixes trust roots, target hosts, token scope, and evidence layout', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/portable-exact-archive-smoke.yml'),
    'utf8',
  );
  const helper = readFileSync(
    join(root, 'scripts/portable-release-smoke-workflow.cjs'),
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: portable-exact-archive-smoke-\$\{\{ inputs\.release_id \}\}/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.equal(workflow.match(/permissions:\s+contents: write/g)?.length, 3);
  assert.match(workflow, /download:[\s\S]*?permissions:\s+contents: write/);
  assert.match(workflow, /smoke:[\s\S]*?permissions:\s+contents: read/);
  assert.match(workflow, /collect:[\s\S]*?permissions:\s+contents: write/);
  assert.match(workflow, /dispatch must use/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.gate_sha \}\}/);
  assert.doesNotMatch(workflow, /outputs\.release_sha|path: release|--release-root/);
  assert.match(workflow, /persist-credentials: false/g);
  assert.match(helper, /runner: 'windows-2025'/);
  assert.match(helper, /runner: 'ubuntu-24\.04'/);
  assert.match(helper, /runner: 'macos-15'/);
  assert.match(workflow, /download-portable-release-asset\.cjs/);
  assert.match(helper, /'--public-release'/);
  assert.match(workflow, /Re-fetch release metadata after download/);
  assert.match(workflow, /Preserve exact asset bytes for the credential-free native smoke/);
  assert.match(workflow, /Restore exact asset bytes without a write-capable token/);
  assert.match(workflow, /--gate-root gate/);
  assert.match(
    workflow,
    /actions\/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7/,
  );
  assert.match(workflow, /go-version: '1\.25\.0'/);
  assert.match(workflow, /go test[\s\S]*?portable-health-probe\/main_test\.go/);
  assert.match(workflow, /go build -trimpath[\s\S]*?portable-health-probe\/main\.go/);
  assert.match(
    workflow,
    /SMARTPERFETTO_WINDOWS_HEALTH_PROBE_PATH: \$\{\{ runner\.temp \}\}\/smartperfetto-health-probe\.exe/,
  );
  assert.equal(
    workflow.match(
      /SMARTPERFETTO_WINDOWS_HEALTH_PROBE_PATH: \$\{\{ runner\.temp \}\}\/smartperfetto-health-probe\.exe/g,
    )?.length,
    3,
  );
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf('runs-on: ${{ matrix.runner }}'),
      workflow.indexOf('steps:', workflow.indexOf('runs-on: ${{ matrix.runner }}')),
    ),
    /SMARTPERFETTO_WINDOWS_HEALTH_PROBE_PATH/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ matrix\.target == 'windows-x64' \}\}[\s\S]*?Windows health probe runs its real fixed Go contract on Windows/,
  );
  assert.match(workflow, /Fetch the unchanged draft after target smoke/);
  assert.match(workflow, /Preserve untrusted target evidence and logs/);
  assert.match(workflow, /merge-multiple: false/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  const postContractTargetJob = workflow.slice(
    workflow.indexOf('Run the release contract'),
    workflow.indexOf('\n  collect:'),
  );
  assert.equal(
    postContractTargetJob.includes('GH_TOKEN'),
    false,
  );
  const smokeJob = workflow.slice(
    workflow.indexOf('\n  smoke:'),
    workflow.indexOf('\n  collect:'),
  );
  assert.match(
    smokeJob,
    /if: \$\{\{ always\(\) && needs\.prepare\.result == 'success' \}\}/,
  );
  assert.equal(smokeJob.includes('contents: write'), false);
  assert.equal(smokeJob.includes('GH_TOKEN'), false);
  assert.ok(
    workflow.indexOf('Fetch the unchanged draft after target smoke') <
      workflow.indexOf('Restore target evidence without merging paths'),
  );
  assert.match(workflow, /collect[\s\S]*?--release-json/);
  assert.match(helper, /verify-portable-smoke-evidence\.cjs/);
  assert.match(
    helper,
    /path\.join\(gateRoot, 'scripts', 'smoke-portable-archive\.cjs'\)/,
  );
  assert.doesNotMatch(helper, /releaseRoot|function finalize|command === 'finalize'/);
  for (const action of [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
  ]) {
    assert.match(workflow, new RegExp(action.replace('/', '\\/')));
  }
});

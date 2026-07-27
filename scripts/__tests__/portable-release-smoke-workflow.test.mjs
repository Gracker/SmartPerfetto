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
  validatePlanReleaseBinding,
} = require(join(root, 'scripts/portable-release-smoke-workflow.cjs'));
const {
  download,
} = require(join(root, 'scripts/download-portable-release-asset.cjs'));
const {
  validateArtifactMetadata,
  validateAttestation,
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

function setupGitFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'smartperfetto-smoke-plan-'));
  mkdirSync(join(cwd, 'scripts'), {recursive: true});
  writeFileSync(join(cwd, 'scripts/smoke-portable-archive.cjs'), "'use strict';\n");
  writeFileSync(join(cwd, 'scripts/verify-portable-smoke-evidence.cjs'), "'use strict';\n");
  git(cwd, ['init', '--quiet']);
  git(cwd, ['config', 'user.name', 'Smoke Plan Test']);
  git(cwd, ['config', 'user.email', 'smoke-plan@example.invalid']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', 'release contract']);
  const releaseCommit = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, 'gate.txt'), 'gate\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', 'gate']);
  const gateCommit = git(cwd, ['rev-parse', 'HEAD']);
  return {cwd, gateCommit, releaseCommit};
}

test('plan binds a draft full SHA and marks windows-linux as partial', () => {
  const fixture = setupGitFixture();
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
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  assert.throws(
    () => collect({
      plan: planFile,
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
  const summary = Buffer.from(`${JSON.stringify({target: entry.target, success: true})}\n`);
  writeFileSync(join(smokeRoot, 'smoke-summary.json'), summary);
  writeFileSync(join(artifactRoot, 'workflow-context.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'verified',
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
    smokeSummarySha256: createHash('sha256').update(summary).digest('hex'),
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
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
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
  const attestationFile = join(work, 'attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  writeCollectedTarget(work, plan, plan.matrix.include[0], {}, 'single');
  collect({
    plan: planFile,
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
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
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
    releaseId: plan.release.id,
    runId: 1234,
    commit: plan.release.commit,
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
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
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
  const releaseFile = join(work, 'release.json');
  const attestationFile = join(work, 'portable-smoke-attestation.json');
  writeFileSync(planFile, `${JSON.stringify(plan)}\n`);
  writeFileSync(releaseFile, `${JSON.stringify(releaseMetadata(fixture.releaseCommit))}\n`);
  for (const entry of plan.matrix.include) writeCollectedTarget(work, plan, entry);
  collect({
    plan: planFile,
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
  assert.match(workflow, /dispatch must use/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.gate_sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/g);
  assert.match(helper, /runner: 'windows-2025'/);
  assert.match(helper, /runner: 'ubuntu-24\.04'/);
  assert.match(helper, /runner: 'macos-15'/);
  assert.match(workflow, /download-portable-release-asset\.cjs/);
  assert.match(helper, /'--public-release'/);
  assert.match(workflow, /Re-fetch release metadata after download/);
  assert.match(workflow, /Re-fetch release metadata after smoke/);
  assert.match(workflow, /Verify evidence with both release and gate contracts/);
  assert.match(workflow, /merge-multiple: false/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  const finalizeStep = workflow.slice(
    workflow.indexOf('Verify evidence with both release and gate contracts'),
    workflow.indexOf('Preserve target evidence and logs'),
  );
  assert.equal(finalizeStep.match(/--release-json/g)?.length, 1);
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf('Run the release contract'),
      workflow.indexOf('Re-fetch release metadata after smoke'),
    ),
    /GH_TOKEN|GITHUB_TOKEN/,
  );
  for (const action of [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
  ]) {
    assert.match(workflow, new RegExp(action.replace('/', '\\/')));
  }
});

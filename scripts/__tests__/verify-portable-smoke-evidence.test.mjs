// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  identifyExpectedAsset,
  parseArgs,
  updateWorkflowContext,
  validateReleaseBinding,
  validateSmokeSummary,
} = require(path.join(repoRoot, 'scripts/verify-portable-smoke-evidence.cjs'));

function validSummary() {
  return {
    schemaVersion: 2,
    success: true,
    asset: {
      name: 'smartperfetto-v1.2.3-linux-x64.tar.gz',
      size: 123,
      sha256: 'a'.repeat(64),
    },
    target: 'linux-x64',
    version: '1.2.3',
    commit: 'abc123',
    gitDirty: false,
    publicRelease: true,
    processTree: {
      enumerationSucceeded: true,
      failures: [],
      observedPids: [101, 102],
      samples: 4,
      survivingPids: [],
    },
    host: {platform: 'linux', arch: 'x64'},
    healthProbe: 'node-http',
    ports: {backend: 3100, frontend: 10100},
    health: {
      backend: {status: 'OK', version: '1.2.3'},
      frontend: {status: 'OK', version: 'v57'},
    },
    runtimes: {
      node: {stdout: 'v24.18.0', stderr: ''},
      claude: {stdout: '1.0.0', stderr: ''},
      opencode: {stdout: '1.0.0', stderr: ''},
      traceProcessor: {stdout: 'smartperfetto_smoke\n1', stderr: ''},
      libc: {stdout: '2.34', stderr: ''},
    },
    lifecycleReceipt: {
      schemaVersion: 2,
      version: '1.2.3',
      gitCommit: 'abc123',
      packageTarget: 'linux-x64',
      containment: 'service-process-groups',
      exitReason: 'shutdown-file',
      success: true,
      ports: {backend: 3100, frontend: 10100, released: true},
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
}

function expected(summary) {
  return {
    asset: summary.asset,
    commit: summary.commit,
    requirePublicRelease: true,
    target: summary.target,
    version: summary.version,
  };
}

test('metadata-only asset identity requires complete hosted release binding', async () => {
  const options = {
    assetName: 'smartperfetto-v1.2.3-linux-x64.tar.gz',
    assetSize: '123',
    assetDigest: `sha256:${'a'.repeat(64)}`,
    releaseJson: 'release.json',
    releaseId: '4242',
    assetId: '5002',
    workflowContext: 'workflow-context.json',
  };
  assert.deepEqual(await identifyExpectedAsset(options), {
    name: options.assetName,
    size: 123,
    sha256: 'a'.repeat(64),
  });
  await assert.rejects(
    () => identifyExpectedAsset({...options, workflowContext: undefined}),
    /complete release and workflow binding/,
  );
  await assert.rejects(
    () => identifyExpectedAsset({...options, assetName: '../asset.zip'}),
    /plain filename/,
  );
  assert.deepEqual(
    parseArgs([
      '--asset-name', options.assetName,
      '--asset-size', options.assetSize,
      '--asset-digest', options.assetDigest,
      '--release-json', options.releaseJson,
      '--release-id', options.releaseId,
      '--asset-id', options.assetId,
      '--workflow-context', options.workflowContext,
      '--require-public-release',
    ]),
    {...options, requirePublicRelease: true},
  );
});

test('public release evidence binds target-native smoke to exact archive bytes', () => {
  const summary = validSummary();
  assert.equal(validateSmokeSummary(summary, expected(summary)), summary);
  for (const candidate of [
    {...summary, publicRelease: false},
    {...summary, gitDirty: true},
    {
      ...summary,
      processTree: {
        ...summary.processTree,
        enumerationSucceeded: false,
        failures: ['process enumeration failed'],
      },
    },
    {...summary, host: {platform: 'darwin', arch: 'arm64'}},
    {...summary, healthProbe: 'windows-powershell-5.1-httpwebrequest'},
    {...summary, asset: {...summary.asset, sha256: 'b'.repeat(64)}},
    {...summary, health: {...summary.health, backend: {status: 'OK', version: 'old'}}},
    {...summary, runtimes: {...summary.runtimes, libc: {stdout: '2.33', stderr: ''}}},
    {...summary, runtimes: {...summary.runtimes, claude: null}},
    {...summary, runtimes: {...summary.runtimes, opencode: null}},
    {
      ...summary,
      runtimes: {
        ...summary.runtimes,
        node: {stdout: 'v24.1.0', stderr: ''},
      },
    },
    {
      ...summary,
      runtimes: {
        ...summary.runtimes,
        traceProcessor: {stdout: 'smartperfetto_smoke\n0', stderr: ''},
      },
    },
    {...summary, lifecycleReceipt: {...summary.lifecycleReceipt, services: []}},
  ]) {
    assert.throws(
      () => validateSmokeSummary(candidate, expected(summary)),
      /smoke evidence|lifecycle receipt/,
    );
  }
});

test('public macOS evidence requires native release trust checks', () => {
  const summary = validSummary();
  summary.target = 'macos-arm64';
  summary.host = {platform: 'darwin', arch: 'arm64'};
  summary.asset.name = 'smartperfetto-v1.2.3-macos-arm64.zip';
  summary.lifecycleReceipt.packageTarget = 'macos-arm64';
  assert.throws(
    () => validateSmokeSummary(summary, expected(summary)),
    /codesign, Gatekeeper, or staple/,
  );
  summary.runtimes.macosRelease = {
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
  };
  assert.equal(validateSmokeSummary(summary, expected(summary)), summary);
  assert.throws(
    () => validateSmokeSummary({
      ...summary,
      runtimes: {
        ...summary.runtimes,
        macosRelease: {
          ...summary.runtimes.macosRelease,
          gatekeeper: {stdout: '', stderr: 'accepted\nsource=Developer ID'},
        },
      },
    }, expected(summary)),
    /not Notarized Developer ID/,
  );
  assert.throws(
    () => validateSmokeSummary({
      ...summary,
      runtimes: {
        ...summary.runtimes,
        macosRelease: {
          ...summary.runtimes.macosRelease,
          notarytool: {
            ...summary.runtimes.macosRelease.notarytool,
            status: 'Invalid',
          },
        },
      },
    }, expected(summary)),
    /Accepted notarytool info receipt/,
  );
});

test('public Windows evidence requires the fixed Go health client', () => {
  const summary = validSummary();
  summary.target = 'windows-x64';
  summary.host = {platform: 'win32', arch: 'x64'};
  summary.healthProbe = 'windows-go-net-http';
  summary.asset.name = 'smartperfetto-v1.2.3-windows-x64.zip';
  summary.lifecycleReceipt.packageTarget = 'windows-x64';
  summary.lifecycleReceipt.containment = 'windows-job-object';
  delete summary.runtimes.libc;

  assert.equal(validateSmokeSummary(summary, expected(summary)), summary);
  assert.throws(
    () => validateSmokeSummary(
      {...summary, healthProbe: 'node-http'},
      expected(summary),
    ),
    /required target-native health probe/,
  );
});

test('hosted evidence binds release id, asset id, and immutable workflow context', () => {
  const summary = validSummary();
  const releaseId = 4242;
  const assetId = 5002;
  const release = {
    id: releaseId,
    draft: true,
    prerelease: false,
    tag_name: 'v1.2.3',
    target_commitish: summary.commit.padEnd(40, '0'),
    name: 'SmartPerfetto v1.2.3',
    assets: [
      {
        id: 5000,
        name: 'smartperfetto-v1.2.3-windows-x64.zip',
        state: 'uploaded',
        size: 121,
        digest: `sha256:${'b'.repeat(64)}`,
      },
      {
        id: 5001,
        name: 'smartperfetto-v1.2.3-macos-arm64.zip',
        state: 'uploaded',
        size: 122,
        digest: `sha256:${'c'.repeat(64)}`,
      },
      {
        id: assetId,
        name: summary.asset.name,
        state: 'uploaded',
        size: summary.asset.size,
        digest: `sha256:${summary.asset.sha256}`,
      },
    ],
  };
  summary.commit = release.target_commitish;
  summary.lifecycleReceipt.gitCommit = release.target_commitish;
  const expectedBinding = {
    asset: summary.asset,
    assetId,
    commit: release.target_commitish,
    releaseId,
    target: summary.target,
    version: summary.version,
  };
  assert.equal(validateReleaseBinding(release, expectedBinding).id, releaseId);
  assert.throws(
    () => validateReleaseBinding({
      ...release,
      assets: release.assets.map(asset => (
        asset.id === assetId ? {...asset, id: 9999} : asset
      )),
    }, expectedBinding),
    /asset identity does not match/,
  );

  const work = mkdtempSync(path.join(tmpdir(), 'smartperfetto-workflow-context-'));
  const contextFile = path.join(work, 'workflow-context.json');
  const summaryFile = path.join(work, 'smoke-summary.json');
  writeFileSync(summaryFile, `${JSON.stringify(summary)}\n`);
  writeFileSync(contextFile, `${JSON.stringify({
    schemaVersion: 1,
    status: 'prepared',
    release: {
      id: releaseId,
      tag: 'v1.2.3',
      commit: release.target_commitish,
    },
    asset: {
      target: summary.target,
      assetId,
      assetName: summary.asset.name,
      assetSize: summary.asset.size,
      assetDigest: `sha256:${summary.asset.sha256}`,
    },
    host: summary.host,
  })}\n`);
  const verified = updateWorkflowContext(contextFile, expectedBinding, summaryFile);
  assert.equal(verified.status, 'verified');
  assert.match(verified.smokeSummarySha256, /^[0-9a-f]{64}$/);
  assert.equal(
    JSON.parse(readFileSync(contextFile, 'utf8')).smokeSummarySha256,
    verified.smokeSummarySha256,
  );
});

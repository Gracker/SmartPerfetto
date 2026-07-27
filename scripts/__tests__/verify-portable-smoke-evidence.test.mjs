// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  assertMatchingHost,
  collectDescendantPids,
  createEvidenceDirectory,
  forceKillProcessTree,
  isolatedSmokeEnv,
  packagePaths,
  parseArgs,
  runArchiveBinary,
  sanitizedSmokeEnv,
  startProcessTreeMonitor,
  validateLifecycleReceipt,
  versionAtLeast,
  windowsSystemBinary,
} = require(path.join(repoRoot, 'scripts/smoke-portable-archive.cjs'));

test('portable smoke requires a matching native host', () => {
  assert.doesNotThrow(() => assertMatchingHost('linux-x64', 'linux', 'x64'));
  assert.throws(
    () => assertMatchingHost('windows-x64', 'darwin', 'arm64'),
    /requires win32\/x64/,
  );
});

test('portable smoke resolves target-specific launcher and runtime paths', () => {
  const windows = packagePaths('/tmp/root', 'package', 'windows-x64');
  assert.equal(windows.launcher, path.join('/tmp/root', 'package', 'SmartPerfetto.exe'));
  assert.equal(windows.node, path.join('/tmp/root', 'package', 'runtime', 'node', 'node.exe'));

  const macos = packagePaths('/tmp/root', 'package', 'macos-arm64');
  assert.equal(
    macos.launcher,
    path.join('/tmp/root', 'package', 'SmartPerfetto.app', 'Contents', 'MacOS', 'SmartPerfetto'),
  );
  assert.match(macos.node, /SmartPerfetto\.app\/Contents\/Resources\/runtime\/node\/bin\/node$/);
});

test('portable smoke parser rejects incomplete option values', () => {
  assert.throws(() => parseArgs(['--asset']), /requires a value/);
  assert.deepEqual(
    parseArgs([
      '--asset', '/tmp/archive',
      '--target', 'linux-x64',
      '--version', '1.2.3',
      '--commit', 'abc',
    ]),
    {
      asset: '/tmp/archive',
      target: 'linux-x64',
      version: '1.2.3',
      commit: 'abc',
    },
  );
  assert.deepEqual(parseArgs(['--allow-dirty']), {allowDirty: true});
});

test('portable smoke creates a fresh evidence directory and refuses reuse', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-smoke-evidence-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const evidence = path.join(root, 'linux-x64');
  assert.equal(createEvidenceDirectory(evidence, 'linux-x64'), evidence);
  assert.throws(
    () => createEvidenceDirectory(evidence, 'linux-x64'),
    /already exists; choose a fresh path/,
  );
});

test('portable smoke does not expose release or provider credentials to the archive', () => {
  assert.deepEqual(
    sanitizedSmokeEnv({
      PATH: '/bin',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'actions-secret',
      OPENAI_API_KEY: 'provider-secret',
      ANTHROPIC_AUTH_TOKEN: 'provider-token',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SMARTPERFETTO_MACOS_NOTARY_PROFILE: 'notary-secret',
      SMARTPERFETTO_ENV_FILE: '/real/maintainer/provider.env',
      NODE_OPTIONS: '--require=/untrusted/hook.js',
    }),
    {PATH: '/bin'},
  );
});

test('every archive runtime probe receives the isolated smoke environment', () => {
  const env = isolatedSmokeEnv(
    {
      PATH: '/bin',
      HOME: '/real/home',
      USERPROFILE: 'C:\\real-home',
      NODE_OPTIONS: '--require=/untrusted/hook.js',
      OPENAI_API_KEY: 'provider-secret',
    },
    '/evidence/fresh-home',
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/evidence/fresh-home');
  assert.equal(env.USERPROFILE, '/evidence/fresh-home');
  assert.equal(env.XDG_CONFIG_HOME, path.join('/evidence/fresh-home', '.config'));
  assert.equal(env.LOCALAPPDATA, path.join('/evidence/fresh-home', 'AppData', 'Local'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);

  let received;
  const result = runArchiveBinary(
    '/archive/runtime/node',
    ['--version'],
    'bundled Node.js',
    env,
    (command, args, label, options) => {
      received = {command, args, label, options};
      return {stdout: 'v24.0.0', stderr: ''};
    },
  );
  assert.equal(result.stdout, 'v24.0.0');
  assert.deepEqual(received, {
    command: '/archive/runtime/node',
    args: ['--version'],
    label: 'bundled Node.js',
    options: {
      env,
      killSignal: 'SIGKILL',
      timeout: 30_000,
    },
  });
});

test('portable smoke validates the complete lifecycle receipt contract', () => {
  const expected = {
    backendPort: 3100,
    commit: 'abc123',
    frontendPort: 10100,
    target: 'linux-x64',
    version: '1.2.3',
  };
  const receipt = {
    schemaVersion: 2,
    version: expected.version,
    gitCommit: expected.commit,
    packageTarget: expected.target,
    containment: 'service-process-groups',
    exitReason: 'shutdown-file',
    success: true,
    ports: {
      backend: expected.backendPort,
      frontend: expected.frontendPort,
      released: true,
    },
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
  };
  assert.equal(validateLifecycleReceipt(receipt, expected), receipt);

  for (const candidate of [
    {...receipt, services: []},
    {...receipt, gitCommit: 'wrong'},
    {...receipt, packageTarget: 'windows-x64'},
    {...receipt, containment: 'windows-job-object'},
    {...receipt, ports: {...receipt.ports, frontend: 10101}},
    {...receipt, services: [receipt.services[0], {...receipt.services[0]}]},
    {
      ...receipt,
      services: [
        {...receipt.services[0], escalated: true},
        receipt.services[1],
      ],
    },
  ]) {
    assert.throws(() => validateLifecycleReceipt(candidate, expected), /invalid lifecycle receipt/);
  }
});

test('portable smoke finds nested descendants in post-order', () => {
  assert.deepEqual(
    collectDescendantPids([
      '10 1',
      '20 10',
      '30 20',
      '40 10',
      '50 999',
    ], 10),
    [30, 20, 40],
  );
});

test('portable smoke records process-enumeration failures instead of failing open', () => {
  const monitor = startProcessTreeMonitor(
    123,
    process.env,
    () => ({status: 1, stderr: 'permission denied'}),
    60_000,
  );
  monitor.stop();
  const evidence = monitor.evidence();
  assert.equal(evidence.enumerationSucceeded, false);
  assert.equal(evidence.samples, 0);
  assert.ok(evidence.failures.some(message => message.includes('permission denied')));
});

test('portable smoke resolves taskkill from trusted Windows System32', () => {
  assert.equal(
    windowsSystemBinary('taskkill.exe', {SystemRoot: 'C:\\Windows'}),
    path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
  );
  assert.throws(
    () => windowsSystemBinary('taskkill.exe', {PATH: 'C:\\archive'}),
    /SystemRoot/,
  );
});

test('portable smoke enforces the Linux glibc baseline numerically', () => {
  assert.equal(versionAtLeast('2.34', '2.34'), true);
  assert.equal(versionAtLeast('2.36', '2.34'), true);
  assert.equal(versionAtLeast('2.33', '2.34'), false);
  assert.equal(versionAtLeast('', '2.34'), false);
});

test('portable smoke failure cleanup kills a launcher and detached service child', {
  skip: process.platform === 'win32',
}, async (t) => {
  const parent = spawn(process.execPath, ['-e', [
    "const {spawn}=require('child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    "process.stdout.write(String(child.pid)+'\\n');",
    'setInterval(()=>{},1000);',
  ].join('')], {stdio: ['ignore', 'pipe', 'ignore']});
  t.after(() => {
    try {
      process.kill(parent.pid, 'SIGKILL');
    } catch {}
  });
  const childPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  t.after(() => {
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {}
  });

  forceKillProcessTree(parent.pid);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    let parentAlive = true;
    let childAlive = true;
    try {
      process.kill(parent.pid, 0);
    } catch {
      parentAlive = false;
    }
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    if (!parentAlive && !childAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('launcher or detached child survived failure cleanup');
});

test('portable smoke remembers observed service children after the launcher exits', {
  skip: process.platform === 'win32',
}, async (t) => {
  const parent = spawn(process.execPath, ['-e', [
    "const {spawn}=require('child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    "process.stdout.write(String(child.pid)+'\\n');",
    'setTimeout(()=>process.exit(0),300);',
  ].join('')], {stdio: ['ignore', 'pipe', 'ignore']});
  const monitor = startProcessTreeMonitor(parent.pid);
  t.after(() => monitor.stop());
  const childPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  t.after(() => {
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {}
  });
  await new Promise((resolve, reject) => {
    parent.once('exit', resolve);
    parent.once('error', reject);
  });
  monitor.stop();
  assert.equal(monitor.observed.has(childPid), true);
  for (const pid of monitor.observed) forceKillProcessTree(pid);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('observed detached child survived cleanup after launcher exit');
});

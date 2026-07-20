// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const lifecycleScript = path.join(repoRoot, 'scripts/service-lifecycle.sh');
const detachedLauncher = path.join(repoRoot, 'scripts/launch-detached.mjs');
const posixTest = (name, fn) => test(name, {
  skip: process.platform === 'win32' ? 'requires POSIX process and shell semantics' : false,
}, fn);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runBash(body, options = {}) {
  return spawnSync('/bin/bash', ['-c', body], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 15_000,
    env: {...process.env, ...options.env},
  });
}

function childPids(pid) {
  const result = spawnSync('pgrep', ['-P', String(pid)], {encoding: 'utf8'});
  if (result.status !== 0) return [];
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

function processTree(pid) {
  const result = [pid];
  for (const child of childPids(pid)) result.push(...processTree(child));
  return result;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition did not become true before timeout');
}

posixTest('owned npm-shaped parent, child, and grandchild tree is stopped completely', async (t) => {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-lifecycle-tree-')),
  );
  const pidFile = path.join(tempDir, 'backend.pid');
  const grandchildProgram = 'setInterval(() => {}, 1000)';
  const childProgram = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], {stdio:'ignore'});`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const encodedProgram = Buffer.from(childProgram).toString('base64');
  const root = spawn(
    '/bin/bash',
    ['-c', `node -e "eval(Buffer.from('${encodedProgram}','base64').toString())" & wait`],
    {cwd: tempDir, stdio: 'ignore'},
  );
  t.after(() => {
    try {
      root.kill('SIGKILL');
    } catch {
      // Already stopped by the lifecycle helper.
    }
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  await waitUntil(() => processTree(root.pid).length >= 3);
  const recordedTree = processTree(root.pid);
  const write = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_write_pid_file ${shellQuote(pidFile)} ${root.pid} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)} generation-tree`,
  );
  assert.equal(write.status, 0, write.stderr);

  const stop = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_stop_owned_pid_file ${shellQuote(pidFile)} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)}`,
    {timeout: 20_000},
  );
  assert.equal(stop.status, 0, stop.stderr);
  await Promise.race([
    once(root, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('root process did not close')), 5_000)),
  ]);
  await waitUntil(() => recordedTree.every((pid) => {
    const probe = spawnSync('kill', ['-0', String(pid)]);
    return probe.status !== 0;
  }));
  assert.equal(fs.existsSync(pidFile), false);
});

posixTest('mismatched process identity is refused without killing the live PID', (t) => {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-lifecycle-reuse-')),
  );
  const pidFile = path.join(tempDir, 'backend.pid');
  const child = spawn('sleep', ['30'], {cwd: tempDir, stdio: 'ignore'});
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  const write = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_write_pid_file ${shellQuote(pidFile)} ${child.pid} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)} generation-reuse`,
  );
  assert.equal(write.status, 0, write.stderr);
  const metadata = fs.readFileSync(pidFile, 'utf8').replace(
    /^start_identity=.*$/m,
    'start_identity=ps:reused-process',
  );
  fs.writeFileSync(pidFile, metadata);

  const stop = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_stop_owned_pid_file ${shellQuote(pidFile)} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)}`,
  );
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /refusing to stop a possibly reused process/);
  assert.equal(spawnSync('kill', ['-0', String(child.pid)]).status, 0);
});

posixTest('mutable process title does not invalidate executable-backed ownership', async (t) => {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-lifecycle-title-')),
  );
  const pidFile = path.join(tempDir, 'backend.pid');
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.title='initial-title'; setTimeout(()=>{process.title='changed-title'}, 250); setInterval(()=>{}, 1000)",
    ],
    {cwd: tempDir, stdio: 'ignore'},
  );
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(tempDir, {recursive: true, force: true});
  });
  await waitUntil(() => {
    const result = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {encoding: 'utf8'});
    return result.stdout.includes('initial-title');
  });

  const write = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_write_pid_file ${shellQuote(pidFile)} ${child.pid} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)} generation-title`,
  );
  assert.equal(write.status, 0, write.stderr);
  await waitUntil(() => {
    const result = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {encoding: 'utf8'});
    return result.stdout.includes('changed-title');
  });

  const stop = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_stop_owned_pid_file ${shellQuote(pidFile)} backend ` +
      `${shellQuote(tempDir)} ${shellQuote(tempDir)}`,
  );
  assert.equal(stop.status, 0, stop.stderr);
  await waitUntil(() => spawnSync('kill', ['-0', String(child.pid)]).status !== 0);
});

posixTest('an unowned listener blocks startup and remains alive', async (t) => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const result = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `if smartperfetto_assert_port_available ${port} frontend; then exit 0; else exit $?; fi`,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to stop an unowned listener/);
  assert.equal(server.listening, true);
});

posixTest('explicit force stop removes a listener and verifies the port is clean', async (t) => {
  const net = await import('node:net');
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const listener = spawn(
    process.execPath,
    ['-e', `require('node:net').createServer().listen(${port}, '127.0.0.1')`],
    {stdio: 'ignore'},
  );
  t.after(() => listener.kill('SIGKILL'));
  await waitUntil(() => {
    const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    return result.status === 0;
  });

  const stop = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_force_stop_port ${port} force-test`,
  );
  assert.equal(stop.status, 0, stop.stderr);
  await waitUntil(() => spawnSync('kill', ['-0', String(listener.pid)]).status !== 0);
  assert.notEqual(spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).status, 0);
});

posixTest('readiness fails immediately when the child exits before becoming ready', () => {
  const result = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `(exit 7) & child=$!\n` +
      'if smartperfetto_wait_for_http "$child" Test http://127.0.0.1:1/ 5 /dev/null; ' +
      'then exit 0; else exit $?; fi',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited before becoming ready/);
});

posixTest('readiness timeout returns non-zero and can clean up the owned child', () => {
  const result = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      '(sleep 10) & child=$!\n' +
      'smartperfetto_wait_for_http "$child" Test http://127.0.0.1:1/ 1 /dev/null\n' +
      'status=$?\n' +
      'smartperfetto_terminate_process_tree "$child" Test\n' +
      'exit "$status"',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become ready within 1s/);
});

posixTest('detached launcher survives its caller and can be stopped as a process tree', async (t) => {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-detached-launch-')),
  );
  const logFile = path.join(tempDir, 'detached.log');
  const program = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['-e','setInterval(() => {}, 1000)']);",
    'setInterval(() => {}, 1000);',
  ].join('');
  const launch = spawnSync(
    process.execPath,
    [detachedLauncher, '--cwd', tempDir, '--log', logFile, '--', process.execPath, '-e', program],
    {encoding: 'utf8', timeout: 5_000},
  );
  assert.equal(launch.status, 0, launch.stderr);
  const pid = Number(launch.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  t.after(() => {
    runBash(
      `. ${shellQuote(lifecycleScript)}\n` +
        `smartperfetto_terminate_process_tree ${pid} detached-test`,
      {timeout: 10_000},
    );
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  await waitUntil(() => processTree(pid).length >= 2);
  assert.equal(spawnSync('kill', ['-0', String(pid)]).status, 0);

  const stop = runBash(
    `. ${shellQuote(lifecycleScript)}\n` +
      `smartperfetto_terminate_process_tree ${pid} detached-test`,
    {timeout: 10_000},
  );
  assert.equal(stop.status, 0, stop.stderr);
  await waitUntil(() => spawnSync('kill', ['-0', String(pid)]).status !== 0);
});

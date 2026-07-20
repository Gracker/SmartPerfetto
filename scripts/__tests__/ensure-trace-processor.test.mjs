// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const backendRoot = path.join(repoRoot, 'backend');
const require = createRequire(import.meta.url);
const {main} = require('../../backend/scripts/ensure-trace-processor.cjs');
const isWindows = process.platform === 'win32';

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createCustomTraceProcessor(tempDir, mode = 0o755) {
  if (isWindows) return process.execPath;
  const filePath = path.join(tempDir, 'custom-trace-processor');
  fs.writeFileSync(filePath, '#!/bin/sh\necho "custom trace processor 1.0"\n', {mode});
  return filePath;
}

test('explicit TRACE_PROCESSOR_PATH is smoke-tested without content or mode mutation', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-custom-tp-'));
  t.after(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  const customPath = createCustomTraceProcessor(tempDir);
  const beforeHash = sha256(customPath);
  const beforeMode = fs.statSync(customPath).mode & 0o777;

  const result = await main({
    TRACE_PROCESSOR_PATH: customPath,
    TRACE_PROCESSOR_DOWNLOAD_URL: 'https://invalid.example/must-not-be-used',
  });

  assert.deepEqual(result, {path: customPath, source: 'custom'});
  assert.equal(sha256(customPath), beforeHash);
  assert.equal(fs.statSync(customPath).mode & 0o777, beforeMode);
});
test('non-executable explicit TRACE_PROCESSOR_PATH is rejected without chmod', {
  skip: isWindows ? 'Windows does not expose POSIX executable mode semantics' : false,
}, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-custom-tp-mode-'));
  t.after(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  const customPath = createCustomTraceProcessor(tempDir, 0o644);

  await assert.rejects(
    main({TRACE_PROCESSOR_PATH: customPath}),
    /is not executable.*will not modify a custom binary/,
  );
  assert.equal(fs.statSync(customPath).mode & 0o777, 0o644);
});

test('backend predev preserves an explicit custom trace processor', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-predev-tp-'));
  t.after(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  const customPath = createCustomTraceProcessor(tempDir);
  const beforeHash = sha256(customPath);

  const command = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = isWindows ? ['/d', '/s', '/c', 'npm.cmd run predev'] : ['run', 'predev'];
  const result = spawnSync(command, args, {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TRACE_PROCESSOR_PATH: customPath,
      TRACE_PROCESSOR_DOWNLOAD_URL: 'https://invalid.example/must-not-be-used',
    },
    timeout: 20_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  if (isWindows) {
    assert.match(result.stdout, new RegExp(`trace_processor_shell ready: ${process.version.replaceAll('.', '\\.')}`));
  } else {
    assert.match(result.stdout, /custom trace processor 1\.0/);
  }
  assert.equal(sha256(customPath), beforeHash);
});

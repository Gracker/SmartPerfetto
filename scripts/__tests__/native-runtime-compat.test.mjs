// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  compareVersions,
  glibcVersionsFromBuffer,
  machoMinimumVersionsFromBuffer,
  verifyNativeRuntimeCompatibility,
} = require(path.join(repoRoot, 'scripts/native-runtime-compat.cjs'));

function thinMachO(minimum) {
  const [major, minor, patch = 0] = minimum.split('.').map(Number);
  const buffer = Buffer.alloc(56);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(24, 20);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE((major << 16) | (minor << 8) | patch, 44);
  return buffer;
}

test('native compatibility parser reads Mach-O and GLIBC requirements', () => {
  assert.deepEqual(machoMinimumVersionsFromBuffer(thinMachO('13.5')), ['13.5']);
  assert.deepEqual(
    glibcVersionsFromBuffer(Buffer.from('\u007fELF\0GLIBC_2.29\0GLIBC_2.34\0')),
    ['2.29', '2.34'],
  );
  assert.equal(compareVersions('13.5', '13.5.0'), 0);
  assert.equal(compareVersions('2.34', '2.29'), 1);
});

test('Linux manifest must cover the highest GLIBC version in every ELF payload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-elf-compat-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(
    path.join(root, 'runtime'),
    Buffer.from('\u007fELF\0GLIBC_2.29\0GLIBC_2.34\0'),
  );
  const manifest = {
    target: {libc: {family: 'glibc', minimumVersion: '2.34'}},
  };
  assert.equal(
    verifyNativeRuntimeCompatibility(root, 'linux-x64', manifest).elfMinimumGlibc,
    '2.34',
  );
  assert.throws(
    () => verifyNativeRuntimeCompatibility(root, 'linux-x64', {
      target: {libc: {family: 'glibc', minimumVersion: '2.33'}},
    }),
    /requires GLIBC_2\.34/,
  );
});

test('macOS manifest and Info.plist must cover every Mach-O minimum', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-macho-compat-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = path.join(root, 'SmartPerfetto.app');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), {recursive: true});
  const bundledNodeDir = path.join(
    contents,
    'Resources',
    'runtime',
    'node',
    'bin',
  );
  fs.mkdirSync(bundledNodeDir, {recursive: true});
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    '<plist><dict><key>LSMinimumSystemVersion</key><string>13.5</string></dict></plist>',
  );
  fs.writeFileSync(path.join(contents, 'MacOS', 'SmartPerfetto'), thinMachO('12.0'));
  fs.writeFileSync(path.join(bundledNodeDir, 'node'), thinMachO('13.5'));
  const manifest = {target: {minimumSystemVersion: '13.5'}};
  assert.equal(
    verifyNativeRuntimeCompatibility(root, 'macos-arm64', manifest)
      .macosMinimumSystemVersion,
    '13.5',
  );
  assert.throws(
    () => verifyNativeRuntimeCompatibility(root, 'macos-arm64', {
      target: {minimumSystemVersion: '13.4'},
    }),
    /does not match Info\.plist/,
  );

  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    '<plist><dict><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>',
  );
  assert.throws(
    () => verifyNativeRuntimeCompatibility(root, 'macos-arm64', {
      target: {minimumSystemVersion: '12.0'},
    }),
    /requires 13\.5, above declared 12\.0/,
  );
});

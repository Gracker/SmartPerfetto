// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  ARCHIVE_LIMITS,
  assertArchiveBudget,
  assertArchiveHasNoLinks,
  assertExtractedTreeSafe,
  assertNotarizationReceipt,
  assertNodeRuntimeExecutablePin,
  assertNodeRuntimeManifestPin,
  assertPublicReleaseManifest,
  assertTraceProcessorManifestPin,
  extractArchiveToTemp,
  inspectArchiveBudget,
  listEntries,
  nodeRuntimeExecutableDigest,
  readPackageManifest,
  validateArchiveEntries,
} = require(path.join(repoRoot, 'scripts/verify-portable-package.cjs'));
const {
  verifyStagingTree,
} = require(path.join(repoRoot, 'scripts/verify-portable-staging-tree.cjs'));

function writeTarField(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii');
}

function createFifoTarGzip(entryName) {
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, entryName);
  writeTarField(header, 100, 8, '0000644\0');
  writeTarField(header, 108, 8, '0000000\0');
  writeTarField(header, 116, 8, '0000000\0');
  writeTarField(header, 124, 12, '00000000000\0');
  writeTarField(header, 136, 12, '00000000000\0');
  header.fill(0x20, 148, 156);
  header.write('6', 156, 1, 'ascii');
  writeTarField(header, 257, 6, 'ustar\0');
  writeTarField(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

function createZipArchive(root, archive, entry, preserveLinks = false) {
  if (process.platform === 'win32') {
    execFileSync('tar', ['-a', '-cf', archive, entry], {cwd: root});
    return;
  }
  const args = ['-qr'];
  if (preserveLinks) args.push('-y');
  execFileSync('zip', [...args, archive, entry], {cwd: root});
}

test('portable verifier enforces archive resource budgets before extraction', () => {
  const valid = {
    assetBytes: 100,
    entryCount: 2,
    expandedBytes: 500,
    largestEntryBytes: 400,
  };
  assert.equal(assertArchiveBudget(valid).expansionRatio, 5);
  for (const [field, value, pattern] of [
    ['assetBytes', ARCHIVE_LIMITS.maxArchiveBytes + 1, /asset exceeds/],
    ['entryCount', ARCHIVE_LIMITS.maxEntries + 1, /entry count exceeds/],
    ['expandedBytes', ARCHIVE_LIMITS.maxExpandedBytes + 1, /expanded size exceeds/],
    ['largestEntryBytes', ARCHIVE_LIMITS.maxSingleEntryBytes + 1, /Archive entry exceeds/],
  ]) {
    assert.throws(
      () => assertArchiveBudget({...valid, [field]: value}),
      pattern,
    );
  }
  assert.throws(
    () => assertArchiveBudget({...valid, expandedBytes: 10_001}),
    /expansion ratio exceeds/,
  );
});

test('portable verifier rejects traversal, absolute, and cross-platform collision paths', () => {
  for (const entries of [
    ['package/../outside'],
    ['/absolute/file'],
    ['C:/absolute/file'],
    ['package\\windows\\path'],
    ['package/File', 'package/file'],
    ['package/cafe\u0301', 'package/café'],
    ['package/file', 'package/file.'],
    ['package/file', 'package/file '],
    ['package/file.txt:stream'],
    ['package/CON'],
    ['package/con.txt'],
    ['package/LPT1.log'],
    ['package/COM¹.cfg'],
    ['package/question?.txt'],
    ['package/line\nbreak.txt'],
  ]) {
    assert.throws(() => validateArchiveEntries(entries), /Archive/);
  }
  assert.doesNotThrow(() => validateArchiveEntries([
    'package/',
    'package/backend/',
    'package/backend/index.js',
  ]));
});

test('portable verifier rejects links before zip or tar extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-archive-links-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'regular'), 'ok');
  fs.symlinkSync('regular', path.join(payload, 'link'));

  const zipPath = path.join(root, 'payload.zip');
  createZipArchive(root, zipPath, 'payload', true);
  assert.throws(
    () => assertArchiveHasNoLinks(zipPath, 'zip'),
    /symbolic or hard link/,
  );

  const tarPath = path.join(root, 'payload.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', root, 'payload']);
  assert.throws(
    () => assertArchiveHasNoLinks(tarPath, 'tar.gz'),
    /symbolic or hard link/,
  );
});

test('portable verifier inspects real ZIP and TAR budgets without extracting', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-budget-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'file.txt'), 'portable\n');
  const zip = path.join(root, 'payload.zip');
  const tar = path.join(root, 'payload.tar.gz');
  createZipArchive(root, zip, 'payload');
  execFileSync('tar', ['-czf', tar, 'payload'], {cwd: root});
  assert.equal(inspectArchiveBudget(zip, 'zip').entryCount, 2);
  assert.equal(inspectArchiveBudget(tar, 'tar.gz').entryCount, 2);
});

test('portable extraction path revalidates caller-provided archive entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-extract-wiring-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'regular'), 'ok');
  const tarPath = path.join(root, 'payload.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', root, 'payload']);

  assert.throws(
    () => extractArchiveToTemp(tarPath, 'tar.gz', ['payload/../outside']),
    /Archive entry/,
  );
});

test('portable verifier rejects archive special files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-archive-special-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tarPath = path.join(root, 'payload.tar.gz');
  fs.writeFileSync(tarPath, createFifoTarGzip('payload/pipe'));

  assert.throws(
    () => assertArchiveHasNoLinks(tarPath, 'tar.gz'),
    /non-regular special entry/,
  );
});

test('portable verifier binds trace processor provenance to the repository pin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-trace-pin-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const pinFile = path.join(root, 'trace-processor-pin.env');
  const sourceSha = 'a'.repeat(64);
  fs.writeFileSync(
    pinFile,
    [
      'PERFETTO_VERSION=v-test',
      `PERFETTO_SHELL_SHA256_WINDOWS_AMD64=${sourceSha}`,
      '',
    ].join('\n'),
  );
  const manifest = {
    traceProcessor: {
      version: 'v-test',
      sourceSha256: sourceSha,
      sha256: 'b'.repeat(64),
    },
  };

  assert.doesNotThrow(() =>
    assertTraceProcessorManifestPin(manifest, 'windows-x64', pinFile));
  assert.throws(
    () => assertTraceProcessorManifestPin({
      ...manifest,
      traceProcessor: {...manifest.traceProcessor, version: 'v-wrong'},
    }, 'windows-x64', pinFile),
    /version does not match/,
  );
  assert.throws(
    () => assertTraceProcessorManifestPin({
      ...manifest,
      traceProcessor: {...manifest.traceProcessor, sourceSha256: 'c'.repeat(64)},
    }, 'windows-x64', pinFile),
    /source SHA256 does not match/,
  );
});

test('portable verifier binds the Node runtime to a repository version and hash pin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-node-pin-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const pinFile = path.join(root, 'node-runtime-pin.env');
  const sha = 'a'.repeat(64);
  const executable = Buffer.from('pinned node executable');
  const executableSha = createHash('sha256').update(executable).digest('hex');
  fs.writeFileSync(
    pinFile,
    [
      'NODE_RUNTIME_VERSION=24.18.0',
      `NODE_RUNTIME_SHA256_WINDOWS_X64=${sha}`,
      `NODE_RUNTIME_EXECUTABLE_SHA256_WINDOWS_X64=${executableSha}`,
      '',
    ].join('\n'),
  );
  const manifest = {
    nodeRuntime: {
      version: '24.18.0',
      file: 'node-v24.18.0-win-x64.zip',
      sha256: sha,
    },
  };
  assert.doesNotThrow(() =>
    assertNodeRuntimeManifestPin(manifest, 'windows-x64', pinFile));
  assert.doesNotThrow(() =>
    assertNodeRuntimeExecutablePin(executable, 'windows-x64', pinFile));
  assert.throws(
    () => assertNodeRuntimeExecutablePin(
      Buffer.from('replaced node executable'),
      'windows-x64',
      pinFile,
    ),
    /does not match/,
  );
  for (const nodeRuntime of [
    {...manifest.nodeRuntime, version: '24.18.1'},
    {...manifest.nodeRuntime, file: 'node-v24.18.0-linux-x64.tar.xz'},
    {...manifest.nodeRuntime, sha256: 'b'.repeat(64)},
  ]) {
    assert.throws(
      () => assertNodeRuntimeManifestPin({nodeRuntime}, 'windows-x64', pinFile),
      /Node runtime/,
    );
  }
});

test('macOS Node digest ignores only valid code-signature layout changes', () => {
  const makeMachO = (signatureSize) => {
    const commandTableSize = 88;
    const signatureOffset = 32 + commandTableSize + 16;
    const buffer = Buffer.alloc(signatureOffset + signatureSize, 0x5a);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(2, 16);
    buffer.writeUInt32LE(commandTableSize, 20);
    buffer.writeUInt32LE(0x19, 32);
    buffer.writeUInt32LE(72, 36);
    buffer.fill(0, 40, 56);
    buffer.write('__LINKEDIT', 40, 'ascii');
    buffer.writeBigUInt64LE(0x1000n, 56);
    buffer.writeBigUInt64LE(BigInt(buffer.length), 64);
    buffer.writeBigUInt64LE(0n, 72);
    buffer.writeBigUInt64LE(BigInt(buffer.length), 80);
    buffer.writeUInt32LE(0x1d, 104);
    buffer.writeUInt32LE(16, 108);
    buffer.writeUInt32LE(signatureOffset, 112);
    buffer.writeUInt32LE(signatureSize, 116);
    return buffer;
  };
  const first = makeMachO(32);
  const resigned = makeMachO(96);
  assert.equal(
    nodeRuntimeExecutableDigest(first, 'macos-arm64'),
    nodeRuntimeExecutableDigest(resigned, 'macos-arm64'),
  );
  resigned[124] ^= 0xff;
  assert.notEqual(
    nodeRuntimeExecutableDigest(first, 'macos-arm64'),
    nodeRuntimeExecutableDigest(resigned, 'macos-arm64'),
  );
});

test('portable packager rejects staging symlinks before archive creation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-staging-tree-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'frontend'));
  fs.writeFileSync(path.join(root, 'frontend', 'index.html'), 'ok');
  assert.doesNotThrow(() => verifyStagingTree(root));
  fs.symlinkSync('index.html', path.join(root, 'frontend', 'leak.html'));
  assert.throws(() => verifyStagingTree(root), /symbolic link/);
});

test('staging and extracted trees reject names made ambiguous by line-based archive listings', {
  skip: process.platform === 'win32'
    ? 'Windows filesystems reject control characters before staging'
    : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-newline-entry-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'line\nbreak.txt'), 'unsafe');
  assert.throws(() => verifyStagingTree(packageRoot), /Windows-unsafe path segment/);
  assert.throws(() => assertExtractedTreeSafe(root), /Windows-unsafe path segment/);

  const archive = path.join(root, 'package.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const entries = listEntries(archive, 'tar.gz');
  assert.throws(
    () => extractArchiveToTemp(archive, 'tar.gz', entries),
    /unsafe backslash path|Windows-unsafe path segment/,
  );
});

test('tar listing preserves Unicode entry names under a C locale', {
  skip: process.platform === 'win32'
    ? 'POSIX tar locale contract does not apply to the Windows ZIP release path'
    : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-tar-unicode-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, '中文 name.txt'), 'ok');
  const archive = path.join(root, 'package.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const entries = listEntries(archive, 'tar.gz', {...process.env, LC_ALL: 'C', LANG: 'C'});
  assert.ok(entries.includes('package/中文 name.txt'), entries.join('\n'));
  assert.doesNotThrow(() => validateArchiveEntries(entries));
});

test('macOS provenance comes from matching outer and signed inner manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-macos-manifest-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const packageName = 'package';
  const packageRoot = path.join(root, packageName);
  const resources = path.join(
    packageRoot,
    'SmartPerfetto.app',
    'Contents',
    'Resources',
  );
  fs.mkdirSync(resources, {recursive: true});
  const manifest = {
    macos: {
      signed: true,
      notarized: true,
    },
    signingMode: 'macos-developer-id-notarized',
  };
  const payload = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(path.join(packageRoot, 'PACKAGE-MANIFEST.json'), payload);
  fs.writeFileSync(path.join(resources, 'PACKAGE-MANIFEST.json'), payload);
  assert.deepEqual(
    readPackageManifest(root, packageName, {os: 'macos'}),
    manifest,
  );
  assert.doesNotThrow(() => assertPublicReleaseManifest(manifest, {os: 'macos'}));

  fs.writeFileSync(
    path.join(packageRoot, 'PACKAGE-MANIFEST.json'),
    `${JSON.stringify({...manifest, signingMode: 'macos-adhoc'})}\n`,
  );
  assert.throws(
    () => readPackageManifest(root, packageName, {os: 'macos'}),
    /outer manifest does not exactly match/,
  );
  assert.throws(
    () => assertPublicReleaseManifest({
      macos: {
        signed: true,
        notarized: false,
      },
      signingMode: 'macos-adhoc',
    }, {os: 'macos'}),
    /Developer ID signing and notarization/,
  );
});

test('macOS public-release verifier follows the packager manifest schema', () => {
  const packager = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'package-portable.sh'),
    'utf8',
  );
  assert.match(
    packager,
    /macos:\s*\{\s*signed:\s*signed === 'true',\s*notarized:\s*notarized === 'true',\s*\}/,
  );
  assert.doesNotThrow(() => assertPublicReleaseManifest({
    macos: {
      signed: true,
      notarized: true,
    },
    signingMode: 'macos-developer-id-notarized',
  }, {os: 'macos'}));
  assert.throws(
    () => assertPublicReleaseManifest({
      signed: true,
      notarized: true,
      signingMode: 'macos-developer-id-notarized',
    }, {os: 'macos'}),
    /Developer ID signing and notarization/,
  );
});

test('macOS public release requires a structured Accepted notarytool receipt', () => {
  assert.doesNotThrow(() => assertNotarizationReceipt({
    schemaVersion: 1,
    status: 'Accepted',
    submissionId: '01234567-89ab-cdef-0123-456789abcdef',
  }));
  for (const receipt of [
    {schemaVersion: 1, status: 'Invalid', submissionId: '01234567-89ab-cdef-0123-456789abcdef'},
    {schemaVersion: 1, status: 'Accepted', submissionId: 'forged'},
    {schemaVersion: 0, status: 'Accepted', submissionId: '01234567-89ab-cdef-0123-456789abcdef'},
  ]) {
    assert.throws(() => assertNotarizationReceipt(receipt), /notarytool info receipt/);
  }
});

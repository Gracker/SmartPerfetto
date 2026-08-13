#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { findMachOFiles } = require('./find-macho-files.cjs');
const {
  compareVersions,
  verifyNativeRuntimeCompatibility,
} = require('./native-runtime-compat.cjs');

const GIB = 1024 * 1024 * 1024;
const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 2 * GIB,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxEntries: 60_000,
  maxExpandedBytes: 4 * GIB,
  maxSingleEntryBytes: GIB,
  maxExpansionRatio: 100,
  listingTimeoutMs: 180_000,
  extractionTimeoutMs: 300_000,
});
const COMMAND_DIAGNOSTIC_LIMIT_BYTES = 4 * 1024;

const TARGETS = {
  'windows-x64': {
    os: 'windows',
    arch: 'x64',
    ext: 'zip',
    nodeRuntimeFileSuffix: 'win-x64.zip',
    nodeRuntimeShaKey: 'NODE_RUNTIME_SHA256_WINDOWS_X64',
    nodeRuntimeExecutable: 'runtime/node/node.exe',
    nodeRuntimeExecutableShaKey: 'NODE_RUNTIME_EXECUTABLE_SHA256_WINDOWS_X64',
    traceProcessorShaKey: 'PERFETTO_SHELL_SHA256_WINDOWS_AMD64',
    readme: 'README-WINDOWS.txt',
    binaryKind: 'pe',
    required: [
      'PACKAGE-MANIFEST.json',
      'README-WINDOWS.txt',
      'README-WINDOWS.zh-CN.txt',
      'SmartPerfetto.exe',
      'runtime/node/node.exe',
      'bin/trace_processor_shell.exe',
      'backend/package.json',
      'backend/dist/index.js',
      'backend/dist/version.js',
      'backend/public/assistant-shell/index.html',
      'backend/public/admin-control-plane/index.html',
      'backend/knowledge/android-internals-capability-map.yaml',
      'backend/knowledge/aiw-pack/1.root.json',
      'backend/knowledge/aiw-pack/knowledge-packs.lock.json',
      'frontend/index.html',
      'frontend/server.js',
      'backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'backend/node_modules/sodium-native/prebuilds/win32-x64/sodium-native.node',
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
      'backend/node_modules/@earendil-works/pi-agent-core/dist/index.js',
      'backend/node_modules/@earendil-works/pi-ai/dist/index.js',
    ],
    binaryRequired: [
      'SmartPerfetto.exe',
      'runtime/node/node.exe',
      'bin/trace_processor_shell.exe',
      'backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'backend/node_modules/sodium-native/prebuilds/win32-x64/sodium-native.node',
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
    ],
  },
  'macos-arm64': {
    os: 'macos',
    arch: 'arm64',
    ext: 'zip',
    nodeRuntimeFileSuffix: 'darwin-arm64.tar.gz',
    nodeRuntimeShaKey: 'NODE_RUNTIME_SHA256_MACOS_ARM64',
    nodeRuntimeExecutable: 'SmartPerfetto.app/Contents/Resources/runtime/node/bin/node',
    nodeRuntimeExecutableShaKey: 'NODE_RUNTIME_EXECUTABLE_SHA256_MACOS_ARM64',
    traceProcessorShaKey: 'PERFETTO_SHELL_SHA256_MAC_ARM64',
    readme: 'README-MACOS.txt',
    binaryKind: 'macho',
    required: [
      'PACKAGE-MANIFEST.json',
      'README-MACOS.txt',
      'SmartPerfetto.app/Contents/Info.plist',
      'SmartPerfetto.app/Contents/MacOS/SmartPerfetto',
      'SmartPerfetto.app/Contents/Resources/PACKAGE-MANIFEST.json',
      'SmartPerfetto.app/Contents/Resources/runtime/node/bin/node',
      'SmartPerfetto.app/Contents/Resources/bin/trace_processor_shell',
      'SmartPerfetto.app/Contents/Resources/backend/package.json',
      'SmartPerfetto.app/Contents/Resources/backend/dist/index.js',
      'SmartPerfetto.app/Contents/Resources/backend/dist/version.js',
      'SmartPerfetto.app/Contents/Resources/backend/public/assistant-shell/index.html',
      'SmartPerfetto.app/Contents/Resources/backend/public/admin-control-plane/index.html',
      'SmartPerfetto.app/Contents/Resources/backend/knowledge/android-internals-capability-map.yaml',
      'SmartPerfetto.app/Contents/Resources/backend/knowledge/aiw-pack/1.root.json',
      'SmartPerfetto.app/Contents/Resources/backend/knowledge/aiw-pack/knowledge-packs.lock.json',
      'SmartPerfetto.app/Contents/Resources/frontend/index.html',
      'SmartPerfetto.app/Contents/Resources/frontend/server.js',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/opencode-ai/bin/opencode.exe',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/@earendil-works/pi-agent-core/dist/index.js',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/@earendil-works/pi-ai/dist/index.js',
    ],
    binaryRequired: [
      'SmartPerfetto.app/Contents/MacOS/SmartPerfetto',
      'SmartPerfetto.app/Contents/Resources/runtime/node/bin/node',
      'SmartPerfetto.app/Contents/Resources/bin/trace_processor_shell',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      'SmartPerfetto.app/Contents/Resources/backend/node_modules/opencode-ai/bin/opencode.exe',
    ],
  },
  'linux-x64': {
    os: 'linux',
    arch: 'x64',
    ext: 'tar.gz',
    nodeRuntimeFileSuffix: 'linux-x64.tar.xz',
    nodeRuntimeShaKey: 'NODE_RUNTIME_SHA256_LINUX_X64',
    nodeRuntimeExecutable: 'runtime/node/bin/node',
    nodeRuntimeExecutableShaKey: 'NODE_RUNTIME_EXECUTABLE_SHA256_LINUX_X64',
    traceProcessorShaKey: 'PERFETTO_SHELL_SHA256_LINUX_AMD64',
    readme: 'README-LINUX.txt',
    binaryKind: 'elf',
    required: [
      'PACKAGE-MANIFEST.json',
      'README-LINUX.txt',
      'SmartPerfetto',
      'runtime/node/bin/node',
      'bin/trace_processor_shell',
      'backend/package.json',
      'backend/dist/index.js',
      'backend/dist/version.js',
      'backend/public/assistant-shell/index.html',
      'backend/public/admin-control-plane/index.html',
      'backend/knowledge/android-internals-capability-map.yaml',
      'backend/knowledge/aiw-pack/1.root.json',
      'backend/knowledge/aiw-pack/knowledge-packs.lock.json',
      'frontend/index.html',
      'frontend/server.js',
      'backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
      'backend/node_modules/@earendil-works/pi-agent-core/dist/index.js',
      'backend/node_modules/@earendil-works/pi-ai/dist/index.js',
    ],
    binaryRequired: [
      'SmartPerfetto',
      'runtime/node/bin/node',
      'bin/trace_processor_shell',
      'backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
    ],
  },
};

function boundedCommandDiagnostic(value) {
  const text = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : String(value || '');
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed) <= COMMAND_DIAGNOSTIC_LIMIT_BYTES) {
    return trimmed;
  }
  return `${Buffer.from(trimmed).subarray(0, COMMAND_DIAGNOSTIC_LIMIT_BYTES).toString('utf8')}\n` +
    '[diagnostic output truncated]';
}

function runArchiveCommandQuiet(
  command,
  args,
  options = {},
  label,
  runner = spawnSync,
) {
  const result = runner(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
    ...options,
  });
  const stdout = result.stdout ?? '';
  const stderr = boundedCommandDiagnostic(result.stderr);
  if (result.error || result.status !== 0) {
    const detail = [
      result.error?.message,
      boundedCommandDiagnostic(stdout),
      stderr,
    ].filter(Boolean).join('\n');
    throw new Error(
      `${label} failed${detail ? `:\n${detail}` : ` with status ${result.status}`}`,
    );
  }
  if (stderr) {
    throw new Error(`${label} produced diagnostics:\n${stderr}`);
  }
  return stdout;
}

const FRONTEND_TOP_LEVEL_SYNTAQLITE_ASSETS = [
  'assets/syntaqlite-perfetto.wasm',
  'assets/syntaqlite-runtime.js',
  'assets/syntaqlite-runtime.wasm',
  'assets/syntaqlite-sqlite.wasm',
];

const FRONTEND_VERSIONED_REQUIRED_ASSETS = [
  'manifest.json',
  'frontend_bundle.js',
  'engine_bundle.js',
  'traceconv_bundle.js',
  'trace_processor.wasm',
  'trace_processor_memory64.wasm',
  'traceconv.wasm',
  'stdlib_docs.json',
  'syntaqlite-runtime.js',
  'syntaqlite-runtime.wasm',
  'syntaqlite-sqlite.wasm',
];

function usage() {
  console.error([
    'Usage:',
    '  node scripts/verify-portable-package.cjs --asset <file> --target <target> --version <version> [options]',
    '',
    'Options:',
    '  --commit <sha>       Require PACKAGE-MANIFEST.json gitCommit to match.',
    '  --require-clean      Require PACKAGE-MANIFEST.json gitDirty to be false.',
    '  --public-release     Enforce public-release signing and provenance rules.',
    '  --package-name NAME  Override expected top-level package directory.',
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--asset' || arg === '--target' || arg === '--version' || arg === '--commit' || arg === '--package-name') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts[arg.slice(2)] = argv[++i];
    } else if (arg === '--require-clean') {
      opts.requireClean = true;
    } else if (arg === '--public-release') {
      opts.publicRelease = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function normalizeVersion(raw) {
  const value = String(raw || '').trim().replace(/^v/, '');
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(value)) throw new Error(`Invalid SemVer version: ${raw}`);
  return value;
}

function readKeyValueFile(filePath) {
  const values = new Map();
  for (const [index, rawLine] of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=([^\s#]+)$/.exec(line);
    assert(match, `Invalid pin entry at ${filePath}:${index + 1}`);
    assert(!values.has(match[1]), `Duplicate pin entry ${match[1]} in ${filePath}`);
    values.set(match[1], match[2]);
  }
  return values;
}

function readNodeRuntimePin(
  targetId,
  pinFile = path.join(__dirname, 'node-runtime-pin.env'),
) {
  const target = TARGETS[targetId];
  assert(target, `Unsupported target for Node runtime pin verification: ${targetId}`);
  const pins = readKeyValueFile(pinFile);
  const version = pins.get('NODE_RUNTIME_VERSION');
  const archiveSha256 = pins.get(target.nodeRuntimeShaKey);
  const executableSha256 = pins.get(target.nodeRuntimeExecutableShaKey);
  assert(
    version && /^24\.\d+\.\d+$/.test(version),
    `Missing or invalid NODE_RUNTIME_VERSION in ${pinFile}`,
  );
  assert(
    /^[0-9a-f]{64}$/i.test(archiveSha256 || ''),
    `Missing or invalid ${target.nodeRuntimeShaKey} in ${pinFile}`,
  );
  assert(
    /^[0-9a-f]{64}$/i.test(executableSha256 || ''),
    `Missing or invalid ${target.nodeRuntimeExecutableShaKey} in ${pinFile}`,
  );
  return {
    version,
    archiveSha256: archiveSha256.toLowerCase(),
    executableSha256: executableSha256.toLowerCase(),
  };
}

function canonicalMacosExecutableDigest(buffer) {
  assert(Buffer.isBuffer(buffer), 'macOS Node runtime must be a Buffer');
  assert(
    buffer.length >= 32 && buffer.readUInt32LE(0) === 0xfeedfacf,
    'macOS Node runtime must be a thin 64-bit little-endian Mach-O',
  );
  const commandCount = buffer.readUInt32LE(16);
  const commandsSize = buffer.readUInt32LE(20);
  assert(
    commandCount > 0 && commandCount <= 4096 && 32 + commandsSize <= buffer.length,
    'macOS Node runtime has an invalid Mach-O load-command table',
  );

  const normalized = Buffer.from(buffer);
  let cursor = 32;
  let codeSignatureOffset;
  let linkedit;
  for (let index = 0; index < commandCount; index++) {
    assert(cursor + 8 <= 32 + commandsSize, 'Mach-O load command exceeds its table');
    const command = buffer.readUInt32LE(cursor);
    const commandSize = buffer.readUInt32LE(cursor + 4);
    assert(
      commandSize >= 8 && cursor + commandSize <= 32 + commandsSize,
      'Mach-O load command has an invalid size',
    );
    if (command === 0x19 && commandSize >= 72) {
      const segmentName = buffer.toString('ascii', cursor + 8, cursor + 24)
        .replace(/\0.*$/, '');
      if (segmentName === '__LINKEDIT') {
        linkedit = {
          commandOffset: cursor,
          fileOffset: Number(buffer.readBigUInt64LE(cursor + 40)),
          fileSize: Number(buffer.readBigUInt64LE(cursor + 48)),
          virtualSize: Number(buffer.readBigUInt64LE(cursor + 32)),
        };
      }
    }
    if (command === 0x1d && commandSize === 16) {
      assert(codeSignatureOffset === undefined, 'Mach-O has duplicate code signatures');
      codeSignatureOffset = buffer.readUInt32LE(cursor + 8);
      const codeSignatureSize = buffer.readUInt32LE(cursor + 12);
      assert(
        codeSignatureOffset > 0 &&
          codeSignatureSize > 0 &&
          codeSignatureOffset + codeSignatureSize === buffer.length,
        'Mach-O code signature does not cover the final file region',
      );
      normalized.fill(0, cursor + 8, cursor + 16);
    }
    cursor += commandSize;
  }
  assert(cursor === 32 + commandsSize, 'Mach-O load-command size does not match its table');
  assert(codeSignatureOffset !== undefined, 'macOS Node runtime lacks LC_CODE_SIGNATURE');
  assert(linkedit, 'macOS Node runtime lacks __LINKEDIT');
  assert(
    linkedit.fileOffset + linkedit.fileSize === buffer.length &&
      linkedit.fileOffset < codeSignatureOffset &&
      linkedit.virtualSize >= linkedit.fileSize,
    'Mach-O __LINKEDIT does not match the signed file layout',
  );
  normalized.fill(0, linkedit.commandOffset + 32, linkedit.commandOffset + 40);
  normalized.fill(0, linkedit.commandOffset + 48, linkedit.commandOffset + 56);
  return sha256Hex(normalized.subarray(0, codeSignatureOffset));
}

function nodeRuntimeExecutableDigest(buffer, targetId) {
  return targetId === 'macos-arm64'
    ? canonicalMacosExecutableDigest(buffer)
    : sha256Hex(buffer);
}

function assertNodeRuntimeExecutablePin(
  buffer,
  targetId,
  pinFile = path.join(__dirname, 'node-runtime-pin.env'),
) {
  const pin = readNodeRuntimePin(targetId, pinFile);
  const actual = nodeRuntimeExecutableDigest(buffer, targetId);
  assert(
    actual === pin.executableSha256,
    `Packaged Node runtime executable does not match ${TARGETS[targetId].nodeRuntimeExecutableShaKey}`,
  );
  return actual;
}

function assertTraceProcessorManifestPin(
  manifest,
  targetId,
  pinFile = path.join(__dirname, 'trace-processor-pin.env'),
) {
  const target = TARGETS[targetId];
  assert(target, `Unsupported target for trace processor pin verification: ${targetId}`);
  const pins = readKeyValueFile(pinFile);
  const expectedVersion = pins.get('PERFETTO_VERSION');
  const expectedSourceSha = pins.get(target.traceProcessorShaKey);
  assert(expectedVersion, `Missing PERFETTO_VERSION in ${pinFile}`);
  assert(expectedSourceSha, `Missing ${target.traceProcessorShaKey} in ${pinFile}`);
  assert(
    manifest.traceProcessor?.version === expectedVersion,
    `Manifest trace processor version does not match ${path.basename(pinFile)}: expected ${expectedVersion}, got ${manifest.traceProcessor?.version}`,
  );
  assert(
    manifest.traceProcessor?.sourceSha256?.toLowerCase() === expectedSourceSha.toLowerCase(),
    `Manifest trace processor source SHA256 does not match ${target.traceProcessorShaKey}`,
  );
}

function assertNodeRuntimeManifestPin(
  manifest,
  targetId,
  pinFile = path.join(__dirname, 'node-runtime-pin.env'),
) {
  const target = TARGETS[targetId];
  assert(target, `Unsupported target for Node runtime pin verification: ${targetId}`);
  const pin = readNodeRuntimePin(targetId, pinFile);
  assert(
    manifest.nodeRuntime?.version === pin.version,
    `Manifest Node runtime version does not match ${path.basename(pinFile)}: expected ${pin.version}, got ${manifest.nodeRuntime?.version}`,
  );
  assert(
    manifest.nodeRuntime?.file === `node-v${pin.version}-${target.nodeRuntimeFileSuffix}`,
    `Manifest Node runtime file does not match the repository pin: ${manifest.nodeRuntime?.file}`,
  );
  assert(
    manifest.nodeRuntime?.sha256?.toLowerCase() === pin.archiveSha256,
    `Manifest Node runtime SHA256 does not match ${target.nodeRuntimeShaKey}`,
  );
}

function listEntries(
  assetPath,
  ext,
  commandEnv = process.env,
  archiveCommandRunner = spawnSync,
) {
  if (ext === 'zip') {
    const listing = commandExists('unzip')
      ? runArchiveCommandQuiet('unzip', ['-Z1', assetPath], {
          encoding: 'utf8',
          env: commandEnv,
          maxBuffer: 64 * 1024 * 1024,
          timeout: ARCHIVE_LIMITS.listingTimeoutMs,
        }, 'ZIP listing', archiveCommandRunner)
      : runArchiveCommandQuiet('tar', ['-tf', assetPath], {
          encoding: 'utf8',
          env: commandEnv,
          maxBuffer: 64 * 1024 * 1024,
          timeout: ARCHIVE_LIMITS.listingTimeoutMs,
        }, 'ZIP listing', archiveCommandRunner);
    return listing
      .split(/\r?\n/)
      .filter(Boolean);
  }
  if (ext === 'tar.gz') {
    const listingEnv = {...commandEnv};
    try {
      const localeCommand = fs.existsSync('/usr/bin/locale') ? '/usr/bin/locale' : 'locale';
      const locales = execFileSync(localeCommand, ['-a'], {
        encoding: 'utf8',
        env: commandEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/);
      const preferred = ['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8']
        .find(candidate => locales.includes(candidate));
      if (preferred) {
        listingEnv.LANG = preferred;
        listingEnv.LC_ALL = preferred;
      }
    } catch {
      // GNU tar's literal quoting mode below remains locale independent.
    }
    let tarArgs = ['-tzf', assetPath];
    try {
      const versionOutput = execFileSync('tar', ['--version'], {
        encoding: 'utf8',
        env: listingEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (/\bGNU tar\b/.test(versionOutput)) {
        tarArgs = ['--quoting-style=literal', '-tzf', assetPath];
      }
    } catch {
      // The listing command below remains the authoritative capability check.
    }
    return runArchiveCommandQuiet('tar', tarArgs, {
      encoding: 'utf8',
      env: listingEnv,
      maxBuffer: 64 * 1024 * 1024,
      timeout: ARCHIVE_LIMITS.listingTimeoutMs,
    }, 'TAR listing', archiveCommandRunner)
      .split(/\r?\n/)
      .filter(Boolean)
      .map(entry => entry.replace(/^\.\//, ''));
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function assertArchiveBudget(metrics, limits = ARCHIVE_LIMITS) {
  for (const [name, value] of Object.entries(metrics)) {
    assert(
      Number.isSafeInteger(value) && value >= 0,
      `Archive ${name} is not a safe non-negative integer: ${value}`,
    );
  }
  assert(metrics.assetBytes > 0, 'Archive asset is empty');
  assert(
    metrics.assetBytes <= limits.maxArchiveBytes,
    `Archive asset exceeds ${limits.maxArchiveBytes} bytes: ${metrics.assetBytes}`,
  );
  assert(metrics.entryCount > 0, 'Archive contains no entries');
  assert(
    metrics.entryCount <= limits.maxEntries,
    `Archive entry count exceeds ${limits.maxEntries}: ${metrics.entryCount}`,
  );
  assert(
    metrics.expandedBytes <= limits.maxExpandedBytes,
    `Archive expanded size exceeds ${limits.maxExpandedBytes} bytes: ${metrics.expandedBytes}`,
  );
  assert(
    metrics.largestEntryBytes <= limits.maxSingleEntryBytes,
    `Archive entry exceeds ${limits.maxSingleEntryBytes} bytes: ${metrics.largestEntryBytes}`,
  );
  const expansionRatio = metrics.expandedBytes / metrics.assetBytes;
  assert(
    expansionRatio <= limits.maxExpansionRatio,
    `Archive expansion ratio exceeds ${limits.maxExpansionRatio}: ${expansionRatio.toFixed(2)}`,
  );
  return {...metrics, expansionRatio};
}

function inspectZipBudget(assetPath, assetBytes) {
  const file = fs.openSync(assetPath, 'r');
  try {
    const tailLength = Math.min(assetBytes, 65_557);
    const tail = Buffer.allocUnsafe(tailLength);
    fs.readSync(file, tail, 0, tailLength, assetBytes - tailLength);
    let eocdOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (
        tail.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
      ) {
        eocdOffset = offset;
        break;
      }
    }
    assert(eocdOffset >= 0, 'ZIP end-of-central-directory record is missing');
    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
    const diskEntries = tail.readUInt16LE(eocdOffset + 8);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectoryBytes = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    assert(
      diskNumber === 0 &&
        centralDirectoryDisk === 0 &&
        diskEntries === entryCount,
      'Multi-disk ZIP archives are unsupported',
    );
    assert(
      entryCount !== 0xffff &&
        centralDirectoryBytes !== 0xffffffff &&
        centralDirectoryOffset !== 0xffffffff,
      'ZIP64 archives are unsupported by the portable package budget',
    );
    assert(
      centralDirectoryBytes <= ARCHIVE_LIMITS.maxCentralDirectoryBytes,
      `ZIP central directory exceeds ${ARCHIVE_LIMITS.maxCentralDirectoryBytes} bytes`,
    );
    assert(
      centralDirectoryOffset + centralDirectoryBytes <= assetBytes,
      'ZIP central directory lies outside the asset',
    );
    const centralDirectory = Buffer.allocUnsafe(centralDirectoryBytes);
    fs.readSync(
      file,
      centralDirectory,
      0,
      centralDirectoryBytes,
      centralDirectoryOffset,
    );
    let cursor = 0;
    let expandedBytes = 0;
    let largestEntryBytes = 0;
    for (let index = 0; index < entryCount; index++) {
      assert(
        cursor + 46 <= centralDirectory.length &&
          centralDirectory.readUInt32LE(cursor) === 0x02014b50,
        `ZIP central directory entry ${index + 1} is malformed`,
      );
      const compressedBytes = centralDirectory.readUInt32LE(cursor + 20);
      const expandedEntryBytes = centralDirectory.readUInt32LE(cursor + 24);
      const fileNameLength = centralDirectory.readUInt16LE(cursor + 28);
      const extraLength = centralDirectory.readUInt16LE(cursor + 30);
      const commentLength = centralDirectory.readUInt16LE(cursor + 32);
      assert(
        compressedBytes !== 0xffffffff && expandedEntryBytes !== 0xffffffff,
        'ZIP64 entries are unsupported by the portable package budget',
      );
      expandedBytes += expandedEntryBytes;
      largestEntryBytes = Math.max(largestEntryBytes, expandedEntryBytes);
      cursor += 46 + fileNameLength + extraLength + commentLength;
      assert(
        cursor <= centralDirectory.length,
        `ZIP central directory entry ${index + 1} exceeds its declared size`,
      );
    }
    assert(
      cursor === centralDirectory.length,
      'ZIP central directory contains unparsed trailing records',
    );
    return assertArchiveBudget({
      assetBytes,
      entryCount,
      expandedBytes,
      largestEntryBytes,
    });
  } finally {
    fs.closeSync(file);
  }
}

function inspectTarGzipBudget(assetPath, assetBytes) {
  const version = execFileSync('tar', ['--version'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const bsdTar = /\bbsdtar\b/i.test(version);
  const listing = runArchiveCommandQuiet('tar', ['-tvzf', assetPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: ARCHIVE_LIMITS.listingTimeoutMs,
  }, 'TAR budget listing');
  const lines = listing.split(/\r?\n/).filter(Boolean);
  let expandedBytes = 0;
  let largestEntryBytes = 0;
  for (const [index, line] of lines.entries()) {
    const match = bsdTar
      ? /^[^\s]+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(line)
      : /^[^\s]+\s+\S+\/\S+\s+(\d+)\s/.exec(line);
    assert(match, `Could not parse TAR size at listing line ${index + 1}`);
    const entryBytes = Number(match[1]);
    assert(Number.isSafeInteger(entryBytes), `Invalid TAR entry size at line ${index + 1}`);
    expandedBytes += entryBytes;
    largestEntryBytes = Math.max(largestEntryBytes, entryBytes);
  }
  return assertArchiveBudget({
    assetBytes,
    entryCount: lines.length,
    expandedBytes,
    largestEntryBytes,
  });
}

function inspectArchiveBudget(assetPath, ext) {
  const stat = fs.statSync(assetPath);
  assert(stat.isFile(), `Archive asset is not a regular file: ${assetPath}`);
  assert(
    stat.size <= ARCHIVE_LIMITS.maxArchiveBytes,
    `Archive asset exceeds ${ARCHIVE_LIMITS.maxArchiveBytes} bytes: ${stat.size}`,
  );
  if (ext === 'zip') return inspectZipBudget(assetPath, stat.size);
  if (ext === 'tar.gz') return inspectTarGzipBudget(assetPath, stat.size);
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function normalizeArchiveEntry(entry) {
  assert(typeof entry === 'string' && entry.length > 0, 'Archive contains an empty entry name');
  assert(!entry.includes('\0'), `Archive entry contains a NUL byte: ${entry}`);
  assert(!entry.includes('\\'), `Archive entry uses an unsafe backslash path: ${entry}`);
  assert(!entry.startsWith('/'), `Archive entry is absolute: ${entry}`);
  assert(!/^[A-Za-z]:/.test(entry), `Archive entry uses an absolute drive path: ${entry}`);

  const withoutPrefix = entry.replace(/^\.\//, '');
  const directory = withoutPrefix.endsWith('/');
  const comparable = directory ? withoutPrefix.slice(0, -1) : withoutPrefix;
  const segments = comparable.split('/');
  assert(
    comparable.length > 0 &&
      segments.every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    `Archive entry contains an unsafe path segment: ${entry}`,
  );
  for (const segment of segments) {
    assert(
      !(
        segment === '__MACOSX' ||
        segment === '.DS_Store' ||
        segment === '.AppleDouble' ||
        segment.startsWith('._')
      ),
      `Archive entry contains macOS metadata: ${entry}`,
    );
    assert(
      !/[<>:"|?*\x00-\x1F]/u.test(segment),
      `Archive entry contains a Windows-unsafe path segment: ${entry}`,
    );
    assert(
      !/[. ]$/u.test(segment),
      `Archive entry contains a Windows-ambiguous trailing character: ${entry}`,
    );
    assert(
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(segment),
      `Archive entry contains a reserved Windows device name: ${entry}`,
    );
  }
  const normalized = path.posix.normalize(comparable);
  assert(normalized === comparable, `Archive entry is not normalized: ${entry}`);
  return directory ? `${normalized}/` : normalized;
}

function validateArchiveEntries(entries) {
  const exact = new Set();
  const portable = new Set();
  for (const entry of entries) {
    const normalized = normalizeArchiveEntry(entry);
    assert(!exact.has(normalized), `Archive contains a duplicate entry: ${normalized}`);
    exact.add(normalized);

    const collisionKey = normalized
      .replace(/\/$/, '')
      .split('/')
      .map(segment => segment.replace(/[. ]+$/u, ''))
      .join('/')
      .normalize('NFC')
      .toLowerCase();
    assert(
      !portable.has(collisionKey),
      `Archive contains a cross-platform path collision: ${normalized}`,
    );
    portable.add(collisionKey);
  }
}

function assertArchiveHasNoLinks(assetPath, ext) {
  let listing;
  if (ext === 'zip') {
    listing = commandExists('unzip')
      ? runArchiveCommandQuiet('unzip', ['-Z', '-l', assetPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: ARCHIVE_LIMITS.listingTimeoutMs,
      }, 'ZIP type listing')
      : runArchiveCommandQuiet('tar', ['-tvf', assetPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: ARCHIVE_LIMITS.listingTimeoutMs,
      }, 'ZIP type listing');
  } else if (ext === 'tar.gz') {
    listing = runArchiveCommandQuiet('tar', ['-tvzf', assetPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: ARCHIVE_LIMITS.listingTimeoutMs,
    }, 'TAR type listing');
  } else {
    throw new Error(`Unsupported archive extension: ${ext}`);
  }
  const linkLine = listing.split(/\r?\n/).find(line => /^[lh]/.test(line));
  assert(!linkLine, `Archive contains a symbolic or hard link: ${linkLine || ''}`);
  const specialLine = listing
    .split(/\r?\n/)
    .find(line => /^[bcpSs?]/.test(line));
  assert(
    !specialLine,
    `Archive contains a non-regular special entry: ${specialLine || ''}`,
  );
}

function readEntry(assetPath, ext, entry) {
  if (ext === 'zip') {
    return commandExists('unzip')
      ? runArchiveCommandQuiet(
        'unzip',
        ['-p', assetPath, entry],
        {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
        'ZIP entry read',
      )
      : runArchiveCommandQuiet(
        'tar',
        ['-xOf', assetPath, entry],
        {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
        'ZIP entry read',
      );
  }
  if (ext === 'tar.gz') {
    return runArchiveCommandQuiet(
      'tar',
      ['-xOzf', assetPath, entry],
      {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
      'TAR entry read',
    );
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function readEntryBuffer(assetPath, ext, entry) {
  const maxBuffer = 256 * 1024 * 1024;
  if (ext === 'zip') {
    return commandExists('unzip')
      ? runArchiveCommandQuiet(
        'unzip',
        ['-p', assetPath, entry],
        {maxBuffer},
        'ZIP binary entry read',
      )
      : runArchiveCommandQuiet(
        'tar',
        ['-xOf', assetPath, entry],
        {maxBuffer},
        'ZIP binary entry read',
      );
  }
  if (ext === 'tar.gz') {
    return runArchiveCommandQuiet(
      'tar',
      ['-xOzf', assetPath, entry],
      {maxBuffer},
      'TAR binary entry read',
    );
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function assertExtractedTreeSafe(tmpRoot) {
  const root = fs.realpathSync(tmpRoot);
  const pending = [root];
  const extractedEntries = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      assert(!stat.isSymbolicLink(), `Extracted archive contains a symbolic link: ${candidate}`);
      assert(
        stat.isDirectory() || stat.isFile(),
        `Extracted archive contains a non-regular entry: ${candidate}`,
      );
      const resolved = path.resolve(candidate);
      assert(
        resolved.startsWith(`${root}${path.sep}`),
        `Extracted archive path escapes verification root: ${candidate}`,
      );
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      extractedEntries.push(stat.isDirectory() ? `${relative}/` : relative);
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
  validateArchiveEntries(extractedEntries);
}

function extractArchiveToTemp(assetPath, ext, entries) {
  inspectArchiveBudget(assetPath, ext);
  validateArchiveEntries(entries);
  assertArchiveHasNoLinks(assetPath, ext);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-package-verify-'));
  try {
    if (ext === 'zip') {
      if (commandExists('unzip')) {
        runArchiveCommandQuiet('unzip', ['-q', assetPath, '-d', tmpRoot], {
          timeout: ARCHIVE_LIMITS.extractionTimeoutMs,
        }, 'ZIP extraction');
      } else {
        runArchiveCommandQuiet('tar', ['-xf', assetPath, '-C', tmpRoot], {
          timeout: ARCHIVE_LIMITS.extractionTimeoutMs,
        }, 'ZIP extraction');
      }
    } else if (ext === 'tar.gz') {
      runArchiveCommandQuiet('tar', ['-xzf', assetPath, '-C', tmpRoot], {
        timeout: ARCHIVE_LIMITS.extractionTimeoutMs,
      }, 'TAR extraction');
    } else {
      throw new Error(`Unsupported archive extension: ${ext}`);
    }
    assertExtractedTreeSafe(tmpRoot);
  } catch (error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw error;
  }
  return tmpRoot;
}

function extractedEntryPath(tmpRoot, entry) {
  const root = path.resolve(tmpRoot);
  const resolved = path.resolve(root, entry);
  assert(resolved.startsWith(`${root}${path.sep}`), `Archive entry escapes verification root: ${entry}`);
  return resolved;
}

function readExtractedBuffer(tmpRoot, entry) {
  return fs.readFileSync(extractedEntryPath(tmpRoot, entry));
}

function readExtractedText(tmpRoot, entry) {
  return readExtractedBuffer(tmpRoot, entry).toString('utf8');
}

function readExtractedJson(tmpRoot, entry) {
  try {
    return JSON.parse(readExtractedText(tmpRoot, entry));
  } catch (error) {
    throw new Error(`Invalid JSON in ${entry}: ${error.message || error}`);
  }
}

function assertExtractedEntryNonEmpty(tmpRoot, entry) {
  const bytes = readExtractedBuffer(tmpRoot, entry);
  assert(bytes.length > 0, `Package entry is empty: ${entry}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertBinaryKind(bytes, label, kind) {
  const hex = [...bytes.subarray(0, 4)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const ok = kind === 'pe'
    ? bytes[0] === 0x4d && bytes[1] === 0x5a
    : kind === 'elf'
      ? bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
      : ['cffaedfe', 'cafebabe', 'feedfacf', 'feedface'].includes(hex);
  assert(ok, `${label} is not a ${kind} binary`);
}

function sha256Resource(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableVersionFromIndex(indexHtml) {
  const match = indexHtml.match(/data-perfetto_version='([^']+)'/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).stable;
  } catch {
    return null;
  }
}

function frontendRootForTarget(target) {
  return target.os === 'macos'
    ? 'SmartPerfetto.app/Contents/Resources/frontend'
    : 'frontend';
}

function backendRootForTarget(target) {
  return target.os === 'macos'
    ? 'SmartPerfetto.app/Contents/Resources/backend'
    : 'backend';
}

function readPackageManifest(extractedRoot, packageName, target) {
  const outerManifestEntry = `${packageName}/PACKAGE-MANIFEST.json`;
  const outerManifestBytes = readExtractedBuffer(extractedRoot, outerManifestEntry);
  let manifestBytes = outerManifestBytes;
  if (target.os === 'macos') {
    const innerManifestEntry =
      `${packageName}/SmartPerfetto.app/Contents/Resources/PACKAGE-MANIFEST.json`;
    const innerManifestBytes = readExtractedBuffer(extractedRoot, innerManifestEntry);
    assert(
      outerManifestBytes.equals(innerManifestBytes),
      'macOS outer manifest does not exactly match the signed app manifest',
    );
    manifestBytes = innerManifestBytes;
  }
  try {
    return JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in signed package manifest: ${error.message || error}`);
  }
}

function assertPublicReleaseManifest(manifest, target) {
  if (target.os !== 'macos') return;
  assert(
    manifest.macos?.signed === true &&
      manifest.macos?.notarized === true &&
      manifest.signingMode === 'macos-developer-id-notarized',
    'Public macOS release requires Developer ID signing and notarization',
  );
}

function assertNotarizationReceipt(receipt) {
  assert(
    receipt?.schemaVersion === 1 &&
      receipt.status === 'Accepted' &&
      typeof receipt.submissionId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(receipt.submissionId),
    'Public macOS release requires an Accepted notarytool info receipt',
  );
}

function assertEntryExists(entries, packageName, rel) {
  const entry = `${packageName}/${rel}`;
  assert(entries.includes(entry), `Missing package entry: ${entry}`);
  return entry;
}

function assertEntryNonEmpty(assetPath, ext, entry) {
  const bytes = readEntryBuffer(assetPath, ext, entry);
  assert(bytes.length > 0, `Package entry is empty: ${entry}`);
}

function readJsonEntry(assetPath, ext, entry) {
  try {
    return JSON.parse(readEntry(assetPath, ext, entry));
  } catch (error) {
    throw new Error(`Invalid JSON in ${entry}: ${error.message || error}`);
  }
}

function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [command], { stdio: 'ignore' });
    } else {
      execFileSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function verifyMacosCodeSignature(extractedRoot, packageName) {
  if (!commandExists('codesign')) return;

  try {
    const appPath = extractedEntryPath(
      extractedRoot,
      `${packageName}/SmartPerfetto.app`,
    );
    for (const binaryPath of findMachOFiles(path.join(appPath, 'Contents'))) {
      execFileSync('codesign', ['--verify', '--strict', '--verbose=2', binaryPath], {
        stdio: 'pipe',
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    const jitRuntimes = [
      'Contents/Resources/runtime/node/bin/node',
      'Contents/Resources/backend/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    ];
    const requiredEntitlements = [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ];
    for (const relativePath of jitRuntimes) {
      const binaryPath = path.join(appPath, relativePath);
      const entitlementXml = execFileSync(
        'codesign',
        ['--display', '--entitlements', '-', '--xml', binaryPath],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
      );
      assert(
        entitlementXml.length > 0,
        `Missing required macOS runtime entitlements: ${relativePath}`,
      );
      const entitlementJson = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: entitlementXml,
        maxBuffer: 16 * 1024 * 1024,
      });
      const entitlements = JSON.parse(entitlementJson);
      for (const entitlement of requiredEntitlements) {
        assert(
          entitlements[entitlement] === true,
          `Missing required macOS runtime entitlement ${entitlement}: ${relativePath}`,
        );
      }
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'pipe',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .map(buffer => buffer.toString())
      .join('\n')
      .trim();
    throw new Error(`macOS app code signature verification failed${output ? `:\n${output}` : ''}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.asset || !opts.target || !opts.version) {
    usage();
    process.exit(2);
  }

  const target = TARGETS[opts.target];
  if (!target) throw new Error(`Unsupported target: ${opts.target}`);

  const version = normalizeVersion(opts.version);
  const packageName = opts['package-name'] || `smartperfetto-v${version}-${target.os}-${target.arch}`;
  const expectedAsset = `${packageName}.${target.ext}`;
  const assetPath = path.resolve(opts.asset);

  assert(path.basename(assetPath) === expectedAsset, `Asset filename must be ${expectedAsset}, got ${path.basename(assetPath)}`);

  const entries = listEntries(assetPath, target.ext);
  assert(entries.length > 0, 'Archive is empty');
  validateArchiveEntries(entries);
  assert(
    entries.every(entry => entry === `${packageName}/` || entry.startsWith(`${packageName}/`)),
    `Archive must contain exactly one top-level directory: ${packageName}/`,
  );

  const extractedRoot = extractArchiveToTemp(assetPath, target.ext, entries);
  process.on('exit', () => {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  });

  for (const rel of target.required) {
    assertEntryExists(entries, packageName, rel);
  }

  const frontendRoot = frontendRootForTarget(target);
  const frontendIndexEntry = `${packageName}/${frontendRoot}/index.html`;
  const frontendStableVersion = stableVersionFromIndex(readExtractedText(extractedRoot, frontendIndexEntry));
  assert(frontendStableVersion, `${frontendIndexEntry} does not declare data-perfetto_version.stable`);

  const frontendManifestEntry = assertEntryExists(
    entries,
    packageName,
    `${frontendRoot}/${frontendStableVersion}/manifest.json`,
  );
  const frontendManifest = readExtractedJson(extractedRoot, frontendManifestEntry);
  const frontendManifestResources = frontendManifest.resources ?? {};
  for (const requiredManifestResource of ['trace_processor.wasm', 'trace_processor_memory64.wasm']) {
    assert(
      typeof frontendManifestResources[requiredManifestResource] === 'string',
      `${frontendManifestEntry} is missing required resource hash: ${requiredManifestResource}`,
    );
  }
  for (const [resource, expectedHash] of Object.entries(frontendManifestResources)) {
    const resourceEntry = assertEntryExists(
      entries,
      packageName,
      `${frontendRoot}/${frontendStableVersion}/${resource}`,
    );
    const actualHash = sha256Resource(readExtractedBuffer(extractedRoot, resourceEntry));
    assert(
      actualHash === expectedHash,
      `Frontend manifest hash mismatch for ${resourceEntry}: expected ${expectedHash}, got ${actualHash}`,
    );
  }

  for (const rel of FRONTEND_TOP_LEVEL_SYNTAQLITE_ASSETS) {
    const entry = assertEntryExists(entries, packageName, `${frontendRoot}/${rel}`);
    assertExtractedEntryNonEmpty(extractedRoot, entry);
  }

  for (const rel of FRONTEND_VERSIONED_REQUIRED_ASSETS) {
    const entry = assertEntryExists(entries, packageName, `${frontendRoot}/${frontendStableVersion}/${rel}`);
    assertExtractedEntryNonEmpty(extractedRoot, entry);
  }

  const frontendBundleEntry = `${packageName}/${frontendRoot}/${frontendStableVersion}/frontend_bundle.js`;
  const frontendBundleText = readExtractedText(extractedRoot, frontendBundleEntry);
  for (const forbidden of [
    "regexp_extract(r.name, 'Lock contention on (?:a )?(.*) lock')",
    'lock_name FROM android_monitor_contention',
    'SELECT lock_name FROM android_monitor_contention',
  ]) {
    assert(
      !frontendBundleText.includes(forbidden),
      `Frontend bundle contains stale AndroidLockContention SQL: ${forbidden}`,
    );
  }
  const referencedSyntaqliteAssets = [...frontendBundleText.matchAll(/["'](assets\/syntaqlite-[^"']+)["']/g)]
    .map(match => match[1]);
  for (const rel of [...new Set(referencedSyntaqliteAssets)].sort()) {
    const entry = assertEntryExists(entries, packageName, `${frontendRoot}/${rel}`);
    assertExtractedEntryNonEmpty(extractedRoot, entry);
  }

  const engineBundleEntry = `${packageName}/${frontendRoot}/${frontendStableVersion}/engine_bundle.js`;
  const engineBundleText = readExtractedText(extractedRoot, engineBundleEntry);
  assert(
    engineBundleText.includes('"trace_processor.wasm"'),
    `${engineBundleEntry} is missing classic trace_processor.wasm loader glue`,
  );

  const backendRoot = backendRootForTarget(target);
  const aiwAssetRoot = `${packageName}/${backendRoot}/knowledge/aiw-pack`;
  const aiwLock = readExtractedJson(extractedRoot, `${aiwAssetRoot}/knowledge-packs.lock.json`);
  assert(aiwLock.schemaVersion === 1, 'Knowledge Pack lock schema must be 1');
  const aiwVersion = aiwLock.bundled?.contentVersion;
  assert(
    typeof aiwVersion === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(aiwVersion),
    `Invalid bundled Knowledge Pack version: ${aiwVersion}`,
  );
  const aiwBundleRoot = `${aiwAssetRoot}/bundled/${aiwVersion}`;
  const aiwRequired = [
    'manifest.json',
    'content.sqlite.gz',
    'audit-summary.json',
    'licenses/LICENSE',
    'licenses/COMMERCIAL-LICENSE.md',
    'licenses/KNOWLEDGE-PACK-LICENSE.md',
  ];
  for (const rel of aiwRequired) {
    const entry = assertEntryExists(entries, packageName, `${backendRoot}/knowledge/aiw-pack/bundled/${aiwVersion}/${rel}`);
    assertExtractedEntryNonEmpty(extractedRoot, entry);
  }
  const aiwManifestBytes = readExtractedBuffer(extractedRoot, `${aiwBundleRoot}/manifest.json`);
  assert(
    sha256Hex(aiwManifestBytes) === aiwLock.bundled.manifestSha256,
    'Bundled Knowledge Pack manifest does not match lock',
  );
  const aiwManifest = JSON.parse(aiwManifestBytes.toString('utf8'));
  assert(aiwManifest.contentVersion === aiwVersion, 'Bundled Knowledge Pack version mismatch');
  assert(
    aiwManifest.contentFingerprint === aiwLock.bundled.contentFingerprint,
    'Bundled Knowledge Pack fingerprint mismatch',
  );
  assert(
    aiwManifest.licenses?.expression === 'CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial',
    'Bundled Knowledge Pack license mismatch',
  );
  const aiwDatabase = readExtractedBuffer(extractedRoot, `${aiwBundleRoot}/content.sqlite.gz`);
  assert(
    aiwDatabase.length === aiwManifest.database.compressedBytes &&
      sha256Hex(aiwDatabase) === aiwManifest.database.sha256,
    'Bundled Knowledge Pack compressed database mismatch',
  );
  const aiwUncompressed = zlib.gunzipSync(aiwDatabase, {
    maxOutputLength: aiwManifest.database.uncompressedBytes,
  });
  assert(
    aiwUncompressed.length === aiwManifest.database.uncompressedBytes &&
      sha256Hex(aiwUncompressed) === aiwManifest.database.uncompressedSha256,
    'Bundled Knowledge Pack database mismatch',
  );
  const backendDistRoot = `${packageName}/${backendRoot}/dist/`;
  const staleBackendEntries = entries.filter(entry => (
    entry.startsWith(backendDistRoot) &&
    (
      entry.includes('traceAnalysisSkill') ||
      entry.includes('traceAnalysisSkillConfig') ||
      entry.includes('advancedAIRoutes') ||
      entry.includes('autoAnalysis') ||
      entry.includes('advancedAIController') ||
      entry.includes('autoAnalysisController') ||
      entry.includes('advancedAIService') ||
      entry.includes('autoAnalysisService') ||
      entry.includes('aiService') ||
      entry.includes('enterpriseLegacyAiGuard')
    )
  ));
  assert(
    staleBackendEntries.length === 0,
    `Package contains stale legacy AI backend artifacts: ${staleBackendEntries.join(', ')}`,
  );
  for (const entry of entries) {
    if (!entry.startsWith(backendDistRoot) || !/\.(js|mjs|cjs|json|map|d\.ts)$/.test(entry)) continue;
    const text = readExtractedText(extractedRoot, entry);
    for (const forbidden of [
      'TraceAnalysisSkill',
      'traceAnalysisSkill',
      'trace-analysis-system',
      'TRACE_ANALYSIS',
      'DeepSeek API not configured on server',
      '/api/advanced-ai',
      '/api/auto-analysis',
    ]) {
      assert(!text.includes(forbidden), `Package backend runtime contains stale provider-specific code in ${entry}: ${forbidden}`);
    }
  }

  for (const rel of target.binaryRequired) {
    const entry = `${packageName}/${rel}`;
    assertBinaryKind(readExtractedBuffer(extractedRoot, entry), entry, target.binaryKind);
  }

  const manifest = readPackageManifest(extractedRoot, packageName, target);
  assert(manifest.schemaVersion === 3, `Manifest schemaVersion mismatch: ${manifest.schemaVersion}`);
  assert(manifest.name === 'smartperfetto', `Manifest name mismatch: ${manifest.name}`);
  assert(manifest.version === version, `Manifest version mismatch: expected ${version}, got ${manifest.version}`);
  assert(manifest.packageName === packageName, `Manifest packageName mismatch: expected ${packageName}, got ${manifest.packageName}`);
  assert(manifest.target?.os === target.os, `Manifest target.os mismatch: ${manifest.target?.os}`);
  assert(manifest.target?.arch === target.arch, `Manifest target.arch mismatch: ${manifest.target?.arch}`);
  assert(manifest.target?.id === opts.target, `Manifest target.id mismatch: ${manifest.target?.id}`);
  if (opts.target === 'windows-x64') {
    assert(
      manifest.target?.minimumSystemVersion === '10.0',
      'Windows portable manifest must require Windows 10 / Windows Server 2016 or newer',
    );
  }
  if (opts.target === 'linux-x64') {
    assert(
      manifest.target?.libc?.family === 'glibc' &&
        manifest.target?.libc?.minimumVersion === '2.34',
      'Linux portable manifest must require glibc 2.34 or newer',
    );
  }
  if (opts.target === 'macos-arm64') {
    assert(
      typeof manifest.target?.minimumSystemVersion === 'string' &&
        compareVersions(manifest.target.minimumSystemVersion, '13.5') >= 0,
      'macOS portable manifest must require macOS 13.5 or newer',
    );
  }
  assert(manifest.distribution === 'portable', `Manifest distribution mismatch: ${manifest.distribution}`);
  assert(manifest.channel === 'stable', `Manifest channel mismatch: ${manifest.channel}`);
  assert(typeof manifest.gitDirty === 'boolean', 'Manifest gitDirty must be a boolean');
  assert(
    typeof manifest.gitCommit === 'string' && /^[0-9a-f]{7,40}$/i.test(manifest.gitCommit),
    `Manifest gitCommit is invalid: ${manifest.gitCommit}`,
  );
  assert(
    typeof manifest.nodeRuntime?.version === 'string' &&
      /^v?24\./.test(manifest.nodeRuntime.version),
    `Manifest Node runtime must be version 24: ${manifest.nodeRuntime?.version}`,
  );
  assert(
    typeof manifest.nodeRuntime?.file === 'string' &&
      manifest.nodeRuntime.file.length > 0 &&
      /^[0-9a-f]{64}$/i.test(manifest.nodeRuntime?.sha256 || ''),
    'Manifest Node runtime file or SHA256 is invalid',
  );
  assertNodeRuntimeManifestPin(manifest, opts.target);
  assertNodeRuntimeExecutablePin(
    readExtractedBuffer(
      extractedRoot,
      `${packageName}/${target.nodeRuntimeExecutable}`,
    ),
    opts.target,
  );
  assert(
    typeof manifest.traceProcessor?.version === 'string' &&
      manifest.traceProcessor.version.length > 0 &&
      /^[0-9a-f]{64}$/i.test(manifest.traceProcessor?.sourceSha256 || '') &&
      /^[0-9a-f]{64}$/i.test(manifest.traceProcessor?.sha256 || ''),
    'Manifest trace processor version, source SHA256, or packaged SHA256 is invalid',
  );
  assertTraceProcessorManifestPin(manifest, opts.target);
  const traceProcessorEntry = `${packageName}/${
    target.os === 'macos'
      ? 'SmartPerfetto.app/Contents/Resources/bin/trace_processor_shell'
      : target.os === 'windows'
        ? 'bin/trace_processor_shell.exe'
        : 'bin/trace_processor_shell'
  }`;
  assert(
    sha256Hex(readExtractedBuffer(extractedRoot, traceProcessorEntry)) ===
      manifest.traceProcessor.sha256,
    'Manifest trace processor SHA256 does not match the extracted binary',
  );
  const allowedSigningModes = target.os === 'macos'
    ? ['macos-adhoc', 'macos-developer-id', 'macos-developer-id-notarized']
    : ['unsigned'];
  assert(
    allowedSigningModes.includes(manifest.signingMode),
    `Manifest signingMode mismatch for ${opts.target}: ${manifest.signingMode}`,
  );
  verifyNativeRuntimeCompatibility(
    extractedEntryPath(extractedRoot, packageName),
    opts.target,
    manifest,
  );
  if (opts.publicRelease) {
    assertPublicReleaseManifest(manifest, target);
    if (target.os === 'macos') {
      assertNotarizationReceipt(readExtractedJson(
        extractedRoot,
        `${packageName}/NOTARIZATION-RECEIPT.json`,
      ));
    }
  }

  const backendPackageEntry = target.os === 'macos'
    ? `${packageName}/SmartPerfetto.app/Contents/Resources/backend/package.json`
    : `${packageName}/backend/package.json`;
  const backendPackage = readExtractedJson(extractedRoot, backendPackageEntry);
  assert(backendPackage.name === '@gracker/smartperfetto', `Backend package name mismatch: ${backendPackage.name}`);
  assert(backendPackage.version === version, `Backend package version mismatch: expected ${version}, got ${backendPackage.version}`);

  const readme = readExtractedText(extractedRoot, `${packageName}/${target.readme}`);
  assert(readme.includes(`Version: ${version}`), `${target.readme} does not contain the package version`);
  if (target.os === 'windows') {
    const readmeZh = readExtractedText(
      extractedRoot,
      `${packageName}/README-WINDOWS.zh-CN.txt`,
    );
    assert(
      readme.includes('%LOCALAPPDATA%\\SmartPerfetto') &&
        readme.includes('--migrate-from') &&
        readme.includes('SMARTPERFETTO_PORTABLE_MODE=1') &&
        readme.includes('Get-FileHash') &&
        readme.includes('Ctrl+C') &&
        readme.includes('docs/getting-started/windows.en.md'),
      'README-WINDOWS.txt is missing durable data or migration instructions',
    );
    assert(
      readmeZh.includes(`版本：${version}`) &&
        readmeZh.includes('%LOCALAPPDATA%\\SmartPerfetto') &&
        readmeZh.includes('Get-FileHash') &&
        readmeZh.includes('Ctrl+C') &&
        readmeZh.includes('docs/getting-started/windows.md'),
      'README-WINDOWS.zh-CN.txt is missing the Windows quick-start contract',
    );
  }
  if (target.os === 'macos') {
    assert(
      readme.includes(
        `System requirement: macOS ${manifest.target.minimumSystemVersion} or newer on Apple silicon.`,
      ),
      'README-MACOS.txt minimum system version does not match the package manifest',
    );
  }

  if (opts.commit) {
    assert(manifest.gitCommit === opts.commit, `Manifest gitCommit mismatch: expected ${opts.commit}, got ${manifest.gitCommit || '<missing>'}`);
  }
  if (opts.requireClean) {
    assert(manifest.gitDirty === false, 'Package was built from a dirty worktree');
  }
  if (target.os === 'macos') {
    verifyMacosCodeSignature(extractedRoot, packageName);
  }

  console.log(`Portable package verified: ${expectedAsset}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  ARCHIVE_LIMITS,
  TARGETS,
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
  normalizeArchiveEntry,
  normalizeVersion,
  nodeRuntimeExecutableDigest,
  readNodeRuntimePin,
  readPackageManifest,
  runArchiveCommandQuiet,
  validateArchiveEntries,
};

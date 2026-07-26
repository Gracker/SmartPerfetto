#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { findMachOFiles } = require('./find-macho-files.cjs');

const TARGETS = {
  'windows-x64': {
    os: 'windows',
    arch: 'x64',
    ext: 'zip',
    readme: 'README-WINDOWS.txt',
    binaryKind: 'pe',
    required: [
      'PACKAGE-MANIFEST.json',
      'README-WINDOWS.txt',
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
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
    ],
    binaryRequired: [
      'SmartPerfetto.exe',
      'runtime/node/node.exe',
      'bin/trace_processor_shell.exe',
      'backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
      'backend/node_modules/opencode-ai/bin/opencode.exe',
    ],
  },
  'macos-arm64': {
    os: 'macos',
    arch: 'arm64',
    ext: 'zip',
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

function listEntries(assetPath, ext) {
  if (ext === 'zip') {
    return execFileSync('unzip', ['-Z1', assetPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean);
  }
  if (ext === 'tar.gz') {
    return execFileSync('tar', ['-tzf', assetPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(entry => entry.replace(/^\.\//, ''));
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function readEntry(assetPath, ext, entry) {
  if (ext === 'zip') {
    return execFileSync('unzip', ['-p', assetPath, entry], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (ext === 'tar.gz') {
    return execFileSync('tar', ['-xOzf', assetPath, entry], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function readEntryBuffer(assetPath, ext, entry) {
  const maxBuffer = 256 * 1024 * 1024;
  if (ext === 'zip') {
    return execFileSync('unzip', ['-p', assetPath, entry], { maxBuffer });
  }
  if (ext === 'tar.gz') {
    return execFileSync('tar', ['-xOzf', assetPath, entry], { maxBuffer });
  }
  throw new Error(`Unsupported archive extension: ${ext}`);
}

function extractArchiveToTemp(assetPath, ext) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-package-verify-'));
  try {
    if (ext === 'zip') {
      execFileSync('unzip', ['-q', assetPath, '-d', tmpRoot], { stdio: 'pipe' });
    } else if (ext === 'tar.gz') {
      execFileSync('tar', ['-xzf', assetPath, '-C', tmpRoot], { stdio: 'pipe' });
    } else {
      throw new Error(`Unsupported archive extension: ${ext}`);
    }
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
    execFileSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function verifyMacosCodeSignature(assetPath, packageName) {
  if (!commandExists('codesign')) return;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-macos-verify-'));
  try {
    execFileSync('unzip', ['-q', assetPath, '-d', tmpRoot], { stdio: 'pipe' });
    const appPath = path.join(tmpRoot, packageName, 'SmartPerfetto.app');
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
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
  assert(
    entries.every(entry => entry === `${packageName}/` || entry.startsWith(`${packageName}/`)),
    `Archive must contain exactly one top-level directory: ${packageName}/`,
  );

  const extractedRoot = extractArchiveToTemp(assetPath, target.ext);
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
    engineBundleText.includes('function requireTrace_processor()') &&
      engineBundleText.includes('return locateFile("trace_processor.wasm")'),
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

  const manifest = readExtractedJson(extractedRoot, `${packageName}/PACKAGE-MANIFEST.json`);
  assert(manifest.name === 'smartperfetto', `Manifest name mismatch: ${manifest.name}`);
  assert(manifest.version === version, `Manifest version mismatch: expected ${version}, got ${manifest.version}`);
  assert(manifest.packageName === packageName, `Manifest packageName mismatch: expected ${packageName}, got ${manifest.packageName}`);
  assert(manifest.target?.os === target.os, `Manifest target.os mismatch: ${manifest.target?.os}`);
  assert(manifest.target?.arch === target.arch, `Manifest target.arch mismatch: ${manifest.target?.arch}`);
  assert(manifest.target?.id === opts.target, `Manifest target.id mismatch: ${manifest.target?.id}`);

  const backendPackageEntry = target.os === 'macos'
    ? `${packageName}/SmartPerfetto.app/Contents/Resources/backend/package.json`
    : `${packageName}/backend/package.json`;
  const backendPackage = readExtractedJson(extractedRoot, backendPackageEntry);
  assert(backendPackage.name === '@gracker/smartperfetto', `Backend package name mismatch: ${backendPackage.name}`);
  assert(backendPackage.version === version, `Backend package version mismatch: expected ${version}, got ${backendPackage.version}`);

  const readme = readExtractedText(extractedRoot, `${packageName}/${target.readme}`);
  assert(readme.includes(`Version: ${version}`), `${target.readme} does not contain the package version`);

  if (opts.commit) {
    assert(manifest.gitCommit === opts.commit, `Manifest gitCommit mismatch: expected ${opts.commit}, got ${manifest.gitCommit || '<missing>'}`);
  }
  if (opts.requireClean) {
    assert(manifest.gitDirty === false, 'Package was built from a dirty worktree');
  }
  if (target.os === 'macos') {
    verifyMacosCodeSignature(assetPath, packageName);
  }

  console.log(`Portable package verified: ${expectedAsset}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

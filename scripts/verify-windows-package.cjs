#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function usage() {
  console.error([
    'Usage:',
    '  node scripts/verify-windows-package.cjs --zip <file> --version <version> [options]',
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
    } else if (arg === '--zip' || arg === '--version' || arg === '--commit' || arg === '--package-name') {
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

function unzipList(zipPath) {
  return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

function unzipText(zipPath, entry) {
  return execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonEntry(zipPath, entry) {
  try {
    return JSON.parse(unzipText(zipPath, entry));
  } catch (error) {
    throw new Error(`Invalid JSON in ${entry}: ${error.message || error}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.zip || !opts.version) {
    usage();
    process.exit(2);
  }

  const version = normalizeVersion(opts.version);
  const packageName = opts['package-name'] || `smartperfetto-v${version}-windows-x64`;
  const expectedAsset = `${packageName}.zip`;
  const zipPath = path.resolve(opts.zip);

  assert(path.basename(zipPath) === expectedAsset, `Asset filename must be ${expectedAsset}, got ${path.basename(zipPath)}`);

  const entries = unzipList(zipPath);
  assert(entries.length > 0, 'Zip is empty');
  assert(entries.every(entry => entry === `${packageName}/` || entry.startsWith(`${packageName}/`)), `Zip must contain exactly one top-level directory: ${packageName}/`);

  const requiredEntries = [
    `${packageName}/PACKAGE-MANIFEST.json`,
    `${packageName}/README-WINDOWS.txt`,
    `${packageName}/SmartPerfetto.exe`,
    `${packageName}/runtime/node/node.exe`,
    `${packageName}/bin/trace_processor_shell.exe`,
    `${packageName}/backend/package.json`,
    `${packageName}/backend/dist/index.js`,
    `${packageName}/backend/dist/version.js`,
    `${packageName}/frontend/index.html`,
  ];
  for (const entry of requiredEntries) {
    assert(entries.includes(entry), `Missing package entry: ${entry}`);
  }

  const manifest = readJsonEntry(zipPath, `${packageName}/PACKAGE-MANIFEST.json`);
  assert(manifest.name === 'smartperfetto', `Manifest name mismatch: ${manifest.name}`);
  assert(manifest.version === version, `Manifest version mismatch: expected ${version}, got ${manifest.version}`);
  assert(manifest.packageName === packageName, `Manifest packageName mismatch: expected ${packageName}, got ${manifest.packageName}`);
  assert(manifest.target?.os === 'windows', `Manifest target.os mismatch: ${manifest.target?.os}`);
  assert(manifest.target?.arch === 'x64', `Manifest target.arch mismatch: ${manifest.target?.arch}`);

  const backendPackage = readJsonEntry(zipPath, `${packageName}/backend/package.json`);
  assert(backendPackage.name === '@gracker/smartperfetto', `Backend package name mismatch: ${backendPackage.name}`);
  assert(backendPackage.version === version, `Backend package version mismatch: expected ${version}, got ${backendPackage.version}`);

  const readme = unzipText(zipPath, `${packageName}/README-WINDOWS.txt`);
  assert(readme.includes(`Version: ${version}`), 'README-WINDOWS.txt does not contain the package version');

  if (opts.commit) {
    assert(manifest.gitCommit === opts.commit, `Manifest gitCommit mismatch: expected ${opts.commit}, got ${manifest.gitCommit || '<missing>'}`);
  }
  if (opts.requireClean) {
    assert(manifest.gitDirty === false, 'Package was built from a dirty worktree');
  }

  console.log(`Windows package verified: ${expectedAsset}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

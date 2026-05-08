#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function usage() {
  console.error([
    'Usage:',
    '  node scripts/sync-version.cjs [version]',
    '  node scripts/sync-version.cjs --check [version]',
    '',
    'Examples:',
    '  npm run version:set -- 1.0.1',
    '  npm run version:sync -- --check',
  ].join('\n'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeVersion(raw) {
  const value = String(raw || '').trim().replace(/^v/, '');
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(value)) {
    throw new Error(`Invalid SemVer version: ${raw}`);
  }
  return value;
}

function setPackageVersion(filePath, version) {
  const json = readJson(filePath);
  json.version = version;
  writeJson(filePath, json);
}

function setPackageLockVersion(filePath, version) {
  const json = readJson(filePath);
  json.version = version;
  if (json.packages?.['']) {
    json.packages[''].version = version;
  }
  writeJson(filePath, json);
}

function currentRootVersion() {
  const rootPackage = readJson(path.join(repoRoot, 'package.json'));
  return normalizeVersion(rootPackage.version);
}

function assertSynced(expectedVersion) {
  const checks = [
    ['package.json', readJson(path.join(repoRoot, 'package.json')).version],
    ['package-lock.json', readJson(path.join(repoRoot, 'package-lock.json')).version],
    ['package-lock.json packages[""]', readJson(path.join(repoRoot, 'package-lock.json')).packages?.['']?.version],
    ['backend/package.json', readJson(path.join(repoRoot, 'backend/package.json')).version],
    ['backend/package-lock.json', readJson(path.join(repoRoot, 'backend/package-lock.json')).version],
    [
      'backend/package-lock.json packages[""]',
      readJson(path.join(repoRoot, 'backend/package-lock.json')).packages?.['']?.version,
    ],
  ];

  const failures = checks
    .filter(([, value]) => value !== expectedVersion)
    .map(([label, value]) => `${label}: expected ${expectedVersion}, got ${value || '<missing>'}`);

  if (failures.length > 0) {
    throw new Error(`Version files are not synchronized:\n- ${failures.join('\n- ')}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const versionArg = args.find(arg => !arg.startsWith('--'));

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const version = normalizeVersion(versionArg || currentRootVersion());

  if (!checkOnly) {
    setPackageVersion(path.join(repoRoot, 'package.json'), version);
    setPackageLockVersion(path.join(repoRoot, 'package-lock.json'), version);
    setPackageVersion(path.join(repoRoot, 'backend/package.json'), version);
    setPackageLockVersion(path.join(repoRoot, 'backend/package-lock.json'), version);
  }

  assertSynced(version);
  console.log(`SmartPerfetto version ${checkOnly ? 'is synchronized at' : 'set to'} ${version}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

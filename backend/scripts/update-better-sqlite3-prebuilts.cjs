#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.
//
// Refreshes prebuilts/better-sqlite3 from the upstream release of the exact
// version backend/package.json pins. npm installs that skip dependency install
// scripts (the npm 12 default) load these through services/sqliteDatabase.ts.
// Pass --check to verify the committed binaries without any network access.

const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.join(BACKEND, 'prebuilts', 'better-sqlite3');
const MANIFEST = path.join(ROOT, 'manifest.json');
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
const NODE_ABI = '137';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pinnedVersion = () => JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8')).dependencies['better-sqlite3'];
const binaryPath = (target) => path.join(ROOT, `node-v${NODE_ABI}-${target}`, 'better_sqlite3.node');

function check() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const failures = [];
  if (manifest.version !== pinnedVersion()) failures.push(`manifest ${manifest.version} != package.json ${pinnedVersion()}`);
  for (const target of TARGETS) {
    const file = binaryPath(target);
    if (!fs.existsSync(file)) failures.push(`missing ${target}`);
    else if (sha256(file) !== manifest.binaries[target]) failures.push(`checksum mismatch ${target}`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`better-sqlite3 ${manifest.version} prebuilts verified for ${TARGETS.length} targets`);
}

function update() {
  const version = pinnedVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`better-sqlite3 must be pinned exactly, got ${version}`);
  const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : undefined;
  const binaries = {};
  const archives = {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'better-sqlite3-prebuilts-'));
  try {
    for (const target of TARGETS) {
      const name = `better-sqlite3-v${version}-node-v${NODE_ABI}-${target}.tar.gz`;
      const archive = path.join(work, name);
      execFileSync('curl', ['-fsSL', '--retry', '3', '-o', archive,
        `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}`], {stdio: 'inherit'});
      archives[target] = sha256(archive);
      if (previous?.version === version && previous.archives[target] !== archives[target]) {
        throw new Error(`upstream archive changed for ${target}`);
      }
      const extracted = path.join(work, target);
      fs.mkdirSync(extracted);
      execFileSync('tar', ['-xzf', archive, '-C', extracted, 'build/Release/better_sqlite3.node']);
      const destination = binaryPath(target);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(path.join(extracted, 'build', 'Release', 'better_sqlite3.node'), destination);
      binaries[target] = sha256(destination);
    }
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify({version, nodeAbi: NODE_ABI, archives, binaries}, null, 2)}\n`);
  check();
}

if (process.argv.includes('--check')) check();
else update();

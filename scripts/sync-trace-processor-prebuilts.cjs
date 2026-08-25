#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pinFile = path.join(repoRoot, 'scripts/trace-processor-pin.env');
const prebuiltRoot = path.join(repoRoot, 'backend/prebuilts/trace_processor');

const targets = [
  {
    key: 'linux-x64',
    perfettoPlatform: 'linux-amd64',
    shaKey: 'PERFETTO_SHELL_SHA256_LINUX_AMD64',
    executableName: 'trace_processor_shell',
  },
  {
    key: 'darwin-arm64',
    perfettoPlatform: 'mac-arm64',
    shaKey: 'PERFETTO_SHELL_SHA256_MAC_ARM64',
    executableName: 'trace_processor_shell',
  },
  {
    key: 'win32-x64',
    perfettoPlatform: 'windows-amd64',
    shaKey: 'PERFETTO_SHELL_SHA256_WINDOWS_AMD64',
    executableName: 'trace_processor_shell.exe',
  },
];

function parsePinFile(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing ${key} in ${pinFile}`);
  return value;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function download(url, destination, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        download(new URL(location, url).toString(), destination, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${status}`));
        return;
      }

      const file = fs.createWriteStream(destination, { mode: 0o755 });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });

    request.setTimeout(120_000, () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on('error', reject);
  });
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function syncTarget(values, target) {
  const version = required(values, 'PERFETTO_VERSION');
  const artifactVersion = values.PERFETTO_ARTIFACT_VERSION || version;
  const urlBase = process.env.TRACE_PROCESSOR_DOWNLOAD_BASE || required(values, 'PERFETTO_LUCI_URL_BASE');
  const expectedSha = required(values, target.shaKey);
  const url = `${urlBase.replace(/\/+$/, '')}/${artifactVersion}/${target.perfettoPlatform}/${target.executableName}`;
  const destination = path.join(prebuiltRoot, target.key, target.executableName);

  if (fs.existsSync(destination)) {
    const actualSha = sha256File(destination);
    if (actualSha === expectedSha) {
      fs.chmodSync(destination, 0o755);
      console.log(`${target.key}: already current (${formatBytes(fs.statSync(destination).size)})`);
      return;
    }
    console.log(`${target.key}: hash mismatch; replacing prebuilt`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = path.join(os.tmpdir(), `smartperfetto-${target.key}-${process.pid}-${Date.now()}`);
  await download(url, tmp);
  const actualSha = sha256File(tmp);
  if (actualSha !== expectedSha) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${target.key}: SHA256 mismatch. expected=${expectedSha} actual=${actualSha}`);
  }
  fs.renameSync(tmp, destination);
  fs.chmodSync(destination, 0o755);
  console.log(`${target.key}: synced ${version} (${formatBytes(fs.statSync(destination).size)})`);
}

async function main() {
  const values = parsePinFile(pinFile);
  for (const target of targets) {
    await syncTarget(values, target);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

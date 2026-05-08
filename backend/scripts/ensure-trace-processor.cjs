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
const { execFile } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const pinFile = path.join(repoRoot, 'scripts/trace-processor-pin.env');
const traceProcessorExecutableName = process.platform === 'win32'
  ? 'trace_processor_shell.exe'
  : 'trace_processor_shell';
const defaultOutput = path.join(repoRoot, 'perfetto/out/ui', traceProcessorExecutableName);
const outputPath = process.env.TRACE_PROCESSOR_PATH
  ? path.resolve(process.env.TRACE_PROCESSOR_PATH)
  : defaultOutput;

function parsePinFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`trace_processor pin file not found: ${filePath}`);
  }

  const pins = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) pins[match[1]] = match[2];
  }
  return pins;
}

function getPlatformAndSha(pins) {
  const arch = os.arch();
  let platform;
  let shaKey;

  if (process.platform === 'darwin') {
    if (arch === 'arm64') {
      platform = 'mac-arm64';
      shaKey = 'PERFETTO_SHELL_SHA256_MAC_ARM64';
    } else if (arch === 'x64') {
      platform = 'mac-amd64';
      shaKey = 'PERFETTO_SHELL_SHA256_MAC_AMD64';
    }
  } else if (process.platform === 'linux') {
    if (arch === 'arm64') {
      platform = 'linux-arm64';
      shaKey = 'PERFETTO_SHELL_SHA256_LINUX_ARM64';
    } else if (arch === 'x64') {
      platform = 'linux-amd64';
      shaKey = 'PERFETTO_SHELL_SHA256_LINUX_AMD64';
    }
  } else if (process.platform === 'win32') {
    if (arch === 'x64') {
      platform = 'windows-amd64';
      shaKey = 'PERFETTO_SHELL_SHA256_WINDOWS_AMD64';
    }
  }

  if (!platform || !shaKey) {
    throw new Error(
      `Unsupported platform for automatic trace_processor_shell install: ${process.platform}/${arch}. ` +
      'Set TRACE_PROCESSOR_PATH to an existing executable.'
    );
  }

  const sha256 = pins[shaKey];
  if (!sha256) throw new Error(`Missing ${shaKey} in ${pinFile}`);
  return { platform, sha256 };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatMacPermissionHint(filePath) {
  if (process.platform !== 'darwin') return '';
  return [
    '',
    'macOS may have blocked trace_processor_shell because it was downloaded from the internet.',
    'Open System Settings -> Privacy & Security -> Security, click "Allow Anyway" for trace_processor_shell,',
    'then run the command again and choose "Open" if macOS asks.',
    '',
    'For a binary you trust, you can also run:',
    `  xattr -dr com.apple.quarantine "${filePath}"`,
    `  chmod +x "${filePath}"`,
  ].join('\n');
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
        reject(new Error(`Failed to download trace_processor_shell: HTTP ${status} from ${url}`));
        return;
      }

      const file = fs.createWriteStream(destination, { mode: 0o755 });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });

    request.setTimeout(120_000, () => {
      request.destroy(new Error('Timed out downloading trace_processor_shell.'));
    });
    request.on('error', reject);
  });
}

function runVersionSmoke(filePath) {
  return new Promise((resolve, reject) => {
    execFile(filePath, ['--version'], (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (error) {
        reject(new Error(
          `trace_processor_shell --version failed: ${output || error.message}${formatMacPermissionHint(filePath)}`
        ));
        return;
      }
      console.log(`trace_processor_shell ready: ${output.trim().split(/\r?\n/)[0]}`);
      resolve();
    });
  });
}

function resolveDownloadUrl(pins, platform) {
  const version = pins.PERFETTO_VERSION;
  const defaultUrlBase = pins.PERFETTO_LUCI_URL_BASE;
  if (!version || !defaultUrlBase) {
    throw new Error(`Missing PERFETTO_VERSION or PERFETTO_LUCI_URL_BASE in ${pinFile}`);
  }

  const exactUrl = process.env.TRACE_PROCESSOR_DOWNLOAD_URL;
  if (exactUrl) {
    return { version, url: exactUrl };
  }

  const urlBase = process.env.TRACE_PROCESSOR_DOWNLOAD_BASE || defaultUrlBase;
  const executableName = platform.startsWith('windows-') ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  return { version, url: `${urlBase.replace(/\/+$/, '')}/${version}/${platform}/${executableName}` };
}

function formatDownloadHelp(url) {
  return [
    '',
    'trace_processor_shell download failed.',
    `Attempted URL: ${url}`,
    '',
    'If Google storage is unreachable from your network, use one of:',
    '  TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell',
    '  TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts',
    '  TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell',
    '',
    'Custom downloads are still SHA256-verified against scripts/trace-processor-pin.env.',
  ].join('\n');
}

async function main() {
  const pins = parsePinFile(pinFile);
  const { platform, sha256 } = getPlatformAndSha(pins);

  if (fs.existsSync(outputPath)) {
    const actual = sha256File(outputPath);
    if (actual === sha256 && isExecutable(outputPath)) {
      await runVersionSmoke(outputPath);
      return;
    }
    console.log('Existing trace_processor_shell does not match the pinned binary; replacing it.');
  }

  const { version, url } = resolveDownloadUrl(pins, platform);
  const tmpSuffix = platform.startsWith('windows-') ? '.exe' : '';
  const tmpPath = path.join(os.tmpdir(), `smartperfetto-trace_processor_shell-${process.pid}-${Date.now()}${tmpSuffix}`);

  console.log(`Downloading pinned trace_processor_shell ${version} (${platform}) from ${url}...`);
  try {
    await download(url, tmpPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`${error.message || error}${formatDownloadHelp(url)}`);
  }

  const actual = sha256File(tmpPath);
  if (actual !== sha256) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`SHA256 mismatch for trace_processor_shell. expected=${sha256} actual=${actual}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.renameSync(tmpPath, outputPath);
  fs.chmodSync(outputPath, 0o755);
  await runVersionSmoke(outputPath);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

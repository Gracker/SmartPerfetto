// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

interface PinConfig {
  version: string;
  urlBase: string;
  sha256ByPlatform: Record<string, string>;
}

export async function installTraceProcessorPrebuilt(destination: string): Promise<void> {
  const pin = loadPinConfig();
  const platform = detectPlatform();
  const expectedSha = pin.sha256ByPlatform[platform];
  if (!expectedSha) {
    throw new Error(`No trace_processor_shell SHA256 pin for platform: ${platform}`);
  }

  const url = `${pin.urlBase}/${pin.version}/${platform}/trace_processor_shell`;
  const tmp = path.join(os.tmpdir(), `smartperfetto-trace_processor_shell-${process.pid}-${Date.now()}`);

  try {
    await downloadFile(url, tmp);
    const actualSha = sha256File(tmp);
    if (actualSha !== expectedSha) {
      throw new Error(
        [
          'Downloaded trace_processor_shell failed SHA256 verification.',
          `expected: ${expectedSha}`,
          `actual:   ${actualSha}`,
        ].join('\n'),
      );
    }

    fs.chmodSync(tmp, 0o755);
    const smoke = spawnSync(tmp, ['--version'], { stdio: 'ignore' });
    if (smoke.status !== 0) {
      throw new Error('Downloaded trace_processor_shell failed the --version smoke test.');
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(tmp, destination);
    fs.chmodSync(destination, 0o755);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function loadPinConfig(): PinConfig {
  const pinPath = findPinFile();
  const values = parseEnvFile(pinPath);
  const version = requirePinValue(values, 'PERFETTO_VERSION', pinPath);
  const urlBase = requirePinValue(values, 'PERFETTO_LUCI_URL_BASE', pinPath);

  return {
    version,
    urlBase,
    sha256ByPlatform: {
      'linux-amd64': requirePinValue(values, 'PERFETTO_SHELL_SHA256_LINUX_AMD64', pinPath),
      'linux-arm64': requirePinValue(values, 'PERFETTO_SHELL_SHA256_LINUX_ARM64', pinPath),
      'mac-amd64': requirePinValue(values, 'PERFETTO_SHELL_SHA256_MAC_AMD64', pinPath),
      'mac-arm64': requirePinValue(values, 'PERFETTO_SHELL_SHA256_MAC_ARM64', pinPath),
    },
  };
}

function findPinFile(): string {
  const candidates = [
    // Packaged npm CLI: backend/dist/cli-user/services -> backend/dist
    path.resolve(__dirname, '../../trace-processor-pin.env'),
    // Source checkout: backend/src/cli-user/services -> repo root
    path.resolve(__dirname, '../../../../scripts/trace-processor-pin.env'),
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`trace_processor_shell pin file not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

function requirePinValue(values: Record<string, string>, key: string, filePath: string): string {
  const value = values[key];
  if (!value) throw new Error(`Missing ${key} in trace_processor_shell pin file: ${filePath}`);
  return value;
}

function detectPlatform(): string {
  const osPart = (() => {
    switch (process.platform) {
      case 'darwin':
        return 'mac';
      case 'linux':
        return 'linux';
      default:
        throw new Error(
          `Unsupported OS for automatic trace_processor_shell install: ${process.platform}. ` +
          'Use TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell.',
        );
    }
  })();

  const archPart = (() => {
    switch (process.arch) {
      case 'x64':
        return 'amd64';
      case 'arm64':
        return 'arm64';
      default:
        throw new Error(
          `Unsupported CPU architecture for automatic trace_processor_shell install: ${process.arch}. ` +
          'Use TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell.',
        );
    }
  })();

  return `${osPart}-${archPart}`;
}

function sha256File(filePath: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

async function downloadFile(url: string, destination: string, redirectsLeft = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading trace_processor_shell from ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        downloadFile(nextUrl, destination, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download trace_processor_shell: HTTP ${statusCode} from ${url}`));
        return;
      }

      const output = fs.createWriteStream(destination, { mode: 0o755 });
      output.on('finish', () => output.close(() => resolve()));
      output.on('error', reject);
      response.on('error', reject);
      response.pipe(output);
    });

    request.setTimeout(60_000, () => {
      request.destroy(new Error('Timed out downloading trace_processor_shell.'));
    });
    request.on('error', reject);
  });
}

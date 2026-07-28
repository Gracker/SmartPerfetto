#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

function fail(message) {
  throw new Error(`portable release asset download: ${message}`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!['--repository', '--asset-id', '--asset-name', '--asset-size', '--asset-digest', '--output'].includes(arg)) {
      fail(`unknown option: ${arg}`);
    }
    if (index + 1 >= argv.length || !String(argv[index + 1]).trim()) {
      fail(`${arg} requires a value`);
    }
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  return options;
}

function validateRequest(options) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository || '')) {
    fail('repository must use the owner/name form');
  }
  if (!/^[1-9]\d*$/.test(options.assetId || '')) fail('asset id must be a positive integer');
  if (!/^[1-9]\d*$/.test(options.assetSize || '')) fail('asset size must be a positive integer');
  if (!/^sha256:[0-9a-f]{64}$/.test(options.assetDigest || '')) {
    fail('asset digest must be a lowercase GitHub sha256 digest');
  }
  if (
    !options.assetName ||
    path.basename(options.assetName) !== options.assetName ||
    /[\0\r\n]/.test(options.assetName)
  ) {
    fail('asset name must be a safe basename');
  }
  const output = path.resolve(options.output);
  if (path.basename(output) !== options.assetName) {
    fail('output basename must match the immutable release asset name');
  }
  if (!fs.statSync(path.dirname(output)).isDirectory()) fail('output parent must exist');
  if (fs.existsSync(output)) fail('refusing to overwrite an existing download');
  return {
    ...options,
    assetId: Number(options.assetId),
    assetSize: Number(options.assetSize),
    output,
  };
}

function identify(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  let size = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        size += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    size,
    digest: `sha256:${hash.digest('hex')}`,
  };
}

function download(options, spawnProcess = spawnSync) {
  const request = validateRequest(options);
  const fd = fs.openSync(request.output, 'wx', 0o600);
  let result;
  try {
    result = spawnProcess(
      'gh',
      [
        'api',
        `repos/${request.repository}/releases/assets/${request.assetId}`,
        '-H',
        'Accept: application/octet-stream',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
      ],
      {stdio: ['ignore', fd, 'inherit']},
    );
  } finally {
    fs.closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    fs.rmSync(request.output, {force: true});
    if (result.error) throw result.error;
    fail(`gh api exited with status ${result.status}`);
  }
  const actual = identify(request.output);
  if (actual.size !== request.assetSize || actual.digest !== request.assetDigest) {
    fs.rmSync(request.output, {force: true});
    fail(
      `downloaded bytes mismatch: expected ${request.assetSize}/${request.assetDigest}, ` +
      `got ${actual.size}/${actual.digest}`,
    );
  }
  console.log(`Portable release asset downloaded and verified: ${request.assetName}`);
  return request.output;
}

function main() {
  download(parseArgs(process.argv.slice(2)));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  download,
  identify,
  parseArgs,
  validateRequest,
};

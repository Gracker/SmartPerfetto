#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(backendRoot, 'package.json'));
const sdkName = '@qoder-ai/qoder-agent-sdk';
const sdkRange = packageJson.peerDependencies?.[sdkName];
const installRoot = path.join(backendRoot, '.qoder-sdk');
const sdkEntry = path.join(installRoot, 'node_modules', sdkName, 'dist', 'index.js');

main();

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }
  if (!args.has('--accept-terms')) {
    throw new Error(
      'Qoder SDK/CLI use is governed by https://qoder.com/product-service. '
      + 'Review the terms, then rerun with --accept-terms.',
    );
  }
  if (!sdkRange) {
    throw new Error(`${sdkName} is not declared as an optional peer dependency`);
  }

  const sdkSpec = `${sdkName}@${sdkRange}`;
  const npmArgs = [
    'install',
    '--prefix', installRoot,
    '--package-lock=false',
    sdkSpec,
    'zod@^4',
  ];
  if (args.has('--dry-run')) {
    console.log(`[qoder-install] ${formatCommand('npm', npmArgs)}`);
    console.log(`[qoder-install] target=${installRoot}`);
    return;
  }

  fs.mkdirSync(installRoot, {recursive: true});
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'npm';
  const commandArgs = npmExecPath ? [npmExecPath, ...npmArgs] : npmArgs;
  const result = spawnSync(command, commandArgs, {
    cwd: backendRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!fs.existsSync(sdkEntry)) {
    throw new Error(`Qoder SDK install completed without the expected entry: ${sdkEntry}`);
  }

  const installedPackage = JSON.parse(
    fs.readFileSync(path.join(installRoot, 'node_modules', sdkName, 'package.json'), 'utf8'),
  );
  console.log(`[qoder-install] installed ${sdkName}@${installedPackage.version}`);
  console.log(`[qoder-install] module=${sdkEntry}`);
}

function printUsage() {
  console.log('Usage: npm run qoder:install -- --accept-terms [--dry-run]');
  console.log('');
  console.log('Installs the opt-in Qoder Agent SDK into backend/.qoder-sdk.');
}

function formatCommand(command, args) {
  return [command, ...args].map(value => JSON.stringify(value)).join(' ');
}

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {spawn} from 'node:child_process';
import {closeSync, openSync, writeSync} from 'node:fs';

function usage(message) {
  if (message) console.error(`ERROR: ${message}`);
  console.error('Usage: launch-detached.mjs --cwd <directory> --log <file> -- <command> [args...]');
  process.exit(2);
}

let cwd = '';
let logFile = '';
let index = 2;

while (index < process.argv.length && process.argv[index] !== '--') {
  const option = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) usage(`missing value for ${option}`);
  if (option === '--cwd') cwd = value;
  else if (option === '--log') logFile = value;
  else usage(`unknown option ${option}`);
  index += 2;
}

if (process.argv[index] !== '--') usage('missing command separator');
const [command, ...args] = process.argv.slice(index + 1);
if (!cwd) usage('missing --cwd');
if (!logFile) usage('missing --log');
if (!command) usage('missing command');

const logFd = openSync(logFile, 'a', 0o600);
const child = spawn(command, args, {
  cwd,
  detached: true,
  env: process.env,
  stdio: ['ignore', logFd, logFd],
});

try {
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
} catch (error) {
  closeSync(logFd);
  console.error(`ERROR: failed to launch ${command}: ${error.message}`);
  process.exit(1);
}

child.unref();
closeSync(logFd);
// Write the PID synchronously so it is flushed before this launcher exits;
// console.log to a pipe is asynchronous and can be dropped under load.
writeSync(1, `${child.pid}\n`);

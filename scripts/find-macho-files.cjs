#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const fs = require('fs');
const path = require('path');

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

function isMachOFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) {
      return false;
    }
    return MACHO_MAGICS.has(header.readUInt32BE(0));
  } finally {
    fs.closeSync(fd);
  }
}

function findMachOFiles(rootPath) {
  const files = [];
  const pending = [path.resolve(rootPath)];

  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isFile()) {
      if (isMachOFile(current)) {
        files.push(current);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push(path.join(current, entries[index].name));
    }
  }

  return files.sort();
}

function main(argv) {
  const nullDelimited = argv.includes('--null');
  const args = argv.filter(arg => arg !== '--null');
  if (args.length !== 1) {
    console.error('Usage: node scripts/find-macho-files.cjs [--null] <path>');
    process.exit(2);
  }

  const separator = nullDelimited ? '\0' : '\n';
  const files = findMachOFiles(args[0]);
  if (files.length > 0) {
    process.stdout.write(`${files.join(separator)}${separator}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { findMachOFiles, isMachOFile };

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const fs = require('fs');
const path = require('path');
const {validateArchiveEntries} = require('./verify-portable-package.cjs');

function verifyStagingTree(root) {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`portable staging root is not a regular directory: ${resolvedRoot}`);
  }
  const stack = [resolvedRoot];
  const entries = [];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`portable staging tree contains a symbolic link: ${candidate}`);
      }
      if (stat.isDirectory()) {
        entries.push(`${path.relative(resolvedRoot, candidate).split(path.sep).join('/')}/`);
        stack.push(candidate);
      } else if (!stat.isFile()) {
        throw new Error(`portable staging tree contains a special file: ${candidate}`);
      } else {
        entries.push(path.relative(resolvedRoot, candidate).split(path.sep).join('/'));
      }
    }
  }
  validateArchiveEntries(entries);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Usage: verify-portable-staging-tree.cjs <package-directory>');
    }
    verifyStagingTree(process.argv[2]);
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {verifyStagingTree};

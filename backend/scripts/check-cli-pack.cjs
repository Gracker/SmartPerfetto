#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const { execFileSync } = require('child_process');

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf-8',
});
const pack = JSON.parse(raw)[0];
const files = new Set(pack.files.map((file) => file.path));
const failures = [];

const requiredFiles = [
  'LICENSE',
  'package.json',
  'dist/cli-user/bin.js',
  'dist/trace-processor-pin.env',
  'data/perfettoSqlIndex.light.json',
  'data/perfettoSqlIndex.json',
  'data/perfettoStdlibSymbols.json',
  'skills/composite/scrolling_analysis.skill.yaml',
  'strategies/scrolling.strategy.md',
];

for (const file of requiredFiles) {
  if (!files.has(file)) failures.push(`missing required package file: ${file}`);
}

for (const file of files) {
  if (file.includes('/__tests__/') || file.includes('__tests__/')) {
    failures.push(`test artifact should not be packed: ${file}`);
  }
  if (/\.test\.(js|d\.ts)(\.map)?$/.test(file)) {
    failures.push(`test artifact should not be packed: ${file}`);
  }
  if (file.startsWith('dist/tests/')) {
    failures.push(`test artifact should not be packed: ${file}`);
  }
}

if (failures.length > 0) {
  console.error('CLI package check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CLI package check passed (${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked).`);

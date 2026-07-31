#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf-8',
});
const pack = JSON.parse(raw)[0];
const files = new Set(pack.files.map((file) => file.path));
const failures = [];
const packageJsonEntry = pack.files.find((file) => file.path === 'package.json');
if (!packageJsonEntry) {
  failures.push('missing required package file: package.json');
}
const packageJson = require('../package.json');
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const pipelineCatalog = yaml.load(
  fs.readFileSync(path.join(backendRoot, 'skills', 'pipelines', 'index.yaml'), 'utf8'),
);

const requiredFiles = [
  'LICENSE',
  'package.json',
  'dist/cli-user/bin.js',
  'dist/trace-processor-pin.env',
  'dist/perfetto-recording-tools-pin.env',
  'data/perfettoSqlIndex.light.json',
  'data/perfettoSqlIndex.json',
  'data/perfettoStdlibSymbols.json',
  'prebuilts/trace_processor/linux-x64/trace_processor_shell',
  'prebuilts/trace_processor/darwin-arm64/trace_processor_shell',
  'prebuilts/trace_processor/win32-x64/trace_processor_shell.exe',
  'prebuilts/android-platform-tools/README.md',
  'prebuilts/perfetto-recording-tools/README.md',
  'skills/atomic/longest_process_slices.skill.yaml',
  'skills/composite/scrolling_analysis.skill.yaml',
  'strategies/scrolling.strategy.md',
  'knowledge/android-internals-capability-map.yaml',
  'knowledge/aiw-pack/1.root.json',
  'knowledge/aiw-pack/knowledge-packs.lock.json',
  'public/assistant-shell/index.html',
  'public/assistant-shell/app.js',
  'public/admin-control-plane/index.html',
  'public/admin-control-plane/app.js',
  'public/admin-control-plane/style.css',
];

for (const file of requiredFiles) {
  if (!files.has(file)) failures.push(`missing required package file: ${file}`);
}

const knowledgePackLock = JSON.parse(
  fs.readFileSync(path.join(backendRoot, 'knowledge', 'aiw-pack', 'knowledge-packs.lock.json'), 'utf8'),
);
const bundledPackVersion = knowledgePackLock?.bundled?.contentVersion;
if (typeof bundledPackVersion !== 'string') {
  failures.push('invalid bundled Knowledge Pack version in lock');
} else {
  for (const file of [
    'manifest.json',
    'content.sqlite.gz',
    'audit-summary.json',
    'licenses/LICENSE',
    'licenses/COMMERCIAL-LICENSE.md',
    'licenses/KNOWLEDGE-PACK-LICENSE.md',
  ]) {
    const packedPath = `knowledge/aiw-pack/bundled/${bundledPackVersion}/${file}`;
    if (!files.has(packedPath)) failures.push(`missing required package file: ${packedPath}`);
  }
}

for (const document of pipelineCatalog.documents) {
  const packedPath = `dist/rendering_pipelines/${document.file}`;
  if (!files.has(packedPath)) {
    failures.push(`missing rendering pipeline runtime asset: ${packedPath}`);
    continue;
  }
  const source = fs.readFileSync(path.join(repoRoot, 'docs', 'rendering_pipelines', document.file));
  const runtime = fs.readFileSync(path.join(backendRoot, packedPath));
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  if (sourceHash !== document.sha256 || !source.equals(runtime)) {
    failures.push(`rendering pipeline runtime asset drift: ${document.file}`);
  }
}

for (const [name, binPath] of Object.entries(packageJson.bin ?? {})) {
  if (typeof binPath !== 'string') {
    failures.push(`bin entry ${name} must point to a string path`);
    continue;
  }
  if (!files.has(binPath)) failures.push(`bin entry ${name} points to missing package file: ${binPath}`);
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

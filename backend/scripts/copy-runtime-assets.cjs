#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const distRoot = path.join(backendRoot, 'dist');

function copyFileRequired(src, dst) {
  if (!fs.existsSync(src)) {
    throw new Error(`Required runtime asset is missing: ${src}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

copyFileRequired(
  path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
  path.join(distRoot, 'trace-processor-pin.env'),
);

copyFileRequired(
  path.join(repoRoot, 'scripts', 'perfetto-recording-tools-pin.env'),
  path.join(distRoot, 'perfetto-recording-tools-pin.env'),
);

const catalog = yaml.load(
  fs.readFileSync(path.join(backendRoot, 'skills', 'pipelines', 'index.yaml'), 'utf8'),
);
const renderingDocsSource = path.join(repoRoot, 'docs', 'rendering_pipelines');
const renderingDocsTarget = path.join(distRoot, 'rendering_pipelines');
fs.rmSync(renderingDocsTarget, { recursive: true, force: true });

for (const document of catalog.documents) {
  const source = path.join(renderingDocsSource, document.file);
  const content = fs.readFileSync(source);
  const actualHash = crypto.createHash('sha256').update(content).digest('hex');
  if (actualHash !== document.sha256) {
    throw new Error(`Rendering pipeline asset hash mismatch: ${document.file}`);
  }
  copyFileRequired(source, path.join(renderingDocsTarget, document.file));
}

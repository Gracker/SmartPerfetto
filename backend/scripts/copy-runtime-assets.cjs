#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const path = require('path');

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

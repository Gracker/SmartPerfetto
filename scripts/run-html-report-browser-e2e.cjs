#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'perfetto/ui/node_modules/@playwright/test/cli.js');
if (!fs.existsSync(cli)) {
  console.error('NOT AVAILABLE: report browser checks require the pinned Perfetto UI Playwright dependencies.');
  process.exit(1);
}
// Exercise the same compiled generator shipped by the backend. Playwright's
// UI transpiler is not the backend's TypeScript compiler.
const build = spawnSync('npm', ['--prefix', 'backend', 'run', 'build'], {
  cwd: root, stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const artifacts = path.join(root, 'output/playwright/html-reports', runId);
fs.mkdirSync(artifacts, {recursive: true, mode: 0o700});
console.log('Report browser evidence: ' + artifacts);
const result = spawnSync(process.execPath, [cli, 'test', '--config',
  path.join(root, 'scripts/e2e/html-report.playwright.config.cjs'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: {...process.env, SMARTPERFETTO_REPORT_BROWSER_ARTIFACTS: artifacts},
});
process.exitCode = result.status ?? 1;

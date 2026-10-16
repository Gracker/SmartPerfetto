// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
'use strict';
const path = require('node:path');
const {defineConfig} = require('../../perfetto/ui/node_modules/@playwright/test');
const artifacts = process.env.SMARTPERFETTO_REPORT_BROWSER_ARTIFACTS;
module.exports = defineConfig({
  testDir: __dirname, testMatch: 'html-report-presentation.spec.ts',
  outputDir: path.join(artifacts, 'test-results'),
  workers: 1, retries: 0, timeout: 60000,
  reporter: [['line'], ['html', {outputFolder: path.join(artifacts, 'html-report'), open: 'never'}]],
  use: {channel: 'chrome', headless: true, viewport: {width: 1280, height: 900},
    trace: 'retain-on-failure', screenshot: 'only-on-failure'},
});

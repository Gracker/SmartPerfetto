// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractHtmlLinks,
  extractMarkdownLinks,
  extractNpmRunReferences,
  findRetiredDocumentationPaths,
  parseCliCommandNames,
  verifyDocumentation,
} from '../verify-docs.mjs';

test('extracts local Markdown links without treating URLs and anchors as files', () => {
  assert.deepEqual(
    extractMarkdownLinks([
      '[local](../README.md#usage)',
      '[web](https://example.com/docs)',
      '[anchor](#section)',
      '![image](../docs/images/example.png)',
    ].join('\n')),
    [
      {target: '../README.md', line: 1},
      {target: '../docs/images/example.png', line: 4},
    ],
  );
});

test('extracts local HTML image and anchor links', () => {
  assert.deepEqual(
    extractHtmlLinks([
      '<img src="images/sponsor/alipay.jpg" alt="QR">',
      '<a href="../README.md#usage">Read me</a>',
      '<img src="https://example.com/remote.png">',
    ].join('\n')),
    [
      {target: 'images/sponsor/alipay.jpg', line: 1},
      {target: '../README.md', line: 2},
    ],
  );
});

test('identifies retired documentation topology without classifying runtime Markdown', () => {
  assert.deepEqual(
    findRetiredDocumentationPaths([
      'docs/reviews/dated-audit.md',
      'research/dump.md',
      'backend/docs/state-machines.md',
      'backend/strategies/startup.strategy.md',
      'docs/rendering_pipelines/S01_rendering_types_overview.md',
    ]),
    [
      'docs/reviews/dated-audit.md',
      'research/dump.md',
      'backend/docs/state-machines.md',
    ],
  );
});

test('tracks package context for npm run references', () => {
  assert.deepEqual(
    extractNpmRunReferences([
      '```bash',
      'npm run verify:pr',
      'cd backend',
      'npm run build',
      'cd ..',
      'npm --prefix backend run cli:pack-check',
      '```',
    ].join('\n')),
    [
      {prefix: null, cwd: '.', script: 'verify:pr', line: 2},
      {prefix: null, cwd: 'backend', script: 'build', line: 4},
      {prefix: 'backend', cwd: '.', script: 'cli:pack-check', line: 6},
    ],
  );
});

test('derives top-level CLI commands from live help formatting', () => {
  assert.deepEqual(
    parseCliCommandNames([
      'Usage: smp [options] [command]',
      '',
      'Commands:',
      '  run [options] <trace>  run analysis',
      '  knowledge              manage knowledge',
      '  help [command]         display help',
    ].join('\n')),
    ['run', 'knowledge'],
  );
});

test('current repository documentation satisfies derived contracts', () => {
  const result = verifyDocumentation({
    cliHelp: [
      'Usage: smp [options] [command]',
      '',
      'Commands:',
      '  run [options] <trace>  run analysis',
    ].join('\n'),
  });
  assert.deepEqual(result.errors, []);
});

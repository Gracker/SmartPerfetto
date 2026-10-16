#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const {execFileSync} = require('node:child_process');
const {appendFileSync, readFileSync} = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scopes = require('../.github/ci-scopes.json');

function classifyChangedPaths(paths, all = false) {
  return Object.fromEntries(Object.entries(scopes).map(([scope, patterns]) => [
    scope,
    all || paths.some(file => patterns.some(pattern => path.posix.matchesGlob(file, pattern))),
  ]));
}

function changedPaths(eventName, event, git) {
  if (eventName === 'workflow_dispatch') return null;
  if (eventName === 'pull_request') {
    // Checkout uses the test merge commit; its first parent is the target branch.
    // Comparing merge trees excludes unrelated changes made on that branch.
    return git(['diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD']).split('\0').filter(Boolean);
  }
  if (eventName !== 'push') throw new Error(`Unsupported CI event: ${eventName}`);
  if (!/^[a-f0-9]{40}$/.test(event.before ?? '')) throw new Error('Missing push base SHA');
  if (/^0+$/.test(event.before)) return null;
  // A multi-commit push may begin outside checkout's shallow history.
  try {
    git(['cat-file', '-e', `${event.before}^{commit}`]);
  } catch {
    git(['fetch', '--no-tags', '--depth=1', 'origin', event.before]);
  }
  return git(['diff', '--name-only', '-z', '--no-renames', event.before, 'HEAD']).split('\0').filter(Boolean);
}

if (require.main === module) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const paths = changedPaths(process.env.GITHUB_EVENT_NAME, event, git);
  const selected = classifyChangedPaths(paths ?? [], paths === null);
  const output = Object.entries(selected).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output.trim());
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### CI scope\n\n${Object.entries(selected).map(([key, value]) => `- ${key}: ${value ? 'run' : 'skip'}`).join('\n')}\n`);
  }
}

module.exports = {classifyChangedPaths, changedPaths};

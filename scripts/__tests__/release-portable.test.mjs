// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const version = '1.2.2';
const targets = [
  ['windows-x64', 'windows-x64.zip'],
  ['macos-arm64', 'macos-arm64.zip'],
  ['linux-x64', 'linux-x64.tar.gz'],
];

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function setupProject() {
  const project = mkdtempSync(join(tmpdir(), 'smartperfetto-release-test-'));
  const scripts = join(project, 'scripts');
  const fakeBin = join(project, 'fake-bin');
  const out = join(project, 'dist', 'portable');
  mkdirSync(join(scripts, '__tests__'), {recursive: true});
  mkdirSync(fakeBin, {recursive: true});
  mkdirSync(out, {recursive: true});
  cpSync(
    join(root, 'scripts', 'release-portable.sh'),
    join(scripts, 'release-portable.sh'),
  );
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({version}, null, 2)}\n`,
  );
  writeFileSync(
    join(scripts, 'sync-version.cjs'),
    `'use strict';\nif (!process.argv.includes('${version}')) process.exit(1);\n`,
  );
  writeFileSync(
    join(scripts, 'verify-portable-package.cjs'),
    `'use strict';\nprocess.exit(0);\n`,
  );
  for (const [, suffix] of targets) {
    writeFileSync(
      join(out, `smartperfetto-v${version}-${suffix}`),
      `verified test asset: ${suffix}\n`,
    );
  }

  const gh = join(fakeBin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const logFile = process.env.FAKE_GH_LOG;
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = state => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const log = () => fs.appendFileSync(logFile, args.join(' ') + '\\n');
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const inline = prefix => args.find(value => value.startsWith(prefix))?.slice(prefix.length);
const output = value => process.stdout.write(String(value) + '\\n');
log();
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'repo' && args[1] === 'view') {
  output('Gracker/SmartPerfetto');
  process.exit(0);
}
if (args[0] === 'api') {
  const state = load();
  if (!state.exists) process.exit(1);
  output(JSON.stringify({
    target_commitish: state.target,
    name: state.name,
    prerelease: state.prerelease,
    draft: state.draft,
    assets: state.assets,
  }));
  process.exit(0);
}
if (args[0] !== 'release') process.exit(2);
const action = args[1];
const state = load();
if (action === 'view') {
  if (!state.exists) process.exit(1);
  const field = option('--jq');
  if (field === '.isDraft') output(state.draft);
  else if (field === '.targetCommitish') output(state.target);
  else output(JSON.stringify(state));
  process.exit(0);
}
if (action === 'create') {
  if (state.exists) process.exit(1);
  state.exists = true;
  state.draft = true;
  state.prerelease = args.includes('--prerelease');
  state.target = option('--target');
  state.name = option('--title');
  state.assets = [];
  save(state);
  process.exit(0);
}
if (action === 'edit') {
  if (!state.exists) process.exit(1);
  const draft = inline('--draft=');
  const prerelease = inline('--prerelease=');
  if (draft !== undefined) state.draft = draft === 'true';
  if (prerelease !== undefined) state.prerelease = prerelease === 'true';
  if (option('--target')) state.target = option('--target');
  if (option('--title')) state.name = option('--title');
  save(state);
  process.exit(0);
}
if (action === 'upload') {
  if (!state.exists || !state.draft) process.exit(1);
  const spec = args[3];
  const file = spec.split('#')[0];
  const name = path.basename(file);
  const bytes = fs.readFileSync(file);
  const asset = {
    name,
    size: bytes.length,
    digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const index = state.assets.findIndex(item => item.name === name);
  if (index >= 0) {
    if (!args.includes('--clobber')) process.exit(1);
    state.assets[index] = asset;
  } else {
    state.assets.push(asset);
  }
  save(state);
  process.exit(0);
}
process.exit(2);
`);
  chmodSync(gh, 0o755);

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'Release Test'],
    ['config', 'user.email', 'release-test@example.invalid'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'fixture'],
  ]) {
    const result = run('git', args, {cwd: project});
    assert.equal(result.status, 0, result.stderr);
  }
  const target = run('git', ['rev-parse', 'HEAD'], {
    cwd: project,
  }).stdout.trim();
  return {project, fakeBin, out, target};
}

function expectedAssets(out) {
  return targets.map(([, suffix]) => {
    const name = `smartperfetto-v${version}-${suffix}`;
    const bytes = readFileSync(join(out, name));
    return {
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  });
}

function executeRelease(fixture, initialState, extraArgs = []) {
  const stateFile = join(fixture.project, '.git', 'fake-gh-state.json');
  const logFile = join(fixture.project, '.git', 'fake-gh.log');
  writeFileSync(stateFile, `${JSON.stringify(initialState, null, 2)}\n`);
  writeFileSync(logFile, '');
  const result = run(
    'bash',
    [
      join(fixture.project, 'scripts', 'release-portable.sh'),
      version,
      '--skip-build',
      ...extraArgs,
    ],
    {
      cwd: fixture.project,
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        FAKE_GH_STATE: stateFile,
        FAKE_GH_LOG: logFile,
      },
    },
  );
  return {
    result,
    state: JSON.parse(readFileSync(stateFile, 'utf8')),
    log: readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean),
  };
}

function mutationLog(log) {
  return log.filter(line =>
    /^release (?:create|edit|upload)\b/.test(line),
  );
}

test('portable release uploads to a draft and publishes only after verification', () => {
  const fixture = setupProject();
  const {result, state, log} = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--no-draft'],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.draft, false);
  assert.deepEqual(state.assets, expectedAssets(fixture.out));
  const mutations = mutationLog(log);
  assert.match(mutations[0], /^release create\b.*--draft\b/);
  assert.equal(mutations.filter(line => /^release upload\b/.test(line)).length, 3);
  assert.equal(mutations.at(-1), `release edit v${version} --draft=false`);
  const publishIndex = log.indexOf(`release edit v${version} --draft=false`);
  const prePublishVerification = log.findIndex(
    (line, index) => index < publishIndex && line.startsWith('api '),
  );
  assert.ok(prePublishVerification >= 0);
});

test('an exact published release is a read-only idempotent no-op', () => {
  const fixture = setupProject();
  const {result, log} = executeRelease(fixture, {
    exists: true,
    draft: false,
    prerelease: false,
    target: fixture.target,
    name: `SmartPerfetto v${version}`,
    assets: expectedAssets(fixture.out),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(mutationLog(log), []);
  assert.match(result.stdout, /no changes made/);
});

test('a published release mismatch fails without mutating remote state', () => {
  const fixture = setupProject();
  const assets = expectedAssets(fixture.out);
  assets[0] = {...assets[0], digest: `sha256:${'0'.repeat(64)}`};
  const {result, log} = executeRelease(fixture, {
    exists: true,
    draft: false,
    prerelease: false,
    target: fixture.target,
    name: `SmartPerfetto v${version}`,
    assets,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest mismatch/);
  assert.deepEqual(mutationLog(log), []);
});

test('--no-draft rejects a partial platform set before contacting GitHub', () => {
  const fixture = setupProject();
  const {result, log} = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--no-draft', '--targets', 'windows-x64'],
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires exactly/);
  assert.deepEqual(log, []);
});

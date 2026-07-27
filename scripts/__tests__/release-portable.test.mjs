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
    `'use strict';\nconst fs=require('fs');fs.appendFileSync('.git/fake-package-verifier.log',JSON.stringify(process.argv.slice(2))+'\\n');\n`,
  );
  writeFileSync(
    join(scripts, 'verify-portable-smoke-evidence.cjs'),
    `'use strict';\nconst fs=require('fs');fs.appendFileSync('.git/fake-smoke-verifier.log',JSON.stringify(process.argv.slice(2))+'\\n');const i=process.argv.indexOf('--summary');if(i<0||!fs.statSync(process.argv[i+1]).isFile())process.exit(1);\n`,
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
  const releaseId = state.releaseId ?? 4242;
  if (args[1] !== \`repos/Gracker/SmartPerfetto/releases/\${releaseId}\`) {
    process.exit(1);
  }
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
  else if (field === '.databaseId') output(state.releaseId ?? 4242);
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
  state.releaseId = 4242;
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
  const npm = join(fakeBin, 'npm');
  writeFileSync(npm, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
fs.writeFileSync('.git/fake-npm-env.json', JSON.stringify(process.env, null, 2));
`);
  chmodSync(npm, 0o755);

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
  const evidence = join(project, '.git', 'smoke-evidence');
  for (const [targetId] of targets) {
    mkdirSync(join(evidence, targetId), {recursive: true});
    writeFileSync(
      join(evidence, targetId, 'smoke-summary.json'),
      `${JSON.stringify({target: targetId, targetCommit: target})}\n`,
    );
  }
  return {project, fakeBin, out, target, evidence};
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

function executeRelease(fixture, initialState, extraArgs = [], options = {}) {
  const stateFile = join(fixture.project, '.git', 'fake-gh-state.json');
  const logFile = join(fixture.project, '.git', 'fake-gh.log');
  writeFileSync(stateFile, `${JSON.stringify(initialState, null, 2)}\n`);
  writeFileSync(logFile, '');
  writeFileSync(join(fixture.project, '.git', 'fake-package-verifier.log'), '');
  writeFileSync(join(fixture.project, '.git', 'fake-smoke-verifier.log'), '');
  const releaseArgs = [...extraArgs];
  if (
    releaseArgs.includes('--no-draft') &&
    !releaseArgs.includes('--smoke-evidence-dir')
  ) {
    releaseArgs.push('--smoke-evidence-dir', fixture.evidence);
  }
  const commandArgs = [
    join(fixture.project, 'scripts', 'release-portable.sh'),
    version,
  ];
  if (options.skipBuild !== false) commandArgs.push('--skip-build');
  commandArgs.push(...releaseArgs);
  const result = run(
    'bash',
    commandArgs,
    {
      cwd: fixture.project,
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        FAKE_GH_STATE: stateFile,
        FAKE_GH_LOG: logFile,
        ...options.env,
      },
    },
  );
  return {
    result,
    state: JSON.parse(readFileSync(stateFile, 'utf8')),
    log: readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean),
    packageVerifierCalls: readFileSync(
      join(fixture.project, '.git', 'fake-package-verifier.log'),
      'utf8',
    ).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    smokeVerifierCalls: readFileSync(
      join(fixture.project, '.git', 'fake-smoke-verifier.log'),
      'utf8',
    ).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

function mutationLog(log) {
  return log.filter(line =>
    /^release (?:create|edit|upload)\b/.test(line),
  );
}

function releaseApiLog(log) {
  return log.filter(line => line.startsWith('api '));
}

test('a draft-only release is verified by immutable release id', () => {
  const fixture = setupProject();
  const {result, state, log} = executeRelease(fixture, {
    exists: false,
    assets: [],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.draft, true);
  assert.deepEqual(state.assets, expectedAssets(fixture.out));
  assert.deepEqual(releaseApiLog(log), [
    'api repos/Gracker/SmartPerfetto/releases/4242',
  ]);
  assert.ok(log.includes(`release view v${version} --json databaseId --jq .databaseId`));
  assert.ok(log.every(line => !line.includes('/releases/tags/')));
});

test('portable release uploads to a draft and publishes only after verification', () => {
  const fixture = setupProject();
  const {
    result,
    state,
    log,
    packageVerifierCalls,
    smokeVerifierCalls,
  } = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--no-draft'],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.draft, false);
  assert.deepEqual(state.assets, expectedAssets(fixture.out));
  assert.equal(packageVerifierCalls.length, 3);
  assert.ok(packageVerifierCalls.every(args => args.includes('--public-release')));
  assert.equal(smokeVerifierCalls.length, 3);
  assert.ok(smokeVerifierCalls.every(args => args.includes('--require-public-release')));
  const mutations = mutationLog(log);
  assert.match(mutations[0], /^release create\b.*--draft\b/);
  assert.equal(mutations.filter(line => /^release upload\b/.test(line)).length, 3);
  assert.equal(mutations.at(-1), `release edit v${version} --draft=false`);
  const publishIndex = log.indexOf(`release edit v${version} --draft=false`);
  const prePublishVerification = log.findIndex(
    (line, index) => index < publishIndex && line.startsWith('api '),
  );
  assert.ok(prePublishVerification >= 0);
  assert.deepEqual(releaseApiLog(log), [
    'api repos/Gracker/SmartPerfetto/releases/4242',
    'api repos/Gracker/SmartPerfetto/releases/4242',
  ]);
  assert.ok(log.every(line => !line.includes('/releases/tags/')));
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

test('--no-draft rejects dirty release assets before contacting GitHub', () => {
  const fixture = setupProject();
  const {result, log} = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--allow-dirty', '--no-draft'],
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-dirty.*cannot be combined with --no-draft/);
  assert.deepEqual(log, []);
});

test('--no-draft rejects rebuilding after target-native smoke', () => {
  const fixture = setupProject();
  const {result, log} = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--no-draft'],
    {skipBuild: false},
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --skip-build.*exactly match target-native smoke evidence/);
  assert.deepEqual(log, []);
});

test('--no-draft rejects missing target-native smoke evidence before contacting GitHub', () => {
  const fixture = setupProject();
  const missing = join(fixture.project, '.git', 'missing-smoke-evidence');
  const {result, log} = executeRelease(
    fixture,
    {exists: false, assets: []},
    ['--no-draft', '--smoke-evidence-dir', missing],
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target-native smoke evidence not found/);
  assert.deepEqual(log, []);
});

test('portable build does not inherit release or provider credentials', () => {
  const fixture = setupProject();
  const {result} = executeRelease(
    fixture,
    {exists: false, assets: []},
    [],
    {
      skipBuild: false,
      env: {
        GH_TOKEN: 'github-release-secret',
        GITHUB_TOKEN: 'actions-release-secret',
        OPENAI_API_KEY: 'provider-secret',
        ANTHROPIC_AUTH_TOKEN: 'provider-token',
        AWS_SECRET_ACCESS_KEY: 'cloud-secret',
        SMARTPERFETTO_MACOS_SIGN_IDENTITY: 'Developer ID Application: Test',
        SMARTPERFETTO_MACOS_NOTARY_PROFILE: 'notary-profile',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const buildEnv = JSON.parse(
    readFileSync(join(fixture.project, '.git', 'fake-npm-env.json'), 'utf8'),
  );
  assert.equal(buildEnv.GH_TOKEN, undefined);
  assert.equal(buildEnv.GITHUB_TOKEN, undefined);
  assert.equal(buildEnv.OPENAI_API_KEY, undefined);
  assert.equal(buildEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(buildEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(
    buildEnv.SMARTPERFETTO_MACOS_SIGN_IDENTITY,
    'Developer ID Application: Test',
  );
  assert.equal(buildEnv.SMARTPERFETTO_MACOS_NOTARY_PROFILE, 'notary-profile');
});

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const TARGETS = {
  'windows-x64': {
    arch: 'x64',
    platform: 'win32',
    runner: 'windows-2025',
    suffix: 'windows-x64.zip',
  },
  'macos-arm64': {
    arch: 'arm64',
    platform: 'darwin',
    runner: 'macos-15',
    suffix: 'macos-arm64.zip',
  },
  'linux-x64': {
    arch: 'x64',
    platform: 'linux',
    runner: 'ubuntu-24.04',
    suffix: 'linux-x64.tar.gz',
  },
};

const SELECTIONS = {
  all: Object.keys(TARGETS),
  'windows-linux': ['windows-x64', 'linux-x64'],
  'windows-x64': ['windows-x64'],
  'macos-arm64': ['macos-arm64'],
  'linux-x64': ['linux-x64'],
};

function fail(message) {
  throw new Error(`portable release smoke workflow: ${message}`);
}

function assertPositiveInteger(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail(`${label} must be a positive integer`);
  }
  return Number(text);
}

function assertSha(value, label) {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(text)) fail(`${label} must be a full commit SHA`);
  return text;
}

function assertRepository(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    fail('repository must use the owner/name form');
  }
  return text;
}

function assertTag(value) {
  const text = String(value ?? '');
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) {
    fail('release tag must be a versioned v<semver> tag');
  }
  return text;
}

function assertWorkflowRef(value, repository) {
  const text = String(value ?? '');
  const prefix = `${repository}/.github/workflows/portable-exact-archive-smoke.yml@refs/heads/`;
  if (!text.startsWith(prefix) || text.length === prefix.length || /[\0\r\n]/.test(text)) {
    fail('workflow ref must identify the exact portable smoke workflow on a branch');
  }
  return text;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

function resolveReleaseCommit(release, gateSha, options = {}) {
  const cwd = options.cwd || process.cwd();
  const targetSha = assertSha(release.target_commitish, 'release target_commitish');
  const tag = assertTag(release.tag_name);
  const gate = assertSha(gateSha, 'gate SHA');
  for (const sha of [gate, targetSha]) {
    const exists = runGit(['cat-file', '-e', `${sha}^{commit}`], {cwd});
    if (exists.status !== 0) fail(`commit ${sha} is not available in the gate checkout`);
  }
  const ancestor = runGit(['merge-base', '--is-ancestor', targetSha, gate], {cwd});
  if (ancestor.status !== 0) {
    fail(`release commit ${targetSha} is not an ancestor of gate commit ${gate}`);
  }

  let method = 'draft-target-sha';
  const tagRef = `refs/tags/${tag}`;
  const localTag = runGit(['show-ref', '--verify', '--quiet', tagRef], {cwd});
  if (localTag.status === 0) {
    const peeled = runGit(['rev-parse', `${tagRef}^{}`], {cwd});
    if (peeled.status !== 0) fail(`could not peel ${tagRef}`);
    const peeledSha = assertSha(peeled.stdout.trim(), 'peeled tag commit');
    if (peeledSha !== targetSha) {
      fail(`peeled tag commit ${peeledSha} does not match release target ${targetSha}`);
    }
    method = 'peeled-tag';
  } else if (release.draft !== true) {
    fail(`published release tag ${tagRef} is unavailable for commit resolution`);
  }

  for (const requiredPath of [
    'scripts/smoke-portable-archive.cjs',
    'scripts/verify-portable-smoke-evidence.cjs',
  ]) {
    const result = runGit(['cat-file', '-e', `${targetSha}:${requiredPath}`], {cwd});
    if (result.status !== 0) {
      fail(`release commit predates the required portable smoke contract: ${requiredPath}`);
    }
  }
  return {commit: targetSha, method};
}

function expectedAssetName(version, target) {
  return `smartperfetto-v${version}-${TARGETS[target].suffix}`;
}

function validateRelease(release, expected = {}) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    fail('release metadata must be an object');
  }
  const id = assertPositiveInteger(release.id, 'release id');
  if (expected.releaseId !== undefined && id !== assertPositiveInteger(expected.releaseId, 'expected release id')) {
    fail(`release id mismatch: expected ${expected.releaseId}, got ${id}`);
  }
  if (release.draft !== true) fail('exact-asset smoke only runs against an immutable draft');
  const tag = assertTag(release.tag_name);
  const version = tag.slice(1);
  const commit = assertSha(release.target_commitish, 'release target_commitish');
  if (release.name !== `SmartPerfetto ${tag}`) {
    fail(`release title must be SmartPerfetto ${tag}`);
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byTarget = {};
  const expectedNames = new Set();
  for (const target of Object.keys(TARGETS)) {
    const name = expectedAssetName(version, target);
    expectedNames.add(name);
    const matches = assets.filter(asset => asset?.name === name);
    if (matches.length !== 1) fail(`release must contain exactly one ${name} asset`);
    const asset = matches[0];
    const assetId = assertPositiveInteger(asset.id, `${name} asset id`);
    const size = assertPositiveInteger(asset.size, `${name} asset size`);
    const digest = String(asset.digest ?? '').toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`${name} must have a GitHub sha256 digest`);
    if (asset.state !== 'uploaded') fail(`${name} is not in the uploaded state`);
    byTarget[target] = {
      id: assetId,
      name,
      size,
      digest,
    };
  }
  const unexpected = assets.filter(asset => !expectedNames.has(asset?.name));
  if (assets.length !== expectedNames.size || unexpected.length > 0) {
    fail('draft asset set must be exactly the three portable platform archives');
  }
  return {assets: byTarget, commit, id, tag, version};
}

function buildPlan(release, options) {
  const selection = String(options.selection ?? '');
  const selectedTargets = SELECTIONS[selection];
  if (!selectedTargets) fail(`unsupported selection: ${selection || '<empty>'}`);
  const gateSha = assertSha(options.gateSha, 'gate SHA');
  const repository = assertRepository(options.repository);
  const metadata = validateRelease(release, {releaseId: options.releaseId});
  const resolved = resolveReleaseCommit(release, gateSha, {cwd: options.cwd});
  if (resolved.commit !== metadata.commit) fail('resolved release commit changed during planning');
  return {
    schemaVersion: 1,
    repository,
    release: {
      id: metadata.id,
      tag: metadata.tag,
      version: metadata.version,
      commit: metadata.commit,
      commitResolution: resolved.method,
    },
    gateSha,
    selection,
    scope: selection === 'all' ? 'complete' : 'partial',
    publicReleaseEligible: selection === 'all',
    matrix: {
      include: selectedTargets.map(target => ({
        target,
        runner: TARGETS[target].runner,
        platform: TARGETS[target].platform,
        arch: TARGETS[target].arch,
        assetId: metadata.assets[target].id,
        assetName: metadata.assets[target].name,
        assetSize: metadata.assets[target].size,
        assetDigest: metadata.assets[target].digest,
      })),
    },
  };
}

function validatePlanReleaseBinding(plan, release, target, assetFile) {
  const metadata = validateRelease(release, {releaseId: plan.release.id});
  if (
    metadata.tag !== plan.release.tag ||
    metadata.version !== plan.release.version ||
    metadata.commit !== plan.release.commit
  ) {
    fail('release identity changed after planning');
  }
  const matrixEntry = plan.matrix.include.find(entry => entry.target === target);
  if (!matrixEntry) fail(`${target} is not part of this smoke plan`);
  const asset = metadata.assets[target];
  if (
    asset.id !== matrixEntry.assetId ||
    asset.name !== matrixEntry.assetName ||
    asset.size !== matrixEntry.assetSize ||
    asset.digest !== matrixEntry.assetDigest
  ) {
    fail(`${target} release asset identity changed after planning`);
  }
  if (assetFile) {
    const resolved = path.resolve(assetFile);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('downloaded asset must be a regular file');
    if (
      path.basename(resolved) !== asset.name ||
      stat.size !== asset.size ||
      `sha256:${sha256File(resolved)}` !== asset.digest
    ) {
      fail(`${target} downloaded bytes do not match release metadata`);
    }
  }
  return matrixEntry;
}

function writeJsonAtomically(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  fs.renameSync(temporary, resolved);
}

function relativePortablePath(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    if (index + 1 >= argv.length || !String(argv[index + 1]).trim()) {
      fail(`${arg} requires a value`);
    }
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  return options;
}

function githubOutput(file, values) {
  for (const [name, value] of Object.entries(values)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (/[\r\n]/.test(text)) fail(`GitHub output ${name} must be single-line`);
    fs.appendFileSync(file, `${name}=${text}\n`);
  }
}

function fetchRelease(options) {
  const repository = assertRepository(options.repository);
  const releaseId = assertPositiveInteger(options.releaseId, 'release id');
  const output = path.resolve(options.output);
  if (!fs.statSync(path.dirname(output)).isDirectory()) fail('release metadata parent must exist');
  if (fs.existsSync(output)) fail('refusing to overwrite release metadata');
  const fd = fs.openSync(output, 'wx', 0o600);
  let result;
  try {
    result = spawnSync(
      'gh',
      [
        'api',
        `repos/${repository}/releases/${releaseId}`,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
      ],
      {stdio: ['ignore', fd, 'inherit']},
    );
  } finally {
    fs.closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    fs.rmSync(output, {force: true});
    if (result.error) throw result.error;
    fail(`gh api exited with status ${result.status}`);
  }
  const release = readJsonFile(output, 'release metadata');
  if (release.id !== releaseId) {
    fs.rmSync(output, {force: true});
    fail(`release id mismatch: expected ${releaseId}, got ${release.id || '<empty>'}`);
  }
  console.log(`GitHub release metadata fetched by immutable id: ${releaseId}`);
}

function prepare(options) {
  const release = readJsonFile(options.releaseJson, 'release metadata');
  const plan = buildPlan(release, {
    cwd: options.gitRoot,
    gateSha: options.gateSha,
    releaseId: options.releaseId,
    repository: options.repository,
    selection: options.selection,
  });
  writeJsonAtomically(options.planOut, plan);
  githubOutput(options.githubOutput, {
    matrix: plan.matrix,
    gate_sha: plan.gateSha,
    release_sha: plan.release.commit,
    release_id: plan.release.id,
    tag: plan.release.tag,
    version: plan.release.version,
    scope: plan.scope,
  });
}

function verify(options) {
  const plan = readJsonFile(options.plan, 'smoke plan');
  const release = readJsonFile(options.releaseJson, 'release metadata');
  validatePlanReleaseBinding(plan, release, options.target, options.asset);
  console.log(`Portable release asset binding verified: ${options.target}`);
}

function runner(options) {
  const plan = readJsonFile(options.plan, 'smoke plan');
  const target = String(options.target ?? '');
  const matrixEntry = plan.matrix.include.find(entry => entry.target === target);
  if (!matrixEntry) fail(`${target} is not part of this smoke plan`);
  if (process.platform !== matrixEntry.platform || process.arch !== matrixEntry.arch) {
    fail(
      `${target} requires ${matrixEntry.platform}/${matrixEntry.arch}, got ${process.platform}/${process.arch}`,
    );
  }
  const runnerTemp = path.resolve(options.runnerTemp);
  const fileSystem = fs.statfsSync(runnerTemp);
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  const minimumFreeBytes = assertPositiveInteger(
    options.minimumFreeBytes || 6 * 1024 * 1024 * 1024,
    'minimum free bytes',
  );
  if (freeBytes < minimumFreeBytes) {
    fail(`runner has only ${freeBytes} free bytes; ${minimumFreeBytes} are required`);
  }
  const evidenceTarget = path.resolve(options.evidenceRoot, target);
  if (fs.existsSync(evidenceTarget)) fail(`evidence target already exists: ${evidenceTarget}`);
  fs.mkdirSync(evidenceTarget, {recursive: true});
  const workflowSha = assertSha(options.workflowSha, 'workflow SHA');
  if (workflowSha !== plan.gateSha) fail('workflow SHA does not match the immutable gate SHA');
  const context = {
    schemaVersion: 1,
    status: 'prepared',
    repository: plan.repository,
    repositoryId: assertPositiveInteger(options.repositoryId, 'repository id'),
    workflow: String(options.workflow),
    workflowRef: assertWorkflowRef(options.workflowRef, plan.repository),
    workflowSha,
    runId: assertPositiveInteger(options.runId, 'run id'),
    runAttempt: assertPositiveInteger(options.runAttempt, 'run attempt'),
    gateSha: plan.gateSha,
    selection: plan.selection,
    scope: plan.scope,
    release: plan.release,
    asset: matrixEntry,
    host: {platform: process.platform, arch: process.arch},
    freeBytes,
    preparedAt: new Date().toISOString(),
  };
  writeJsonAtomically(path.join(evidenceTarget, 'workflow-context.json'), context);
  console.log(`Portable smoke runner prepared: ${target}`);
}

function releaseToolEnvironment() {
  const environment = {...process.env};
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    delete environment[key];
  }
  return environment;
}

function runNodeScript(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: releaseToolEnvironment(),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${path.basename(script)} exited with status ${result.status}`);
  }
}

function runSmoke(options) {
  const plan = readJsonFile(options.plan, 'smoke plan');
  const target = String(options.target ?? '');
  const entry = plan.matrix.include.find(item => item.target === target);
  if (!entry) fail(`${target} is not part of this smoke plan`);
  const releaseRoot = path.resolve(options.releaseRoot);
  const outputDir = path.resolve(options.evidenceRoot, target, 'smoke');
  if (fs.existsSync(outputDir)) fail(`smoke output directory already exists: ${outputDir}`);
  runNodeScript(
    path.join(releaseRoot, 'scripts', 'smoke-portable-archive.cjs'),
    [
      '--asset', path.resolve(options.asset),
      '--target', target,
      '--version', plan.release.version,
      '--commit', plan.release.commit,
      '--public-release',
      '--output-dir', outputDir,
    ],
    releaseRoot,
  );
}

function finalize(options) {
  const plan = readJsonFile(options.plan, 'smoke plan');
  const target = String(options.target ?? '');
  const entry = plan.matrix.include.find(item => item.target === target);
  if (!entry) fail(`${target} is not part of this smoke plan`);
  const releaseRoot = path.resolve(options.releaseRoot);
  const gateRoot = path.resolve(options.gateRoot);
  const asset = path.resolve(options.asset);
  const summary = path.resolve(options.evidenceRoot, target, 'smoke', 'smoke-summary.json');
  const common = [
    '--summary', summary,
    '--asset', asset,
    '--target', target,
    '--version', plan.release.version,
    '--commit', plan.release.commit,
    '--require-public-release',
  ];
  runNodeScript(
    path.join(releaseRoot, 'scripts', 'verify-portable-smoke-evidence.cjs'),
    common,
    releaseRoot,
  );
  runNodeScript(
    path.join(gateRoot, 'scripts', 'verify-portable-smoke-evidence.cjs'),
    [
      ...common,
      '--release-json', path.resolve(options.releaseJson),
      '--release-id', String(plan.release.id),
      '--asset-id', String(entry.assetId),
      '--workflow-context',
      path.resolve(options.evidenceRoot, target, 'workflow-context.json'),
    ],
    gateRoot,
  );
}

function collect(options) {
  const plan = readJsonFile(options.plan, 'smoke plan');
  const workflowSha = assertSha(options.workflowSha, 'workflow SHA');
  if (workflowSha !== plan.gateSha) fail('workflow SHA does not match the immutable gate SHA');
  const workflowRef = assertWorkflowRef(options.workflowRef, plan.repository);
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const targets = [];
  const promotionSources = [];
  let successful = true;
  for (const entry of plan.matrix.include) {
    const artifactName = `portable-smoke-${plan.release.id}-${entry.target}`;
    const multiArtifactRoot = path.join(artifactsRoot, artifactName, entry.target);
    const singleArtifactRoot = path.join(artifactsRoot, entry.target);
    const targetRoot = fs.existsSync(multiArtifactRoot)
      ? multiArtifactRoot
      : singleArtifactRoot;
    const contextFile = path.join(targetRoot, 'workflow-context.json');
    const summaryFile = path.join(targetRoot, 'smoke', 'smoke-summary.json');
    let context = null;
    let contextError = null;
    try {
      context = readJsonFile(contextFile, `${entry.target} workflow context`);
    } catch (error) {
      contextError = error?.message || String(error);
    }
    const summaryPresent = fs.existsSync(summaryFile);
    const summaryDigest = summaryPresent ? sha256File(summaryFile) : null;
    const targetSuccess = (
      contextError === null &&
      context.status === 'verified' &&
      context.repository === plan.repository &&
      context.repositoryId === assertPositiveInteger(options.repositoryId, 'repository id') &&
      context.workflow === String(options.workflow) &&
      context.workflowRef === workflowRef &&
      context.workflowSha === workflowSha &&
      context.runId === assertPositiveInteger(options.runId, 'run id') &&
      context.runAttempt === assertPositiveInteger(options.runAttempt, 'run attempt') &&
      context.gateSha === plan.gateSha &&
      context.selection === plan.selection &&
      context.scope === plan.scope &&
      context.release?.id === plan.release.id &&
      context.release?.tag === plan.release.tag &&
      context.release?.commit === plan.release.commit &&
      context.asset?.target === entry.target &&
      context.asset?.assetId === entry.assetId &&
      context.asset?.assetName === entry.assetName &&
      context.asset?.assetSize === entry.assetSize &&
      context.asset?.assetDigest === entry.assetDigest &&
      context.host?.platform === entry.platform &&
      context.host?.arch === entry.arch &&
      summaryPresent &&
      context.smokeSummarySha256 === summaryDigest
    );
    successful &&= targetSuccess;
    if (targetSuccess) {
      promotionSources.push({target: entry.target, summaryFile, contextFile});
    }
    targets.push({
      target: entry.target,
      success: targetSuccess,
      error: targetSuccess ? null : (contextError || 'verified smoke summary/context is missing or inconsistent'),
      context: contextError === null ? relativePortablePath(artifactsRoot, contextFile) : null,
      smokeSummary: summaryPresent ? relativePortablePath(artifactsRoot, summaryFile) : null,
      smokeSummarySha256: summaryDigest,
    });
  }
  const attestation = {
    schemaVersion: 1,
    repository: plan.repository,
    repositoryId: assertPositiveInteger(options.repositoryId, 'repository id'),
    workflow: String(options.workflow),
    workflowRef,
    workflowSha,
    runId: assertPositiveInteger(options.runId, 'run id'),
    runAttempt: assertPositiveInteger(options.runAttempt, 'run attempt'),
    gateSha: plan.gateSha,
    release: plan.release,
    selection: plan.selection,
    scope: plan.scope,
    publicReleaseEligible: successful && plan.publicReleaseEligible,
    success: successful,
    targets,
    collectedAt: new Date().toISOString(),
  };
  if (attestation.publicReleaseEligible) {
    for (const source of promotionSources) {
      const promotionRoot = path.join(artifactsRoot, 'promotion-evidence', source.target);
      fs.mkdirSync(promotionRoot, {recursive: true});
      fs.copyFileSync(source.summaryFile, path.join(promotionRoot, 'smoke-summary.json'));
      fs.copyFileSync(source.contextFile, path.join(promotionRoot, 'workflow-context.json'));
    }
  }
  writeJsonAtomically(options.attestationOut, attestation);
  if (!successful) fail('one or more selected target smokes did not produce verified evidence');
  console.log(
    `Portable smoke evidence collected: ${plan.scope} (${targets.map(item => item.target).join(', ')})`,
  );
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parseOptions(argv);
  if (command === 'prepare') return prepare(options);
  if (command === 'fetch') return fetchRelease(options);
  if (command === 'verify') return verify(options);
  if (command === 'runner') return runner(options);
  if (command === 'run') return runSmoke(options);
  if (command === 'finalize') return finalize(options);
  if (command === 'collect') return collect(options);
  fail(`unknown command: ${command || '<empty>'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  SELECTIONS,
  TARGETS,
  buildPlan,
  collect,
  resolveReleaseCommit,
  validatePlanReleaseBinding,
  validateRelease,
};

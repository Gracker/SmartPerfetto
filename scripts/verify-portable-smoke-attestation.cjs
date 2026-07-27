#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {
  extractArchiveToTemp,
  listEntries,
} = require('./verify-portable-package.cjs');
const {
  TARGETS,
  validateRelease,
} = require('./portable-release-smoke-workflow.cjs');

const WORKFLOW_NAME = 'Portable Exact Archive Smoke';
const WORKFLOW_PATH = '.github/workflows/portable-exact-archive-smoke.yml';

function fail(message) {
  throw new Error(`invalid hosted portable smoke attestation: ${message}`);
}

function positiveInteger(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail(`${label} must be a positive integer`);
  }
  return Number(text);
}

function fullSha(value, label) {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(text)) fail(`${label} must be a full commit SHA`);
  return text;
}

function repositoryName(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    fail('repository must use owner/name');
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

function readRegularJson(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function validateAttestation(attestation, expected) {
  const repository = repositoryName(expected.repository);
  const repositoryId = positiveInteger(expected.repositoryId, 'repository id');
  const releaseId = positiveInteger(expected.releaseId, 'release id');
  const runId = positiveInteger(expected.runId, 'run id');
  const commit = fullSha(expected.commit, 'release commit');
  const trustedGateSha = fullSha(expected.gateSha, 'trusted gate SHA');
  const defaultBranch = String(expected.defaultBranch ?? '');
  if (!defaultBranch || /[\0\r\n]/.test(defaultBranch)) {
    fail('default branch is invalid');
  }
  if (
    attestation?.schemaVersion !== 1 ||
    attestation.success !== true ||
    attestation.publicReleaseEligible !== true ||
    attestation.selection !== 'all' ||
    attestation.scope !== 'complete'
  ) {
    fail('only a successful complete all-target attestation is promotion evidence');
  }
  if (
    attestation.repository !== repository ||
    attestation.repositoryId !== repositoryId ||
    attestation.release?.id !== releaseId ||
    attestation.release?.tag !== `v${expected.version}` ||
    attestation.release?.version !== expected.version ||
    attestation.release?.commit !== commit ||
    attestation.runId !== runId
  ) {
    fail('repository, release, or run identity does not match promotion');
  }
  const runAttempt = positiveInteger(attestation.runAttempt, 'run attempt');
  const gateSha = fullSha(attestation.gateSha, 'gate SHA');
  const workflowSha = fullSha(attestation.workflowSha, 'workflow SHA');
  if (
    attestation.workflow !== WORKFLOW_NAME ||
    workflowSha !== gateSha ||
    gateSha !== trustedGateSha
  ) {
    fail('workflow name or SHA is not the trusted gate identity');
  }
  const workflowRef = `${repository}/${WORKFLOW_PATH}@refs/heads/${defaultBranch}`;
  if (attestation.workflowRef !== workflowRef) {
    fail('workflow ref is not the portable smoke workflow on the default branch');
  }
  const expectedTargets = Object.keys(TARGETS);
  const targets = Array.isArray(attestation.targets) ? attestation.targets : [];
  if (
    targets.length !== expectedTargets.length ||
    new Set(targets.map(item => item.target)).size !== expectedTargets.length
  ) {
    fail('attestation must contain each portable target exactly once');
  }
  for (const target of expectedTargets) {
    const item = targets.find(candidate => candidate.target === target);
    const artifactName = `portable-smoke-${releaseId}-${target}`;
    if (
      item?.success !== true ||
      item.context !== `${artifactName}/${target}/workflow-context.json` ||
      item.smokeSummary !== `${artifactName}/${target}/smoke/smoke-summary.json` ||
      !/^[0-9a-f]{64}$/.test(item.smokeSummarySha256 || '')
    ) {
      fail(`${target} attestation paths or digest are invalid`);
    }
  }
  return {
    ...expected,
    commit,
    defaultBranch,
    gateSha,
    releaseId,
    repository,
    repositoryId,
    runAttempt,
    runId,
    workflowRef: attestation.workflowRef,
    workflowSha,
  };
}

function validateRun(run, expected) {
  if (
    run?.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== WORKFLOW_PATH ||
    run.head_sha !== expected.gateSha ||
    run.head_branch !== expected.defaultBranch ||
    run.repository?.id !== expected.repositoryId ||
    run.repository?.full_name !== expected.repository
  ) {
    fail('GitHub Actions run identity or successful conclusion does not match');
  }
  return run;
}

function validateRepository(repository, expected) {
  const id = positiveInteger(repository?.id, 'repository id');
  const fullName = repositoryName(repository?.full_name);
  const defaultBranch = String(repository?.default_branch ?? '');
  if (
    fullName !== repositoryName(expected.repository) ||
    !defaultBranch ||
    /[\0\r\n]/.test(defaultBranch)
  ) {
    fail('GitHub repository identity or default branch does not match');
  }
  return {defaultBranch, repositoryId: id};
}

function validateArtifactMetadata(response, expected) {
  const artifactName = `portable-smoke-evidence-release-${expected.releaseId}`;
  const matches = (Array.isArray(response?.artifacts) ? response.artifacts : [])
    .filter(artifact => artifact.name === artifactName);
  if (matches.length !== 1) fail(`expected one ${artifactName} artifact`);
  const artifact = matches[0];
  if (
    !Number.isInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest || '') ||
    artifact.workflow_run?.id !== expected.runId ||
    artifact.workflow_run?.head_sha !== expected.gateSha
  ) {
    fail('combined artifact identity, digest, or workflow run does not match');
  }
  return artifact;
}

function validateWorkflowContexts(extractedRoot, evidenceDir, release, attestation, expected) {
  const metadata = validateRelease(release, {releaseId: expected.releaseId});
  if (
    metadata.tag !== `v${expected.version}` ||
    metadata.commit !== expected.commit
  ) {
    fail('draft release identity does not match attestation');
  }
  for (const target of Object.keys(TARGETS)) {
    const extractedTarget = path.join(extractedRoot, 'promotion-evidence', target);
    const localTarget = path.join(path.resolve(evidenceDir), target);
    for (const name of ['smoke-summary.json', 'workflow-context.json']) {
      const extractedFile = path.join(extractedTarget, name);
      const localFile = path.join(localTarget, name);
      if (sha256File(extractedFile) !== sha256File(localFile)) {
        fail(`${target}/${name} differs from the digest-verified Actions artifact`);
      }
    }
    const summaryFile = path.join(localTarget, 'smoke-summary.json');
    const context = readRegularJson(
      path.join(localTarget, 'workflow-context.json'),
      `${target} workflow context`,
    );
    const targetAttestation = attestation.targets.find(item => item.target === target);
    const asset = metadata.assets[target];
    if (
      context.schemaVersion !== 1 ||
      context.status !== 'verified' ||
      context.repository !== expected.repository ||
      context.repositoryId !== expected.repositoryId ||
      context.workflow !== WORKFLOW_NAME ||
      context.workflowRef !== expected.workflowRef ||
      context.workflowSha !== expected.workflowSha ||
      context.runId !== expected.runId ||
      context.runAttempt !== expected.runAttempt ||
      context.gateSha !== expected.gateSha ||
      context.selection !== 'all' ||
      context.scope !== 'complete' ||
      context.release?.id !== expected.releaseId ||
      context.release?.tag !== `v${expected.version}` ||
      context.release?.commit !== expected.commit ||
      context.asset?.target !== target ||
      context.asset?.assetId !== asset.id ||
      context.asset?.assetName !== asset.name ||
      context.asset?.assetSize !== asset.size ||
      context.asset?.assetDigest !== asset.digest ||
      context.host?.platform !== TARGETS[target].platform ||
      context.host?.arch !== TARGETS[target].arch ||
      context.smokeSummarySha256 !== sha256File(summaryFile) ||
      targetAttestation.smokeSummarySha256 !== context.smokeSummarySha256
    ) {
      fail(`${target} workflow context is not complete all-target provenance`);
    }
  }
}

function fetchWithGh(endpoint, output, accept) {
  const descriptor = fs.openSync(output, 'wx', 0o600);
  let result;
  try {
    result = spawnSync(
      'gh',
      [
        'api',
        endpoint,
        '-H',
        `Accept: ${accept}`,
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
      ],
      {stdio: ['ignore', descriptor, 'inherit']},
    );
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    fs.rmSync(output, {force: true});
    if (result.error) throw result.error;
    fail(`gh api failed for ${endpoint}`);
  }
}

function verifyHostedEvidence(options) {
  const attestation = readRegularJson(options.attestation, 'combined attestation');
  const release = readRegularJson(options.releaseJson, 'release metadata');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-smoke-attestation-'));
  let extractedRoot;
  try {
    const repository = repositoryName(options.repository);
    const repositoryFile = path.join(temporary, 'repository.json');
    const runFile = path.join(temporary, 'run.json');
    const artifactsFile = path.join(temporary, 'artifacts.json');
    fetchWithGh(
      `repos/${repository}`,
      repositoryFile,
      'application/vnd.github+json',
    );
    const repositoryMetadata = validateRepository(
      readRegularJson(repositoryFile, 'repository metadata'),
      {repository},
    );
    const expected = validateAttestation(attestation, {
      ...options,
      ...repositoryMetadata,
    });
    fetchWithGh(
      `repos/${expected.repository}/actions/runs/${expected.runId}`,
      runFile,
      'application/vnd.github+json',
    );
    fetchWithGh(
      `repos/${expected.repository}/actions/runs/${expected.runId}/artifacts?per_page=100`,
      artifactsFile,
      'application/vnd.github+json',
    );
    validateRun(readRegularJson(runFile, 'Actions run metadata'), expected);
    const artifact = validateArtifactMetadata(
      readRegularJson(artifactsFile, 'Actions artifact metadata'),
      expected,
    );
    const artifactZip = path.join(temporary, 'combined-evidence.zip');
    fetchWithGh(
      `repos/${expected.repository}/actions/artifacts/${artifact.id}/zip`,
      artifactZip,
      'application/octet-stream',
    );
    if (`sha256:${sha256File(artifactZip)}` !== artifact.digest) {
      fail('downloaded combined artifact does not match the GitHub artifact digest');
    }
    extractedRoot = extractArchiveToTemp(artifactZip, 'zip', listEntries(artifactZip, 'zip'));
    const extractedAttestation = path.join(extractedRoot, 'portable-smoke-attestation.json');
    if (sha256File(extractedAttestation) !== sha256File(options.attestation)) {
      fail('local attestation differs from the digest-verified Actions artifact');
    }
    validateWorkflowContexts(
      extractedRoot,
      options.evidenceDir,
      release,
      attestation,
      expected,
    );
    console.log(
      `Hosted portable smoke attestation verified: run ${expected.runId}, artifact ${artifact.id}`,
    );
  } finally {
    if (extractedRoot) fs.rmSync(extractedRoot, {recursive: true, force: true});
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

function parseArgs(argv) {
  const options = {};
  const allowed = new Set([
    '--attestation',
    '--evidence-dir',
    '--release-json',
    '--repository',
    '--release-id',
    '--version',
    '--commit',
    '--run-id',
    '--gate-sha',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!allowed.has(arg)) fail(`unknown option: ${arg}`);
    if (index + 1 >= argv.length || !String(argv[index + 1]).trim()) {
      fail(`${arg} requires a value`);
    }
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  for (const name of allowed) {
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!options[key]) fail(`${name} is required`);
  }
  return options;
}

if (require.main === module) {
  try {
    verifyHostedEvidence(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  validateArtifactMetadata,
  validateAttestation,
  validateRepository,
  validateRun,
  validateWorkflowContexts,
  verifyHostedEvidence,
};

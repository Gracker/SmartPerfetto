#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  TARGETS,
  normalizeVersion,
  readNodeRuntimePin,
} = require('./verify-portable-package.cjs');
const {
  validateLifecycleReceipt,
  versionAtLeast,
} = require('./smoke-portable-archive.cjs');

const HOSTS = {
  'windows-x64': {platform: 'win32', arch: 'x64'},
  'macos-arm64': {platform: 'darwin', arch: 'arm64'},
  'linux-x64': {platform: 'linux', arch: 'x64'},
};

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--require-public-release') {
      options.requirePublicRelease = true;
      continue;
    }
    if (['--summary', '--asset', '--target', '--version', '--commit'].includes(arg)) {
      if (index + 1 >= argv.length || !argv[index + 1].trim()) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = argv[++index];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function identifyAsset(asset) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(asset);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return {
    name: path.basename(asset),
    sha256: hash.digest('hex'),
    size: fs.statSync(asset).size,
  };
}

function validateSmokeSummary(summary, expected) {
  const fail = (message) => {
    throw new Error(`invalid portable smoke evidence: ${message}`);
  };
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) fail('expected an object');
  if (summary.schemaVersion !== 2 || summary.success !== true) {
    fail('schemaVersion 2 successful evidence is required');
  }
  if (
    summary.target !== expected.target ||
    summary.version !== expected.version ||
    summary.commit !== expected.commit
  ) {
    fail('target, version, or commit does not match the release');
  }
  if (expected.requirePublicRelease && summary.publicRelease !== true) {
    fail('public-release smoke evidence is required');
  }
  if (typeof summary.gitDirty !== 'boolean') {
    fail('gitDirty evidence is required');
  }
  if (expected.requirePublicRelease && summary.gitDirty !== false) {
    fail('public-release smoke must come from a clean source tree');
  }
  if (
    expected.requirePublicRelease &&
    (
      summary.processTree?.enumerationSucceeded !== true ||
      !Number.isInteger(summary.processTree?.samples) ||
      summary.processTree.samples < 1 ||
      !Array.isArray(summary.processTree?.failures) ||
      summary.processTree.failures.length !== 0 ||
      !Array.isArray(summary.processTree?.survivingPids) ||
      summary.processTree.survivingPids.length !== 0
    )
  ) {
    fail('public-release smoke lacks reliable descendant-process cleanup evidence');
  }
  const expectedHost = HOSTS[expected.target];
  if (
    summary.host?.platform !== expectedHost.platform ||
    summary.host?.arch !== expectedHost.arch
  ) {
    fail('smoke did not run on the target operating system and architecture');
  }
  if (
    summary.asset?.name !== expected.asset.name ||
    summary.asset?.size !== expected.asset.size ||
    summary.asset?.sha256 !== expected.asset.sha256
  ) {
    fail('archive name, size, or SHA256 does not match the smoked bytes');
  }
  if (
    !Number.isInteger(summary.ports?.backend) ||
    !Number.isInteger(summary.ports?.frontend) ||
    summary.ports.backend <= 0 ||
    summary.ports.frontend <= 0 ||
    summary.ports.backend === summary.ports.frontend
  ) {
    fail('service ports are invalid');
  }
  if (
    summary.health?.backend?.status !== 'OK' ||
    summary.health?.backend?.version !== expected.version ||
    summary.health?.frontend?.status !== 'OK'
  ) {
    fail('backend or frontend health evidence is incomplete');
  }
  const probeHasOutput = (probe) => (
    probe &&
    typeof probe === 'object' &&
    [probe.stdout, probe.stderr].some(value => typeof value === 'string' && value.trim())
  );
  const traceProcessorOutput = String(summary.runtimes?.traceProcessor?.stdout || '');
  const expectedNodeVersion = `v${readNodeRuntimePin(expected.target).version}`;
  if (
    String(summary.runtimes?.node?.stdout || '').trim() !== expectedNodeVersion ||
    !probeHasOutput(summary.runtimes?.claude) ||
    !probeHasOutput(summary.runtimes?.opencode) ||
    !traceProcessorOutput.includes('smartperfetto_smoke') ||
    !/(^|\r?\n)1(\r?\n|$)/.test(traceProcessorOutput)
  ) {
    fail('bundled runtime probes are incomplete');
  }
  if (
    expected.target === 'linux-x64' &&
    !versionAtLeast(summary.runtimes?.libc?.stdout, '2.34')
  ) {
    fail('Linux smoke did not prove glibc 2.34 or newer');
  }
  if (expected.requirePublicRelease && expected.target === 'macos-arm64') {
    const macosRelease = summary.runtimes?.macosRelease;
    if (
      !probeHasOutput(macosRelease?.codesign) ||
      !probeHasOutput(macosRelease?.gatekeeper) ||
      !probeHasOutput(macosRelease?.staple)
    ) {
      fail('macOS public smoke lacks complete codesign, Gatekeeper, or staple evidence');
    }
    if (
      macosRelease?.notarytool?.schemaVersion !== 1 ||
      macosRelease.notarytool.status !== 'Accepted' ||
      !/^[0-9a-f-]{36}$/i.test(macosRelease.notarytool.submissionId || '')
    ) {
      fail('macOS public smoke lacks an Accepted notarytool info receipt');
    }
    const gatekeeperOutput = [
      macosRelease.gatekeeper.stdout,
      macosRelease.gatekeeper.stderr,
    ].join('\n');
    if (!/source=Notarized Developer ID/i.test(gatekeeperOutput)) {
      fail('macOS Gatekeeper evidence is not Notarized Developer ID');
    }
  }
  validateLifecycleReceipt(summary.lifecycleReceipt, {
    version: expected.version,
    commit: expected.commit,
    target: expected.target,
    backendPort: summary.ports.backend,
    frontendPort: summary.ports.frontend,
  });
  if (
    typeof summary.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(summary.finishedAt))
  ) {
    fail('finishedAt must be a valid timestamp');
  }
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.summary || !options.asset || !options.target || !options.version || !options.commit) {
    throw new Error('--summary, --asset, --target, --version, and --commit are required');
  }
  if (!TARGETS[options.target]) throw new Error(`Unsupported target: ${options.target}`);
  const version = normalizeVersion(options.version);
  const summaryPath = path.resolve(options.summary);
  const summaryStat = fs.lstatSync(summaryPath);
  if (!summaryStat.isFile() || summaryStat.isSymbolicLink()) {
    throw new Error('Smoke summary must be a regular file, not a symlink');
  }
  const asset = await identifyAsset(path.resolve(options.asset));
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  validateSmokeSummary(summary, {
    asset,
    commit: options.commit,
    requirePublicRelease: options.requirePublicRelease === true,
    target: options.target,
    version,
  });
  console.log(`Portable smoke evidence verified: ${asset.name}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  identifyAsset,
  parseArgs,
  validateSmokeSummary,
};

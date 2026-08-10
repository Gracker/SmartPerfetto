// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSET_COMMANDS = {
  docs: ['node', 'backend/scripts/generate-perfetto-sql-docs.cjs'],
  symbols: ['node', 'backend/scripts/generate-stdlib-symbol-index.cjs'],
  index: ['python3', 'backend/scripts/regenerate-sql-index.py'],
};

const ASSET_OUTPUTS = {
  docs: ['backend/data/perfettoSqlDocs.json'],
  symbols: ['backend/data/perfettoStdlibSymbols.json'],
  index: [
    'backend/data/perfettoSqlIndex.light.json',
    'backend/data/perfettoSqlIndex.json',
  ],
};

const RUNTIME_SOURCE_OVERRIDES = [
  'PERFETTO_STDLIB_PATH',
  'PERFETTO_STDLIB_DOCS_PATH',
  'PFSQL_BIN',
];

function parseRuntimeRevision(pinText) {
  const match = pinText.match(/^PERFETTO_VERSION=([^\s#]+)$/m);
  const revision = match?.[1];
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('PERFETTO_VERSION must be an exact 40-character lowercase commit');
  }
  return revision;
}

function selectedAssets(arguments_) {
  if (arguments_.length === 0) return Object.keys(ASSET_COMMANDS);
  const assets = arguments_.map(argument => argument.replace(/^--/, ''));
  for (const asset of assets) {
    if (!Object.hasOwn(ASSET_COMMANDS, asset)) {
      throw new Error(`Unknown runtime stdlib asset: ${asset}`);
    }
  }
  return [...new Set(assets)];
}

function runtimeSourceEnvironment(checkout, revision) {
  const env = {...process.env};
  for (const name of RUNTIME_SOURCE_OVERRIDES) delete env[name];
  env.PERFETTO_SOURCE_ROOT = checkout;
  env.PERFETTO_GENERATED_FROM = revision;
  return env;
}

function verifyRuntimeAssetOutputs(root, assets, revision) {
  for (const asset of assets) {
    for (const relativePath of ASSET_OUTPUTS[asset]) {
      const outputPath = path.join(root, relativePath);
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      } catch (error) {
        throw new Error(`Could not validate ${relativePath}: ${error.message}`);
      }
      if (payload?.generatedFrom !== revision) {
        throw new Error(
          `${relativePath} generatedFrom does not match runtime revision ${revision}`,
        );
      }
    }
  }
}

function runRuntimeAssetGeneration({
  repoRoot,
  assets = Object.keys(ASSET_COMMANDS),
  runCommand = execFileSync,
  removeTree = fs.rmSync,
}) {
  const root = path.resolve(repoRoot);
  const perfettoRepository = path.join(root, 'perfetto');
  const pinPath = path.join(root, 'scripts', 'trace-processor-pin.env');
  const revision = parseRuntimeRevision(fs.readFileSync(pinPath, 'utf8'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-perfetto-runtime-'));
  const checkout = path.join(tempRoot, 'perfetto');
  let worktreeAdded = false;
  let primaryError;
  let result;
  try {
    runCommand(
      'git',
      ['-C', perfettoRepository, 'cat-file', '-e', `${revision}^{commit}`],
      {cwd: root, stdio: 'ignore'},
    );
    runCommand(
      'git',
      ['-C', perfettoRepository, 'worktree', 'add', '--detach', checkout, revision],
      {cwd: root, stdio: 'inherit'},
    );
    worktreeAdded = true;
    const env = runtimeSourceEnvironment(checkout, revision);
    for (const asset of assets) {
      const [runtime, script] = ASSET_COMMANDS[asset];
      const command = runtime === 'node' ? process.execPath : (process.env.PYTHON_BIN || runtime);
      runCommand(command, [path.join(root, script)], {
        cwd: root,
        env,
        stdio: 'inherit',
      });
    }
    verifyRuntimeAssetOutputs(root, assets, revision);
    result = revision;
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  let worktreeRemoveFailed = false;
  if (worktreeAdded) {
    try {
      runCommand(
        'git',
        ['-C', perfettoRepository, 'worktree', 'remove', '--force', checkout],
        {cwd: root, stdio: 'ignore'},
      );
    } catch (error) {
      cleanupError = error;
      worktreeRemoveFailed = true;
    }
  }
  try {
    removeTree(tempRoot, {recursive: true, force: true});
  } catch (error) {
    cleanupError ??= error;
  }
  if (worktreeRemoveFailed) {
    try {
      runCommand(
        'git',
        ['-C', perfettoRepository, 'worktree', 'prune', '--expire', 'now'],
        {cwd: root, stdio: 'ignore'},
      );
    } catch {
      // Preserve the first cleanup error; the caller must treat the run as failed.
    }
  }

  if (primaryError) {
    if (cleanupError && primaryError instanceof Error && primaryError.cause === undefined) {
      primaryError.cause = cleanupError;
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return result;
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  runRuntimeAssetGeneration({
    repoRoot,
    assets: selectedAssets(process.argv.slice(2)),
  });
}

module.exports = {
  parseRuntimeRevision,
  runRuntimeAssetGeneration,
  runtimeSourceEnvironment,
  selectedAssets,
  verifyRuntimeAssetOutputs,
};

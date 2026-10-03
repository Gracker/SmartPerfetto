#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const path = require('node:path');

const {
  discoverCoverageTargets,
  resolveCaseTrace,
  validateCatalog,
} = require('./lib/catalog.cjs');
const {writeIndexes} = require('./lib/indexer.cjs');
const {
  buildCatalogCases,
  materializeCatalogCases,
  staleCaseExpectations,
  updateCaseExpectations,
} = require('./lib/builder.cjs');
const {importRealCase, promoteRealCase} = require('./lib/import-real.cjs');

function parseArgs(argv) {
  const args = [...argv];
  let repoRoot = path.resolve(__dirname, '../..');
  const repoIndex = args.indexOf('--repo');
  if (repoIndex !== -1) {
    const value = args[repoIndex + 1];
    if (!value) throw new Error('--repo requires a path');
    repoRoot = path.resolve(value);
    args.splice(repoIndex, 2);
  }
  const command = args.shift();
  const positional = [];
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    flags.add(token);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (!values.has(token)) values.set(token, []);
      values.get(token).push(next);
      index += 1;
    }
  }
  return {
    command,
    positional,
    flags,
    value: (name) => values.get(name)?.at(-1),
    values: (name) => values.get(name) ?? [],
    repoRoot,
  };
}

function requiredValue(parsed, name) {
  const value = parsed.value(name);
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function printIssues(validation) {
  for (const item of validation.issues) {
    const file = item.file ? ` (${item.file})` : '';
    console.error(`[${item.code}] ${item.message}${file}`);
  }
}

function usage() {
  console.log(`Usage: node Trace/tools/trace-corpus.cjs <command> [options]

Commands:
  index [--check]                 Generate or check README/catalog indexes
  validate [--check-generated]   Validate manifests, hashes, and coverage
  coverage                       Print exact Skill and Strategy coverage
  build [--check] [--case <id>]  Materialize constructed trace cases
  materialize [--case <id>]     Combine committed bases and overlays without proto sources
  expectations --case <id> [--check]  Generate or check one constructed case's expected.json
  resolve <case-id-or-alias>     Print the committed trace path
  import-real [options]          Stage a captured trace under ignored .private/
  promote-real <id> [options]    Publish a reviewed private draft atomically

Import options:
  --id --title --description --scene --trace --origin
  [--result <file>]... [--log <file>]... [--tag <tag>]...
  [--android-release <release>] [--api-level <level>] [--device <name>]
  [--build-fingerprint <value>] [--captured-at <ISO timestamp>]

Promotion options:
  --license <SPDX/expression> --consent <record>
  --privacy-review <approved|not-applicable>
  --sanitization-review <approved|not-applicable>

Global options:
  --repo <path>                  Override repository root for tooling/tests`);
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'index') {
    const result = writeIndexes(parsed.repoRoot, {check: parsed.flags.has('--check')});
    console.log(parsed.flags.has('--check')
      ? 'PASS generated indexes are current'
      : `generated ${result.changed.length} file(s)`);
    return 0;
  }
  if (parsed.command === 'validate') {
    if (parsed.flags.has('--check-generated')) writeIndexes(parsed.repoRoot, {check: true});
    const validation = validateCatalog(parsed.repoRoot);
    if (!validation.ok) {
      printIssues(validation);
      return 1;
    }
    if (parsed.flags.has('--check-generated')) {
      const constructed = validation.catalog.cases.filter((entry) => entry.kind === 'constructed');
      const stale = staleCaseExpectations(parsed.repoRoot, constructed.map((entry) => entry.id));
      if (stale.length > 0) {
        for (const caseId of stale) {
          console.error(`[stale-expectations] run expectations --case ${caseId} (Trace/constructed/${caseId}/analysis/expected.json)`);
        }
        return 1;
      }
    }
    console.log(`PASS ${validation.catalog.cases.length} trace case(s) validated`);
    return 0;
  }
  if (parsed.command === 'coverage') {
    const targets = discoverCoverageTargets(parsed.repoRoot);
    const validation = validateCatalog(parsed.repoRoot);
    console.log(`Skills: ${validation.coverage.covered.skills.length}/${targets.skills.length}`);
    console.log(`Strategies: ${validation.coverage.covered.strategies.length}/${targets.strategies.length}`);
    console.log(`Skill quality: semantic=${validation.coverage.quality.semantic.length}, execution=${validation.coverage.quality.execution.length}, graceful-empty=${validation.coverage.quality.graceful_empty.length}, unavailable=${validation.coverage.quality.unavailable.length}, definition=${validation.coverage.quality.definition.length}`);
    if (!validation.ok) {
      printIssues(validation);
      return 1;
    }
    return 0;
  }
  if (parsed.command === 'build') {
    const caseId = parsed.value('--case');
    const caseIds = caseId ? [caseId] : undefined;
    if (parsed.flags.has('--case') && !caseId) throw new Error('--case requires a case id');
    const result = buildCatalogCases(parsed.repoRoot, {
      caseIds,
      check: parsed.flags.has('--check'),
    });
    console.log(`built ${result.length} constructed case(s)`);
    return 0;
  }
  if (parsed.command === 'materialize') {
    const caseId = parsed.value('--case');
    const caseIds = caseId ? [caseId] : undefined;
    if (parsed.flags.has('--case') && !caseId) throw new Error('--case requires a case id');
    const result = materializeCatalogCases(parsed.repoRoot, {caseIds});
    console.log(`materialized ${result.length} constructed case(s) from committed overlays`);
    return 0;
  }
  if (parsed.command === 'expectations') {
    if (parsed.positional.length > 0 || [...parsed.flags].some(flag => !['--case', '--check'].includes(flag)) ||
        parsed.values('--case').length !== 1 || parsed.values('--check').length > 0) {
      throw new Error('expectations requires exactly --case <id> and optional --check');
    }
    const result = updateCaseExpectations(parsed.repoRoot, {caseId: requiredValue(parsed, '--case'),
      check: parsed.flags.has('--check')});
    console.log(parsed.flags.has('--check') ? `PASS expectations are current for ${result.case_id}`
      : `${result.changed ? 'generated' : 'unchanged'} ${result.output}`);
    return 0;
  }
  if (parsed.command === 'resolve') {
    const selector = parsed.positional[0];
    if (!selector) throw new Error('resolve requires a case id or alias');
    console.log(resolveCaseTrace(parsed.repoRoot, selector));
    return 0;
  }
  if (parsed.command === 'import-real') {
    const apiLevelValue = parsed.value('--api-level');
    const apiLevel = apiLevelValue === undefined ? null : Number.parseInt(apiLevelValue, 10);
    if (apiLevelValue !== undefined && (!Number.isInteger(apiLevel) || apiLevel < 1)) {
      throw new Error('--api-level must be a positive integer');
    }
    const imported = importRealCase(parsed.repoRoot, {
      id: requiredValue(parsed, '--id'),
      title: requiredValue(parsed, '--title'),
      description: requiredValue(parsed, '--description'),
      scene: requiredValue(parsed, '--scene'),
      tracePath: path.resolve(requiredValue(parsed, '--trace')),
      origin: requiredValue(parsed, '--origin'),
      resultPaths: parsed.values('--result').map((file) => path.resolve(file)),
      logPaths: parsed.values('--log').map((file) => path.resolve(file)),
      tags: parsed.values('--tag').length > 0 ? parsed.values('--tag') : undefined,
      capturedAt: parsed.value('--captured-at') ?? null,
      android: {
        release: parsed.value('--android-release') ?? null,
        api_level: apiLevel,
        device: parsed.value('--device') ?? null,
        build_fingerprint: parsed.value('--build-fingerprint') ?? null,
      },
    });
    console.log(`staged private real case: ${imported.caseDir}`);
    return 0;
  }
  if (parsed.command === 'promote-real') {
    const id = parsed.positional[0] ?? parsed.value('--id');
    if (!id) throw new Error('promote-real requires a case id');
    const promoted = promoteRealCase(parsed.repoRoot, {
      id,
      license: requiredValue(parsed, '--license'),
      consent: requiredValue(parsed, '--consent'),
      privacyReview: requiredValue(parsed, '--privacy-review'),
      sanitizationReview: requiredValue(parsed, '--sanitization-review'),
    });
    console.log(`promoted public real case: ${promoted.caseDir}`);
    return 0;
  }
  usage();
  return parsed.command ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {main, parseArgs};

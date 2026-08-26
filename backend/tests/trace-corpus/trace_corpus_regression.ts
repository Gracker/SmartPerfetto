// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';

import {runCorpusRegression} from './corpusRunner';

function optionValues(name: string): string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values.length > 0 ? values : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--quiet')) {
    const writeSummary = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (String(args[0] ?? '').startsWith('Trace corpus regression')) writeSummary(...args);
    };
  }
  const repoRoot = path.resolve(__dirname, '../../..');
  const result = await runCorpusRegression(repoRoot, {
    caseIds: optionValues('--case'),
    targetIds: optionValues('--target'),
    writeEvidence: true,
  });
  for (const failure of result.failures) {
    console.error(`[FAIL] ${failure.case_id}:${failure.target} - ${failure.reason}`);
  }
  if (result.failures.length > 0) {
    throw new Error(
      `Trace corpus regression failed: ${result.executed.length} passed, ${result.failures.length} failed`,
    );
  }
  const incompleteSql = result.sql.condition_skipped.length + result.sql.unavailable.length;
  if (incompleteSql > 0) {
    throw new Error(
      `Trace corpus SQL coverage incomplete: ${result.sql.condition_skipped.length} skipped, `
      + `${result.sql.unavailable.length} unavailable`,
    );
  }
  const executedSql = result.sql.normal.length + result.sql.forced.length + result.sql.isolated.length;
  console.log(
    `Trace corpus regression passed: ${result.executed.length} expectation(s), `
    + `${executedSql} SQL contract(s) executed `
    + `(${result.sql.normal.length} production, ${result.sql.forced.length} forced read-only/context, `
    + `${result.sql.isolated.length} isolated branch probe), `
    + `${result.correctness.positive.length} positive semantic, `
    + `${result.correctness.execution_only.length} execution-only, `
    + `${result.correctness.negative.length} negative, `
    + `${result.correctness.deferred.length} deferred, 0 skipped, 0 unavailable`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

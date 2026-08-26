// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {classifyScene} from '../../src/agentv3/sceneClassifier';
import {loadStrategies} from '../../src/agentv3/strategyLoader';
import {createSkillEvaluator, type EvalStepResult, type SkillEvaluator} from '../skill-eval/runner';

type TokenContext = {
  trace_start: string;
  trace_end: string;
  fixture_start: string;
  fixture_end: string;
  fixture_upid: number;
  fixture_utid: number;
};

type CorpusExpectation = {
  id: string;
  type: 'skill' | 'strategy' | 'sql';
  target: string;
  mode?: 'semantic' | 'execution' | 'negative' | 'deferred' | 'graceful_empty' | 'unavailable' | 'definition';
  source_file?: string;
  source_sha256?: string;
  parameters?: Record<string, unknown>;
  required_steps?: string[];
  required_sql_steps?: string[];
  forced_sql_steps?: string[];
  isolated_sql_probes?: Array<{step: string; setup_sql: string[]}>;
  expected_condition_skips?: Array<{step: string; reason: string}>;
  expected_unavailable_sql_steps?: Array<{step: string; reason: string; error: string}>;
  semantic_step?: string;
  min_rows?: number;
  max_rows?: number;
  required_columns?: string[];
  assertions?: CorpusValueAssertion[];
  limitation_reason?: string;
  expected_empty_reason?: string;
  expected_error?: string;
  required_marker?: string;
  query?: string;
  expected_strategy?: string;
};

type CorpusValueAssertion = {
  column: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'matches';
  value: string | number | boolean | null;
};

type CorpusCase = {
  id: string;
  kind: 'real' | 'constructed';
  case_dir: string;
  manifest_path: string;
  trace: {file: string};
  source: {evidence_tier: 'R1' | 'R2' | 'R3'};
  construction?: {output: string};
  coverage: {expectations: CorpusExpectation[]};
};

export type CorpusRunResult = {
  executed: string[];
  sql: {
    normal: string[];
    forced: string[];
    isolated: string[];
    condition_skipped: string[];
    unavailable: string[];
  };
  correctness: {
    positive: string[];
    execution_only: string[];
    negative: string[];
    deferred: string[];
  };
  failures: Array<{case_id: string; target: string; reason: string}>;
};

type SkillSqlEvidence = CorpusRunResult['sql'];

export function sqlResultState(
  result: Pick<EvalStepResult, 'success' | 'code' | 'error'>,
): 'executed' | 'condition_skipped' | 'failed' {
  if (result.code === 'condition_not_met') return 'condition_skipped';
  if (result.code === 'optional_query_error' || result.error) return 'failed';
  return result.success ? 'executed' : 'failed';
}

export function loadCorpus(repoRoot: string): {
  cases: CorpusCase[];
  coverage: any;
} {
  return {
    cases: JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/catalog.json'), 'utf8')).cases,
    coverage: JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/coverage.json'), 'utf8')),
  };
}

export function resolveParameterTokens(
  parameters: Record<string, unknown>,
  context: TokenContext,
): Record<string, unknown> {
  const tokenValues = new Map<string, unknown>([
    ['${trace_start}', context.trace_start],
    ['${trace_end}', context.trace_end],
    ['${fixture_start}', context.fixture_start],
    ['${fixture_end}', context.fixture_end],
    ['${fixture_upid}', context.fixture_upid],
    ['${fixture_utid}', context.fixture_utid],
  ]);
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      typeof value === 'string' && tokenValues.has(value) ? tokenValues.get(value) : value,
    ]),
  );
}

function assertionMatches(actual: unknown, assertion: CorpusValueAssertion): boolean {
  switch (assertion.operator) {
    case 'eq': return actual === assertion.value;
    case 'ne': return actual !== assertion.value;
    case 'contains': return String(actual ?? '').includes(String(assertion.value ?? ''));
    case 'matches': return new RegExp(String(assertion.value ?? '')).test(String(actual ?? ''));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = Number(actual);
      const right = Number(assertion.value);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      if (assertion.operator === 'gt') return left > right;
      if (assertion.operator === 'gte') return left >= right;
      if (assertion.operator === 'lt') return left < right;
      return left <= right;
    }
  }
  return false;
}

export function assertExpectationRows(
  rows: unknown[],
  expectation: Pick<CorpusExpectation, 'target' | 'semantic_step' | 'min_rows' | 'max_rows' | 'required_columns' | 'assertions'>,
): void {
  const minRows = expectation.min_rows ?? 1;
  if (rows.length < minRows) {
    throw new Error(`result step returned ${rows.length} row(s), expected at least ${minRows}: ${expectation.semantic_step ?? expectation.target}`);
  }
  if (expectation.max_rows !== undefined && rows.length > expectation.max_rows) {
    throw new Error(`result step returned ${rows.length} row(s), expected at most ${expectation.max_rows}: ${expectation.semantic_step ?? expectation.target}`);
  }
  const requiredColumns = expectation.required_columns ?? [];
  const hasDeclaredShape = rows.some((row) =>
    !!row
    && typeof row === 'object'
    && requiredColumns.every((column) => Object.prototype.hasOwnProperty.call(row, column)),
  );
  if (requiredColumns.length > 0 && !hasDeclaredShape) {
    throw new Error(
      `result is missing required columns ${requiredColumns.join(', ')}: ${expectation.semantic_step ?? expectation.target}`,
    );
  }
  const assertions = expectation.assertions ?? [];
  if (assertions.length > 0) {
    const matched = rows.some((row) =>
      !!row &&
      typeof row === 'object' &&
      assertions.every(assertion =>
        assertionMatches((row as Record<string, unknown>)[assertion.column], assertion),
      ),
    );
    if (!matched) {
      const contract = assertions
        .map(assertion => `${assertion.column} ${assertion.operator} ${JSON.stringify(assertion.value)}`)
        .join(' AND ');
      throw new Error(
        `no single result row satisfies ${contract}: ${expectation.semantic_step ?? expectation.target}`,
      );
    }
  }
}

async function loadTokenContext(evaluator: SkillEvaluator): Promise<TokenContext> {
  const result = await evaluator.executeSQL(`
    SELECT
      printf('%d', trace_start()) AS trace_start,
      printf('%d', trace_end()) AS trace_end,
      printf('%d', COALESCE((
        SELECT MIN(s.ts)
        FROM slice s
        JOIN thread_track tt ON tt.id = s.track_id
        JOIN thread t ON t.utid = tt.utid
        JOIN process p ON p.upid = t.upid
        WHERE p.name = 'com.smartperfetto.fixture'
      ), trace_start())) AS fixture_start,
      printf('%d', COALESCE((
        SELECT MAX(s.ts + MAX(s.dur, 0))
        FROM slice s
        JOIN thread_track tt ON tt.id = s.track_id
        JOIN thread t ON t.utid = tt.utid
        JOIN process p ON p.upid = t.upid
        WHERE p.name = 'com.smartperfetto.fixture'
      ), trace_end())) AS fixture_end,
      COALESCE((SELECT upid FROM process WHERE name = 'com.smartperfetto.fixture' ORDER BY upid DESC LIMIT 1), 0) AS fixture_upid,
      COALESCE((
        SELECT t.utid FROM thread t
        JOIN process p USING (upid)
        WHERE p.name = 'com.smartperfetto.fixture' AND t.name = 'main'
        ORDER BY t.utid DESC LIMIT 1
      ), 0) AS fixture_utid
  `);
  if (result.error || result.rows.length !== 1) {
    throw new Error(`cannot resolve trace tokens: ${result.error ?? 'no row'}`);
  }
  const row = result.rows[0];
  return {
    trace_start: String(row[0]),
    trace_end: String(row[1]),
    fixture_start: String(row[2]),
    fixture_end: String(row[3]),
    fixture_upid: Number(row[4]),
    fixture_utid: Number(row[5]),
  };
}

async function assertMarker(evaluator: SkillEvaluator, marker: string | undefined): Promise<void> {
  if (!marker) return;
  const escaped = marker.replace(/'/g, "''");
  const result = await evaluator.executeSQL(`SELECT COUNT(*) AS count FROM slice WHERE name = '${escaped}'`);
  if (result.error || Number(result.rows[0]?.[0] ?? 0) < 1) {
    throw new Error(`required marker is absent: ${marker}`);
  }
}

function validateDefinition(repoRoot: string, expectation: CorpusExpectation): void {
  if (!expectation.source_file) throw new Error('definition expectation has no source_file');
  const sourcePath = path.resolve(repoRoot, expectation.source_file);
  if (!fs.existsSync(sourcePath)) throw new Error(`definition source is missing: ${expectation.source_file}`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!new RegExp(`^name:\\s*["']?${expectation.target}["']?\\s*$`, 'm').test(source)) {
    throw new Error(`definition source does not declare ${expectation.target}`);
  }
}

async function runSkillExpectation(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
  tokenContext: TokenContext,
  tracePath: string,
): Promise<SkillSqlEvidence> {
  const evidence: SkillSqlEvidence = {
    normal: [],
    forced: [],
    isolated: [],
    condition_skipped: [],
    unavailable: [],
  };
  await assertMarker(evaluator, expectation.required_marker);
  if (expectation.mode === 'definition') return evidence;
  await evaluator.selectSkill(expectation.target);
  const requiredSteps = expectation.required_steps ?? [];
  if (requiredSteps.length === 0) throw new Error('execute expectation has no required_steps');
  const params = resolveParameterTokens(expectation.parameters ?? {}, tokenContext);
  const semanticStep = expectation.semantic_step ?? requiredSteps[requiredSteps.length - 1];
  const requiredSqlSteps = expectation.required_sql_steps ?? [];
  const forcedSqlSteps = new Set(expectation.forced_sql_steps ?? []);
  const isolatedSqlProbes = new Map(
    (expectation.isolated_sql_probes ?? []).map((probe) => [probe.step, probe]),
  );
  const expectedConditionSkips = new Map(
    (expectation.expected_condition_skips ?? []).map((item) => [item.step, item]),
  );
  const expectedUnavailable = new Map(
    (expectation.expected_unavailable_sql_steps ?? []).map((item) => [item.step, item]),
  );
  let results;
  try {
    results = requiredSteps.length === 1 && requiredSteps[0] === 'root'
      ? [await evaluator.executeRootAtomic(params)]
      : await evaluator.executeStepSequence(requiredSteps, params);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const unmatched = requiredSqlSteps.filter((stepId) => {
      const unavailable = expectedUnavailable.get(stepId);
      if (unavailable && message.includes(unavailable.error)) {
        evidence.unavailable.push(stepId);
        return false;
      }
      return true;
    });
    if (requiredSqlSteps.length > 0 && unmatched.length === 0) {
      return evidence;
    }
    throw error;
  }

  let forcedResults: typeof results = [];
  if (forcedSqlSteps.size > 0) {
    await evaluator.selectSkill(expectation.target);
    try {
      forcedResults = await evaluator.executeStepSequence(requiredSteps, params, {
        forceSqlStepIds: [...forcedSqlSteps],
      });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const unmatched = [...forcedSqlSteps].filter((stepId) => {
        const unavailable = expectedUnavailable.get(stepId);
        if (unavailable && message.includes(unavailable.error)) {
          evidence.unavailable.push(stepId);
          return false;
        }
        return true;
      });
      if (unmatched.length > 0) throw error;
    }
  }

  const normalByStep = new Map(results.map((result) => [result.stepId, result]));
  const forcedByStep = new Map(forcedResults.map((result) => [result.stepId, result]));
  const isolatedByStep = new Map<string, EvalStepResult>();
  for (const [stepId, probe] of isolatedSqlProbes) {
    if (normalByStep.get(stepId)?.code !== 'condition_not_met') continue;
    const isolatedEvaluator = createSkillEvaluator(expectation.target);
    try {
      await isolatedEvaluator.loadTrace(tracePath);
      for (const setupSql of probe.setup_sql) {
        const setup = await isolatedEvaluator.executeSQL(setupSql);
        if (setup.error) throw new Error(`${stepId} isolated setup failed: ${setup.error}`);
      }
      const isolatedResults = await isolatedEvaluator.executeStepSequence(requiredSteps, params);
      const isolated = isolatedResults.find((result) => result.stepId === stepId);
      if (!isolated) throw new Error(`${stepId} isolated SQL step was not attempted`);
      isolatedByStep.set(stepId, isolated);
    } finally {
      await isolatedEvaluator.cleanup();
    }
  }
  for (const result of results) {
    if (requiredSqlSteps.includes(result.stepId)) continue;
    if (!result.success && result.code !== 'condition_not_met') {
      throw new Error(`${result.stepId} failed: ${result.error ?? 'unknown error'}`);
    }
  }
  for (const stepId of requiredSqlSteps) {
    const normal = normalByStep.get(stepId);
    if (!normal) throw new Error(`required SQL step was not attempted: ${stepId}`);
    if (normal.code === 'optional_query_error') {
      throw new Error(`${stepId} optional SQL failed: ${normal.error ?? 'unknown error'}`);
    }
    if (sqlResultState(normal) === 'executed') {
      evidence.normal.push(stepId);
      continue;
    }
    if (normal.code === 'condition_not_met') {
      if (isolatedSqlProbes.has(stepId)) {
        const isolated = isolatedByStep.get(stepId);
        if (!isolated) throw new Error(`isolated SQL step was not attempted: ${stepId}`);
        if (isolated.code === 'optional_query_error' || sqlResultState(isolated) !== 'executed') {
          throw new Error(`${stepId} isolated SQL failed: ${isolated.error ?? isolated.code ?? 'unknown error'}`);
        }
        evidence.isolated.push(stepId);
        continue;
      }
      if (forcedSqlSteps.has(stepId)) {
        if (evidence.unavailable.includes(stepId)) continue;
        const forced = forcedByStep.get(stepId);
        if (!forced) throw new Error(`forced SQL step was not attempted: ${stepId}`);
        if (forced.code === 'optional_query_error') {
          throw new Error(`${stepId} forced optional SQL failed: ${forced.error ?? 'unknown error'}`);
        }
        if (sqlResultState(forced) === 'executed') {
          evidence.forced.push(stepId);
          continue;
        }
        const unavailable = expectedUnavailable.get(stepId);
        const forcedMessage = forced.error ?? 'unknown error';
        if (unavailable && forcedMessage.includes(unavailable.error)) {
          evidence.unavailable.push(stepId);
          continue;
        }
        throw new Error(`${stepId} forced SQL failed: ${forcedMessage}`);
      }
      if (expectedConditionSkips.has(stepId)) {
        evidence.condition_skipped.push(stepId);
        continue;
      }
      throw new Error(`SQL step was skipped without a forced probe or explicit condition contract: ${stepId}`);
    }
    const message = normal.error ?? 'unknown error';
    const unavailable = expectedUnavailable.get(stepId);
    if (unavailable && message.includes(unavailable.error)) {
      evidence.unavailable.push(stepId);
      continue;
    }
    throw new Error(`${stepId} failed: ${message}`);
  }

  const normalSemanticResult = normalByStep.get(semanticStep);
  const semanticResult = normalSemanticResult?.code === 'condition_not_met'
    ? forcedByStep.get(semanticStep) ?? isolatedByStep.get(semanticStep)
    : normalSemanticResult ?? forcedByStep.get(semanticStep) ?? isolatedByStep.get(semanticStep);
  if (expectation.mode === 'unavailable') {
    if (!evidence.unavailable.includes(semanticStep)) {
      throw new Error(`unavailable expectation unexpectedly executed successfully: ${semanticStep}`);
    }
    return evidence;
  }
  if (!semanticResult) throw new Error(`semantic step was not executed: ${semanticStep}`);
  if (
    expectation.mode === 'graceful_empty'
    || expectation.mode === 'negative'
    || expectation.mode === 'deferred'
  ) {
    if (semanticResult.data.length !== 0) {
      throw new Error(
        `${expectation.mode} expectation unexpectedly returned ${semanticResult.data.length} row(s): ${semanticStep}`,
      );
    }
    return evidence;
  }
  assertExpectationRows(semanticResult.data, expectation);
  return evidence;
}

async function runStrategyExpectation(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
): Promise<void> {
  await assertMarker(evaluator, expectation.required_marker);
  const strategy = loadStrategies().get(expectation.target);
  if (!strategy) throw new Error(`Strategy loader cannot resolve ${expectation.target}`);
  if (strategy.strategyKind !== 'contract_only') {
    const actual = classifyScene(expectation.query ?? '');
    if (actual !== (expectation.expected_strategy ?? expectation.target)) {
      throw new Error(`classifier returned ${actual} for query ${JSON.stringify(expectation.query)}`);
    }
  }
}

function corpusTracePath(repoRoot: string, entry: CorpusCase): string {
  if (entry.kind === 'constructed') {
    if (!entry.construction?.output) throw new Error(`constructed case ${entry.id} has no output path`);
    return path.resolve(repoRoot, entry.construction.output);
  }
  return path.resolve(repoRoot, entry.case_dir, entry.trace.file);
}

async function runSqlExpectation(
  repoRoot: string,
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
): Promise<'positive' | 'negative'> {
  await assertMarker(evaluator, expectation.required_marker);
  if (!expectation.source_file || !expectation.source_sha256 || !expectation.query) {
    throw new Error('canonical SQL expectation requires source_file, source_sha256, and query');
  }
  const packageRoot = path.resolve(repoRoot, 'backend/sql/smartperfetto');
  const sourcePath = path.resolve(repoRoot, expectation.source_file);
  if (!sourcePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`canonical SQL source escapes backend/sql/smartperfetto: ${expectation.source_file}`);
  }
  const source = fs.readFileSync(sourcePath, 'utf8');
  const actualHash = crypto.createHash('sha256').update(source).digest('hex');
  if (actualHash !== expectation.source_sha256) {
    throw new Error(
      `canonical SQL source hash mismatch: expected ${expectation.source_sha256}, got ${actualHash}`,
    );
  }
  const sourceResult = await evaluator.executeSQL(source);
  if (sourceResult.error) throw new Error(`canonical SQL source failed: ${sourceResult.error}`);
  const queryResult = await evaluator.executeSQL(expectation.query);
  if (queryResult.error) throw new Error(`canonical SQL query failed: ${queryResult.error}`);
  const resultRows = queryResult.rows.map((row) => Object.fromEntries(
    queryResult.columns.map((column, index) => [column, row[index]]),
  ));
  if (expectation.mode === 'negative') {
    if (resultRows.length !== 0) {
      throw new Error(
        `negative SQL expectation unexpectedly returned ${resultRows.length} row(s): ${expectation.target}`,
      );
    }
    return 'negative';
  }
  assertExpectationRows(resultRows, expectation);
  return 'positive';
}

export async function runCorpusRegression(
  repoRoot: string,
  options: {
    caseIds?: string[];
    targetIds?: string[];
    writeEvidence?: boolean;
  } = {},
): Promise<CorpusRunResult> {
  const corpus = loadCorpus(repoRoot);
  const selectedCases = corpus.cases.filter((entry) =>
    !options.caseIds || options.caseIds.includes(entry.id),
  );
  const targetFilter = options.targetIds ? new Set(options.targetIds) : null;
  const result: CorpusRunResult = {
    executed: [],
    sql: {normal: [], forced: [], isolated: [], condition_skipped: [], unavailable: []},
    correctness: {positive: [], execution_only: [], negative: [], deferred: []},
    failures: [],
  };

  for (const entry of selectedCases) {
    const expectations = entry.coverage.expectations.filter((expectation) =>
      !targetFilter || targetFilter.has(expectation.target),
    );
    if (expectations.length === 0) continue;
    const tracePath = corpusTracePath(repoRoot, entry);
    if (!fs.existsSync(tracePath)) {
      for (const expectation of expectations) {
        result.failures.push({case_id: entry.id, target: expectation.target, reason: `materialized trace missing: ${tracePath}`});
      }
      continue;
    }
    const executable = expectations.find((expectation) => expectation.type === 'skill' && expectation.mode !== 'definition');
    const evaluator = createSkillEvaluator(executable?.target ?? 'global_trace_sanity_check');
    try {
      await evaluator.loadTrace(tracePath);
      const tokenContext = await loadTokenContext(evaluator);
      for (const expectation of expectations) {
        const executionKey = `${entry.id}:${expectation.type}:${expectation.target}`;
        try {
          if (expectation.type === 'skill') {
            if (expectation.mode === 'definition') validateDefinition(repoRoot, expectation);
            const sqlEvidence = await runSkillExpectation(
              evaluator,
              expectation,
              tokenContext,
              tracePath,
            );
            for (const [status, stepIds] of Object.entries(sqlEvidence)) {
              result.sql[status as keyof SkillSqlEvidence].push(
                ...stepIds.map((stepId) => `${entry.id}:skill:${expectation.target}:${stepId}`),
              );
            }
            if (expectation.mode === 'semantic') result.correctness.positive.push(executionKey);
            else if (expectation.mode === 'execution') result.correctness.execution_only.push(executionKey);
            else if (expectation.mode === 'negative' || expectation.mode === 'graceful_empty') {
              result.correctness.negative.push(executionKey);
            } else if (expectation.mode === 'deferred' || expectation.mode === 'unavailable') {
              result.correctness.deferred.push(executionKey);
            }
          } else if (expectation.type === 'sql') {
            const correctness = await runSqlExpectation(repoRoot, evaluator, expectation);
            result.correctness[correctness].push(executionKey);
            result.sql.normal.push(
              `${entry.id}:sql:${expectation.target}:source`,
              `${entry.id}:sql:${expectation.target}:query`,
            );
          } else {
            await runStrategyExpectation(evaluator, expectation);
          }
          result.executed.push(executionKey);
        } catch (error: any) {
          result.failures.push({case_id: entry.id, target: expectation.target, reason: error?.message ?? String(error)});
        }
      }
    } catch (error: any) {
      for (const expectation of expectations) {
        result.failures.push({case_id: entry.id, target: expectation.target, reason: error?.message ?? String(error)});
      }
    } finally {
      await evaluator.cleanup();
    }

    if (options.writeEvidence !== false) {
      const evidencePath = path.join(
        repoRoot,
        'Trace/.generated',
        entry.kind,
        entry.id,
        'regression-result.json',
      );
      fs.mkdirSync(path.dirname(evidencePath), {recursive: true});
      const caseEvidence = {
        schema_version: 1,
        case_id: entry.id,
        executed: result.executed.filter((key) => key.startsWith(`${entry.id}:`)),
        sql: Object.fromEntries(
          Object.entries(result.sql).map(([status, keys]) => [
            status,
            keys.filter((key) => key.startsWith(`${entry.id}:`)),
          ]),
        ),
        correctness: Object.fromEntries(
          Object.entries(result.correctness).map(([status, keys]) => [
            status,
            keys.filter((key) => key.startsWith(`${entry.id}:`)),
          ]),
        ),
        failures: result.failures.filter((failure) => failure.case_id === entry.id),
      };
      fs.writeFileSync(evidencePath, `${JSON.stringify(caseEvidence, null, 2)}\n`);
    }
  }
  return result;
}

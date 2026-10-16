// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {loadStrategies} from '../../src/agentv3/strategyLoader';
import {executableSqlUnits, sqlRunBy, type ExactProcessScopeSupport} from '../../src/services/skillEngine/processScopeSql';
import type {SkillDefinition} from '../../src/services/skillEngine/types';
import {createSkillEvaluator, SkillEvaluator, type EvalStepResult, type ScopeProbeOutcome} from '../skill-eval/runner';
import {stableStringify} from '../../src/utils/stableJson';
import {analysisTracePath} from '../helpers/traceCorpus';

type FixtureTokenContext = {
  trace_start: string;
  trace_end: string;
  fixture_start: string;
  fixture_end: string;
  fixture_upid: number;
  fixture_utid: number;
};

type TokenContext = FixtureTokenContext & {fixture_process_found: boolean};

type SqlQuery = (sql: string) => Promise<{columns: string[]; rows: any[][]; error?: string}>;

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
  exact_scope?: ExactScopeBinding;
};

/**
 * Runs the expectation's steps again under an exact UPID scope, so the
 * executor selects each step's exact_sql (processScopeSql.sqlRunBy). The
 * process is named, never numbered: without `instance` the name must resolve
 * to exactly one UPID in the case trace; with it, to several (an app that was
 * restarted), of which `instance` picks one by UPID order, as `fixture_upid`
 * does (selectExactScopeInstance). Each bound unit is an `executableSqlUnits`
 * exact path.
 */
type ExactScopeBinding = {
  process_name: string;
  instance?: 'newest' | 'oldest';
  units: ExactUnitBinding[];
};

type ExactUnitBinding = Pick<CorpusExpectation, 'min_rows' | 'max_rows' | 'required_columns' | 'assertions'> & {
  unit: string;
  mode: 'semantic' | 'execution';
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
  trace: {file: string; materialization: 'committed' | 'base-plus-overlay'};
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
  strategy: {
    declaration_checked: string[];
    semantic_routing: 'not_evaluated';
  };
  correctness: {
    positive: string[];
    execution_only: string[];
    negative: string[];
    deferred: string[];
    /** Exact units whose bound result matched source-backed row assertions. */
    exact_positive: string[];
    /** Exact units asserted to execute under the bound UPID, without row semantics. */
    exact_execution_only: string[];
  };
  failures: Array<{case_id: string; target: string; reason: string}>;
};

type SkillSqlEvidence = CorpusRunResult['sql'];
type ExactSqlEvidence = {positive: string[]; execution_only: string[]};
const noExactEvidence = (): ExactSqlEvidence => ({positive: [], execution_only: []});

/** How the corpus names one exact unit of a Skill across expectations. */
export const exactUnitKey = (target: string, unit: string): string => `${target}:${unit}`;

/** A SQL string literal. */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The units a Skill runs as target SQL under an exact UPID, from the walk
 * every Skill SQL check shares: each exact_sql, and the SQL of a target step
 * that has none and binds the scope's UPID itself, through the token
 * (`binding: native_upid`) or the target relation
 * (`binding: effective_target_processes`), which an exact run executes as
 * written (processScopeSql.sqlRunBy). Whether the executor admits an exact
 * run of the Skill at all is a separate question (unboundExactUnitFailures).
 */
function exactSqlUnits(definition: SkillDefinition) {
  return executableSqlUnits(definition).filter(({variant, node, source}) => variant === 'exact'
    || (sqlRunBy(node, 'exact') === source && source.process_scope?.role === 'target'
      && source.process_scope.binding !== undefined && source.process_scope.exact_unavailable === undefined));
}

export function exactSqlUnitPaths(definition: SkillDefinition): string[] {
  return exactSqlUnits(definition).map(unit => unit.path);
}

/**
 * The result that reports an exact unit: `root` for the Skill's root, or the
 * id of the top-level step that owns it. The runner sees only those results,
 * so a nested unit (inside a step, a branch, or a step without an id) has none.
 */
function exactUnitStepId(definition: SkillDefinition, unitPath: string): string | undefined {
  const node = exactSqlUnits(definition).find(candidate => candidate.path === unitPath)?.node;
  if (node === definition) return 'root';
  return definition.steps?.includes(node as any) && typeof node?.id === 'string' ? node.id : undefined;
}

const NESTED_UNSUPPORTED = 'nested exact units are not yet supported by the corpus runner';

/**
 * Why `binding` cannot run `target`'s exact units, judged before any trace
 * work. The case schema owns the binding's shape (a semantic unit's columns
 * and assertions); this checks what only the Skill knows.
 */
export function exactScopeBindingError(
  target: string,
  definition: SkillDefinition,
  binding: ExactScopeBinding,
): string | undefined {
  const known = exactSqlUnitPaths(definition);
  const bound = binding.units.map(unit => unit.unit);
  const duplicate = bound.filter((unit, index) => bound.indexOf(unit) !== index);
  if (duplicate.length > 0) return `exact_scope binds ${[...new Set(duplicate)].join(', ')} more than once`;
  const unknown = bound.filter(unit => !known.includes(unit));
  if (unknown.length > 0) {
    return `exact_scope binds ${unknown.join(', ')}, which ${target} does not run as exact SQL `
      + `(exact units: ${known.join(', ') || '(none)'})`;
  }
  const nested = bound.filter(unit => !exactUnitStepId(definition, unit));
  if (nested.length > 0) return `${NESTED_UNSUPPORTED}: ${nested.join(', ')}`;
  return undefined;
}

/**
 * The UPID `binding` runs under, from the UPIDs its process name matches in
 * ascending order, and the same-named instance the scope probe compares it
 * with: the next one in the same direction. One sibling is enough, since a
 * selection by name admits every instance that shares it.
 */
export function selectExactScopeInstance(
  upids: readonly number[],
  binding: Pick<ExactScopeBinding, 'process_name' | 'instance'>,
): {upid: number; sibling?: number} {
  const matched = `exact_scope process ${binding.process_name} matches ${upids.length} process(es)`;
  if (upids.some(upid => !Number.isSafeInteger(upid) || upid <= 0)) {
    throw new Error(`${matched}, not all with a positive UPID`);
  }
  if (!binding.instance) {
    if (upids.length !== 1) {
      throw new Error(`${matched}; an exact binding needs exactly one positive UPID, `
        + 'or an instance (newest|oldest) when the name is shared');
    }
    return {upid: upids[0]};
  }
  if (upids.length < 2) {
    throw new Error(`${matched}; instance ${binding.instance} picks among same-named processes, so the name must be shared`);
  }
  const ordered = binding.instance === 'newest' ? [...upids].reverse() : upids;
  return {upid: ordered[0], sibling: ordered[1]};
}

/** Why `result` is not `unit` executed under exact UPID `upid`, or undefined when it is. */
export function exactUnitResultError(
  unit: string,
  result: EvalStepResult | undefined,
  upid: number,
): string | undefined {
  if (!result) return `${unit} was not attempted under exact UPID ${upid}`;
  if (result.code === 'condition_not_met') {
    return `${unit} was skipped by its condition under exact UPID ${upid}; an exact unit has no forced `
      + 'or isolated probe, so bind a process whose trace reaches it through the production path';
  }
  if (sqlResultState(result) !== 'executed') {
    return `${unit} failed under exact UPID ${upid}: ${result.error ?? result.code ?? 'unknown error'}`;
  }
  // Target evidence carries the exact scope; context evidence is recorded relative to it.
  const exact = result.scopeProvenance?.entries.some(entry => entry.availability !== 'unavailable' &&
    [entry.scope, entry.relativeTo].some(scope => scope?.mode === 'exact_upid' && scope.upid === upid));
  return exact ? undefined : `${unit} did not record evidence under exact UPID ${upid}`;
}

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
  context: FixtureTokenContext,
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

const FRAME_TOKEN = /^\$\{frame_(start|end):(.+)\}$/;

/**
 * Resolves `${frame_start:<layer>}` / `${frame_end:<layer>}` to the bounds of
 * the one fixture-process FrameTimeline frame whose layer_name is exactly
 * <layer>. A layer is queried only when a parameter names it. Bounds stay
 * decimal strings from SQL, so nanoseconds past 2^53 keep their precision.
 */
export async function resolveFrameTokens(
  parameters: Record<string, unknown>,
  context: Pick<TokenContext, 'fixture_upid' | 'fixture_process_found'>,
  query: SqlQuery,
  caseId: string,
): Promise<Record<string, unknown>> {
  const frames = new Map<string, {start: string; end: string}>();
  const resolved: Record<string, unknown> = {...parameters};
  for (const [key, value] of Object.entries(parameters)) {
    const match = typeof value === 'string' ? FRAME_TOKEN.exec(value) : null;
    if (!match) continue;
    const [, edge, layer] = match;
    let frame = frames.get(layer);
    if (!frame) {
      frame = await lookupFixtureFrame(layer, context, query, caseId);
      frames.set(layer, frame);
    }
    resolved[key] = edge === 'start' ? frame.start : frame.end;
  }
  return resolved;
}

async function lookupFixtureFrame(
  layer: string,
  context: Pick<TokenContext, 'fixture_upid' | 'fixture_process_found'>,
  query: SqlQuery,
  caseId: string,
): Promise<{start: string; end: string}> {
  const subject = `${caseId}: frame token layer ${JSON.stringify(layer)}`;
  if (!context.fixture_process_found) {
    throw new Error(`${subject} needs the com.smartperfetto.fixture process, which the trace does not contain`);
  }
  const result = await query(`
    SELECT printf('%d', ts) AS start_ts, printf('%d', ts + dur) AS end_ts, dur > 0 AS has_duration
    FROM actual_frame_timeline_slice
    WHERE upid = ${context.fixture_upid} AND layer_name = ${sqlString(layer)}
  `);
  if (result.error) throw new Error(`${subject} cannot be resolved: ${result.error}`);
  if (result.rows.length !== 1) {
    throw new Error(`${subject} matches ${result.rows.length} frames of fixture upid ${context.fixture_upid}, expected exactly 1`);
  }
  const [start, end, hasDuration] = result.rows[0];
  if (Number(hasDuration) !== 1) throw new Error(`${subject} names a frame without a positive duration`);
  return {start: String(start), end: String(end)};
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
      ), 0) AS fixture_utid,
      EXISTS (SELECT 1 FROM process WHERE name = 'com.smartperfetto.fixture') AS fixture_process_found
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
    fixture_process_found: Number(row[6]) === 1,
  };
}

async function assertMarker(evaluator: SkillEvaluator, marker: string | undefined): Promise<void> {
  if (!marker) return;
  const result = await evaluator.executeSQL(`SELECT COUNT(*) AS count FROM slice WHERE name = ${sqlString(marker)}`);
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
  caseId: string,
  expectation: CorpusExpectation,
  tokenContext: TokenContext,
  tracePath: string,
): Promise<{sql: SkillSqlEvidence; exact: ExactSqlEvidence}> {
  const evidence: SkillSqlEvidence = {
    normal: [],
    forced: [],
    isolated: [],
    condition_skipped: [],
    unavailable: [],
  };
  await assertMarker(evaluator, expectation.required_marker);
  if (expectation.mode === 'definition') return {sql: evidence, exact: noExactEvidence()};
  await evaluator.selectSkill(expectation.target);
  const definition = evaluator.getSkillDefinition()!;
  const bindingError = expectation.exact_scope
    && exactScopeBindingError(expectation.target, definition, expectation.exact_scope);
  if (bindingError) throw new Error(bindingError);
  const requiredSteps = expectation.required_steps ?? [];
  if (requiredSteps.length === 0) throw new Error('execute expectation has no required_steps');
  const params = await resolveFrameTokens(
    resolveParameterTokens(expectation.parameters ?? {}, tokenContext),
    tokenContext,
    sql => evaluator.executeSQL(sql),
    caseId,
  );
  await runNamedSkillSteps(evaluator, expectation, params, tracePath, evidence);
  const exact = expectation.exact_scope
    ? await runExactScopeBinding(tracePath, expectation, definition, expectation.exact_scope, params)
    : noExactEvidence();
  return {sql: evidence, exact};
}

/** An atomic Skill runs its root; any other runs the named steps in order. */
function runRequiredSteps(
  evaluator: SkillEvaluator,
  requiredSteps: string[],
  params: Record<string, unknown>,
): Promise<EvalStepResult[]> {
  return requiredSteps.length === 1 && requiredSteps[0] === 'root'
    ? evaluator.executeRootAtomic(params).then(result => [result])
    : evaluator.executeStepSequence(requiredSteps, params);
}

/**
 * Runs the expectation's steps under an exact UPID. The process name selects
 * the UPID; the production identity gate verifies it, admission checks exact
 * support, and each step executes `sqlRunBy(step, 'exact')`. Every bound unit
 * must execute and record its evidence under that UPID; no other step may fail.
 * The pass loads the trace afresh, as isolated probes do: the named run can
 * leave views and tables behind (`CREATE VIEW IF NOT EXISTS ...`), and an
 * exact unit reading one must not pass on the named run's rows.
 */
async function runExactScopeBinding(
  tracePath: string,
  expectation: CorpusExpectation,
  definition: SkillDefinition,
  binding: ExactScopeBinding,
  params: Record<string, unknown>,
): Promise<ExactSqlEvidence> {
  const evaluator = createSkillEvaluator(expectation.target);
  try {
    await evaluator.loadTrace(tracePath);
    return await runExactUnits(evaluator, expectation, definition, binding, params);
  } finally {
    await evaluator.cleanup();
  }
}

async function runExactUnits(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
  definition: SkillDefinition,
  binding: ExactScopeBinding,
  params: Record<string, unknown>,
): Promise<ExactSqlEvidence> {
  const processes = await evaluator.executeSQL(
    `SELECT upid FROM process WHERE name = ${sqlString(binding.process_name)} ORDER BY upid`);
  if (processes.error) throw new Error(`exact_scope process lookup failed: ${processes.error}`);
  const {upid, sibling} = selectExactScopeInstance(processes.rows.map(row => Number(row[0])), binding);
  if (params.upid !== undefined && Number(params.upid) !== upid) {
    throw new Error(`exact_scope UPID ${upid} conflicts with the expectation's upid parameter ${String(params.upid)}`);
  }
  const exactParams = {...params, upid};
  const required = expectation.required_steps ?? [];
  const units = binding.units.map(unit => ({unit, stepId: exactUnitStepId(definition, unit.unit)!}));
  const probe = {scopeProbeStepIds: units.map(({stepId}) => stepId), scopeProbeSiblingUpid: sibling};
  // Each bound step's scope probe rides on the exact run itself. A root-atomic
  // Skill's exact run takes the production root path, which has no fork
  // point, so its probe gets one run of its own (SkillEvaluator scopeProbeStepIds).
  const rootOnly = required.length === 1 && required[0] === 'root';
  const results = rootOnly
    ? await runRequiredSteps(evaluator, required, exactParams)
    : await evaluator.executeStepSequence(required, exactParams, probe);
  // A step may be skipped or declare exact scope unavailable; it may not fail.
  for (const result of results) {
    if (result.code === 'optional_query_error' ||
        (!result.success && result.code !== 'condition_not_met' && result.code !== 'exact_scope_unavailable')) {
      throw new Error(`${result.stepId} failed under exact UPID ${upid}: ${result.error ?? result.code ?? 'unknown error'}`);
    }
  }
  const evidence = noExactEvidence();
  for (const {unit, stepId} of units) {
    const result = results.find(candidate => candidate.stepId === stepId);
    const error = exactUnitResultError(unit.unit, result, upid);
    if (error) throw new Error(error);
    // Row counts and declared assertions bind both modes, as for a top-level expectation.
    assertExpectationRows(result!.data, {...unit, target: expectation.target, semantic_step: unit.unit});
    if (unit.mode === 'semantic') {
      // Source-column-backed: the declared columns are exactly what the exact SQL
      // returns. Named SQL is held to this statically (catalog.cjs); exact SQL is
      // not walked there, so its live result is the source.
      const returned = Object.keys(result!.data[0]).sort();
      if (JSON.stringify(returned) !== JSON.stringify([...unit.required_columns!].sort())) {
        throw new Error(`${unit.unit} returns ${returned.join(', ')}; required_columns must name exactly these`);
      }
      evidence.positive.push(unit.unit);
    } else {
      evidence.execution_only.push(unit.unit);
    }
  }
  const probed = rootOnly
    ? await evaluator.executeStepSequence(required, exactParams, probe)
    : results;
  const isolation = scopeIsolationFailures(units.map(({unit, stepId}) => ({unit: unit.unit, stepId})), probed, upid, sibling);
  if (isolation.length > 0) throw new Error(isolation.join('; '));
  return evidence;
}

/** A step result as the isolation probe compares it: its outcome and its rows. */
const probedOutcome = ({success, code, error, data}: ScopeProbeOutcome): string =>
  stableStringify({success, code, error, data});

/**
 * Why the bound units' rows depend on more than the exact UPID, or why this
 * trace cannot tell, from a run with each unit's step probed (SkillEvaluator
 * scopeProbeStepIds). `blanked` ran the sequence again without the process
 * selectors, which turns a named-mode fallback into every process: a unit
 * whose exact branch, or an earlier step whose result it reads, still admits
 * rows by package (a same-package `:worker`, say), pid or upid parameter
 * answers it differently. `open` ran it unscoped, which is every process: if
 * that answers like the exact run, no other process in this trace carries the
 * unit's evidence and the first check proved nothing, so the fixture, not the
 * Skill, is insufficient. A step with an exact_sql has no unscoped form, so
 * only its blanked check applies. When the bound process shares its name,
 * `sibling` ran it under the other instance's UPID, which each unit must
 * answer differently: an equal answer reads by name (ScopeProbeVariant), or
 * the two instances carry the same evidence.
 */
export function scopeIsolationFailures(
  units: ReadonlyArray<{unit: string; stepId: string}>,
  results: readonly EvalStepResult[],
  upid: number,
  siblingUpid?: number,
): string[] {
  return units.flatMap(({unit, stepId}) => {
    const result = results.find(candidate => candidate.stepId === stepId);
    if (!result?.scopeProbe) return [`${unit} was not probed for scope isolation`];
    const exact = probedOutcome(result);
    if (probedOutcome(result.scopeProbe.blanked) !== exact) {
      return [`${unit} reads more than its exact UPID: without the process selectors the identity gate `
        + 'wrote it answers differently, so its exact branch still admits rows by package, pid or upid parameter'];
    }
    if (result.scopeProbe.open && probedOutcome(result.scopeProbe.open) === exact) {
      return [`${unit} isolation is inconclusive: it answers for every process as for UPID ${upid}, `
        + 'so no other process in this trace carries its evidence; '
        + 'bind a trace where one does (the fixture is insufficient, not the Skill)'];
    }
    if (siblingUpid === undefined) return [];
    if (!result.scopeProbe.sibling) return [`${unit} was not probed under same-named UPID ${siblingUpid}`];
    if (probedOutcome(result.scopeProbe.sibling) === exact) {
      return [`${unit} answers alike under UPID ${upid} and UPID ${siblingUpid}, which share a process name: `
        + 'its exact branch selects by name, itself or through an earlier result, '
        + 'or the instances carry the same evidence (give them distinct evidence)'];
    }
    return [];
  });
}

/** The expectation's steps as written, with its forced, isolated and declared-skip contracts. */
async function runNamedSkillSteps(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
  params: Record<string, unknown>,
  tracePath: string,
  evidence: SkillSqlEvidence,
): Promise<void> {
  const requiredSteps = expectation.required_steps ?? [];
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
    results = await runRequiredSteps(evaluator, requiredSteps, params);
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
      return;
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
    return;
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
    return;
  }
  assertExpectationRows(semanticResult.data, expectation);
}

/** Checks declared registry identity only; a fixture query is not a model-routing verdict. */
export function validateStrategyExpectationDeclaration(
  expectation: Pick<CorpusExpectation, 'target' | 'expected_strategy' | 'query'>,
): void {
  const strategy = loadStrategies().get(expectation.target);
  if (!strategy) throw new Error(`Strategy loader cannot resolve ${expectation.target}`);
  const expected = expectation.expected_strategy ?? expectation.target;
  if (strategy.scene !== expected) {
    throw new Error(`Strategy declaration ${expected} does not match registered target ${strategy.scene}`);
  }
  if (!strategy.content.trim()) throw new Error(`Strategy declaration is empty: ${strategy.scene}`);
}

async function runStrategyExpectation(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
): Promise<void> {
  await assertMarker(evaluator, expectation.required_marker);
  validateStrategyExpectationDeclaration(expectation);
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
  if (options.caseIds) {
    const knownCaseIds = new Set(corpus.cases.map(entry => entry.id));
    const unknownCaseIds = options.caseIds.filter(id => !knownCaseIds.has(id));
    if (unknownCaseIds.length > 0) {
      throw new Error(`Unknown requested corpus case(s): ${unknownCaseIds.join(', ')}`);
    }
    if (options.caseIds.length === 0) {
      throw new Error('Explicit corpus case selection must not be empty');
    }
  }
  const selectedCases = corpus.cases.filter((entry) =>
    !options.caseIds || options.caseIds.includes(entry.id),
  );
  const targetFilter = options.targetIds ? new Set(options.targetIds) : null;
  const result: CorpusRunResult = {
    executed: [],
    sql: {normal: [], forced: [], isolated: [], condition_skipped: [], unavailable: []},
    correctness: {positive: [], execution_only: [], negative: [], deferred: [],
      exact_positive: [], exact_execution_only: []},
    strategy: {declaration_checked: [], semantic_routing: 'not_evaluated'},
    failures: [],
  };
  // `${target}:${unit}` for every exact unit some selected expectation binds.
  const boundExactUnits = new Set<string>();

  for (const entry of selectedCases) {
    const expectations = entry.coverage.expectations.filter((expectation) =>
      !targetFilter || targetFilter.has(expectation.target),
    );
    if (expectations.length === 0) continue;
    const tracePath = analysisTracePath(entry, repoRoot);
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
          if (expectation.exact_scope && (expectation.type !== 'skill' || expectation.mode === 'definition')) {
            throw new Error(`exact_scope needs an executed Skill expectation, not ${expectation.type}`
              + `${expectation.mode ? ` mode ${expectation.mode}` : ''}`);
          }
          if (expectation.type === 'skill') {
            if (expectation.mode === 'definition') validateDefinition(repoRoot, expectation);
            const skillEvidence = await runSkillExpectation(
              evaluator,
              entry.id,
              expectation,
              tokenContext,
              tracePath,
            );
            const sqlKey = (stepId: string) => `${entry.id}:skill:${expectation.target}:${stepId}`;
            for (const [status, stepIds] of Object.entries(skillEvidence.sql)) {
              result.sql[status as keyof SkillSqlEvidence].push(...stepIds.map(sqlKey));
            }
            result.correctness.exact_positive.push(...skillEvidence.exact.positive.map(sqlKey));
            result.correctness.exact_execution_only.push(...skillEvidence.exact.execution_only.map(sqlKey));
            // A unit counts as bound only once its exact run passed.
            for (const unit of [...skillEvidence.exact.positive, ...skillEvidence.exact.execution_only]) {
              boundExactUnits.add(exactUnitKey(expectation.target, unit));
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
            result.strategy.declaration_checked.push(executionKey);
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
        strategy: {
          declaration_checked: result.strategy.declaration_checked.filter(key => key.startsWith(`${entry.id}:`)),
          semantic_routing: result.strategy.semantic_routing,
        },
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
  // Every exact_sql the executor can run needs a binding somewhere in the
  // corpus; a case selection sees only part of the corpus, so it cannot judge.
  if (!options.caseIds) {
    for (const failure of unboundExactUnitFailures(SkillEvaluator.listSkillDefinitions(),
      SkillEvaluator.exactScopeSupportCatalog(), boundExactUnits, targetFilter)) {
      result.failures.push(failure);
    }
  }
  return result;
}

/**
 * Exact units of the selected Skills that no corpus expectation binds to a
 * process. A Skill the executor never admits to an exact run (`supports`,
 * the admission closure: some step has no process_scope) runs none of its
 * units under one, so it owes no binding until that changes.
 */
export function unboundExactUnitFailures(
  definitions: SkillDefinition[],
  supports: ReadonlyMap<string, ExactProcessScopeSupport>,
  boundExactUnits: ReadonlySet<string>,
  targetFilter: ReadonlySet<string> | null = null,
): CorpusRunResult['failures'] {
  return definitions
    .filter(definition => (!targetFilter || targetFilter.has(definition.name))
      && supports.get(definition.name)?.supported !== false)
    .flatMap(definition => exactSqlUnitPaths(definition)
      .filter(unit => !boundExactUnits.has(exactUnitKey(definition.name, unit)))
      .map(unit => ({case_id: 'corpus', target: definition.name,
        reason: `exact SQL unit ${unit} was not executed by any corpus exact_scope binding`
          + (exactUnitStepId(definition, unit) ? '' : ` (${NESTED_UNSUPPORTED})`)})));
}

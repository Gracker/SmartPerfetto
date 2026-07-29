// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import fs from 'fs';
import path from 'path';

import type {
  CurationProposalV1,
  ProposalCandidateMaterializationV1,
  ProposalSqlRegressionProofV1,
} from '../../types/selfEvolution';
import {TraceProcessorService} from '../traceProcessorService';
import {splitSqlStatements} from '../sqlStdlibDependencyAnalyzer';
import {TraceProcessorFactory, type QueryResult} from '../workingTraceProcessor';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import {
  createProposalSqlRegressionProofV1,
  parseProposalCandidateMaterializationV1,
  proposalDraftContentHash,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';
import {TraceProcessorCpuSampler} from './traceProcessorCpuSampler';

export const PROPOSAL_SQL_REGRESSION_VERSION = '3';
export const PROPOSAL_SQL_GUARDRAIL_FINGERPRINT = canonicalContentHash({
  sqlValidator: 'SQLValidator',
  sqlGuardrails: 'DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES',
  version: PROPOSAL_SQL_REGRESSION_VERSION,
});
const MAX_CASES = 5;
const MAX_SQL_BYTES = 256 * 1024;
const MAX_STATEMENTS = 32;
const MAX_RESULT_ROWS = 10_000;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_TRACE_PROCESSOR_CPU_MS = 5_000;
const trustedSqlRegressionProofHashes = new Set<string>();

interface CatalogAssertion {
  column: string;
  operator: 'contains' | 'gte';
  value: string | number;
}

interface CatalogExpectation {
  id: string;
  type: 'skill' | string;
  target: string;
  mode: 'definition' | 'execution' | 'graceful_empty' | 'semantic';
  source_file?: string;
  required_sql_steps?: string[];
  semantic_step?: string;
  min_rows?: number;
  assertions?: CatalogAssertion[];
}

interface CatalogCase {
  id: string;
  kind: 'real' | 'constructed';
  case_dir: string;
  trace: {
    file: string;
    sha256: string;
  };
  construction?: {
    base_case_id: string;
    output: string;
  };
  coverage?: {
    expectations?: CatalogExpectation[];
  };
}

interface ConstructedTraceProvenance {
  schema_version: 1;
  case_id: string;
  base_case_id: string;
  base_sha256: string;
  overlay_sha256: string;
  output_sha256: string;
}

interface ManagedCase {
  caseId: string;
  tracePath: string;
  traceContentHash: string;
  sourceContentHash: string;
  expectation: CatalogExpectation;
}

interface SqlBudget {
  timeoutMs: number;
  maxCpuMs: number;
  maxRows: number;
  maxResponseBytes: number;
}

export async function runManagedProposalSqlRegression(input: {
  proposal: CurationProposalV1;
  candidate: ProposalCandidateMaterializationV1;
  baselineSql: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gatePolicyFingerprint: string;
  repoRoot: string;
  uploadDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  traceProcessorService?: TraceProcessorService;
}): Promise<ProposalSqlRegressionProofV1> {
  const proposal = parseM6DraftProposal(input.proposal);
  const candidate = parseProposalCandidateMaterializationV1(input.candidate);
  const delta = proposal.deltas[0];
  const sql = candidate.serializedContent;
  const baselineSql = input.baselineSql;
  if (
    proposal.kind !== 'skill_sql'
    || candidate.proposalId !== proposal.proposalId
    || candidate.draftContentHash !== proposalDraftContentHash(proposal)
    || baselineSql !== delta.before
    || !baselineSql?.trim()
    || !input.gateAttemptId.trim()
    || !Number.isSafeInteger(input.gateAttemptOrdinal)
    || input.gateAttemptOrdinal < 1
    || !/^[0-9a-f]{64}$/.test(input.gatePolicyFingerprint)
    || [sql, baselineSql].some(value =>
      Buffer.byteLength(value, 'utf8') > MAX_SQL_BYTES
      || splitSqlStatements(value).length > MAX_STATEMENTS)
  ) {
    throw new Error('proposal_sql_regression_input_invalid');
  }

  const budget: SqlBudget = {
    timeoutMs: Math.max(1, input.timeoutMs ?? 30_000),
    maxCpuMs: MAX_TRACE_PROCESSOR_CPU_MS,
    maxRows: MAX_RESULT_ROWS,
    maxResponseBytes: MAX_RESULT_BYTES,
  };
  const repoRoot = fs.realpathSync.native(input.repoRoot);
  const cases = resolveManagedCases(repoRoot, proposal);
  const traceProcessorVersion = readTraceProcessorVersion(repoRoot);
  const oracleFingerprint = canonicalContentHash({
    version: PROPOSAL_SQL_REGRESSION_VERSION,
    targetId: delta.targetId,
    operationId: delta.operationId,
    baselineQueryContentHash: canonicalContentHash(baselineSql),
    expectations: cases.map(item => item.expectation),
  });
  const corpusFingerprint = canonicalContentHash({
    regressionVersion: PROPOSAL_SQL_REGRESSION_VERSION,
    traceProcessorVersion,
    oracleFingerprint,
    cases: cases.map(item => ({
      caseId: item.caseId,
      traceContentHash: item.traceContentHash,
      sourceContentHash: item.sourceContentHash,
      relativePath: path.relative(repoRoot, item.tracePath),
    })),
  });
  const service = input.traceProcessorService
    ?? new TraceProcessorService(input.uploadDir);
  const results: ProposalSqlRegressionProofV1['cases'] = [];
  for (const item of cases) {
    results.push(await runCase({
      item,
      sql,
      baselineSql,
      budget,
      gateAttemptId: input.gateAttemptId,
      signal: input.signal,
      service,
    }));
  }
  const verdict = results.some(result => result.verdict === 'failed')
    ? 'failed'
    : results.some(result => result.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'passed';
  const proof = createProposalSqlRegressionProofV1({
    proposalId: proposal.proposalId,
    proposalRevision: 1,
    draftContentHash: proposalDraftContentHash(proposal),
    candidateMaterializationContentHash: candidate.contentHash,
    gateAttemptId: input.gateAttemptId,
    gateAttemptOrdinal: input.gateAttemptOrdinal,
    gatePolicyFingerprint: input.gatePolicyFingerprint,
    corpusFingerprint,
    traceProcessorVersion,
    sqlValidatorVersion: PROPOSAL_SQL_REGRESSION_VERSION,
    sqlGuardrailFingerprint: PROPOSAL_SQL_GUARDRAIL_FINGERPRINT,
    oracleFingerprint,
    budget,
    cases: results,
    verdict,
  });
  trustedSqlRegressionProofHashes.add(proof.contentHash);
  return proof;
}

export function assertTrustedProposalSqlRegressionProof(
  value: ProposalSqlRegressionProofV1,
): void {
  if (!trustedSqlRegressionProofHashes.has(value.contentHash)) {
    throw new Error('curation_gate_sql_evidence_not_authoritative');
  }
}

async function runCase(input: {
  item: ManagedCase;
  sql: string;
  baselineSql: string;
  budget: SqlBudget;
  gateAttemptId: string;
  signal?: AbortSignal;
  service: TraceProcessorService;
}): Promise<ProposalSqlRegressionProofV1['cases'][number]> {
  const traceId = [
    'proposal-sql',
    input.gateAttemptId,
    input.item.caseId,
    randomUUID(),
  ].join(':');
  const leaseId = `proposal-sql-lease:${randomUUID()}`;
  const orderPolicy = hasSqlOrderBy(input.sql)
    ? 'sql_order_by' as const
    : 'canonical_row_sort' as const;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', relayAbort, {once: true});
  const timer = setTimeout(
    () => controller.abort('proposal_sql_regression_timeout'),
    input.budget.timeoutMs,
  );
  timer.unref?.();
  let cpuMs = 0;
  let cpuObserved = false;
  let cpuExceeded = false;
  let cpuSamplingFailed = false;
  const sampler = new TraceProcessorCpuSampler({
    resolvePids: () => TraceProcessorFactory.getStats().processors
      .filter(processor =>
        processor.pid && processor.leaseId === leaseId)
      .map(processor => processor.pid as number),
    recordSample: cumulativeCpuMs => {
      cpuObserved = true;
      cpuMs = Math.max(cpuMs, Math.ceil(cumulativeCpuMs));
      if (cpuMs > input.budget.maxCpuMs && !cpuExceeded) {
        cpuExceeded = true;
        controller.abort('proposal_sql_regression_cpu_budget_exceeded');
        input.service.cleanupLeaseProcessor(traceId, leaseId, 'isolated');
      }
    },
    countNewProcessesFromZero: true,
    onError: () => {
      cpuSamplingFailed = true;
      controller.abort('proposal_sql_regression_cpu_unavailable');
    },
  });
  let baseline: QueryResult | undefined;
  let candidate: QueryResult | undefined;
  let samplerStarted = false;
  try {
    input.service.registerStoredTrace({
      id: traceId,
      filename: `${input.item.caseId}.pftrace`,
      size: fs.statSync(input.item.tracePath).size,
      filePath: input.item.tracePath,
    });
    sampler.start();
    samplerStarted = true;
    await input.service.ensureProcessorForLease(
      traceId,
      leaseId,
      'isolated',
    );
    baseline = await input.service.queryBounded(
      traceId,
      input.baselineSql,
      {
        leaseId,
        leaseMode: 'isolated',
        signal: controller.signal,
        timeoutMs: input.budget.timeoutMs,
        maxRows: input.budget.maxRows,
        maxResponseBytes: input.budget.maxResponseBytes,
      },
    );
    if (baseline.error) {
      return failedCase(
        input,
        orderPolicy,
        cpuMs,
        'inconclusive',
        'sql_regression_baseline_oracle_unavailable',
        baseline,
      );
    }
    candidate = await input.service.queryBounded(traceId, input.sql, {
      leaseId,
      leaseMode: 'isolated',
      signal: controller.signal,
      timeoutMs: input.budget.timeoutMs,
      maxRows: input.budget.maxRows,
      maxResponseBytes: input.budget.maxResponseBytes,
    });
    if (candidate.error) {
      return failedCase(
        input,
        orderPolicy,
        cpuMs,
        'failed',
        'sql_execution_failed',
        candidate,
        baseline,
      );
    }
  } catch (error) {
    const reasonCode = cpuExceeded
      ? 'sql_regression_cpu_budget_exceeded'
      : controller.signal.aborted
        ? 'sql_regression_timeout_or_cancelled'
        : errorCode(error);
    return failedCase(
      input,
      orderPolicy,
      cpuMs,
      cpuExceeded ? 'failed' : 'inconclusive',
      reasonCode,
      candidate,
      baseline,
    );
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', relayAbort);
    if (samplerStarted) {
      try {
        sampler.stop();
      } catch {
        cpuSamplingFailed = true;
      }
    }
    input.service.cleanupLeaseProcessor(traceId, leaseId, 'isolated');
    input.service.unregisterStoredTrace(traceId, input.item.tracePath);
  }
  if (!baseline || !candidate) {
    return failedCase(
      input,
      orderPolicy,
      cpuMs,
      'inconclusive',
      'sql_regression_result_unavailable',
      candidate,
      baseline,
    );
  }
  if (!cpuObserved || cpuSamplingFailed) {
    return failedCase(
      input,
      orderPolicy,
      cpuMs,
      'inconclusive',
      'sql_regression_cpu_measurement_unavailable',
      candidate,
      baseline,
    );
  }
  if (cpuMs > input.budget.maxCpuMs) {
    return failedCase(
      input,
      orderPolicy,
      cpuMs,
      'failed',
      'sql_regression_cpu_budget_exceeded',
      candidate,
      baseline,
    );
  }
  const oracle = evaluateOracle(
    input.item.expectation,
    baseline,
    candidate,
  );
  const resultBytes = serializedResultBytes(candidate);
  return {
    caseId: input.item.caseId,
    traceContentHash: input.item.traceContentHash,
    queryContentHash: canonicalContentHash(input.sql),
    baselineQueryContentHash: canonicalContentHash(input.baselineSql),
    baselineResultContentHash: resultContentHash(baseline, orderPolicy),
    candidateResultContentHash: resultContentHash(candidate, orderPolicy),
    oracleContentHash: oracle.contentHash,
    orderPolicy,
    rowCount: candidate.rows.length,
    columns: [...candidate.columns],
    durationMs: baseline.durationMs + candidate.durationMs,
    traceProcessorCpuMs: cpuMs,
    resultBytes,
    verdict: oracle.passed ? 'passed' : 'failed',
    ...(oracle.passed ? {} : {reasonCode: oracle.reasonCode}),
  };
}

function evaluateOracle(
  expectation: CatalogExpectation,
  baseline: QueryResult,
  candidate: QueryResult,
): {passed: boolean; reasonCode?: string; contentHash: string} {
  const assertions = expectation.assertions ?? [];
  const baselineResultContentHash = resultContentHash(
    baseline,
    'canonical_row_sort',
  );
  const candidateResultContentHash = resultContentHash(
    candidate,
    'canonical_row_sort',
  );
  const minimumRows = Math.max(
    expectation.min_rows ?? 0,
    baseline.rows.length > 0 ? 1 : 0,
  );
  let reasonCode: string | undefined;
  if (
    canonicalJsonString(candidate.columns)
      !== canonicalJsonString(baseline.columns)
  ) {
    reasonCode = 'sql_regression_column_contract_changed';
  } else if (candidate.rows.length < minimumRows) {
    reasonCode = 'sql_regression_minimum_rows_not_met';
  } else if (
    assertions.length === 0
    && candidateResultContentHash !== baselineResultContentHash
  ) {
    reasonCode = 'sql_regression_result_changed';
  } else {
    reasonCode = evaluateTypedAssertions(
      assertions,
      candidate,
    );
  }
  const receipt = {
    oracleKind: assertions.length > 0
      ? 'catalog_typed_assertions_v1'
      : 'baseline_exact_result_v1',
    expectationId: expectation.id,
    minimumRows,
    baselineColumns: baseline.columns,
    candidateColumns: candidate.columns,
    baselineResultContentHash,
    candidateResultContentHash,
    assertions,
    passed: reasonCode === undefined,
    ...(reasonCode ? {reasonCode} : {}),
  };
  return {
    passed: reasonCode === undefined,
    ...(reasonCode ? {reasonCode} : {}),
    contentHash: canonicalContentHash(receipt),
  };
}

function evaluateTypedAssertions(
  assertions: readonly CatalogAssertion[],
  result: QueryResult,
): string | undefined {
  for (const assertion of assertions) {
    const columnIndex = result.columns.indexOf(assertion.column);
    if (columnIndex < 0) return 'sql_regression_assertion_column_missing';
    const values = result.rows.map(row => row[columnIndex]);
    if (
      assertion.operator === 'contains'
      && !values.some(value =>
        String(value).includes(String(assertion.value)))
    ) {
      return 'sql_regression_contains_assertion_failed';
    }
    if (
      assertion.operator === 'gte'
      && !values.some(value =>
        typeof value === 'number'
        && typeof assertion.value === 'number'
        && value >= assertion.value)
    ) {
      return 'sql_regression_gte_assertion_failed';
    }
  }
  return undefined;
}

function failedCase(
  input: {
    item: ManagedCase;
    sql: string;
    baselineSql: string;
  },
  orderPolicy: 'sql_order_by' | 'canonical_row_sort',
  cpuMs: number,
  verdict: 'failed' | 'inconclusive',
  reasonCode: string,
  candidate?: QueryResult,
  baseline?: QueryResult,
): ProposalSqlRegressionProofV1['cases'][number] {
  const fallback = {columns: [], rows: [], durationMs: 0};
  const baselineResult = baseline ?? fallback;
  const candidateResult = candidate ?? fallback;
  return {
    caseId: input.item.caseId,
    traceContentHash: input.item.traceContentHash,
    queryContentHash: canonicalContentHash(input.sql),
    baselineQueryContentHash: canonicalContentHash(input.baselineSql),
    baselineResultContentHash: resultContentHash(
      baselineResult,
      orderPolicy,
    ),
    candidateResultContentHash: resultContentHash(
      candidateResult,
      orderPolicy,
    ),
    oracleContentHash: canonicalContentHash({
      expectation: input.item.expectation,
      reasonCode,
    }),
    orderPolicy,
    rowCount: candidateResult.rows.length,
    columns: [...candidateResult.columns],
    durationMs: baselineResult.durationMs + candidateResult.durationMs,
    traceProcessorCpuMs: cpuMs,
    resultBytes: serializedResultBytes(candidateResult),
    verdict,
    reasonCode,
  };
}

function resolveManagedCases(
  repoRoot: string,
  proposal: CurationProposalV1,
): ManagedCase[] {
  const catalogPath = path.join(repoRoot, 'Trace/catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    cases: CatalogCase[];
  };
  const delta = proposal.deltas[0];
  const selected = catalog.cases
    .filter(entry => entry.kind === 'constructed')
    .flatMap(entry => (entry.coverage?.expectations ?? [])
      .filter(expectation =>
        expectation.type === 'skill'
        && expectation.target === delta.targetId
        && (
          expectation.semantic_step === delta.operationId
          || expectation.required_sql_steps?.includes(delta.operationId)
        ))
      .map(expectation => ({entry, expectation})))
    .sort((left, right) =>
      oraclePriority(left.expectation) - oraclePriority(right.expectation)
      || left.entry.id.localeCompare(right.entry.id))
    .slice(0, MAX_CASES);
  if (selected.length === 0) {
    throw new Error('proposal_sql_regression_coverage_unavailable');
  }
  return selected.map(({entry, expectation}) => {
    if (!entry.construction?.output) {
      throw new Error('proposal_sql_regression_case_not_managed');
    }
    if (expectation.source_file) {
      resolveManagedFile(repoRoot, expectation.source_file);
    }
    const tracePath = path.resolve(repoRoot, entry.construction.output);
    const managedRoot = fs.realpathSync.native(
      path.join(repoRoot, 'Trace/.generated/constructed'),
    );
    const traceRealpath = fs.realpathSync.native(tracePath);
    if (!isWithin(managedRoot, traceRealpath)) {
      throw new Error('proposal_sql_regression_trace_escape');
    }
    const traceContentHash = sha256File(traceRealpath);
    const provenance = JSON.parse(fs.readFileSync(
      path.join(path.dirname(traceRealpath), 'build-provenance.json'),
      'utf8',
    )) as ConstructedTraceProvenance;
    const base = catalog.cases.find(item =>
      item.id === entry.construction!.base_case_id && item.kind === 'real');
    if (!base) throw new Error('proposal_sql_regression_base_case_missing');
    const basePath = resolveManagedFile(
      repoRoot,
      path.join(base.case_dir, base.trace.file),
    );
    const overlayPath = resolveManagedFile(
      repoRoot,
      path.join(entry.case_dir, entry.trace.file),
    );
    const baseHash = sha256File(basePath);
    const overlayHash = sha256File(overlayPath);
    const expectedOutputHash = sha256Files([basePath, overlayPath]);
    if (
      provenance.schema_version !== 1
      || provenance.case_id !== entry.id
      || provenance.base_case_id !== entry.construction.base_case_id
      || baseHash !== base.trace.sha256
      || overlayHash !== entry.trace.sha256
      || provenance.overlay_sha256 !== overlayHash
      || provenance.base_sha256 !== baseHash
      || expectedOutputHash !== traceContentHash
      || provenance.output_sha256 !== traceContentHash
    ) {
      throw new Error('proposal_sql_regression_trace_hash_mismatch');
    }
    return {
      caseId: entry.id,
      tracePath: traceRealpath,
      traceContentHash,
      sourceContentHash: canonicalContentHash({
        baseHash,
        overlayHash,
        outputHash: traceContentHash,
        provenance,
        expectation,
      }),
      expectation,
    };
  });
}

function oraclePriority(expectation: CatalogExpectation): number {
  if (expectation.mode === 'semantic') return 0;
  if (expectation.mode === 'execution') return 1;
  if (expectation.mode === 'graceful_empty') return 2;
  return 3;
}

function resultContentHash(
  result: Pick<QueryResult, 'columns' | 'rows'>,
  orderPolicy: 'sql_order_by' | 'canonical_row_sort',
): string {
  const rows = orderPolicy === 'sql_order_by'
    ? result.rows
    : [...result.rows].sort((left, right) =>
      canonicalJsonString(left).localeCompare(canonicalJsonString(right)));
  return canonicalContentHash({columns: result.columns, rows});
}

function serializedResultBytes(
  result: Pick<QueryResult, 'columns' | 'rows'>,
): number {
  return Buffer.byteLength(canonicalJsonString({
    columns: result.columns,
    rows: result.rows,
  }), 'utf8');
}

function hasSqlOrderBy(sql: string): boolean {
  return /\border\s+by\b/i.test(sql);
}

function readTraceProcessorVersion(repoRoot: string): string {
  const pinPath = path.join(repoRoot, 'scripts/trace-processor-pin.env');
  const match = /^PERFETTO_VERSION=(\S+)$/m.exec(
    fs.readFileSync(pinPath, 'utf8'),
  );
  if (!match) throw new Error('proposal_sql_regression_version_missing');
  return match[1];
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Files(filePaths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const filePath of filePaths) hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function resolveManagedFile(repoRoot: string, relativePath: string): string {
  const allowedRoots = [
    fs.realpathSync.native(path.join(repoRoot, 'Trace')),
    fs.realpathSync.native(path.join(repoRoot, 'backend')),
  ];
  const realpath = fs.realpathSync.native(path.resolve(repoRoot, relativePath));
  if (!allowedRoots.some(root => isWithin(root, realpath))) {
    throw new Error('proposal_sql_regression_trace_escape');
  }
  return realpath;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return `sql_regression_${error.code.toLowerCase()}`;
  }
  return 'sql_regression_execution_failed';
}

export const proposalSqlRegressionTesting = {
  evaluateOracle,
};

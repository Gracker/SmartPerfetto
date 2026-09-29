// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Plan 51 first slice — authenticated CI gate evaluation entry point
 * + persistent run audit log.
 *
 * Endpoints (mounted under `/api/ci`, `authenticate` applied at the
 * mount site so every verb requires a valid bearer/API key when one
 * is configured):
 *   POST /gate-eval            evaluate + persist a run
 *   GET  /gate-runs/:runId     fetch a persisted run
 *   GET  /gate-runs            list with optional filters
 *
 * Why a new entry point rather than reusing `compare_baselines` /
 * `baselineRoutes`: that surface is agent-facing and transient. A CI
 * caller needs auth + a stable `runId` so downstream IM/Bug/PR
 * adapters have a durable anchor to reference. Records for missing or
 * non-published baselines are still persisted with `status='skipped'`
 * + a concrete `skipReason` so the audit trail stays continuous —
 * silent 404s would leave gates without a paper trail.
 */

import * as crypto from 'crypto';

import {Router, type Router as ExpressRouter} from 'express';

import {requireRequestContext} from '../middleware/auth';
import {
  computeBaselineDiff,
  evaluateRegressionGate,
  type DiffCandidate,
  type RegressionRule,
} from '../services/baselineDiffer';
import {BaselineStore} from '../services/baselineStore';
import {CiGateRunStore} from '../services/ciGateRunStore';
import {
  type KnowledgeScope,
  knowledgeScopeFromRequestContext,
} from '../services/scopedKnowledgeStore';
import type {
  CiGateRunCandidateSnapshot,
  CiGateRunRecord,
} from '../types/ciGateContracts';
import {
  type BaselineMetric,
  type BaselineRecord,
  type RegressionGateResult,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';

const MAX_CI_SOURCE_LEN = 64;
// Allow `/`, `:`, and `@` so qualified provider names common in CI
// systems (`org/repo`, `github.com/org/repo-ci`, `@org/pipeline`) are
// accepted. Whitespace and control chars stay rejected so the value is
// safe to log and to use as an SQLite filter column.
const CI_SOURCE_PATTERN = /^[a-zA-Z0-9_./@:-]+$/;

interface EvalBody {
  gateId?: unknown;
  baselineId?: unknown;
  candidate?: unknown;
  rules?: unknown;
  ciSource?: unknown;
  ciContext?: unknown;
}

interface ResolvedCandidate {
  snapshot: CiGateRunCandidateSnapshot;
  /**
   * For `kind='baseline'`, the already-fetched `BaselineRecord` so the
   * route does not re-query the store and risk a TOCTOU between
   * validation and use.
   */
  baselineRecord?: BaselineRecord;
}

let cachedBaselineStore: BaselineStore | null = null;
let cachedRunStore: CiGateRunStore | null = null;

function getDefaultBaselineStore(): BaselineStore {
  if (!cachedBaselineStore) {
    cachedBaselineStore = new BaselineStore(backendLogPath('baselines.json'));
  }
  return cachedBaselineStore;
}

function getDefaultRunStore(): CiGateRunStore {
  if (!cachedRunStore) cachedRunStore = new CiGateRunStore();
  return cachedRunStore;
}

export interface CiGateRoutesDeps {
  baselineStore?: BaselineStore;
  runStore?: CiGateRunStore;
}

export function createCiGateRoutes(deps: CiGateRoutesDeps = {}): ExpressRouter {
  // Resolve default stores lazily inside each handler so a bare module
  // import (e.g. by a test that injects its own deps) does not trigger
  // the production sqlite mkdir + connection on module load.
  const resolveBaselineStore = () =>
    deps.baselineStore ?? getDefaultBaselineStore();
  const resolveRunStore = () => deps.runStore ?? getDefaultRunStore();
  const router = Router();

  router.post('/gate-eval', (req, res) => {
    const baselineStore = resolveBaselineStore();
    const runStore = resolveRunStore();
    const storageScope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const body = (req.body ?? {}) as EvalBody;

    const gateId = stringField(body.gateId);
    const baselineId = stringField(body.baselineId);
    const ciSource = stringField(body.ciSource);

    if (!gateId || !baselineId || !ciSource) {
      return res.status(400).json({
        success: false,
        error: 'gateId, baselineId, and ciSource are required strings',
      });
    }
    if (
      ciSource.length > MAX_CI_SOURCE_LEN ||
      !CI_SOURCE_PATTERN.test(ciSource)
    ) {
      return res.status(400).json({
        success: false,
        error:
          'ciSource must match /^[a-zA-Z0-9_.-]+$/ and be at most 64 chars',
      });
    }

    const rules = parseRules(body.rules);
    if (!rules) {
      return res.status(400).json({
        success: false,
        error: 'rules must be a non-empty array of {metricId, threshold} objects',
      });
    }

    const candidateOrError = parseCandidate(
      body.candidate,
      baselineStore,
      storageScope,
    );
    if ('error' in candidateOrError) {
      return res
        .status(400)
        .json({success: false, error: candidateOrError.error});
    }
    const candidate = candidateOrError.candidate;
    const ciContext = parseCiContext(body.ciContext);

    const baseline = baselineStore.getBaseline(baselineId, storageScope);

    if (!baseline) {
      const skipped = makeSkippedRun({
        runId: makeRunId(),
        gateId,
        baselineId,
        baselineStatus: 'draft',
        ciSource,
        ciContext,
        authSubject: subjectFromReq(req),
        candidateSnapshot: candidate.snapshot,
        rulesSnapshot: rules,
        skipReason: 'baseline_not_found',
      });
      runStore.recordRun(skipped);
      return res.status(200).json({
        success: true,
        runId: skipped.runId,
        result: skipped.result,
        skipReason: skipped.skipReason,
      });
    }

    if (baseline.status !== 'published') {
      const skipped = makeSkippedRun({
        runId: makeRunId(),
        gateId,
        baselineId,
        baselineStatus: baseline.status,
        ciSource,
        ciContext,
        authSubject: subjectFromReq(req),
        candidateSnapshot: candidate.snapshot,
        rulesSnapshot: rules,
        skipReason: `baseline_status_${baseline.status}`,
      });
      runStore.recordRun(skipped);
      return res.status(200).json({
        success: true,
        runId: skipped.runId,
        result: skipped.result,
        skipReason: skipped.skipReason,
      });
    }

    const diffCandidate: DiffCandidate =
      candidate.snapshot.kind === 'trace'
        ? {
            kind: 'trace',
            traceId: candidate.snapshot.traceId ?? 'inline',
            metrics: candidate.snapshot.metrics,
          }
        : candidate.baselineRecord!;

    const diff = computeBaselineDiff(baseline, diffCandidate);

    const knownMetricIds = new Set(diff.deltas.map(d => d.metricId));
    const ruleHasUnknownMetric = rules.some(
      r => !knownMetricIds.has(r.metricId),
    );

    // evaluateRegressionGate silently skips rules that point at metrics
    // not in the diff (baselineDiffer.ts line 343–345). Without an
    // override, a rule that only mentions an unknown metric would
    // resolve to 'pass' — exactly the silent-pass trap Codex flagged.
    // Promote 'pass' to 'flaky' in that case so the CI surface
    // signals the gate's lack of confidence.
    const rawResult = evaluateRegressionGate(baselineId, diff, rules, {
      gateId,
    });
    const finalResult: RegressionGateResult =
      ruleHasUnknownMetric && rawResult.status === 'pass'
        ? {...rawResult, status: 'flaky'}
        : rawResult;

    const runId = makeRunId();
    const authSubject = subjectFromReq(req);
    const record: CiGateRunRecord = {
      ...makeSparkProvenance({source: 'ciGateRoutes.gateEval'}),
      schemaVersion: 1,
      runId,
      gateId,
      baselineId,
      baselineStatus: baseline.status,
      ciSource,
      ...(ciContext ? {ciContext} : {}),
      ...(authSubject ? {authSubject} : {}),
      candidateSnapshot: candidate.snapshot,
      rulesSnapshot: rules,
      result: finalResult,
      createdAt: Date.now(),
    };
    runStore.recordRun(record);

    return res.status(200).json({success: true, runId, result: finalResult});
  });

  router.get('/gate-runs/:runId', (req, res) => {
    const runStore = resolveRunStore();
    const run = runStore.getRun(req.params.runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        error: `Gate run '${req.params.runId}' not found`,
      });
    }
    return res.json({success: true, run});
  });

  router.get('/gate-runs', (req, res) => {
    const runStore = resolveRunStore();
    const {gateId, status, ciSource, limit} = req.query as {
      gateId?: string;
      status?: string;
      ciSource?: string;
      limit?: string;
    };
    const runs = runStore.listRuns({
      gateId,
      status: status as CiGateRunRecord['result']['status'] | undefined,
      ciSource,
      limit: limit ? Number(limit) : undefined,
    });
    return res.json({success: true, runs, count: runs.length});
  });

  return router;
}

function makeRunId(): string {
  return `gate-run-${crypto.randomUUID()}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function parseRules(value: unknown): RegressionRule[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parsed: RegressionRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const metricId = stringField(r.metricId);
    const threshold = typeof r.threshold === 'number' ? r.threshold : NaN;
    if (!metricId || !Number.isFinite(threshold)) return undefined;
    const rule: RegressionRule = {metricId, threshold};
    if (typeof r.expectIncrease === 'boolean') {
      rule.expectIncrease = r.expectIncrease;
    }
    parsed.push(rule);
  }
  return parsed;
}

function parseCandidate(
  value: unknown,
  baselineStore: BaselineStore,
  storageScope?: KnowledgeScope,
):
  | {candidate: ResolvedCandidate}
  | {error: string} {
  if (!value || typeof value !== 'object') {
    return {error: 'candidate is required'};
  }
  const c = value as Record<string, unknown>;
  if (c.kind === 'trace') {
    if (!Array.isArray(c.metrics)) {
      return {error: "candidate.metrics is required for kind='trace'"};
    }
    const metrics = c.metrics as BaselineMetric[];
    const traceId = stringField(c.traceId);
    const sampleCount =
      typeof c.sampleCount === 'number' ? c.sampleCount : undefined;
    return {
      candidate: {
        snapshot: {
          kind: 'trace',
          metrics,
          ...(traceId ? {traceId} : {}),
          ...(sampleCount !== undefined ? {sampleCount} : {}),
        },
      },
    };
  }
  if (c.kind === 'baseline') {
    const candidateBaselineId = stringField(c.baselineId);
    if (!candidateBaselineId) {
      return {error: "candidate.baselineId is required for kind='baseline'"};
    }
    const candidateBaseline = baselineStore.getBaseline(
      candidateBaselineId,
      storageScope,
    );
    if (!candidateBaseline) {
      return {
        error: `candidate baseline '${candidateBaselineId}' not found`,
      };
    }
    return {
      candidate: {
        snapshot: {
          kind: 'baseline',
          baselineId: candidateBaselineId,
          metrics: candidateBaseline.metrics,
          sampleCount: candidateBaseline.sampleCount,
        },
        baselineRecord: candidateBaseline,
      },
    };
  }
  return {error: "candidate.kind must be 'baseline' or 'trace'"};
}

function parseCiContext(
  value: unknown,
): CiGateRunRecord['ciContext'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const key of ['repo', 'commit', 'workflow', 'runUrl'] as const) {
    const v = stringField(c[key]);
    if (v) out[key] = v;
  }
  if (typeof c.pr === 'number' && Number.isFinite(c.pr)) {
    out.pr = c.pr;
  }
  return Object.keys(out).length === 0
    ? undefined
    : (out as CiGateRunRecord['ciContext']);
}

function subjectFromReq(req: unknown): string | undefined {
  const user = (req as {user?: {id?: string}}).user;
  return user?.id;
}

interface SkippedRunInput {
  runId: string;
  gateId: string;
  baselineId: string;
  baselineStatus: BaselineRecord['status'];
  ciSource: string;
  ciContext?: CiGateRunRecord['ciContext'];
  authSubject?: string;
  candidateSnapshot: CiGateRunCandidateSnapshot;
  rulesSnapshot: RegressionRule[];
  skipReason: string;
}

function makeSkippedRun(input: SkippedRunInput): CiGateRunRecord {
  return {
    ...makeSparkProvenance({source: 'ciGateRoutes.skipped'}),
    schemaVersion: 1,
    runId: input.runId,
    gateId: input.gateId,
    baselineId: input.baselineId,
    baselineStatus: input.baselineStatus,
    ciSource: input.ciSource,
    ...(input.ciContext ? {ciContext: input.ciContext} : {}),
    ...(input.authSubject ? {authSubject: input.authSubject} : {}),
    candidateSnapshot: input.candidateSnapshot,
    rulesSnapshot: input.rulesSnapshot,
    result: {
      ...makeSparkProvenance({source: 'ciGateRoutes.skipped.gate'}),
      gateId: input.gateId,
      baselineId: input.baselineId,
      status: 'skipped',
      skipReason: input.skipReason,
    },
    skipReason: input.skipReason,
    createdAt: Date.now(),
  };
}

const ciGateRoutes = createCiGateRoutes();
export default ciGateRoutes;

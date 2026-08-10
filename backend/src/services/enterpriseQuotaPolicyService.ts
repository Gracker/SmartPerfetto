// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import { resolveFeatureConfig } from '../config';
import type { RequestContext } from '../middleware/auth';
import { openEnterpriseDb } from './enterpriseDb';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';

export type EnterpriseQuotaDecisionCode =
  | 'OK'
  | 'TRACE_SIZE_QUOTA_EXCEEDED'
  | 'WORKSPACE_TRACE_STORAGE_QUOTA_EXCEEDED'
  | 'CONCURRENT_RUN_QUOTA_EXCEEDED'
  | 'MONTHLY_RUN_QUOTA_EXCEEDED';

export type EnterpriseQuotaDecisionStatus =
  | 'allowed'
  | 'pending'
  | 'quota_exceeded';

export interface WorkspaceQuotaPolicy {
  maxTraceBytes?: number;
  maxWorkspaceTraceBytes?: number;
  maxConcurrentRuns?: number;
  monthlyRunLimit?: number;
}

export interface WorkspaceRetentionPolicy {
  defaultRetentionDays?: number;
  traceRetentionDays?: number;
  reportRetentionDays?: number;
}

export interface WorkspaceEnterprisePolicies {
  quotaPolicy: WorkspaceQuotaPolicy;
  retentionPolicy: WorkspaceRetentionPolicy;
}

export interface EnterpriseQuotaDecision {
  allowed: boolean;
  code: EnterpriseQuotaDecisionCode;
  status: EnterpriseQuotaDecisionStatus;
  httpStatus: number;
  message: string;
  details: Record<string, number | string | boolean>;
}

interface WorkspacePolicyRow {
  quota_policy: string | null;
  retention_policy: string | null;
}

interface CountRow {
  count: number;
}

interface SumRow {
  total: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'awaiting_user'] as const;

function allowedDecision(): EnterpriseQuotaDecision {
  return {
    allowed: true,
    code: 'OK',
    status: 'allowed',
    httpStatus: 200,
    message: 'Allowed',
    details: {},
  };
}

function denyDecision(
  code: Exclude<EnterpriseQuotaDecisionCode, 'OK'>,
  status: Exclude<EnterpriseQuotaDecisionStatus, 'allowed'>,
  httpStatus: number,
  message: string,
  details: Record<string, number | string | boolean>,
): EnterpriseQuotaDecision {
  return {
    allowed: false,
    code,
    status,
    httpStatus,
    message,
    details,
  };
}

function parseObjectJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizeQuotaPolicy(raw: Record<string, unknown>): WorkspaceQuotaPolicy {
  return {
    maxTraceBytes: nonNegativeInteger(raw.maxTraceBytes),
    maxWorkspaceTraceBytes: nonNegativeInteger(raw.maxWorkspaceTraceBytes),
    maxConcurrentRuns: nonNegativeInteger(raw.maxConcurrentRuns),
    monthlyRunLimit: nonNegativeInteger(raw.monthlyRunLimit),
  };
}

function normalizeRetentionPolicy(raw: Record<string, unknown>): WorkspaceRetentionPolicy {
  return {
    defaultRetentionDays: nonNegativeInteger(raw.defaultRetentionDays),
    traceRetentionDays: nonNegativeInteger(raw.traceRetentionDays),
    reportRetentionDays: nonNegativeInteger(raw.reportRetentionDays),
  };
}

function monthStartMs(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function workspaceTraceBytes(db: Database.Database, scope: EnterpriseRepositoryScope, now: number): number {
  const row = db.prepare<unknown[], SumRow>(`
    SELECT COALESCE(SUM(size_bytes), 0) AS total
    FROM trace_assets
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND status <> 'deleted'
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(scope.tenantId, scope.workspaceId, now);
  return row?.total ?? 0;
}

function activeRunCount(
  db: Database.Database,
  scope: EnterpriseRepositoryScope,
  replacingRunId?: string,
): number {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
  const replacementClause = replacingRunId ? 'AND id <> ?' : '';
  const row = db.prepare<unknown[], CountRow>(`
    SELECT COUNT(*) AS count
    FROM analysis_runs
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND status IN (${placeholders})
      -- Conversation clarification preserves logical session continuity after
      -- its physical run has settled, so it must not consume a run slot.
      AND NOT (mode = 'conversation' AND status = 'awaiting_user')
      ${replacementClause}
  `).get(
    scope.tenantId,
    scope.workspaceId,
    ...ACTIVE_RUN_STATUSES,
    ...(replacingRunId ? [replacingRunId] : []),
  );
  return row?.count ?? 0;
}

function monthlyRunCount(db: Database.Database, scope: EnterpriseRepositoryScope, now: number): number {
  const row = db.prepare<unknown[], CountRow>(`
    SELECT COUNT(*) AS count
    FROM analysis_runs
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND started_at >= ?
  `).get(scope.tenantId, scope.workspaceId, monthStartMs(now));
  return row?.count ?? 0;
}

export function readWorkspaceEnterprisePolicies(
  db: Database.Database,
  scope: EnterpriseRepositoryScope,
): WorkspaceEnterprisePolicies {
  const row = db.prepare<unknown[], WorkspacePolicyRow>(`
    SELECT quota_policy, retention_policy
    FROM workspaces
    WHERE tenant_id = ?
      AND id = ?
    LIMIT 1
  `).get(scope.tenantId, scope.workspaceId);
  return {
    quotaPolicy: normalizeQuotaPolicy(parseObjectJson(row?.quota_policy ?? null)),
    retentionPolicy: normalizeRetentionPolicy(parseObjectJson(row?.retention_policy ?? null)),
  };
}

export function resolveEnterpriseRetentionExpiresAt(
  db: Database.Database,
  scope: EnterpriseRepositoryScope,
  artifactType: 'trace' | 'report',
  createdAt: number,
): number | null {
  const { retentionPolicy } = readWorkspaceEnterprisePolicies(db, scope);
  const days = artifactType === 'trace'
    ? retentionPolicy.traceRetentionDays ?? retentionPolicy.defaultRetentionDays
    : retentionPolicy.reportRetentionDays ?? retentionPolicy.defaultRetentionDays;
  if (days === undefined) return null;
  return createdAt + days * DAY_MS;
}

export function evaluateTraceUploadQuota(
  context: RequestContext,
  sizeBytes: number,
  options: { now?: number } = {},
): EnterpriseQuotaDecision {
  if (!resolveFeatureConfig().enterprise) return allowedDecision();
  const now = options.now ?? Date.now();
  const requestedBytes = Math.max(0, Math.floor(sizeBytes));
  const db = openEnterpriseDb();
  try {
    const scope = {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      userId: context.userId,
    };
    const { quotaPolicy } = readWorkspaceEnterprisePolicies(db, scope);
    if (quotaPolicy.maxTraceBytes !== undefined && requestedBytes > quotaPolicy.maxTraceBytes) {
      return denyDecision(
        'TRACE_SIZE_QUOTA_EXCEEDED',
        'quota_exceeded',
        413,
        'Trace upload exceeds workspace per-trace quota',
        {
          requestedBytes,
          limitBytes: quotaPolicy.maxTraceBytes,
        },
      );
    }

    if (quotaPolicy.maxWorkspaceTraceBytes !== undefined) {
      const currentBytes = workspaceTraceBytes(db, scope, now);
      if (currentBytes + requestedBytes > quotaPolicy.maxWorkspaceTraceBytes) {
        return denyDecision(
          'WORKSPACE_TRACE_STORAGE_QUOTA_EXCEEDED',
          'quota_exceeded',
          409,
          'Trace upload exceeds workspace trace storage quota',
          {
            currentBytes,
            requestedBytes,
            limitBytes: quotaPolicy.maxWorkspaceTraceBytes,
          },
        );
      }
    }

    return allowedDecision();
  } finally {
    db.close();
  }
}

export function evaluateAnalysisRunQuota(
  context: RequestContext,
  options: { now?: number; replacingRunId?: string } = {},
): EnterpriseQuotaDecision {
  if (!resolveFeatureConfig().enterprise) return allowedDecision();
  const now = options.now ?? Date.now();
  const db = openEnterpriseDb();
  try {
    const scope = {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      userId: context.userId,
    };
    const { quotaPolicy } = readWorkspaceEnterprisePolicies(db, scope);

    if (quotaPolicy.monthlyRunLimit !== undefined) {
      const usedRuns = monthlyRunCount(db, scope, now);
      if (usedRuns >= quotaPolicy.monthlyRunLimit) {
        return denyDecision(
          'MONTHLY_RUN_QUOTA_EXCEEDED',
          'quota_exceeded',
          402,
          'Workspace monthly run quota is exhausted',
          {
            usedRuns,
            limitRuns: quotaPolicy.monthlyRunLimit,
            windowStartMs: monthStartMs(now),
          },
        );
      }
    }

    if (quotaPolicy.maxConcurrentRuns !== undefined) {
      const activeRuns = activeRunCount(db, scope, options.replacingRunId);
      if (activeRuns >= quotaPolicy.maxConcurrentRuns) {
        return denyDecision(
          'CONCURRENT_RUN_QUOTA_EXCEEDED',
          'pending',
          429,
          'Workspace concurrent run quota is full',
          {
            activeRuns,
            limitRuns: quotaPolicy.maxConcurrentRuns,
            queuePosition: activeRuns - quotaPolicy.maxConcurrentRuns + 1,
          },
        );
      }
    }

    return allowedDecision();
  } finally {
    db.close();
  }
}

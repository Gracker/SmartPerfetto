// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import type { RequestContext } from '../../middleware/auth';
import {
  ENTERPRISE_DB_PATH_ENV,
  openEnterpriseDb,
} from '../enterpriseDb';
import {
  evaluateAnalysisRunQuota,
  evaluateTraceUploadQuota,
  readWorkspaceEnterprisePolicies,
  resolveEnterpriseRetentionExpiresAt,
} from '../enterpriseQuotaPolicyService';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
};

let tmpDir: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function context(): RequestContext {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    roles: ['workspace_admin'],
    scopes: ['*'],
    authType: 'sso',
    requestId: 'req-test',
  };
}

function seedWorkspacePolicies(input: {
  quotaPolicy?: Record<string, unknown>;
  retentionPolicy?: Record<string, unknown>;
}): void {
  const db = openEnterpriseDb();
  const now = 1_777_000_000_000;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT OR REPLACE INTO workspaces
        (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
      VALUES
        ('workspace-a', 'tenant-a', 'workspace-a', ?, ?, ?, ?)
    `).run(
      input.retentionPolicy ? JSON.stringify(input.retentionPolicy) : null,
      input.quotaPolicy ? JSON.stringify(input.quotaPolicy) : null,
      now,
      now,
    );
    db.prepare(`
      INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('user-a', 'tenant-a', 'user-a@example.test', 'user-a', 'user-a', ?, ?)
    `).run(now, now);
  } finally {
    db.close();
  }
}

function seedAnalysisGraph(
  db: ReturnType<typeof openEnterpriseDb>,
  sessionId: string,
  traceId: string,
  now: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
    VALUES
      (?, 'tenant-a', 'workspace-a', 'user-a', ?, 0, 'metadata_only', '{}', ?)
  `).run(traceId, `/tmp/${traceId}.trace`, now);
  db.prepare(`
    INSERT OR IGNORE INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
    VALUES
      (?, 'tenant-a', 'workspace-a', ?, 'user-a', ?, 'private', 'running', ?, ?)
  `).run(sessionId, traceId, sessionId, now, now);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-quota-'));
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
});

afterEach(async () => {
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise quota and retention policy service', () => {
  it('reads workspace policy JSON and resolves artifact retention expiry', () => {
    seedWorkspacePolicies({
      quotaPolicy: { maxTraceBytes: 1024 },
      retentionPolicy: { traceRetentionDays: 7, reportRetentionDays: 30 },
    });

    const db = openEnterpriseDb();
    try {
      const policies = readWorkspaceEnterprisePolicies(db, context());
      expect(policies.quotaPolicy.maxTraceBytes).toBe(1024);
      expect(resolveEnterpriseRetentionExpiresAt(db, context(), 'trace', 1000)).toBe(1000 + 7 * 24 * 60 * 60 * 1000);
      expect(resolveEnterpriseRetentionExpiresAt(db, context(), 'report', 1000)).toBe(1000 + 30 * 24 * 60 * 60 * 1000);
    } finally {
      db.close();
    }
  });

  it('rejects trace uploads that exceed per-file or workspace storage quota', () => {
    seedWorkspacePolicies({
      quotaPolicy: {
        maxTraceBytes: 100,
        maxWorkspaceTraceBytes: 150,
      },
    });

    let db = openEnterpriseDb();
    try {
      db.prepare(`
        INSERT INTO trace_assets
          (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
        VALUES
          ('existing', 'tenant-a', 'workspace-a', 'user-a', '/tmp/existing.trace', 80, 'ready', '{}', ?)
      `).run(1_777_000_000_000);
    } finally {
      db.close();
    }

    expect(evaluateTraceUploadQuota(context(), 101)).toEqual(expect.objectContaining({
      allowed: false,
      code: 'TRACE_SIZE_QUOTA_EXCEEDED',
      status: 'quota_exceeded',
    }));
    expect(evaluateTraceUploadQuota(context(), 90)).toEqual(expect.objectContaining({
      allowed: false,
      code: 'WORKSPACE_TRACE_STORAGE_QUOTA_EXCEEDED',
      status: 'quota_exceeded',
    }));
    expect(evaluateTraceUploadQuota(context(), 70)).toEqual(expect.objectContaining({
      allowed: true,
      code: 'OK',
    }));

    db = openEnterpriseDb();
    try {
      db.prepare(`
        UPDATE trace_assets
        SET expires_at = ?
        WHERE id = 'existing'
      `).run(Date.now() - 1);
    } finally {
      db.close();
    }
    expect(evaluateTraceUploadQuota(context(), 90)).toEqual(expect.objectContaining({
      allowed: true,
      code: 'OK',
    }));
  });

  it('separates concurrent-run pending from monthly quota_exceeded preflight', () => {
    seedWorkspacePolicies({
      quotaPolicy: {
        maxConcurrentRuns: 1,
        monthlyRunLimit: 2,
      },
    });
    const now = Date.UTC(2026, 4, 8);

    const db = openEnterpriseDb();
    try {
      seedAnalysisGraph(db, 'session-active', 'trace-active', now);
      db.prepare(`
        INSERT INTO analysis_runs
          (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
        VALUES
          ('run-active', 'tenant-a', 'workspace-a', 'session-active', 'agent', 'running', '', ?)
      `).run(now);
    } finally {
      db.close();
    }

    expect(evaluateAnalysisRunQuota(context(), { now })).toEqual(expect.objectContaining({
      allowed: false,
      code: 'CONCURRENT_RUN_QUOTA_EXCEEDED',
      status: 'pending',
    }));
    expect(evaluateAnalysisRunQuota(context(), {
      now,
      replacingRunId: 'run-active',
    })).toEqual(expect.objectContaining({
      allowed: true,
      code: 'OK',
    }));

    const db2 = openEnterpriseDb();
    try {
      db2.prepare(`DELETE FROM analysis_runs`).run();
      for (const id of ['run-a', 'run-b']) {
        seedAnalysisGraph(db2, `session-${id}`, `trace-${id}`, now);
        db2.prepare(`
          INSERT INTO analysis_runs
            (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
          VALUES
            (?, 'tenant-a', 'workspace-a', ?, 'agent', 'completed', '', ?)
        `).run(id, `session-${id}`, now);
      }
    } finally {
      db2.close();
    }

    expect(evaluateAnalysisRunQuota(context(), { now })).toEqual(expect.objectContaining({
      allowed: false,
      code: 'MONTHLY_RUN_QUOTA_EXCEEDED',
      status: 'quota_exceeded',
    }));
  });

  it('does not count a conversation awaiting clarification as a concurrent run', () => {
    seedWorkspacePolicies({
      quotaPolicy: { maxConcurrentRuns: 1 },
    });
    const now = Date.UTC(2026, 4, 8);
    const db = openEnterpriseDb();
    try {
      seedAnalysisGraph(db, 'conversation-session', 'conversation-trace', now);
      db.prepare(`
        INSERT INTO analysis_runs
          (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
        VALUES
          ('conversation-run', 'tenant-a', 'workspace-a', 'conversation-session',
           'conversation', 'awaiting_user', '', ?)
      `).run(now);
    } finally {
      db.close();
    }

    expect(evaluateAnalysisRunQuota(context(), { now })).toEqual(expect.objectContaining({
      allowed: true,
      code: 'OK',
    }));

    const db2 = openEnterpriseDb();
    try {
      db2.prepare(`
        UPDATE analysis_runs
        SET mode = 'agent'
        WHERE id = 'conversation-run'
      `).run();
    } finally {
      db2.close();
    }

    expect(evaluateAnalysisRunQuota(context(), { now })).toEqual(expect.objectContaining({
      allowed: false,
      code: 'CONCURRENT_RUN_QUOTA_EXCEEDED',
    }));
  });
});

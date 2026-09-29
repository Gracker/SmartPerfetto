// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ENTERPRISE_DB_PATH_ENV,
  openEnterpriseDb,
} from '../enterpriseDb';
import {
  getAnalysisRunLifecycle,
  failInterruptedAnalysisRunsOnStartup,
  heartbeatAnalysisRun,
  isAnalysisRunHeartbeatFresh,
  persistAnalysisRunState,
  resetAnalysisRunStoreForTests,
  type AnalysisRunPersistenceScope,
} from '../analysisRunStore';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
let tmpDir: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function scope(overrides: Partial<AnalysisRunPersistenceScope> = {}): AnalysisRunPersistenceScope {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    sessionId: 'session-a',
    runId: 'run-a',
    traceId: 'trace-a',
    query: 'why is this trace slow?',
    privateContext: NO_PRIVATE_CONTEXT,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-analysis-runs-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
});

afterEach(async () => {
  resetAnalysisRunStoreForTests();
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalDbPath);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('analysis run store', () => {
  it('creates missing user placeholders without replacing existing profile metadata on lifecycle writes', () => {
    const runScope = scope();
    persistAnalysisRunState(runScope, 'pending', {now: 1000});
    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT email, display_name, updated_at FROM users WHERE id = ?').get(runScope.userId))
        .toEqual({email: 'user-a@analysis-run.local', display_name: 'user-a', updated_at: 1000});
      db.prepare('UPDATE users SET email = ?, display_name = ?, updated_at = ? WHERE id = ?')
        .run('real@example.test', 'Real profile', 1500, runScope.userId);
      for (const status of ['pending', 'running', 'completed'] as const) {
        persistAnalysisRunState(runScope, status, {now: 2000});
        expect(db.prepare('SELECT email, display_name, updated_at FROM users WHERE id = ?').get(runScope.userId))
          .toEqual({email: 'real@example.test', display_name: 'Real profile', updated_at: 1500});
      }
      heartbeatAnalysisRun(runScope, 3000);
      expect(db.prepare('SELECT email, display_name, updated_at FROM users WHERE id = ?').get(runScope.userId))
        .toEqual({email: 'real@example.test', display_name: 'Real profile', updated_at: 1500});
    } finally { db.close(); }
  });

  it('fixes the private-context marker when the run row is created', () => {
    persistAnalysisRunState(scope({runId: 'run-private', privateContext: {codebase: true, knowledge: true}}), 'running');
    // A later writer, such as settling from a changed session selection, cannot rewrite it.
    persistAnalysisRunState(scope({runId: 'run-private', privateContext: NO_PRIVATE_CONTEXT}), 'completed');
    persistAnalysisRunState(scope({runId: 'run-public'}), 'completed');
    const db = openEnterpriseDb();
    try {
      const marker = (id: string) => db.prepare('SELECT private_context FROM analysis_runs WHERE id = ?').get(id);
      expect(marker('run-private')).toEqual({private_context: 3});
      expect(marker('run-public')).toEqual({private_context: 0});
    } finally {
      db.close();
    }
  });

  it('persists run lifecycle and heartbeat with workspace scope', () => {
    const runScope = scope();

    persistAnalysisRunState(runScope, 'running', { now: 1_777_000_000_000 });
    heartbeatAnalysisRun(runScope, 1_777_000_030_000);

    expect(getAnalysisRunLifecycle(runScope, 'run-a')).toEqual(expect.objectContaining({
      id: 'run-a',
      status: 'running',
      heartbeatAt: 1_777_000_030_000,
      updatedAt: 1_777_000_030_000,
      completedAt: null,
    }));
    expect(isAnalysisRunHeartbeatFresh(runScope, 'run-a', 1_777_000_040_000, 60_000)).toBe(true);
    expect(isAnalysisRunHeartbeatFresh(runScope, 'run-a', 1_777_000_200_000, 60_000)).toBe(false);
    expect(getAnalysisRunLifecycle(scope({ workspaceId: 'workspace-b' }), 'run-a')).toBeNull();

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status, heartbeat_at, updated_at FROM analysis_runs WHERE id = ?').get('run-a')).toEqual({
        status: 'running',
        heartbeat_at: 1_777_000_030_000,
        updated_at: 1_777_000_030_000,
      });
    } finally {
      db.close();
    }
  });

  it('reopens the enterprise DB handle when the configured DB path changes', async () => {
    const firstDbPath = process.env[ENTERPRISE_DB_PATH_ENV]!;
    const firstScope = scope({ runId: 'run-first', sessionId: 'session-first' });
    persistAnalysisRunState(firstScope, 'running', { now: 1_777_000_000_000 });

    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-reconnected.sqlite');
    const secondScope = scope({ runId: 'run-second', sessionId: 'session-second' });
    persistAnalysisRunState(secondScope, 'running', { now: 1_777_000_010_000 });

    expect(getAnalysisRunLifecycle(secondScope, 'run-second')).toEqual(expect.objectContaining({
      id: 'run-second',
      status: 'running',
    }));
    expect(getAnalysisRunLifecycle(firstScope, 'run-first')).toBeNull();

    const firstDb = openEnterpriseDb(firstDbPath);
    try {
      expect(firstDb.prepare('SELECT id, status FROM analysis_runs WHERE id = ?').get('run-first')).toEqual({
        id: 'run-first',
        status: 'running',
      });
      expect(firstDb.prepare('SELECT id FROM analysis_runs WHERE id = ?').get('run-second')).toBeUndefined();
    } finally {
      firstDb.close();
    }

    const secondDb = openEnterpriseDb(process.env[ENTERPRISE_DB_PATH_ENV]!);
    try {
      expect(secondDb.prepare('SELECT id, status FROM analysis_runs WHERE id = ?').get('run-second')).toEqual({
        id: 'run-second',
        status: 'running',
      });
    } finally {
      secondDb.close();
    }
  });

  it('marks terminal runs stale for cleanup decisions', () => {
    const runScope = scope({ runId: 'run-failed' });

    persistAnalysisRunState(runScope, 'running', { now: 1_777_000_000_000 });
    persistAnalysisRunState(runScope, 'failed', {
      now: 1_777_000_010_000,
      error: 'cancelled by user',
    });

    expect(getAnalysisRunLifecycle(runScope, 'run-failed')).toEqual(expect.objectContaining({
      status: 'failed',
      completedAt: 1_777_000_010_000,
      heartbeatAt: 1_777_000_010_000,
      errorJson: JSON.stringify({ message: 'cancelled by user' }),
    }));
    expect(isAnalysisRunHeartbeatFresh(runScope, 'run-failed', 1_777_000_011_000, 60_000)).toBe(false);
  });

  it('persists quota_exceeded as a terminal run and session state', () => {
    const runScope = scope({ runId: 'run-quota', sessionId: 'session-quota' });

    persistAnalysisRunState(runScope, 'running', { now: 1_777_000_000_000 });
    persistAnalysisRunState(runScope, 'quota_exceeded', {
      now: 1_777_000_010_000,
      error: 'single-run LLM budget exhausted',
    });

    expect(getAnalysisRunLifecycle(runScope, 'run-quota')).toEqual(expect.objectContaining({
      status: 'quota_exceeded',
      completedAt: 1_777_000_010_000,
      heartbeatAt: 1_777_000_010_000,
      errorJson: JSON.stringify({ message: 'single-run LLM budget exhausted' }),
    }));
    expect(isAnalysisRunHeartbeatFresh(runScope, 'run-quota', 1_777_000_011_000, 60_000)).toBe(false);

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-quota')).toEqual({
        status: 'quota_exceeded',
      });
    } finally {
      db.close();
    }
  });

  it('can preserve current session status when persisting a stale terminal run', () => {
    const firstRun = scope({ runId: 'run-first', sessionId: 'session-shared' });
    const secondRun = scope({ runId: 'run-second', sessionId: 'session-shared' });

    persistAnalysisRunState(firstRun, 'running', { now: 1_777_000_000_000 });
    persistAnalysisRunState(secondRun, 'running', { now: 1_777_000_001_000 });
    persistAnalysisRunState(firstRun, 'cancelled', {
      now: 1_777_000_002_000,
      error: 'cancelled by user',
      updateSessionStatus: false,
    });

    expect(getAnalysisRunLifecycle(firstRun, 'run-first')).toEqual(expect.objectContaining({
      status: 'cancelled',
      completedAt: 1_777_000_002_000,
    }));
    expect(getAnalysisRunLifecycle(secondRun, 'run-second')).toEqual(expect.objectContaining({
      status: 'running',
    }));

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-shared')).toEqual({
        status: 'running',
      });
    } finally {
      db.close();
    }
  });

  it('fails interrupted nonterminal runs on backend startup while preserving terminal runs', () => {
    const pendingScope = scope({ sessionId: 'session-pending', runId: 'run-pending' });
    const runningScope = scope({ sessionId: 'session-running', runId: 'run-running' });
    const awaitingScope = scope({ sessionId: 'session-awaiting', runId: 'run-awaiting' });
    const completedScope = scope({ sessionId: 'session-completed', runId: 'run-completed' });

    persistAnalysisRunState(pendingScope, 'pending', { now: 1_777_000_000_000 });
    persistAnalysisRunState(runningScope, 'running', { now: 1_777_000_001_000 });
    persistAnalysisRunState(awaitingScope, 'awaiting_user', { now: 1_777_000_002_000 });
    persistAnalysisRunState(completedScope, 'completed', { now: 1_777_000_003_000 });

    const recovered = failInterruptedAnalysisRunsOnStartup({
      now: 1_777_000_100_000,
      error: 'test restart',
    });

    expect(recovered.map(run => [run.id, run.previousStatus])).toEqual([
      ['run-pending', 'pending'],
      ['run-running', 'running'],
      ['run-awaiting', 'awaiting_user'],
    ]);
    expect(getAnalysisRunLifecycle(pendingScope, 'run-pending')).toEqual(expect.objectContaining({
      status: 'failed',
      completedAt: 1_777_000_100_000,
      errorJson: JSON.stringify({ message: 'test restart', source: 'backend_startup_recovery' }),
    }));
    expect(getAnalysisRunLifecycle(runningScope, 'run-running')?.status).toBe('failed');
    expect(getAnalysisRunLifecycle(awaitingScope, 'run-awaiting')?.status).toBe('failed');
    expect(getAnalysisRunLifecycle(completedScope, 'run-completed')?.status).toBe('completed');

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-running')).toEqual({
        status: 'failed',
      });
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-completed')).toEqual({
        status: 'completed',
      });
    } finally {
      db.close();
    }
  });
});

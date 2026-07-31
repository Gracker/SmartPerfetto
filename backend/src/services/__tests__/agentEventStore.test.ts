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
  listSerializedAgentEventsAfter,
  getLatestSerializedAgentEventByType,
  persistSerializedAgentEvent,
  resetAgentEventStoreForTests,
  type AgentEventPersistenceScope,
} from '../agentEventStore';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];

let tmpDir: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function scope(overrides: Partial<AgentEventPersistenceScope> = {}): AgentEventPersistenceScope {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    sessionId: 'session-a',
    runId: 'run-a',
    traceId: 'trace-a',
    query: 'why is this trace slow?',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-events-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
});

afterEach(async () => {
  resetAgentEventStoreForTests();
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalDbPath);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('agent event store', () => {
  it('persists replayable SSE events with workspace scope and terminal run status', () => {
    const eventScope = scope();

    persistSerializedAgentEvent(eventScope, {
      cursor: 1,
      eventType: 'progress',
      eventData: JSON.stringify({ type: 'progress', data: { phase: 'start' } }),
      createdAt: 1_777_000_000_000,
    });
    persistSerializedAgentEvent(eventScope, {
      cursor: 2,
      eventType: 'analysis_completed',
      eventData: JSON.stringify({ type: 'analysis_completed', data: { reportUrl: '/api/reports/report-a' } }),
      createdAt: 1_777_000_000_100,
    });
    persistSerializedAgentEvent(eventScope, {
      cursor: 2,
      eventType: 'analysis_completed',
      eventData: JSON.stringify({ duplicate: true }),
      createdAt: 1_777_000_000_200,
    });

    expect(listSerializedAgentEventsAfter(eventScope, 'run-a', 0)).toEqual([
      expect.objectContaining({ cursor: 1, eventType: 'progress' }),
      expect.objectContaining({ cursor: 2, eventType: 'analysis_completed' }),
    ]);
    expect(listSerializedAgentEventsAfter(eventScope, 'run-a', 1)).toEqual([
      expect.objectContaining({
        cursor: 2,
        eventData: expect.stringContaining('/api/reports/report-a'),
      }),
    ]);
    expect(listSerializedAgentEventsAfter(scope({ workspaceId: 'workspace-b' }), 'run-a', 0)).toEqual([]);
    expect(
      getLatestSerializedAgentEventByType(
        eventScope,
        'run-a',
        'analysis_completed',
      ),
    ).toEqual(expect.objectContaining({
      cursor: 2,
      eventType: 'analysis_completed',
    }));
    expect(
      getLatestSerializedAgentEventByType(
        scope({workspaceId: 'workspace-b'}),
        'run-a',
        'analysis_completed',
      ),
    ).toBeNull();

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_events WHERE run_id = ?').get('run-a')).toEqual({ count: 2 });
      expect(db.prepare('SELECT status, completed_at FROM analysis_runs WHERE id = ?').get('run-a')).toEqual({
        status: 'completed',
        completed_at: 1_777_000_000_100,
      });
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-a')).toEqual({
        status: 'completed',
      });
    } finally {
      db.close();
    }
  });

  it('marks the run failed when an error event is persisted', () => {
    persistSerializedAgentEvent(scope({ runId: 'run-failed' }), {
      cursor: 1,
      eventType: 'error',
      eventData: JSON.stringify({ error: 'cancelled' }),
      createdAt: 1_777_000_001_000,
    });

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status, completed_at FROM analysis_runs WHERE id = ?').get('run-failed')).toEqual({
        status: 'failed',
        completed_at: 1_777_000_001_000,
      });
    } finally {
      db.close();
    }
  });

  it('marks the run cancelled when an analysis_cancelled event is persisted', () => {
    persistSerializedAgentEvent(scope({ runId: 'run-cancelled', sessionId: 'session-cancelled' }), {
      cursor: 1,
      eventType: 'analysis_cancelled',
      eventData: JSON.stringify({
        type: 'analysis_cancelled',
        data: { terminalRunStatus: 'cancelled' },
      }),
      createdAt: 1_777_000_001_500,
    });

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status, completed_at FROM analysis_runs WHERE id = ?').get('run-cancelled')).toEqual({
        status: 'cancelled',
        completed_at: 1_777_000_001_500,
      });
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-cancelled')).toEqual({
        status: 'cancelled',
      });
    } finally {
      db.close();
    }
  });

  it('can persist stale terminal events without overwriting the session status', () => {
    const firstRun = scope({ runId: 'run-first', sessionId: 'session-shared' });
    const secondRun = scope({ runId: 'run-second', sessionId: 'session-shared' });

    persistSerializedAgentEvent(secondRun, {
      cursor: 1,
      eventType: 'progress',
      eventData: JSON.stringify({ type: 'progress', data: { phase: 'running' } }),
      createdAt: 1_777_000_001_000,
    });
    persistSerializedAgentEvent(firstRun, {
      cursor: 1,
      eventType: 'analysis_cancelled',
      eventData: JSON.stringify({
        type: 'analysis_cancelled',
        data: { terminalRunStatus: 'cancelled' },
      }),
      createdAt: 1_777_000_002_000,
    }, { updateSessionStatus: false });

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status, completed_at FROM analysis_runs WHERE id = ?').get('run-first')).toEqual({
        status: 'cancelled',
        completed_at: 1_777_000_002_000,
      });
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-shared')).toEqual({
        status: 'running',
      });
    } finally {
      db.close();
    }
  });

  it('preserves quota_exceeded terminal status from analysis_completed payloads', () => {
    persistSerializedAgentEvent(scope({ runId: 'run-quota', sessionId: 'session-quota' }), {
      cursor: 1,
      eventType: 'analysis_completed',
      eventData: JSON.stringify({
        type: 'analysis_completed',
        data: {
          terminalRunStatus: 'quota_exceeded',
          partial: true,
        },
      }),
      createdAt: 1_777_000_002_000,
    });

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT status, completed_at FROM analysis_runs WHERE id = ?').get('run-quota')).toEqual({
        status: 'quota_exceeded',
        completed_at: 1_777_000_002_000,
      });
      expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?').get('session-quota')).toEqual({
        status: 'quota_exceeded',
      });
    } finally {
      db.close();
    }
  });
});

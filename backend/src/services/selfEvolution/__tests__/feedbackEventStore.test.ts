// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import type {
  AppendFeedbackEventInput,
  FeedbackEventV1,
} from '../../../types/selfEvolution';
import {
  FeedbackEventStore,
  FeedbackRequestError,
  feedbackEventStoreTesting,
  privateFeedbackStorePaths,
} from '../feedbackEventStore';
import {FeedbackProjectionService} from '../feedbackProjectionService';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
let tmpDir: string;
let logPath: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-feedback-event-'));
  logPath = path.join(tmpDir, 'feedback.jsonl');
  dbPath = path.join(tmpDir, 'feedback.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function input(
  overrides: Partial<AppendFeedbackEventInput> = {},
): AppendFeedbackEventInput {
  return {
    kind: 'created',
    idempotencyKey: 'request-1',
    runId: 'run-1',
    sessionId: 'session-1',
    rating: 'positive',
    targetKind: 'session',
    targetId: 'session-1',
    source: 'api',
    actor: {userId: 'user-1'},
    scope,
    timestamp: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

/** A checksum-valid v1 event, as an earlier release appended it. */
function loggedEvent(
  overrides: Partial<Omit<FeedbackEventV1, 'checksum'>> = {},
): FeedbackEventV1 {
  const withoutChecksum: Omit<FeedbackEventV1, 'checksum'> = {
    schemaVersion: 1,
    eventId: 'event-crash-window',
    feedbackId: 'feedback-crash-window',
    sequence: 1,
    idempotencyKey: 'request-crash-window',
    kind: 'created',
    runId: 'run-1',
    sessionId: 'session-1',
    rating: 'positive',
    targetKind: 'session',
    targetId: 'session-1',
    source: 'api',
    actor: {userId: 'user-1'},
    scope,
    timestamp: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
  return {
    ...withoutChecksum,
    checksum: feedbackEventStoreTesting.checksumForEvent(withoutChecksum),
  };
}

/**
 * Feedback on learned-case candidates as releases before their retirement
 * logged it: an audit-only legacy line, an accepted legacy import, and a v1
 * event, around one ordinary session event.
 */
function writeRetiredCandidateHistory(): void {
  const lines = [
    {
      schemaVersion: 1,
      sessionId: 'legacy-session',
      rating: 'negative',
      caseCandidateId: 'candidate-legacy',
      timestamp: '2026-07-27T00:00:00.000Z',
      storageScope: scope,
    },
    {
      legacyCandidateFeedbackAccepted: true,
      legacySourceRowId: 7,
      sessionId: 'legacy-session',
      runId: 'legacy-run',
      rating: 'positive',
      caseCandidateId: 'candidate-legacy',
      timestamp: '2026-07-27T00:00:20.000Z',
      storageScope: scope,
    },
    loggedEvent({
      eventId: 'event-candidate',
      feedbackId: 'feedback-candidate',
      idempotencyKey: 'request-candidate',
      sessionId: 'session-2',
      runId: 'run-2',
      rating: 'negative',
      targetKind: 'case_candidate',
      targetId: 'candidate-1',
      caseCandidateId: 'candidate-1',
    }),
    loggedEvent({
      eventId: 'event-session',
      feedbackId: 'feedback-session',
      sequence: 2,
      idempotencyKey: 'request-session',
    }),
  ];
  fs.writeFileSync(logPath, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
}

function openStore(): FeedbackEventStore {
  return new FeedbackEventStore({
    scope,
    eventLogPath: logPath,
    databasePath: dbPath,
  });
}

describe('FeedbackEventStore', () => {
  it('appends canonical events with monotonic sequence and idempotent retry', async () => {
    const store = openStore();
    const first = await store.append(input());
    const second = await store.append(input({timestamp: '2030-01-01T00:00:00.000Z'}));

    expect(first.idempotent).toBe(false);
    expect(first.event.sequence).toBe(1);
    expect(second).toMatchObject({
      idempotent: true,
      event: {eventId: first.event.eventId, sequence: 1},
    });
    const {checksum, ...withoutChecksum} = first.event;
    expect(checksum).toBe(
      feedbackEventStoreTesting.checksumForEvent(withoutChecksum),
    );
    expect(fs.readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1);
    store.close();

    const reopened = openStore();
    await expect(reopened.append(input({
      rating: 'negative',
    }))).rejects.toThrow('feedback_idempotency_conflict');
    reopened.close();
  });

  it('rejects a missing or contradictory target as a request error', async () => {
    const store = openStore();
    await expect(store.append(input({targetKind: 'session', targetId: 'another-session'})))
      .rejects.toMatchObject({code: 'feedback_session_target_mismatch', status: 400});
    await expect(store.append(input({targetKind: 'pattern', targetId: undefined})))
      .rejects.toBeInstanceOf(FeedbackRequestError);
    store.close();
  });

  it('replaces and retracts one logical feedback without forking the chain', async () => {
    const store = openStore();
    const created = await store.append(input());
    const replaced = await store.append(input({
      kind: 'replaced',
      idempotencyKey: 'request-2',
      feedbackId: created.event.feedbackId,
      supersedesEventId: created.event.eventId,
      rating: 'negative',
    }));
    expect(replaced.event.sequence).toBe(2);
    expect(store.getEffectiveForTarget('session', 'session-1')).toMatchObject([
      {
        feedbackId: created.event.feedbackId,
        currentEventId: replaced.event.eventId,
        rating: 'negative',
      },
    ]);

    await expect(store.append(input({
      kind: 'replaced',
      idempotencyKey: 'request-fork',
      feedbackId: created.event.feedbackId,
      supersedesEventId: created.event.eventId,
      rating: 'positive',
    }))).rejects.toThrow('feedback_supersedes_fork');

    const retracted = await store.append(input({
      kind: 'retracted',
      idempotencyKey: 'request-3',
      feedbackId: created.event.feedbackId,
      supersedesEventId: replaced.event.eventId,
      rating: undefined,
    }));
    expect(retracted.event.sequence).toBe(3);
    expect(store.getEffectiveForTarget('session', 'session-1')).toEqual([]);
    store.close();
  });

  it('rebuilds the SQLite projection exclusively from the append-only log', async () => {
    const store = openStore();
    const created = await store.append(input());
    const replaced = await store.append(input({
      kind: 'replaced',
      idempotencyKey: 'request-2',
      feedbackId: created.event.feedbackId,
      supersedesEventId: created.event.eventId,
      rating: 'negative',
    }));
    await store.append(input({
      kind: 'retracted',
      idempotencyKey: 'request-3',
      feedbackId: created.event.feedbackId,
      supersedesEventId: replaced.event.eventId,
      rating: undefined,
    }));
    const originalLog = fs.readFileSync(logPath, 'utf8');

    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM effective_feedback;
      DELETE FROM feedback_event_index;
      DELETE FROM feedback_projection_offsets;
      DELETE FROM feedback_projection_targets;
    `);
    raw.close();

    store.rebuild();
    expect(fs.readFileSync(logPath, 'utf8')).toBe(originalLog);
    expect(store.getEffectiveForTarget('session', 'session-1')).toEqual([]);
    expect(store.listDirtyTargets()).toMatchObject([
      {targetKind: 'session', targetId: 'session-1'},
    ]);
    store.close();
  });

  it('refuses an unreadable stored record without quoting another member\'s feedback', async () => {
    const store = openStore();
    await store.append(input());
    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE effective_feedback SET actor_json = ?').run('{"userId":[FEEDBACK-CANARY-8d6 x]}');
    } finally {
      db.close();
    }
    expect(() => store.listEffective()).toThrow(/^feedback record is not valid JSON$/);
    store.close();
  });

  it('catches up a fsynced event left behind before SQLite projection', () => {
    const event = loggedEvent();
    fs.writeFileSync(logPath, `${JSON.stringify(event)}\n`);

    const store = openStore();
    store.catchUp();
    expect(store.getEffectiveForTarget('session', 'session-1')).toMatchObject([
      {currentEventId: event.eventId, rating: 'positive'},
    ]);
    store.close();
  });

  it('decodes retired candidate feedback yet keeps it out of every active view', async () => {
    writeRetiredCandidateHistory();
    const store = openStore();
    const activeView = () => ({
      effective: store.listEffective().map(feedback => feedback.feedbackId),
      stats: store.effectiveStats(),
      candidateStats: store.effectiveStats('case_candidate'),
      candidate: [
        ...store.getEffectiveForTarget('case_candidate', 'candidate-legacy'),
        ...store.getEffectiveForTarget('case_candidate', 'candidate-1'),
      ],
      dirty: store.listDirtyTargets().map(target => target.targetKind),
    });
    const expected = {
      effective: ['feedback-session'],
      stats: {totalPositive: 1, totalNegative: 0, distinctSessions: 1},
      candidateStats: {totalPositive: 0, totalNegative: 0, distinctSessions: 0},
      candidate: [],
      dirty: ['session'],
    };
    const decoded = () => {
      const raw = new Database(dbPath, {readonly: true});
      try {
        return raw.prepare(`
          SELECT target_kind AS kind, COUNT(*) AS rows
          FROM feedback_event_index GROUP BY target_kind ORDER BY target_kind
        `).all();
      } finally {
        raw.close();
      }
    };

    store.catchUp();
    expect(activeView()).toEqual(expected);
    // History is kept, not dropped: every line decoded into the index.
    expect(decoded()).toEqual([
      {kind: 'case_candidate', rows: 3},
      {kind: 'session', rows: 1},
    ]);

    store.rebuild();
    expect(activeView()).toEqual(expected);
    expect(decoded()).toEqual([
      {kind: 'case_candidate', rows: 3},
      {kind: 'session', rows: 1},
    ]);

    // A new event continues the sequence the historical events began.
    const appended = await store.append(input({
      idempotencyKey: 'request-after-retirement',
      sessionId: 'session-3',
      runId: 'run-3',
      targetId: 'session-3',
    }));
    expect(appended.event.sequence).toBe(3);

    // Projection applies what it projected and nothing it skipped: the
    // retired targets stay unapplied instead of being marked done.
    await new FeedbackProjectionService({store, knowledgeScope: scope})
      .projectDirtyTargets();
    expect(store.listDirtyTargets()).toEqual([]);
    const raw = new Database(dbPath, {readonly: true});
    try {
      expect(raw.prepare(`
        SELECT target_kind AS kind, target_id AS id, applied_revision IS NULL AS unapplied
        FROM feedback_projection_targets ORDER BY target_kind, target_id
      `).all()).toEqual([
        {kind: 'case_candidate', id: 'candidate-1', unapplied: 1},
        {kind: 'case_candidate', id: 'candidate-legacy', unapplied: 1},
        {kind: 'session', id: 'session-1', unapplied: 0},
        {kind: 'session', id: 'session-3', unapplied: 0},
      ]);
    } finally {
      raw.close();
    }
    store.close();
  });

  it('refuses new feedback on a retired target, including retracting its history', async () => {
    writeRetiredCandidateHistory();
    const originalLog = fs.readFileSync(logPath, 'utf8');
    const store = openStore();
    store.catchUp();
    // The input type no longer admits a retired target; an untyped writer
    // still meets the store's own refusal.
    const untypedInput = (overrides: Record<string, unknown>) =>
      input(overrides as Partial<AppendFeedbackEventInput>);

    await expect(store.append(untypedInput({
      idempotencyKey: 'new-candidate',
      targetKind: 'case_candidate',
      targetId: 'candidate-1',
    }))).rejects.toThrow('feedback_target_retired');
    await expect(store.append(untypedInput({
      idempotencyKey: 'session-with-candidate',
      caseCandidateId: 'candidate-1',
    }))).rejects.toThrow('feedback_target_retired');
    await expect(store.append(untypedInput({
      kind: 'retracted',
      idempotencyKey: 'retract-candidate',
      feedbackId: 'feedback-candidate',
      supersedesEventId: 'event-candidate',
      rating: undefined,
      sessionId: 'session-2',
      runId: 'run-2',
      targetKind: 'case_candidate',
      targetId: 'candidate-1',
      caseCandidateId: 'candidate-1',
    }))).rejects.toThrow('feedback_target_retired');

    expect(fs.readFileSync(logPath, 'utf8')).toBe(originalLog);
    store.close();
  });

  it('does not advance the offset for a checksum-valid invalid v2 event', () => {
    const invalidWithoutChecksum = {
      schemaVersion: 1 as const,
      eventId: 'event-invalid-target',
      feedbackId: 'feedback-invalid-target',
      sequence: 1,
      idempotencyKey: 'request-invalid-target',
      kind: 'created' as const,
      runId: 'run-1',
      sessionId: 'session-1',
      rating: 'positive' as const,
      targetKind: 'unknown',
      targetId: 'target-1',
      source: 'api' as const,
      actor: {userId: 'user-1'},
      scope,
      timestamp: '2026-07-28T00:00:00.000Z',
    };
    const invalid = {
      ...invalidWithoutChecksum,
      checksum: feedbackEventStoreTesting.checksumForEvent(
        invalidWithoutChecksum as Omit<FeedbackEventV1, 'checksum'>,
      ),
    };
    fs.writeFileSync(logPath, `${JSON.stringify(invalid)}\n`);

    const store = openStore();
    expect(() => store.catchUp()).toThrow('feedback_target_kind_invalid');
    store.close();
    const raw = new Database(dbPath);
    const offset = raw.prepare(`
      SELECT byte_offset FROM feedback_projection_offsets
    `).get();
    raw.close();
    expect(offset).toBeUndefined();
  });

  it('rejects checksum-valid non-string target identifiers', () => {
    const invalidWithoutChecksum = {
      schemaVersion: 1 as const,
      eventId: 'event-invalid-target-id',
      feedbackId: 'feedback-invalid-target-id',
      sequence: 1,
      idempotencyKey: 'request-invalid-target-id',
      kind: 'created' as const,
      runId: 'run-1',
      sessionId: 'session-1',
      rating: 'positive' as const,
      targetKind: 'finding' as const,
      targetId: 123,
      source: 'api' as const,
      actor: {userId: 'user-1'},
      scope,
      timestamp: '2026-07-28T00:00:00.000Z',
    };
    const invalid = {
      ...invalidWithoutChecksum,
      checksum: feedbackEventStoreTesting.checksumForEvent(
        invalidWithoutChecksum as unknown as Omit<
          FeedbackEventV1,
          'checksum'
        >,
      ),
    };
    fs.writeFileSync(logPath, `${JSON.stringify(invalid)}\n`);

    const store = openStore();
    expect(() => store.catchUp()).toThrow('feedback_target_id_invalid');
    store.close();
  });

  it('rejects cross-scope input before touching the log', async () => {
    const store = openStore();
    await expect(store.append(input({
      scope: {tenantId: 'tenant-b', workspaceId: 'workspace-a'},
    }))).rejects.toThrow('feedback_scope_mismatch');
    expect(fs.existsSync(logPath)).toBe(false);
    store.close();
  });

  it('rejects client-selected created ids and mismatched dimensions', async () => {
    const store = openStore();
    await expect(store.append(input({
      feedbackId: 'client-selected-id',
    }))).rejects.toThrow('feedback_created_feedback_id_forbidden');
    await expect(store.append(input({
      dimensions: ['wrong_conclusion'],
    }))).rejects.toThrow('feedback_dimension_rating_mismatch');
    expect(fs.existsSync(logPath)).toBe(false);
    store.close();
  });

  it('uses physically separate public and private storage roots', () => {
    const durable = privateFeedbackStorePaths({
      scope,
      userId: 'user-1',
      durable: true,
    });
    const temporary = privateFeedbackStorePaths({
      scope,
      userId: 'user-1',
      durable: false,
    });

    expect(durable.eventLogPath).toContain(
      path.join('private_feedback', 'tenant-a', 'workspace-a', 'user-1'),
    );
    expect(temporary.eventLogPath).toContain(
      path.join('SmartPerfetto', 'private_feedback'),
    );
    expect(durable.eventLogPath).not.toBe(logPath);
    expect(durable.databasePath).not.toBe(dbPath);
    expect(durable.storage).toBe('durable');
    expect(temporary.storage).toBe('temporary_private');
    expect(durable.visibility).toBe('private_local');
    expect(temporary.visibility).toBe('private_local');

    const privateDurableStore = new FeedbackEventStore({
      scope,
      ...durable,
    });
    expect(privateDurableStore.provenance).toEqual({
      visibility: 'private_local',
      durability: 'durable',
    });
    privateDurableStore.close();
    const publicStore = openStore();
    expect(publicStore.provenance).toEqual({
      visibility: 'public_scoped',
      durability: 'durable',
    });
    publicStore.close();
  });

  it('filters effective metrics by target kind', async () => {
    const store = openStore();
    await store.append(input());
    await store.append(input({
      idempotencyKey: 'finding-request',
      sessionId: 'session-2',
      runId: 'run-2',
      rating: 'negative',
      targetKind: 'finding',
      targetId: 'finding-1',
    }));

    expect(store.effectiveStats()).toEqual({
      totalPositive: 1,
      totalNegative: 1,
      distinctSessions: 2,
    });
    expect(store.effectiveStats('finding')).toEqual({
      totalPositive: 0,
      totalNegative: 1,
      distinctSessions: 1,
    });
    store.close();
  });
});

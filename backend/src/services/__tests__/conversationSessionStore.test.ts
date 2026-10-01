// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {ConversationSessionStore, type ConversationSessionDescriptor} from '../conversationSessionStore';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {openEnterpriseDb, ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {persistAnalysisRunState, resetAnalysisRunStoreForTests} from '../analysisRunStore';
import {buildReviewNotFinishedResult} from '../reviewStopHandle';
import {createAnalysisHistoryReader, renderAnalysisHistoryContext} from '../../agentRuntime/analysisHistory';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
let tmpDir: string;
let db: Database.Database;
const owner = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const scope = {...owner, sessionId: 'conversation-a', traceId: 'trace-a', runId: 'run-a',
  privateContext: NO_PRIVATE_CONTEXT};
function descriptor(): ConversationSessionDescriptor {
  return {version: 1, ...owner, sessionId: scope.sessionId, traceContext: {kind: 'attached', traceId: scope.traceId},
    providerId: 'provider-a', providerFollowsActive: false, runtimeKind: 'openai-agents-sdk', providerSnapshotHash: 'hash-a',
    analysisContextFingerprint: 'auth-a', status: 'running', createdAt: 100, lastActivityAt: 100,
    lastRun: {runId: 'run-a', query: 'why?', turnIndex: 0, startedAt: 100, status: 'running'}};
}
function turn(answer = '') {
  return toAnalysisHistoryTurn({id: 'run-a', turnIndex: 0, query: 'why?', traceId: 'trace-a', timestamp: 100,
    result: {conclusion: answer, partial: true, completion: {status: 'incomplete'}, terminationReason: 'max_turns',
      uncertainties: ['Need wakeup evidence'], nextSteps: ['Inspect preceding wakeup']}});
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-conversation-store-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
  persistAnalysisRunState(scope, 'running', {now: 100});
  db = openEnterpriseDb();
});
afterEach(() => {
  db.close(); resetAnalysisRunStoreForTests();
  if (originalDbPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
  else process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('logical conversation durability', () => {
  it('writes one terminal turn per run and keeps a review-not-finished body incomplete for later readers', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn());
    const done = {...descriptor(), status: 'completed' as const, lastActivityAt: 200,
      lastRun: {...descriptor().lastRun, status: 'completed' as const, completedAt: 200}};
    const partial = toAnalysisHistoryTurn({id: 'run-a', turnIndex: 0, query: 'why?', traceId: 'trace-a', timestamp: 200,
      analysisContextFingerprint: 'auth-a', result: buildReviewNotFinishedResult({sessionId: scope.sessionId,
        conclusion: 'Main thread waited 80 ms on binder.', outputLanguage: 'en'})});
    store.save(done, partial);
    expect(() => store.save(done, {...partial, answer: 'a second terminal write'}))
      .toThrow('conversation_recovery_turn_already_terminal');

    const restored = store.listTurns(store.load(owner, scope.sessionId)!);
    expect(restored).toEqual([expect.objectContaining({answer: 'Main thread waited 80 ms on binder.', partial: true,
      completionStatus: 'incomplete', terminationReason: 'review_not_finished',
      terminationMessage: 'The semantic review did not finish: this answer is unverified.',
      analysisContextFingerprint: 'auth-a'})]);
    const reader = createAnalysisHistoryReader({getTurns: () => restored, assertActive: () => undefined});
    expect(reader.read({})).toMatchObject({entries: [expect.objectContaining({partial: true,
      completionStatus: 'incomplete', terminationReason: 'review_not_finished'})]});
    expect(reader.read({turnId: 'run-a'})).toMatchObject({partial: true, completionStatus: 'incomplete',
      text: expect.stringContaining('this answer is unverified')});
    const preview = renderAnalysisHistoryContext(restored, {outputLanguage: 'en'})!;
    expect(preview).toContain('"completionStatus":"incomplete"');
    expect(preview).toContain('"terminationReason":"review_not_finished"');
  });

  it('holds the write lock across its owner and descriptor reads', () => {
    // A deferred save lost its read snapshot to any commit before its first write
    // and failed at once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out.
    const other = new Database(process.env[ENTERPRISE_DB_PATH_ENV]!, {timeout: 0});
    const outcomes: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('INSERT INTO runtime_snapshots')) {
        try {other.prepare("UPDATE analysis_runs SET status = 'running' WHERE id = 'run-a'").run(); outcomes.push('committed');}
        catch (error) {outcomes.push((error as {code?: string}).code ?? 'error');}
      }
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      expect(() => new ConversationSessionStore(db).save(descriptor())).not.toThrow();
      expect(outcomes).toEqual(['SQLITE_BUSY']);
      expect(new ConversationSessionStore(db).load(owner, scope.sessionId)?.lastRun.runId).toBe('run-a');
    } finally {spy.mockRestore(); other.close();}
  });

  it('recovers a pre-final-commit crash as a running descriptor with explicitly partial history', () => {
    new ConversationSessionStore(db).save(descriptor(), turn());
    const restarted = new ConversationSessionStore(db);
    const stored = restarted.load(owner, scope.sessionId)!;
    expect(stored.lastRun.status).toBe('running');
    expect(restarted.listTurns(stored)).toEqual([expect.objectContaining({query: 'why?', answer: '', partial: true})]);
    expect(JSON.stringify(stored)).not.toMatch(/runtimeSessionId|evidenceWitness|sdkTranscript/);
  });

  it('atomically recovers finalized body, partial status, uncertainty, and logical clarification', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn());
    const done = {...descriptor(), status: 'awaiting_user' as const,
      lastRun: {...descriptor().lastRun, status: 'completed' as const, completedAt: 200}, lastActivityAt: 200,
      lastOutcome: {kind: 'needs_user_input' as const, message: 'Observed scheduling delay.', question: 'Which interval?'}};
    store.save(done, turn('Observed scheduling delay.'));
    const stored = new ConversationSessionStore(db).load(owner, scope.sessionId)!;
    expect(stored.lastOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which interval?'});
    expect(store.listTurns(stored)[0]).toMatchObject({answer: 'Observed scheduling delay.', partial: true,
      completionStatus: 'incomplete', terminationReason: 'max_turns', uncertainties: ['Need wakeup evidence'],
      nextSteps: ['Inspect preceding wakeup']});
  });

  it('rolls back the final turn when descriptor commit fails', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn());
    db.exec("CREATE TRIGGER fail_conversation_commit BEFORE UPDATE ON runtime_snapshots BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(() => store.save({...descriptor(), status: 'completed',
      lastRun: {...descriptor().lastRun, status: 'completed'}}, turn('Must not partially commit'))).toThrow('disk failure');
    expect(store.load(owner, scope.sessionId)?.status).toBe('running');
    expect(store.listTurns(descriptor())[0].answer).toBe('');
  });

  it('denies the same workspace different user and different workspace at the parent ownership join', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn('PRIVATE_OWNER_ANSWER'));
    expect(store.load({...owner, userId: 'user-b'}, scope.sessionId)).toBeUndefined();
    expect(store.load({...owner, workspaceId: 'workspace-b'}, scope.sessionId)).toBeUndefined();
    expect(store.listTurns({...descriptor(), userId: 'user-b'})).toEqual([]);
    expect(() => store.save({...descriptor(), userId: 'user-b'}, turn())).toThrow('owner_unavailable');
  });

  it('rejects a late old final write after a new run has replaced the descriptor', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn());
    persistAnalysisRunState({...scope, runId: 'run-b'}, 'running', {now: 300});
    const newer = {...descriptor(), lastRun: {...descriptor().lastRun, runId: 'run-b', turnIndex: 1, startedAt: 300},
      lastActivityAt: 300};
    store.save(newer, {...turn(), id: 'run-b', turnIndex: 1});
    expect(() => store.save({...descriptor(), lastRun: {...descriptor().lastRun, status: 'completed'}},
      turn('LATE_OLD_ANSWER'))).toThrow('stale_run');
    expect(store.load(owner, scope.sessionId)?.lastRun.runId).toBe('run-b');
    expect(store.listTurns(newer).some(entry => entry.answer === 'LATE_OLD_ANSWER')).toBe(false);
  });

  it('refuses an unparsable descriptor with its fixed code, quoting none of it', () => {
    const store = new ConversationSessionStore(db);
    store.save(descriptor(), turn());
    db.prepare('UPDATE runtime_snapshots SET snapshot_json = ?').run('{"lastRun":[CONVERSATION-CANARY-1b4 x]}');
    expect(() => store.load(owner, scope.sessionId)).toThrow(/^conversation_recovery_descriptor_invalid$/);
  });

  it('stores only the descriptor allowlist even when a caller passes private runtime fields', () => {
    const input = {...descriptor(), runtime: {secret: 'SDK_SECRET'}, sdkTranscript: ['HIDDEN_SDK_HISTORY'],
      evidenceWitness: 'LIVE_WITNESS', lastOutcome: {kind: 'answered' as const, message: 'public',
        finalResult: {secret: 'RESULT_SECRET'}}};
    new ConversationSessionStore(db).save(input as unknown as ConversationSessionDescriptor, turn('public'));
    const row = db.prepare('SELECT snapshot_json FROM runtime_snapshots').get() as {snapshot_json: string};
    expect(row.snapshot_json).not.toMatch(/SDK_SECRET|HIDDEN_SDK_HISTORY|LIVE_WITNESS|RESULT_SECRET/);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {openEnterpriseDb, ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {persistAnalysisRunState, failInterruptedAnalysisRunsOnStartup, resetAnalysisRunStoreForTests} from '../analysisRunStore';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';
import {ConversationSessionStore, type ConversationSessionDescriptor} from '../conversationSessionStore';
import {AssistantWorkCatalogService, parseAssistantWorkCatalogQuery} from '../assistantWorkCatalogService';

const owner = {tenantId: 'work-tenant', workspaceId: 'work-space', userId: 'work-owner'};
const originalPath = process.env[ENTERPRISE_DB_PATH_ENV];
let root: string;
let db: Database.Database;
function seed(sessionId: string, runId: string, now: number, status: 'running' | 'completed' | 'awaiting_user' = 'completed',
  overrides: Partial<typeof owner> & {mode?: string} = {}) {
  const scope = {...owner, ...overrides, sessionId, runId, traceId: `trace-${sessionId}`,
    query: 'PRIVATE_QUERY_NEVER_IN_CATALOG', privateContext: NO_PRIVATE_CONTEXT};
  persistAnalysisRunState(scope, status, {now});
  return scope;
}
function conversation(sessionId: string, runId: string, now: number, kind: 'answered' | 'needs_user_input' | 'recommend_full') {
  seed(sessionId, runId, now, 'completed', {mode: 'conversation'});
  const lastOutcome = kind === 'answered' ? {kind, message: 'PRIVATE_ANSWER'}
    : kind === 'needs_user_input' ? {kind, message: 'PRIVATE_ANSWER', question: 'PRIVATE_QUESTION'}
      : {kind, message: 'PRIVATE_ANSWER', handoff: {question: 'PRIVATE_QUESTION', scope: 'PRIVATE_SCOPE', assumptions: [], evidence: []}};
  new ConversationSessionStore(db).save({version: 1, ...owner, sessionId,
    providerId: null, providerFollowsActive: false, runtimeKind: 'claude-agent-sdk', providerSnapshotHash: 'PRIVATE_PROVIDER',
    analysisContextFingerprint: 'PRIVATE_FINGERPRINT', traceContext: {kind: 'attached', traceId: `trace-${sessionId}`},
    status: kind === 'needs_user_input' ? 'awaiting_user' : 'completed', createdAt: now, lastActivityAt: now,
    lastRun: {runId, query: 'PRIVATE_QUERY', turnIndex: 0, startedAt: now, completedAt: now, status: 'completed'},
    lastOutcome} as ConversationSessionDescriptor);
}
function list(filter: 'recent' | 'needs_input' = 'recent', limit = 20, cursor?: string,
  options: ConstructorParameters<typeof AssistantWorkCatalogService>[1] = {}) {
  return new AssistantWorkCatalogService(db, {now: () => 1000, ...options}).list(owner,
    parseAssistantWorkCatalogQuery({filter, limit: String(limit), ...(cursor ? {cursor} : {})}));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-work-catalog-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(root, 'enterprise.sqlite');
  db = openEnterpriseDb();
});
afterEach(() => {
  db.close(); resetAnalysisRunStoreForTests();
  if (originalPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV]; else process.env[ENTERPRISE_DB_PATH_ENV] = originalPath;
  fs.rmSync(root, {recursive: true, force: true});
});

describe('assistant work catalog', () => {
  it('filters owner before the latest-run selection and stable pagination', () => {
    seed('mine-1', 'r-a', 10); seed('mine-2', 'r-b', 10);
    seed('foreign', 'r-z', 100, 'completed', {userId: 'another-owner'});
    const first = list('recent', 1);
    expect(first.items.map(item => item.work.runId)).toEqual(['r-b']);
    expect(list('recent', 1, first.nextCursor).items.map(item => item.work.runId)).toEqual(['r-a']);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|another-owner|foreign/);
  });

  it('chooses the latest run before filtering attention and ignores heartbeat ordering', () => {
    seed('superseded', 'old-needs-input', 10, 'awaiting_user');
    seed('superseded', 'new-completed', 20);
    seed('waiting', 'still-waiting', 15, 'awaiting_user');
    db.prepare('UPDATE analysis_runs SET updated_at = 999999 WHERE id = ?').run('still-waiting');
    expect(list('needs_input').items.map(item => item.work.runId)).toEqual(['still-waiting']);
    expect(list().items.map(item => item.work.runId)).toEqual(['new-completed', 'still-waiting']);
  });

  it('includes valid conversation input and full-analysis decisions without returning their text', () => {
    conversation('question', 'question-run', 10, 'needs_user_input');
    conversation('handoff', 'handoff-run', 20, 'recommend_full');
    conversation('answer', 'answer-run', 30, 'answered');
    const page = list('needs_input');
    expect(page.items.map(item => item.work.inputReason)).toEqual(['full_analysis', 'question']);
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
    expect(list().items[0].work).toMatchObject({phase: 'ready', hasResult: true});
  });

  it('keeps a bad descriptor local to its row instead of returning a fake empty catalog', () => {
    conversation('broken', 'broken-run', 20, 'needs_user_input');
    seed('healthy', 'healthy-run', 10);
    db.prepare("UPDATE runtime_snapshots SET snapshot_json = '{bad PRIVATE_JSON' WHERE session_id = ?").run('broken');
    const page = list();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({metadata: 'unavailable', work: {hasResult: false}});
    expect(page.items[1].metadata).toBe('available');
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
  });

  it('does not call a missing live execution interrupted without recovery evidence', () => {
    seed('running', 'running-run', 10, 'running');
    expect(list().items[0].work.phase).toBe('unknown');
    failInterruptedAnalysisRunsOnStartup({now: 40});
    expect(list().items[0].work.phase).toBe('interrupted');
  });

  it('uses only a matching live run and keeps scanning possible after an overlay removes attention', () => {
    seed('first', 'first-run', 30, 'awaiting_user');
    seed('second', 'second-run', 20, 'awaiting_user');
    const page = list('needs_input', 1, undefined, {readLiveWork: (_owner, sessionId, runId) => ({
      sessionId, runId, phase: 'running', hasResult: false})});
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeDefined();
    expect(list('needs_input', 1, page.nextCursor).items[0].work.runId).toBe('second-run');
    expect(list('recent', 1, undefined, {readLiveWork: () => ({sessionId: 'foreign', runId: 'other', phase: 'ready', hasResult: true})})
      .items[0].work.phase).toBe('needs_input');
  });

  it('keeps completion separate from actual readable results', () => {
    seed('complete', 'complete-run', 10);
    expect(list().items[0].work).toMatchObject({phase: 'finished', hasResult: false});
  });

  it('offers snapshots only for exact owner, session, run, nonexpiry and permission', () => {
    seed('result', 'result-run', 10);
    db.prepare(`INSERT INTO analysis_result_snapshots
      (id, tenant_id, workspace_id, trace_id, session_id, run_id, created_by, visibility, scene_type, title, user_query,
       trace_label, trace_metadata_json, summary_json, status, schema_version, created_at, expires_at)
      VALUES ('snapshot', ?, ?, 'trace-result', 'result', 'result-run', ?, 'private', 'startup', 'PRIVATE_TITLE',
       'PRIVATE_QUERY', 'PRIVATE_TRACE', '{}', '{}', 'completed', '1', 20, 2000)`)
      .run(owner.tenantId, owner.workspaceId, owner.userId);
    expect(list().items[0].result).toBeUndefined();
    expect(list('recent', 20, undefined, {canReadSnapshots: true}).items[0]).toMatchObject({
      result: {kind: 'snapshot', id: 'snapshot'}, work: {phase: 'ready', hasResult: true}});
    seed('result', 'new-run', 30);
    expect(list('recent', 20, undefined, {canReadSnapshots: true}).items[0].result).toBeUndefined();
    db.prepare('UPDATE analysis_runs SET started_at = 1 WHERE id = ?').run('new-run');
    db.prepare('UPDATE analysis_result_snapshots SET expires_at = 100').run();
    expect(list('recent', 20, undefined, {canReadSnapshots: true}).items[0].result).toBeUndefined();
  });

  it('offers a report only with exact metadata, read authority, permission and an existing file', () => {
    seed('report', 'report-run', 10);
    const file = path.join(root, 'report.html'); fs.writeFileSync(file, '<html>PRIVATE</html>');
    db.prepare(`INSERT INTO report_artifacts (id, tenant_id, workspace_id, session_id, run_id, local_path,
      visibility, created_by, created_at, expires_at) VALUES ('report-id', ?, ?, 'report', 'report-run', ?, 'private', ?, 10, 2000)`)
      .run(owner.tenantId, owner.workspaceId, file, owner.userId);
    const options = {canReadReports: true, reportReadAuthority: () => true};
    const item = list('recent', 20, undefined, options).items[0];
    expect(item).toMatchObject({reportId: 'report-id', work: {phase: 'ready', hasResult: true}});
    expect(JSON.stringify(item)).not.toMatch(/PRIVATE|report.html/);
    expect(list('recent', 20, undefined, {...options, reportReadAuthority: () => false}).items[0].reportId).toBeUndefined();
    for (const phase of ['running', 'reviewing', 'finished', 'needs_input', 'failed', 'cancelled'] as const) {
      const live = {sessionId: 'report', runId: 'report-run', phase, hasResult: false};
      expect(list('recent', 20, undefined, {...options, readLiveWork: () => live}).items[0].work)
        .toMatchObject({hasResult: true, phase: phase === 'finished' ? 'ready' : phase});
    }
    db.prepare('UPDATE report_artifacts SET expires_at = 100 WHERE id = ?').run('report-id');
    for (const phase of ['running', 'finished'] as const) {
      expect(list('recent', 20, undefined, {...options,
        readLiveWork: () => ({sessionId: 'report', runId: 'report-run', phase, hasResult: false})}).items[0].work)
        .toMatchObject({hasResult: false, phase});
    }
    db.prepare('UPDATE report_artifacts SET expires_at = 2000 WHERE id = ?').run('report-id');
    fs.unlinkSync(file);
    expect(list('recent', 20, undefined, options).items[0].reportId).toBeUndefined();
  });

  it('does not assign admission order to random IDs when a session has equal start times', () => {
    seed('tie', 'old-z', 20, 'awaiting_user'); seed('tie', 'new-a', 20, 'completed');
    const work = list().items[0];
    expect(work).toMatchObject({metadata: 'unavailable', metadataReason: 'latest_run_ambiguous',
      work: {phase: 'unknown', hasResult: false}});
    expect(work.work.runId).toBeUndefined(); expect(work.work.inputReason).toBeUndefined();
    expect(list('needs_input').items[0].work.phase).toBe('unknown');
  });

  it('uses an owner-bound live latest pointer within a tied group without changing its cursor', () => {
    seed('tie', 'old-z', 20, 'awaiting_user'); seed('tie', 'new-a', 20, 'completed');
    seed('older', 'older-waiting', 10, 'awaiting_user');
    const unobserved = list('needs_input', 1);
    const latest = list('needs_input', 1, undefined, {readLiveWork: (_owner, sessionId, runId) =>
      sessionId === 'tie' && (runId === undefined || runId === 'new-a')
        ? {sessionId, runId: 'new-a', phase: 'finished', hasResult: false} : undefined});
    expect(latest.items).toEqual([]); expect(latest.nextCursor).toBe(unobserved.nextCursor);
    expect(list('needs_input', 1, latest.nextCursor).items[0].work.runId).toBe('older-waiting');
    expect(list('recent', 1, undefined, {readLiveWork: () => ({sessionId: 'foreign', runId: 'new-a', phase: 'ready', hasResult: true})})
      .items[0].work.runId).toBeUndefined();
  });

  it('resolves a restart from its strict conversation pointer and refuses conflicting pointers', () => {
    conversation('tie-conversation', 'old-z', 20, 'needs_user_input');
    conversation('tie-conversation', 'new-a', 20, 'answered');
    expect(list().items[0].work).toMatchObject({runId: 'new-a', phase: 'ready'});
    expect(list('needs_input').items).toEqual([]);
    const conflict = list('recent', 20, undefined, {readLiveWork: (_owner, sessionId) => ({
      sessionId, runId: 'old-z', phase: 'needs_input', hasResult: true})});
    expect(conflict.items[0]).toMatchObject({metadataReason: 'latest_run_ambiguous', work: {phase: 'unknown', hasResult: false}});
    expect(conflict.items[0].work.runId).toBeUndefined();
  });

  it('does not let an in-group descriptor conceal an owner-bound live pointer outside the group', () => {
    conversation('tie-conversation', 'old-z', 20, 'needs_user_input');
    conversation('tie-conversation', 'new-a', 20, 'answered');
    const page = list('recent', 20, undefined, {readLiveWork: (_owner, sessionId) => ({
      sessionId, runId: 'newer-unpersisted', phase: 'running', hasResult: false})});
    expect(page.items[0]).toMatchObject({metadataReason: 'latest_run_ambiguous',
      work: {phase: 'unknown', hasResult: false}});
    expect(page.items[0].work.runId).toBeUndefined();
    expect(list('recent', 20, undefined, {readLiveWork: () => ({
      sessionId: 'foreign-session', runId: 'newer-unpersisted', phase: 'running', hasResult: false})})
      .items[0].work.runId).toBe('new-a');
  });

  it('does not expose either candidate artifact when the latest group is ambiguous', () => {
    seed('tie-report', 'old-z', 20, 'awaiting_user'); seed('tie-report', 'new-a', 20);
    const file = path.join(root, 'tie-report.html'); fs.writeFileSync(file, '<html>PRIVATE</html>');
    db.prepare(`INSERT INTO report_artifacts (id, tenant_id, workspace_id, session_id, run_id, local_path,
      visibility, created_by, created_at, expires_at) VALUES ('ambiguous-report', ?, ?, 'tie-report', 'old-z', ?, 'private', ?, 20, 2000)`)
      .run(owner.tenantId, owner.workspaceId, file, owner.userId);
    const result = list('recent', 20, undefined, {canReadReports: true, reportReadAuthority: () => true});
    expect(result.items[0].reportId).toBeUndefined(); expect(result.items[0].result).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('ambiguous-report');
  });

  it('rejects invalid cursors and bounds before any read', () => {
    for (const query of [{limit: '0'}, {limit: '51'}, {limit: '1.5'}, {filter: 'all'}, {cursor: 'not-json'}]) {
      expect(() => parseAssistantWorkCatalogQuery(query)).toThrow();
    }
  });
});

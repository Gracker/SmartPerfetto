// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runtime from '../../agentRuntime';
import * as authorization from '../../services/resolvedAnalysisContext';
import type {IOrchestrator} from '../../agent/core/orchestratorTypes';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {getProviderService} from '../../services/providerManager';
import {resolveProviderRuntimeSnapshot} from '../../services/providerManager/providerSnapshot';
import {getConversationSessionStore, resetConversationSessionStoreForTests,
  type ConversationSessionDescriptor} from '../../services/conversationSessionStore';
import {persistAnalysisRunState, resetAnalysisRunStoreForTests} from '../../services/analysisRunStore';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';
import {registerAgentConversationRoutes} from '../agentConversationRoutes';
import * as finalization from '../../services/finalizeAnalysisResult';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';

const previousPath = process.env[ENTERPRISE_DB_PATH_ENV];
const owner = {tenantId: 'recovery-tenant', workspaceId: 'recovery-workspace', userId: 'recovery-owner'};
let tmp: string;
let sequence = 0;
let descriptor: ConversationSessionDescriptor;
let factory: jest.SpiedFunction<typeof runtime.createAgentOrchestrator>;
function app(userId = owner.userId) {
  const value = express(); value.use(express.json());
  value.use((req, _res, next) => {
    (req as any).requestContext = {...owner, userId, authType: 'dev', requestId: 'recovery-request', roles: ['org_admin'], scopes: ['*']};
    next();
  });
  const router = express.Router(); registerAgentConversationRoutes(router); value.use('/api/agent/v1', router);
  return value;
}
function storeSnapshot(overrides: Partial<ConversationSessionDescriptor> = {},
  turnOverrides: Partial<ReturnType<typeof toAnalysisHistoryTurn>> = {}) {
  descriptor = {...descriptor, ...overrides};
  const traceId = `conversation-no-trace:${descriptor.sessionId}`;
  persistAnalysisRunState({...owner, sessionId: descriptor.sessionId, runId: descriptor.lastRun.runId, traceId,
    privateContext: NO_PRIVATE_CONTEXT}, 'running');
  getConversationSessionStore().save(descriptor, {...toAnalysisHistoryTurn({id: descriptor.lastRun.runId,
    turnIndex: 0, traceId, query: descriptor.lastRun.query, timestamp: 100,
    result: {conclusion: 'Final retained answer', partial: true, terminationReason: 'max_turns',
      uncertainties: ['Unobserved wakeup'], nextSteps: ['Inspect wakeup']}}), ...turnOverrides});
}
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-conversation-route-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmp, 'enterprise.sqlite');
  const pin = resolveProviderRuntimeSnapshot(getProviderService(), null, undefined, owner);
  const sessionId = `recovery-conversation-${++sequence}`;
  descriptor = {version: 1, ...owner, sessionId, traceContext: {kind: 'none'}, providerId: null,
    providerFollowsActive: false, runtimeKind: pin.snapshot.runtimeKind, providerSnapshotHash: pin.snapshotHash,
    analysisContextFingerprint: authorization.buildAnalysisContextAuthorizationFingerprint({}, owner),
    status: 'completed', createdAt: 100, lastActivityAt: 200,
    lastRun: {runId: `${sessionId}-run`, query: 'previous question', turnIndex: 0, startedAt: 100, completedAt: 200, status: 'completed'},
    lastOutcome: {kind: 'answered', message: 'Final retained answer'}};
  factory = jest.spyOn(runtime, 'createAgentOrchestrator').mockImplementation(() => {
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.reset = jest.fn(); emitter.analyze = jest.fn<IOrchestrator['analyze']>();
    return emitter;
  });
});
afterEach(() => {
  jest.restoreAllMocks(); resetConversationSessionStoreForTests(); resetAnalysisRunStoreForTests();
  if (previousPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV]; else process.env[ENTERPRISE_DB_PATH_ENV] = previousPath;
  fs.rmSync(tmp, {recursive: true, force: true});
});

describe('conversation route deliver first, verify after', () => {
  it('answers a review-only stop at once, then settles the answered turn', async () => {
    factory.mockImplementation(() => {
      const emitter = new EventEmitter() as unknown as IOrchestrator;
      emitter.reset = jest.fn();
      emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, sessionId) => ({sessionId: sessionId!,
        success: true, findings: [], hypotheses: [], conclusion: 'Trace duration is 12.3 s.', confidence: 1,
        rounds: 1, totalDurationMs: 1}));
      return emitter;
    });
    let provisionalSent!: () => void;
    const provisional = new Promise<void>(resolve => {provisionalSent = resolve;});
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      try {
        expect(input.onProvisionalAnswer?.({conclusion: input.result.conclusion})).toBe(true);
        provisionalSent();
        const stop = input.reviewStopSignal!;
        await new Promise(resolve => stop.aborted ? resolve(undefined) : stop.addEventListener('abort', resolve, {once: true}));
        input.owner.signal.throwIfAborted();
        return {result: input.result, conversationOutcome: {kind: 'answered', message: input.result.conclusion}};
      } finally {input.context?.dispose();}
    });
    const started = await request(app()).post('/api/agent/v1/conversation').send({query: 'trace 时长'});
    expect(started.status).toBe(202);
    await provisional;
    const cancelled = await request(app()).post(`/api/agent/v1/conversation/${started.body.sessionId}/cancel`)
      .send({runId: started.body.runId});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({success: true, sessionId: started.body.sessionId, runId: started.body.runId,
      status: 'review_stop_requested'});
    let snapshot = await request(app()).get(`/api/agent/v1/conversation/${started.body.sessionId}`);
    for (let attempt = 0; snapshot.body.activeRunId && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      snapshot = await request(app()).get(`/api/agent/v1/conversation/${started.body.sessionId}`);
    }
    expect(snapshot.body.activeRunId).toBeUndefined();
    expect(snapshot.body.history.map((message: {content: string}) => message.content))
      .toEqual(['trace 时长', 'Trace duration is 12.3 s.']);
  });
});

describe('conversation live-only drafts', () => {
  it('sends an answer draft without an SSE id or seqId, while replayable events keep theirs', async () => {
    const runtimeKind = resolveProviderRuntimeSnapshot(getProviderService(), null, undefined, owner).snapshot.runtimeKind;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    factory.mockImplementation(() => {
      const emitter = new EventEmitter() as unknown as IOrchestrator;
      emitter.reset = jest.fn();
      emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, sessionId, _traceId, options) => {
        await gate;
        emitter.emit('update', {type: 'answer_token', timestamp: 1,
          content: {token: 'Draft text', runId: options!.runId, attempt: 0}});
        return {sessionId: sessionId!, success: true, findings: [], hypotheses: [], conclusion: 'Final answer.',
          confidence: 1, rounds: 1, totalDurationMs: 1};
      });
      return emitter;
    });
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose();
      return {result: input.result, conversationOutcome: {kind: 'answered', message: input.result.conclusion}};
    });
    const started = await request(app()).post('/api/agent/v1/conversation').send({query: 'trace 时长'});
    expect(started.status).toBe(202);
    const stream = request(app()).get(`/api/agent/v1/conversation/${started.body.sessionId}/stream`)
      .query({runId: started.body.runId}).buffer(true).parse((res, done) => {
        let text = '';
        res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        res.on('end', () => done(null, text));
      });
    const response = stream.then(value => value);
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    const frames = String((await response).body).split('\n\n').filter(frame => frame.includes('event: runtime_update'));
    const draftFrames = frames.filter(frame => frame.includes('Draft text'));
    // The default pinned runtime streams drafts; otherwise this test would prove nothing.
    expect(['claude-agent-sdk', 'openai-agents-sdk']).toContain(runtimeKind);
    expect(draftFrames).toHaveLength(1);
    expect(draftFrames[0]).not.toMatch(/^id: /m);
    const data = JSON.parse(draftFrames[0].split('\n').find(line => line.startsWith('data: '))!.slice(6));
    expect(data).toMatchObject({type: 'runtime_update', liveOnly: true, update: {type: 'answer_token'}});
    expect(data).not.toHaveProperty('seqId');
    const completed = String((await response).body).split('\n\n').find(frame => frame.includes('event: run_completed'))!;
    expect(completed).toMatch(/^id: \d+$/m);
  });
});

describe('conversation routes authorized recovery', () => {
  it('reopens an owner-authorized finalized turn with partial metadata and a pinned fresh adapter', async () => {
    storeSnapshot();
    const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({sessionId: descriptor.sessionId, status: 'completed', recoveryStatus: 'available',
      history: [expect.objectContaining({content: 'previous question'}), expect.objectContaining({content: 'Final retained answer',
        turn: expect.objectContaining({partial: true, uncertainties: ['Unobserved wakeup'], nextSteps: ['Inspect wakeup']})})]});
    expect(response.body).not.toHaveProperty('historyTurns');
    expect(response.body).not.toHaveProperty('activeRunId');
    expect(response.body.recommendedFullAnalysis).toBe(false);
    expect(response.body).not.toHaveProperty('fullHandoff');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({providerId: null, runtimeOverride: descriptor.runtimeKind}));
  });

  it('returns a boolean recommendation and a separate structured full handoff after reopening', async () => {
    const fullHandoff = {question: 'Compare scheduling before and after the stall', scope: 'Main-thread scheduling',
      assumptions: ['The process selection is unchanged'], evidence: [{id: 'finding-1', label: 'Observed scheduling delay'}]};
    storeSnapshot({lastOutcome: {kind: 'recommend_full', message: 'A full comparison would help.', handoff: fullHandoff}});
    const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(200);
    expect(response.body.recommendedFullAnalysis).toBe(true);
    expect(response.body.fullHandoff).toEqual(fullHandoff);
    expect(Array.isArray(response.body.fullHandoff.assumptions)).toBe(true);
    const handoff = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}/full-handoff`);
    expect(handoff.status).toBe(200);
    expect(handoff.body.handoff).toEqual(response.body.fullHandoff);
  });

  it('does not expose a structured full handoff from an unavailable historical source grant', async () => {
    storeSnapshot({lastRun: {...descriptor.lastRun, sourceDerived: true}, lastOutcome: {kind: 'recommend_full',
      message: 'PRIVATE_HANDOFF_ANSWER', handoff: {question: 'PRIVATE_HANDOFF_QUESTION', scope: 'PRIVATE_HANDOFF_SCOPE',
        assumptions: ['PRIVATE_HANDOFF_ASSUMPTION'], evidence: []}}},
    {sourceDerived: true, analysisContextFingerprint: 'previous-source-grant'});
    const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('recommendedFullAnalysis');
    expect(response.body).not.toHaveProperty('fullHandoff');
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_HANDOFF');
  });

  it('reopens an authorized private turn with its question under the owner view', async () => {
    const question = 'Why is Foo::bar slow here? api_key="conversation-secret-123456"';
    storeSnapshot({lastRun: {...descriptor.lastRun, query: question, sourceDerived: true}},
      {sourceDerived: true, analysisContextFingerprint: descriptor.analysisContextFingerprint});
    const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(200);
    // The stored question is the authorized original, read back by its creator
    // with only the credential withheld; source names stay readable.
    expect(response.body.history[0]).toMatchObject({role: 'user', sourceDerived: true,
      content: 'Why is Foo::bar slow here? api_key="[REDACTED_SECRET]"'});
    expect(JSON.stringify(response.body)).not.toContain('conversation-secret-123456');
    // What the model reads on a follow-up stays unrewritten.
    expect(getConversationSessionStore().listTurns(descriptor)[0].query).toBe(question);
  });

  it('does not hydrate or create an adapter for a different user in the same workspace', async () => {
    storeSnapshot();
    const response = await request(app('other-owner')).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Final retained answer');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['provider-missing', 'hash-changed', 'source-revoked'])(
    'fails closed before history hydration for %s', async failure => {
      storeSnapshot(failure === 'provider-missing' ? {providerId: 'deleted-provider-id'} :
        failure === 'hash-changed' ? {providerSnapshotHash: 'different-hash'} : {});
      const historyRead = jest.spyOn(getConversationSessionStore(), 'listTurns');
      if (failure === 'source-revoked') jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization')
        .mockImplementation(() => {throw new authorization.AnalysisContextAuthorizationChangedError();});
      const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
      expect(response.status).toBe(failure === 'provider-missing' ? 404 : 409);
      expect(JSON.stringify(response.body)).not.toContain('Final retained answer');
      expect(historyRead).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    });

  it('reopens a crashed running turn as interrupted without resurrecting a pending run', async () => {
    storeSnapshot({status: 'running', lastRun: {...descriptor.lastRun, status: 'running'}, lastOutcome: undefined});
    const response = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({status: 'failed', recoveryStatus: 'interrupted'});
    expect(response.body).not.toHaveProperty('activeRunId');
    expect(response.body.history).toEqual([expect.objectContaining({role: 'user', content: 'previous question'})]);
  });
  it.each([undefined, 'old-source-grant'])(
    'omits source history with unavailable original grant %s and blocks replay/control disclosure', async originalGrant => {
      storeSnapshot({status: 'awaiting_user', lastRun: {...descriptor.lastRun, sourceDerived: true},
        lastOutcome: {kind: 'needs_user_input', message: 'PRIVATE_SOURCE_ANSWER', question: 'PRIVATE_SOURCE_QUESTION'}},
      {sourceDerived: true, analysisContextFingerprint: originalGrant, query: 'PRIVATE_SOURCE_QUERY', answer: 'PRIVATE_SOURCE_ANSWER'});
      const view = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({history: [], historyUnavailableMessages: 2});
      expect(view.body).not.toHaveProperty('pendingQuestion');
      expect(JSON.stringify(view.body)).not.toMatch(/PRIVATE_SOURCE/);
      const streamed = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}/stream?runId=${descriptor.lastRun.runId}`);
      expect(streamed.status).toBe(409);
      expect(streamed.body.code).toBe('CONVERSATION_HISTORY_SOURCE_UNAVAILABLE');
      expect(JSON.stringify(streamed.body)).not.toMatch(/PRIVATE_SOURCE/);
      const handoff = await request(app()).get(`/api/agent/v1/conversation/${descriptor.sessionId}/full-handoff`);
      expect(handoff.status).toBe(409);
      expect(JSON.stringify(handoff.body)).not.toMatch(/PRIVATE_SOURCE/);
    });

});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {RunSupplementChannel, RUN_SUPPLEMENT_FLAG_ENV, RUN_SUPPLEMENT_MAX_BYTES, RUN_SUPPLEMENT_MAX_PER_RUN} from '../../agentRuntime/runSupplementChannel';
import * as rbac from '../../services/rbac';
import * as tenant from '../../services/enterpriseTenantLifecycleService';
import * as outputRegistry from '../../services/security/codeAwareOutputRegistry';
import {registerRunSupplementRoutes, type RunSupplementRouteDependencies} from '../agentRunSupplementRoutes';

const originalFlag = process.env[RUN_SUPPLEMENT_FLAG_ENV];
const originalAi = process.env.SMARTPERFETTO_AI_ENABLED;

interface FakeSession {
  sessionId: string;
  cancellationInFlightRunId?: string;
  runSupplementChannel?: RunSupplementChannel;
  activeRunId?: string;
  runs: Record<string, {runId: string; status: string}>;
  privateRun?: boolean;
}

function makeApp(session: FakeSession | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).requestContext = {tenantId: 't', workspaceId: 'w', userId: 'u', authType: 'dev', roles: ['analyst'], scopes: [], requestId: 'r'};
    next();
  });
  const deps: RunSupplementRouteDependencies<FakeSession> = {
    getAuthorizedSession: (_req, res) => {
      if (!session) { res.status(404).json({success: false, error: 'Session not found'}); return null; }
      return session;
    },
    resolveSessionRun: (value, runId) => value.runs[runId],
    isCurrentRunOwner: (value, runId) => value.activeRunId === runId,
    sessionRunHasPrivateContext: value => value.privateRun === true,
    sessionOutputLanguage: () => 'en',
  };
  const router = express.Router();
  registerRunSupplementRoutes(router, deps);
  app.use(router);
  return app;
}

function liveSession(overrides: Partial<FakeSession> = {}): FakeSession {
  const channel = new RunSupplementChannel({runId: 'run-1'});
  return {sessionId: 'session-1', activeRunId: 'run-1', runSupplementChannel: channel,
    runs: {'run-1': {runId: 'run-1', status: 'running'}}, ...overrides};
}

const url = (run = 'run-1') => `/sessions/session-1/runs/${run}/supplements`;
const validBody = {idempotencyKey: 'key-1', text: 'focus on the render thread'};

describe('POST /sessions/:sessionId/runs/:runId/supplements', () => {
  beforeEach(() => {
    process.env[RUN_SUPPLEMENT_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'true';
    jest.spyOn(rbac, 'hasRbacPermission').mockReturnValue(true);
    jest.spyOn(tenant, 'evaluateTenantMutationPolicy').mockReturnValue({allowed: true} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFlag === undefined) delete process.env[RUN_SUPPLEMENT_FLAG_ENV];
    else process.env[RUN_SUPPLEMENT_FLAG_ENV] = originalFlag;
    if (originalAi === undefined) delete process.env.SMARTPERFETTO_AI_ENABLED;
    else process.env.SMARTPERFETTO_AI_ENABLED = originalAi;
  });

  it('returns 202 with a receipt of ids and enums for a live run', async () => {
    const res = await request(makeApp(liveSession())).post(url()).send(validBody);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({receipt: {id: expect.any(String), runId: 'run-1', sequence: 1, state: 'classifying'}});
    expect(JSON.stringify(res.body)).not.toContain('render thread');
  });

  it('reports RUN_SUPPLEMENT_UNSUPPORTED when the flag is off, even for an invalid body', async () => {
    process.env[RUN_SUPPLEMENT_FLAG_ENV] = 'false';
    const res = await request(makeApp(liveSession())).post(url()).send({nonsense: true});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({success: false, code: 'RUN_SUPPLEMENT_UNSUPPORTED'});
  });

  it('enforces agent:run RBAC', async () => {
    jest.mocked(rbac.hasRbacPermission).mockReturnValue(false);
    const res = await request(makeApp(liveSession())).post(url()).send(validBody);
    expect(res.status).toBe(403);
  });

  it('applies the tenant mutation policy', async () => {
    jest.mocked(tenant.evaluateTenantMutationPolicy).mockReturnValue({allowed: false, httpStatus: 403, code: 'TENANT_READ_ONLY', message: 'denied'} as any);
    const res = await request(makeApp(liveSession())).post(url()).send(validBody);
    expect(res.status).toBe(403);
  });

  it('does not reach the channel for an unauthorized session', async () => {
    const res = await request(makeApp(null)).post(url()).send(validBody);
    expect(res.status).toBe(404);
  });

  it.each([
    ['extra field', {...validBody, sessionId: 'evil'}],
    ['missing key', {text: 'x'}],
    ['missing text', {idempotencyKey: 'k'}],
    ['blank text', {idempotencyKey: 'k', text: '   '}],
    ['non-string key', {idempotencyKey: 7, text: 'x'}],
    ['oversized key', {idempotencyKey: 'k'.repeat(200), text: 'x'}],
    ['key outside the id grammar', {idempotencyKey: 'has space', text: 'x'}],
    ['array body', ['x']],
  ])('rejects %s with RUN_SUPPLEMENT_INVALID_BODY', async (_name, body) => {
    const res = await request(makeApp(liveSession())).post(url()).send(body as any);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_INVALID_BODY');
  });

  it('rejects an oversized text with 413', async () => {
    const res = await request(makeApp(liveSession())).post(url()).send({idempotencyKey: 'k', text: 'x'.repeat(RUN_SUPPLEMENT_MAX_BYTES + 1)});
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_TOO_LARGE');
  });

  it('returns RUN_NOT_FOUND for an unknown run', async () => {
    const res = await request(makeApp(liveSession())).post(url('run-missing')).send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('never delivers to a successor run: a stale run id is RUN_NOT_ACTIVE', async () => {
    const session = liveSession({activeRunId: 'run-2', runs: {
      'run-1': {runId: 'run-1', status: 'completed'}, 'run-2': {runId: 'run-2', status: 'running'},
    }});
    session.runSupplementChannel = new RunSupplementChannel({runId: 'run-2'});
    const res = await request(makeApp(session)).post(url('run-1')).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_NOT_ACTIVE');
    expect(session.runSupplementChannel.receipts()).toHaveLength(0);
  });

  it('answers RUN_SUPPLEMENT_UNSUPPORTED for a current run with no channel (smart/scene/other runtime)', async () => {
    const session = liveSession({runSupplementChannel: undefined});
    const res = await request(makeApp(session)).post(url()).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_UNSUPPORTED');
  });

  it('answers RUN_SUPPLEMENT_UNSUPPORTED when the loaded module cannot steer', async () => {
    const session = liveSession();
    session.runSupplementChannel!.markUnsupported();
    const res = await request(makeApp(session)).post(url()).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_UNSUPPORTED');
  });

  it('answers CANCELLATION_IN_PROGRESS while the run is stopping', async () => {
    const session = liveSession({cancellationInFlightRunId: 'run-1'});
    const res = await request(makeApp(session)).post(url()).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCELLATION_IN_PROGRESS');
  });

  it('answers RUN_SUPPLEMENT_WINDOW_CLOSED after the main prompt closes the window', async () => {
    const session = liveSession();
    session.runSupplementChannel!.closeAcquisition('window_closed');
    const res = await request(makeApp(session)).post(url()).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_WINDOW_CLOSED');
  });

  it('answers RUN_NOT_ACTIVE after the run terminated, but replays an exact retry', async () => {
    const session = liveSession();
    const app = makeApp(session);
    const first = await request(app).post(url()).send(validBody);
    session.runSupplementChannel!.terminate('window_closed');
    const replay = await request(app).post(url()).send(validBody);
    expect(replay.status).toBe(202);
    expect(replay.body.receipt.id).toBe(first.body.receipt.id);
    const fresh = await request(app).post(url()).send({idempotencyKey: 'other', text: 'too late'});
    expect(fresh.status).toBe(409);
    expect(fresh.body.code).toBe('RUN_NOT_ACTIVE');
  });

  it('answers an idempotency-key conflict without creating a new supplement', async () => {
    const session = liveSession();
    const app = makeApp(session);
    await request(app).post(url()).send(validBody);
    const res = await request(app).post(url()).send({idempotencyKey: 'key-1', text: 'different'});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT');
    expect(session.runSupplementChannel!.receipts()).toHaveLength(1);
  });

  it('refuses a seventh supplement', async () => {
    const session = liveSession();
    const app = makeApp(session);
    for (let i = 0; i < RUN_SUPPLEMENT_MAX_PER_RUN; i++) {
      const res = await request(app).post(url()).send({idempotencyKey: `k${i}`, text: `note ${i}`});
      expect(res.status).toBe(202);
    }
    const res = await request(app).post(url()).send({idempotencyKey: 'overflow', text: 'x'});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_SUPPLEMENT_CAPACITY_EXCEEDED');
  });

  it('registers the private echo guard only for a private run', async () => {
    const register = jest.spyOn(outputRegistry, 'registerPrivateAnalysisQueryForEcho').mockImplementation(() => undefined);
    await request(makeApp(liveSession())).post(url()).send(validBody);
    expect(register).not.toHaveBeenCalled();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const body = {idempotencyKey: 'key-2', text: `token ${secret} in the note`};
    await request(makeApp(liveSession({privateRun: true}))).post(url()).send(body);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toBe('session-1');
    expect(register.mock.calls[0][1]).not.toContain(secret);
  });
});

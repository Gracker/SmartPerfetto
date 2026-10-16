// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'http';
import express from 'express';
import request from 'supertest';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';
import { authenticate, getRequestContext } from '../auth';
import { requestIdMiddleware, requestIdOf } from '../requestId';

const loopbackServers = createLoopbackServerFixture();

const GENERATED_ID = /^req-\d+-[0-9a-f]{8}$/;

function message(headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('requestIdOf', () => {
  it('prefers x-request-id, then x-correlation-id, then x-amzn-trace-id', () => {
    expect(requestIdOf(message({
      'x-request-id': 'request-a',
      'x-correlation-id': 'correlation-a',
      'x-amzn-trace-id': 'Root=1-abc',
    }))).toBe('request-a');
    expect(requestIdOf(message({
      'x-correlation-id': 'correlation-a',
      'x-amzn-trace-id': 'Root=1-abc',
    }))).toBe('correlation-a');
    expect(requestIdOf(message({ 'x-amzn-trace-id': 'Root=1-abc;Sampled=1' }))).toBe('Root1-abcSampled1');
  });

  it('sanitizes caller ids and skips a header that sanitizes to nothing', () => {
    expect(requestIdOf(message({ 'x-request-id': ' a b<\r\n>c ' }))).toBe('abc');
    expect(requestIdOf(message({ 'x-request-id': 'x'.repeat(200) }))).toHaveLength(128);
    expect(requestIdOf(message({ 'x-request-id': '<>', 'x-correlation-id': 'next' }))).toBe('next');
  });

  it('generates a random id when the caller sends none', () => {
    const first = requestIdOf(message());
    const second = requestIdOf(message());
    expect(first).toMatch(GENERATED_ID);
    expect(second).toMatch(GENERATED_ID);
    expect(first).not.toBe(second);
  });

  it('resolves a request once, whoever asks first', () => {
    const req = message();
    const id = requestIdOf(req);
    req.headers['x-request-id'] = 'arrived-later';
    expect(requestIdOf(req)).toBe(id);
  });
});

describe('requestIdMiddleware', () => {
  const originalApiKey = process.env.SMARTPERFETTO_API_KEY;

  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
  });

  afterEach(async () => {
    await loopbackServers.close();
    if (originalApiKey === undefined) delete process.env.SMARTPERFETTO_API_KEY;
    else process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  });

  /** Mirrors index.ts: the id first, authentication at the API mount and again inside a router. */
  async function makeApp() {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use('/api', authenticate);
    const router = express.Router();
    router.use(authenticate);
    router.post('/probe', (req, res) => {
      res.json({ contextId: getRequestContext(req)?.requestId, routeId: requestIdOf(req) });
    });
    app.use('/api/agent', router);
    return loopbackServers.listen(app);
  }

  it('gives the header, the request context and the route one generated id', async () => {
    const res = await request(await makeApp()).post('/api/agent/probe').send({ requestId: 'body-id' });

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(GENERATED_ID);
    expect(res.body).toEqual({
      contextId: res.headers['x-request-id'],
      routeId: res.headers['x-request-id'],
    });
  });

  it('echoes the caller id everywhere', async () => {
    const res = await request(await makeApp())
      .post('/api/agent/probe')
      .set('X-Correlation-Id', 'trace 42');

    expect(res.headers['x-request-id']).toBe('trace42');
    expect(res.body).toEqual({ contextId: 'trace42', routeId: 'trace42' });
  });

  it('sets the header on responses no route answers', async () => {
    const res = await request(await makeApp()).get('/missing').set('X-Request-Id', 'lost-1');

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('lost-1');
  });
});

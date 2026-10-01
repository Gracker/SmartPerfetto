// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';
import { UNHANDLED_ERROR_CODE, unhandledErrorHandler } from '../unhandledErrorHandler';

const CANARY = 'canary-7f3a /srv/secret/path.db SELECT * FROM provider_keys';

function canaryError(fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(CANARY), fields);
}

/** An app whose `/boom` route runs `before` and then throws `produce()`. */
function appThrowing(
  produce: () => unknown,
  before: (req: express.Request, res: express.Response) => void = () => undefined,
) {
  const app = express();
  app.use(express.json());
  app.post('/json', (_req, res) => res.json({ ok: true }));
  app.get('/boom', async (req, res) => {
    before(req, res);
    throw produce();
  });
  app.use(unhandledErrorHandler);
  return app;
}

describe('unhandledErrorHandler', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  function loggedText(): string {
    return errorLog.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : JSON.stringify(value)))
      .join('\n');
  }

  test('keeps the message and stack out of the response and in the log', async () => {
    const res = await request(appThrowing(() => canaryError())).get('/boom?token=abc');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      code: UNHANDLED_ERROR_CODE,
      error: 'Internal Server Error',
      requestId: expect.stringMatching(/^req-\d+-[0-9a-f]{8}$/),
    });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.text).not.toContain('canary-7f3a');
    expect(res.text).not.toContain('unhandledErrorHandler.test');

    const logged = loggedText();
    expect(logged).toContain(CANARY);
    expect(logged).toContain('unhandledErrorHandler.test');
    expect(logged).toContain(res.body.requestId);
    expect(logged).toContain('"path":"/boom"');
    expect(logged).not.toContain('token=abc');
  });

  test.each([
    [{ status: 404 }, 404, 'Not Found'],
    [{ statusCode: 413 }, 413, 'Payload Too Large'],
    [{ status: 503 }, 503, 'Service Unavailable'],
    [{ status: 499 }, 499, 'Request failed'],
    [{ status: 200 }, 500, 'Internal Server Error'],
    [{ status: 302 }, 500, 'Internal Server Error'],
    [{ status: 700 }, 500, 'Internal Server Error'],
    [{ status: '404' }, 500, 'Internal Server Error'],
  ])('maps error fields %j to status %i with fixed text', async (fields, status, text) => {
    const res = await request(appThrowing(() => canaryError(fields))).get('/boom');

    expect(res.status).toBe(status);
    expect(res.body.error).toBe(text);
    expect(res.text).not.toContain('canary-7f3a');
  });

  test.each([
    ['a string', () => CANARY],
    ['null', () => null],
  ])('answers a thrown %s without echoing it', async (_label, produce) => {
    const res = await request(appThrowing(produce)).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(UNHANDLED_ERROR_CODE);
    expect(res.text).not.toContain('canary-7f3a');
  });

  test('prefers an id the route already sent over the authenticated one', async () => {
    const res = await request(appThrowing(() => canaryError(), (req, res) => {
      (req as any).requestContext = { requestId: 'context-id' };
      res.setHeader('X-Request-Id', 'route-id');
    })).get('/boom');

    expect(res.body.requestId).toBe('route-id');
    expect(res.headers['x-request-id']).toBe('route-id');
  });

  test('reuses the authenticated request id', async () => {
    const res = await request(appThrowing(() => canaryError(), (req) => {
      (req as any).requestContext = { requestId: 'context-id' };
    })).get('/boom');

    expect(res.body.requestId).toBe('context-id');
    expect(res.headers['x-request-id']).toBe('context-id');
    expect(loggedText()).toContain('context-id');
  });

  test('keeps the raw body of a malformed JSON request out of the response and the log', async () => {
    const res = await request(appThrowing(() => canaryError()))
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', ' client <id> ')
      .send('{"secret": "canary-7f3a",');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: UNHANDLED_ERROR_CODE,
      error: 'Bad Request',
      requestId: 'clientid',
    });
    expect(res.text).not.toContain('canary-7f3a');
    const logged = loggedText();
    expect(logged).toContain('entity.parse.failed');
    expect(logged).not.toContain('canary-7f3a');
  });

  test('hands a started response to Express unchanged instead of writing a body', async () => {
    const thrown = canaryError();
    const forwarded: unknown[] = [];
    const app = appThrowing(() => thrown, (_req, res) => {
      res.status(200).write('partial');
    });
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      forwarded.push(err);
      res.end();
    });

    const text = await request(app).get('/boom').then((res) => res.text);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBe(thrown);
    expect(text).toBe('partial');
    expect(loggedText()).toContain('"headersSent":true');
  });
});

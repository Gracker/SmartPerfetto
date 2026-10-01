// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';
import { sendRouteFailure } from '../routeFailure';

const CANARY = 'canary-91c2 /srv/secret/reports.db SELECT key FROM provider_secrets';

function failingApp(before: (req: express.Request, res: express.Response) => void = () => undefined) {
  const app = express();
  app.get('/fail', (req, res) => {
    before(req, res);
    try {
      throw Object.assign(new Error(CANARY), {body: 'raw-request-body-canary'});
    } catch (error) {
      sendRouteFailure(res, {
        status: 503,
        code: 'thing_failed',
        error: 'Thing failed',
        logLabel: '[Test] Thing error',
      }, error);
    }
  });
  return app;
}

describe('sendRouteFailure', () => {
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

  test('answers fixed text and code; the message stays in the log under the request id', async () => {
    const res = await request(failingApp()).get('/fail?token=abc');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: 'thing_failed',
      error: 'Thing failed',
      requestId: expect.stringMatching(/^req-\d+-[0-9a-f]{8}$/),
    });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.text).not.toContain('canary-91c2');

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [label, meta] = errorLog.mock.calls[0];
    expect(label).toBe('[Test] Thing error');
    expect(meta).toEqual({
      requestId: res.body.requestId,
      method: 'GET',
      path: '/fail',
      status: 503,
      code: 'thing_failed',
      headersSent: false,
    });
    const logged = loggedText();
    expect(logged).toContain(CANARY);
    expect(logged).not.toContain('raw-request-body-canary');
    expect(logged).not.toContain('token=abc');
  });

  test('uses the request id resolved for the request', async () => {
    const res = await request(failingApp()).get('/fail').set('X-Request-Id', 'client-req-42');

    expect(res.body.requestId).toBe('client-req-42');
  });

  test('closes a response that already started instead of writing a body', async () => {
    let destroyed = false;
    const app = express();
    app.get('/stream', (_req, res) => {
      res.write('partial');
      sendRouteFailure(res, {code: 'stream_failed', error: 'Stream failed', logLabel: '[Test] Stream'}, new Error(CANARY));
      destroyed = res.destroyed;
    });

    await request(app).get('/stream').catch(() => undefined);

    expect(destroyed).toBe(true);
    expect(errorLog.mock.calls[0][1]).toMatchObject({headersSent: true, code: 'stream_failed'});
    expect(loggedText()).toContain(CANARY);
  });

  test('drops attachment and HTML headers the success path had set', async () => {
    const app = express();
    app.get('/download', (_req, res) => {
      res.attachment('report.html');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      sendRouteFailure(res, {code: 'download_failed', error: 'Download failed', logLabel: '[Test] Download'}, new Error(CANARY));
    });

    const res = await request(app).get('/download');

    expect(res.status).toBe(500);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.code).toBe('download_failed');
  });
});

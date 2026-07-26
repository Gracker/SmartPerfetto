// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {authenticate} from '../../middleware/auth';
import type {ApplicationUpdateStatus} from '../../services/applicationUpdate/types';
import {createApplicationUpdateRoutes} from '../applicationUpdateRoutes';

const originalEnv = {
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

const status: ApplicationUpdateStatus = {
  schemaVersion: 1,
  state: 'up_to_date',
  checkedAt: '2026-07-26T08:00:00.000Z',
  source: 'github-releases',
  current: {
    distribution: 'source',
    channel: 'stable',
    version: '1.2.2',
    target: {os: 'linux', arch: 'x64'},
    signingMode: 'source-checkout',
  },
  latest: {
    version: '1.2.2',
    releaseUrl: 'https://github.com/Gracker/SmartPerfetto/releases/tag/v1.2.2',
  },
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.SMARTPERFETTO_API_KEY;
  delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
});

afterEach(() => {
  restore(
    'SMARTPERFETTO_SSO_TRUSTED_HEADERS',
    originalEnv.trustedHeaders,
  );
  restore('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
});

describe('applicationUpdateRoutes', () => {
  it('returns cached status and performs an explicit refresh', async () => {
    const service = {
      getStatus: jest.fn(() => status),
      checkNow: jest.fn(
        async (
          _identity: typeof status.current,
          _options: {force?: boolean},
        ) => status,
      ),
    };
    const app = express();
    app.use(authenticate);
    app.use(
      '/api/application-update',
      createApplicationUpdateRoutes({service, identity: status.current}),
    );

    const getResponse = await request(app).get('/api/application-update/status');
    const postResponse = await request(app).post('/api/application-update/check');

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.state).toBe('up_to_date');
    expect(postResponse.status).toBe(200);
    expect(service.checkNow).toHaveBeenCalledWith(status.current, {force: true});
  });

  it('requires runtime:manage for trusted SSO users', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = '1';
    const app = express();
    app.use(authenticate);
    app.use(
      '/api/application-update',
      createApplicationUpdateRoutes({
        service: {
          getStatus: () => status,
          checkNow: async () => status,
        },
        identity: status.current,
      }),
    );

    const response = await request(app)
      .get('/api/application-update/status')
      .set('X-SmartPerfetto-SSO-User-Id', 'analyst')
      .set('X-SmartPerfetto-SSO-Roles', 'analyst')
      .set('X-SmartPerfetto-SSO-Scopes', 'trace:read');

    expect(response.status).toBe(403);
    expect(response.body.details).toContain('runtime:manage');
  });
});

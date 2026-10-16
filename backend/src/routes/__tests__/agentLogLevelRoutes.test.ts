// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { authenticate } from '../../middleware/auth';
import { getLogLevel, setLogLevel } from '../../utils/logger';
import { registerAgentLogsRoutes } from '../agentLogsRoutes';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(authenticate);
  registerAgentLogsRoutes(router);
  app.use('/api/agent/v1', router);
  return loopbackServers.listen(app);
}

function ssoHeaders(req: request.Test, role: string, scopes: string): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', `${role}-a`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', role)
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
}

describe('runtime log level routes', () => {
  afterEach(async () => {
    await loopbackServers.close();
    setLogLevel(null);
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  });

  describe('in enterprise mode', () => {
    beforeEach(() => {
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      delete process.env.SMARTPERFETTO_API_KEY;
    });

    it('refuses a caller without runtime:manage and leaves the level unchanged', async () => {
      const before = getLogLevel();
      const app = await makeApp();
      const put = await ssoHeaders(request(app).put('/api/agent/v1/admin/log-level'), 'analyst', 'profile')
        .send({level: 'debug'});
      expect(put.status).toBe(403);
      expect(put.body).toMatchObject({success: false, error: 'Forbidden', details: expect.stringContaining('runtime:manage')});
      expect(getLogLevel()).toBe(before);
      const get = await ssoHeaders(request(app).get('/api/agent/v1/admin/log-level'), 'analyst', 'profile');
      expect(get.status).toBe(403);
    });

    it('lets a runtime administrator read and set the level', async () => {
      const app = await makeApp();
      const put = await ssoHeaders(request(app).put('/api/agent/v1/admin/log-level'), 'org_admin', '*')
        .send({level: 'debug'});
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({success: true, level: 'debug'});
      const get = await ssoHeaders(request(app).get('/api/agent/v1/admin/log-level'), 'org_admin', '*');
      expect(get.body).toMatchObject({success: true, level: 'debug'});
    });
  });

  it('keeps the local single-user mode able to set the level', async () => {
    delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    delete process.env.SMARTPERFETTO_API_KEY;
    const response = await request(await makeApp()).put('/api/agent/v1/admin/log-level').send({level: 'warn'});
    expect(response.status).toBe(200);
    expect(getLogLevel()).toBe('warn');
  });
});

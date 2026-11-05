// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';
import {persistAnalysisRunState, resetAnalysisRunStoreForTests} from '../../services/analysisRunStore';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {registerAgentWorkCatalogRoutes} from '../agentWorkCatalogRoutes';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';
import type {AssistantWorkLiveReader} from '../../services/assistantWorkCatalogService';

const owner = {tenantId: 'catalog-route-tenant', workspaceId: 'catalog-route-workspace', userId: 'catalog-route-owner'};
const originalPath = process.env[ENTERPRISE_DB_PATH_ENV];
const servers = createLoopbackServerFixture();
let root: string;
let readLive: jest.MockedFunction<AssistantWorkLiveReader>;
async function app(userId = owner.userId, scopes = ['*']) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).requestContext = {...owner, userId, authType: 'dev', roles: [], scopes, requestId: 'work-test'};
    next();
  });
  const router = express.Router(); registerAgentWorkCatalogRoutes(router, readLive);
  app.use('/api/agent/v1', router); return servers.listen(app);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-work-route-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(root, 'enterprise.sqlite');
  readLive = jest.fn<AssistantWorkLiveReader>(() => undefined);
  persistAnalysisRunState({...owner, sessionId: 'work-session', runId: 'work-run', traceId: 'work-trace',
    privateContext: NO_PRIVATE_CONTEXT, query: 'PRIVATE_QUERY'}, 'completed', {now: 100});
});
afterEach(async () => {
  await servers.close(); resetAnalysisRunStoreForTests();
  if (originalPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV]; else process.env[ENTERPRISE_DB_PATH_ENV] = originalPath;
  fs.rmSync(root, {recursive: true, force: true});
});
describe('agent work catalog route', () => {
  it('uses the authenticated owner and returns only navigation metadata', async () => {
    const response = await request(await app()).get('/api/agent/v1/work?userId=someone-else');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.text).not.toMatch(/PRIVATE_QUERY|work-trace|provider|sourceSelection/);
    expect(readLive).toHaveBeenCalledWith(owner, 'work-session', 'work-run');
    const foreign = await request(await app('foreign-user')).get('/api/agent/v1/work');
    expect(foreign.body.items).toEqual([]);
    expect(readLive).toHaveBeenCalledTimes(1);
  });
  it('requires agent access and validates bounded input', async () => {
    expect((await request(await app(owner.userId, [])).get('/api/agent/v1/work')).status).toBe(403);
    expect((await request(await app()).get('/api/agent/v1/work?limit=500')).status).toBe(400);
    expect((await request(await app()).get('/api/agent/v1/work?cursor=bad')).status).toBe(400);
    expect(readLive).not.toHaveBeenCalled();
  });
  it('does not turn a failed metadata read into a successful empty catalog', async () => {
    readLive.mockImplementation(() => {throw new Error('PRIVATE_INTERNAL_DETAIL');});
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request(await app()).get('/api/agent/v1/work');
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.text).not.toContain('PRIVATE_INTERNAL_DETAIL');
    } finally {errorLog.mockRestore();}
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import skillAdminRoutes from '../skillAdminRoutes';
import strategyAdminRoutes from '../strategyAdminRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', skillAdminRoutes);
  app.use('/api/admin', strategyAdminRoutes);
  // Another router on the same prefix, as index.ts mounts Self-Evolution admin.
  app.get('/api/admin/later-router', (_req, res) => { res.json({reached: true}); });
  return app;
}

function roleHeaders(req: request.Test, role: string): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', `${role}-a`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', role)
    // A scope that grants nothing, so only the role decides (no header falls back to default scopes).
    .set('X-SmartPerfetto-SSO-Scopes', 'profile');
}

const VALID_YAML = [
  'name: validation_only_skill',
  'version: "1"',
  'meta:',
  '  display_name: Validation Only Skill',
  '  description: Validates without persisting',
  'steps:',
  '  - id: rows',
  '    type: atomic',
  '    sql: SELECT 1 AS value',
  '',
].join('\n');

function adminHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'org_admin')
    .set('X-SmartPerfetto-SSO-Scopes', '*');
}

describe('skill admin enterprise guard', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    app = makeApp();
  });

  afterEach(() => {
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  });

  it('disables custom skill write endpoints in enterprise mode', async () => {
    const create = await adminHeaders(request(app).post('/api/admin/skills'))
      .send({ yaml: 'name: custom_skill\nversion: "1"\nsteps: []\n' })
      .expect(404);
    expect(create.body).toMatchObject({
      error: 'disabled_in_enterprise_mode',
    });

    const update = await adminHeaders(request(app).put('/api/admin/skills/custom_skill'))
      .send({ yaml: 'name: custom_skill\nversion: "2"\nsteps: []\n' })
      .expect(404);
    expect(update.body).toMatchObject({
      error: 'disabled_in_enterprise_mode',
    });

    const remove = await adminHeaders(request(app).delete('/api/admin/skills/custom_skill'))
      .expect(404);
    expect(remove.body).toMatchObject({
      error: 'disabled_in_enterprise_mode',
    });
  });

  it('keeps non-writing validation available in enterprise mode', async () => {

    const res = await adminHeaders(request(app).post('/api/admin/skills/validate'))
      .send({ yaml: VALID_YAML })
      .expect(200);

    expect(res.body).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});

describe('skill and strategy admin permissions', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    app = makeApp();
  });

  afterEach(() => {
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  });

  it('lets an analyst list the Skill catalog but not read, validate or reload Skill content', async () => {
    const list = await roleHeaders(request(app).get('/api/admin/skills'), 'analyst').expect(200);
    expect(list.body.count).toBeGreaterThan(0);
    await roleHeaders(request(app).get('/api/admin/vendors'), 'analyst').expect(200);

    // Built one at a time: a supertest request starts its server when constructed.
    const denied = [
      () => roleHeaders(request(app).get('/api/admin/skills/startup_analysis'), 'analyst'),
      () => roleHeaders(request(app).get('/api/admin/vendors/pixel/overrides'), 'analyst'),
      () => roleHeaders(request(app).post('/api/admin/skills/validate'), 'analyst').send({yaml: VALID_YAML}),
      () => roleHeaders(request(app).post('/api/admin/skills/reload'), 'analyst'),
      () => roleHeaders(request(app).post('/api/admin/strategies/reload'), 'analyst'),
    ];
    const responses = [];
    for (const send of denied) {
      const res = await send();
      responses.push({status: res.status, body: res.body});
    }
    expect(responses).toEqual(denied.map(() => ({status: 403,
      body: {success: false, error: 'Forbidden', details: expect.stringContaining('runtime:manage')}})));
  });

  it('keeps the catalog from a viewer, who cannot run the agent', async () => {
    const res = await roleHeaders(request(app).get('/api/admin/skills'), 'viewer').expect(403);
    expect(res.body.details).toContain('agent:run');
  });

  it('gives a runtime manager every operation and names Skill files relative to the Skills root', async () => {
    const skill = await roleHeaders(request(app).get('/api/admin/skills/startup_analysis'), 'workspace_admin')
      .expect(200);
    expect(skill.body).toMatchObject({
      id: 'startup_analysis',
      filePath: 'composite/startup_analysis.skill.yaml',
      isCustom: false,
      isEditable: false,
    });
    expect(skill.body.rawYaml).toContain('name: startup_analysis');
    expect(skill.text).not.toContain(process.cwd());

    await roleHeaders(request(app).get('/api/admin/vendors/pixel/overrides'), 'workspace_admin').expect(200);
    await roleHeaders(request(app).post('/api/admin/skills/validate'), 'workspace_admin')
      .send({yaml: VALID_YAML}).expect(200);
    await roleHeaders(request(app).post('/api/admin/skills/reload'), 'workspace_admin').expect(200);
    await roleHeaders(request(app).post('/api/admin/strategies/reload'), 'workspace_admin').expect(200);
  });

  it('gates per route, so a router mounted later on the same prefix is not gated by these permissions', async () => {
    const res = await roleHeaders(request(app).get('/api/admin/later-router'), 'viewer').expect(200);
    expect(res.body).toEqual({reached: true});
  });

  it('names no vendor outside the vendors directory', async () => {
    const res = await roleHeaders(request(app).get('/api/admin/vendors/..%2F..%2Fcomposite/overrides'), 'workspace_admin');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({error: 'Vendor not found'});
  });
});

describe('skill and strategy admin in keyless local mode', () => {
  beforeEach(() => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
    delete process.env.SMARTPERFETTO_API_KEY;
  });

  afterEach(() => {
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  });

  it('keeps every operation available to the single local user', async () => {
    const app = makeApp();
    await request(app).get('/api/admin/skills').expect(200);
    const skill = await request(app).get('/api/admin/skills/startup_analysis').expect(200);
    expect(skill.body.filePath).toBe('composite/startup_analysis.skill.yaml');
    await request(app).post('/api/admin/skills/validate').send({yaml: VALID_YAML}).expect(200);
    await request(app).post('/api/admin/skills/reload').expect(200);
    await request(app).post('/api/admin/strategies/reload').expect(200);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import request from 'supertest';
import express from 'express';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { resetProviderService } from '../index';

describe('Provider Routes', () => {
  let app: express.Express;
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `provider-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    resetProviderService();

    const { default: providerRoutes } = await import('../../../routes/providerRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/providers', providerRoutes);
  });

  afterEach(async () => {
    delete process.env.PROVIDER_DATA_DIR_OVERRIDE;
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('GET /api/v1/providers returns empty list initially', async () => {
    const res = await request(app).get('/api/v1/providers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers).toEqual([]);
  });

  it('GET /api/v1/providers/templates returns official templates', async () => {
    const res = await request(app).get('/api/v1/providers/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.length).toBeGreaterThan(0);
    expect(res.body.templates[0].type).toBe('anthropic');
  });

  it('POST + GET + DELETE lifecycle', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'Test',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { apiKey: 'sk-test-key-12345678' },
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;

    const getRes = await request(app).get(`/api/v1/providers/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.provider.connection.apiKey).toMatch(/^\*{4}/);

    const deleteRes = await request(app).delete(`/api/v1/providers/${id}`);
    expect(deleteRes.status).toBe(200);
  });

  it('POST /:id/activate sets active', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'Activate Me',
      category: 'official',
      type: 'bedrock',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { awsRegion: 'us-east-1', awsBearerToken: 'tok' },
    });
    const id = createRes.body.provider.id;

    const activateRes = await request(app).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(app).get('/api/v1/providers/effective');
    expect(effectiveRes.body.source).toBe('provider-manager');
  });
});

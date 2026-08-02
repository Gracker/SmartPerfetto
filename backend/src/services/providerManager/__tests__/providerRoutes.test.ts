// SPDX-License-Identifier: AGPL-3.0-or-later

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../../config';
import { listEnterpriseAuditEvents } from '../../enterpriseAuditService';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../enterpriseDb';
import { authenticate } from '../../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../../middleware/workspaceRouteContext';
import {
  SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV,
  SECRET_STORE_DIR_ENV,
} from '../localSecretStore';
import { resetProviderService } from '../index';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  secretStoreDir: process.env[SECRET_STORE_DIR_ENV],
  allowLocalMasterKey: process.env[SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  aiEnabled: process.env.SMARTPERFETTO_AI_ENABLED,
};

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
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
    restoreEnvValue(SECRET_STORE_DIR_ENV, originalEnv.secretStoreDir);
    restoreEnvValue(SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV, originalEnv.allowLocalMasterKey);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
    restoreEnvValue('SMARTPERFETTO_AI_ENABLED', originalEnv.aiEnabled);
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function restoreEnvValue(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  function ssoHeaders(
    req: request.Test,
    input: {
      userId?: string;
      role?: string;
      scopes?: string;
    } = {},
  ): request.Test {
    const userId = input.userId ?? 'provider-admin';
    return req
      .set('X-SmartPerfetto-SSO-User-Id', userId)
      .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
      .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
      .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
      .set('X-SmartPerfetto-SSO-Roles', input.role ?? 'workspace_admin')
      .set('X-SmartPerfetto-SSO-Scopes', input.scopes ?? 'provider:write,audit:read');
  }

  function readEnterpriseAuditActions(dbPath: string): string[] {
    const db = openEnterpriseDb(dbPath);
    try {
      return listEnterpriseAuditEvents(db).map(event => event.action);
    } finally {
      db.close();
    }
  }

  it('GET /api/v1/providers returns empty list initially', async () => {
    const res = await request(app).get('/api/v1/providers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers).toEqual([]);
  });

  it('GET /api/v1/providers/templates returns provider templates including custom runtime entry', async () => {
    const res = await request(app).get('/api/v1/providers/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.length).toBeGreaterThan(0);
    expect(res.body.templates[0].type).toBe('anthropic');
    const xiaomi = res.body.templates.find((template: { type: string }) => template.type === 'xiaomi');
    expect(xiaomi.defaultConnection.claudeBaseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/anthropic');
    expect(xiaomi.defaultConnection.openaiBaseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    const custom = res.body.templates.find((template: { type: string }) => template.type === 'custom');
    expect(custom).toMatchObject({
      displayName: 'Custom Provider',
      requiredFields: [],
      defaultModels: { primary: '', light: '' },
      availableModels: [],
      defaultConnection: { agentRuntime: 'claude-agent-sdk' },
    });
  });

  it('requires provider management permission for provider access in enterprise SSO', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;

    const analystRes = await ssoHeaders(
      request(app).get('/api/v1/providers'),
      { userId: 'provider-analyst', role: 'analyst', scopes: 'trace:read,report:read' },
    );
    expect(analystRes.status).toBe(403);
    expect(analystRes.body.details).toContain('Provider management requires provider:manage_workspace permission');

    const adminRes = await ssoHeaders(request(app).get('/api/v1/providers/templates'));
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
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

  it('POST /:id/runtime switches provider SDK runtime', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'DeepSeek Dual',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        apiKey: 'sk-deepseek-test',
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://api.deepseek.com/anthropic',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });
    const id = createRes.body.provider.id;

    const runtimeRes = await request(app)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'openai-agents-sdk' });

    expect(runtimeRes.status).toBe(200);
    expect(runtimeRes.body.provider.connection.agentRuntime).toBe('openai-agents-sdk');
  });

  it('POST /:id/runtime rejects unsupported SDK runtime for provider type', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'Anthropic Only',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { claudeApiKey: 'sk-test-key-12345678' },
    });
    const id = createRes.body.provider.id;

    const runtimeRes = await request(app)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'openai-agents-sdk' });

    expect(runtimeRes.status).toBe(400);
    expect(runtimeRes.body.error).toMatch(/does not support openai-agents-sdk/);
  });

  it('POST /:id/runtime rejects public Pi runtime for non-custom providers', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'DeepSeek Dual',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        apiKey: 'sk-deepseek-test',
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://api.deepseek.com/anthropic',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });
    const id = createRes.body.provider.id;

    const runtimeRes = await request(app)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'pi-agent-core' });

    expect(runtimeRes.status).toBe(400);
    expect(runtimeRes.body.error).toMatch(/does not support pi-agent-core/);
  });

  it('keeps provider configuration available but blocks connection tests when AI is disabled', async () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'Disabled Test Provider',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        apiKey: 'sk-disabled-provider',
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;
    expect(await request(app).get(`/api/v1/providers/${id}`)).toHaveProperty('status', 200);
    expect(await request(app).post(`/api/v1/providers/${id}/activate`)).toHaveProperty('status', 200);

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const testRes = await request(app).post(`/api/v1/providers/${id}/test`);
      expect(testRes.status).toBe(403);
      expect(testRes.body).toMatchObject({
        success: false,
        code: 'AI_DISABLED',
        feature: 'provider_test',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('creates and activates custom Pi agent-core providers without exposing model JSON', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'Pi Custom',
      category: 'custom',
      type: 'custom',
      models: { primary: 'pi-model', light: 'pi-light' },
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModulePath: '/tmp/pi-agent-core/dist/index.js',
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test","apiKey":"sk-pi-secret"}',
        piAgentCoreSystemPrompt: 'Runtime-only Pi prompt',
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.provider.connection.agentRuntime).toBe('pi-agent-core');
    expect(createRes.body.provider.connection.piAgentCoreModelJson).toMatch(/^\*{4}/);
    expect(JSON.stringify(createRes.body)).not.toContain('sk-pi-secret');

    const id = createRes.body.provider.id;
    const activateRes = await request(app).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(app).get('/api/v1/providers/effective');
    expect(effectiveRes.status).toBe(200);
    expect(effectiveRes.body.provider.connection.agentRuntime).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_AGENT_RUNTIME).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toMatch(/^\*{4}/);
    expect(JSON.stringify(effectiveRes.body)).not.toContain('sk-pi-secret');
  });

  it('creates and activates custom OpenCode providers without exposing model JSON', async () => {
    const createRes = await request(app).post('/api/v1/providers').send({
      name: 'OpenCode Custom',
      category: 'custom',
      type: 'custom',
      models: { primary: 'opencode-model', light: 'opencode-light' },
      connection: {
        agentRuntime: 'opencode',
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: 'sk-opencode-openai',
        openaiProtocol: 'chat_completions',
        openCodeSdkModulePath: '/tmp/opencode-sdk/dist/index.js',
        openCodeModelJson: '{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-secret"}',
        openCodeSystemPrompt: 'Runtime-only OpenCode prompt',
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.provider.connection.agentRuntime).toBe('opencode');
    expect(createRes.body.provider.connection.openCodeModelJson).toMatch(/^\*{4}/);
    expect(JSON.stringify(createRes.body)).not.toContain('sk-opencode-secret');

    const id = createRes.body.provider.id;
    const activateRes = await request(app).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(app).get('/api/v1/providers/effective');
    expect(effectiveRes.status).toBe(200);
    expect(effectiveRes.body.provider.connection.agentRuntime).toBe('opencode');
    expect(effectiveRes.body.env.SMARTPERFETTO_AGENT_RUNTIME).toBe('opencode');
    expect(effectiveRes.body.env.SMARTPERFETTO_OPENCODE_MODEL_JSON).toMatch(/^\*{4}/);
    expect(effectiveRes.body.env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH).toBe('/tmp/opencode-sdk/dist/index.js');
    expect(JSON.stringify(effectiveRes.body)).not.toContain('sk-opencode-secret');
  });

  it('records enterprise audit events for provider management actions', async () => {
    const dbPath = path.join(dir, 'enterprise.sqlite');
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env[SECRET_STORE_DIR_ENV] = path.join(dir, 'secrets');
    process.env[SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV] = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    resetProviderService();

    const createRes = await ssoHeaders(request(app).post('/api/v1/providers')).send({
      name: 'Audited DeepSeek',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        apiKey: 'sk-deepseek-audit',
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://api.deepseek.com/anthropic',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;

    expect(await ssoHeaders(request(app).get(`/api/v1/providers/${id}`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(app).patch(`/api/v1/providers/${id}`)).send({
      name: 'Audited DeepSeek Updated',
    })).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(app).post(`/api/v1/providers/${id}/activate`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(app).post(`/api/v1/providers/${id}/runtime`)).send({
      agentRuntime: 'openai-agents-sdk',
    })).toHaveProperty('status', 200);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      expect(await ssoHeaders(request(app).post(`/api/v1/providers/${id}/test`))).toHaveProperty('status', 200);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await ssoHeaders(request(app).post(`/api/v1/providers/${id}/rotate-secret`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(app).post('/api/v1/providers/deactivate'))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(app).delete(`/api/v1/providers/${id}`))).toHaveProperty('status', 200);

    expect(readEnterpriseAuditActions(dbPath)).toEqual(expect.arrayContaining([
      'provider.created',
      'provider.read',
      'provider.updated',
      'provider.activated',
      'provider.runtime_switched',
      'provider.connection_tested',
      'provider.secret_rotated',
      'provider.deactivated',
      'provider.deleted',
    ]));
  });

  it('uses workspace scope for workspace provider routes', async () => {
    const dbPath = path.join(dir, 'enterprise.sqlite');
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env[SECRET_STORE_DIR_ENV] = path.join(dir, 'secrets');
    process.env[SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV] = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    resetProviderService();

    const { default: workspaceProviderRoutes } = await import('../../../routes/providerRoutes');
    const workspaceApp = express();
    workspaceApp.use(express.json());
    workspaceApp.use(
      '/api/workspaces/:workspaceId/providers',
      bindWorkspaceRouteContext,
      authenticate,
      requireWorkspaceRouteContext,
      workspaceProviderRoutes,
    );

    const createRes = await ssoHeaders(
      request(workspaceApp).post('/api/workspaces/workspace-a/providers'),
    ).send({
      name: 'Workspace OpenAI',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-workspace-route',
      },
    });

    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;
    expect(await ssoHeaders(
      request(workspaceApp).post(`/api/workspaces/workspace-a/providers/${id}/activate`),
    )).toHaveProperty('status', 200);

    const db = openEnterpriseDb(dbPath);
    try {
      const row = db.prepare(`
        SELECT scope, owner_user_id, policy_json
        FROM provider_credentials
        WHERE id = ?
      `).get(id) as { scope: string; owner_user_id: string | null; policy_json: string };
      expect(row.scope).toBe('workspace');
      expect(row.owner_user_id).toBeNull();
      expect(JSON.parse(row.policy_json).isActive).toBe(true);
    } finally {
      db.close();
    }
  });

  it('preserves inherited org provider mutation behavior outside OIDC', async () => {
    const dbPath = path.join(dir, 'enterprise.sqlite');
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env[SECRET_STORE_DIR_ENV] = path.join(dir, 'secrets');
    process.env[SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV] = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    resetProviderService();

    const { default: workspaceProviderRoutes } = await import('../../../routes/providerRoutes');
    const workspaceApp = express();
    workspaceApp.use(express.json());
    workspaceApp.use(
      '/api/workspaces/:workspaceId/providers',
      bindWorkspaceRouteContext,
      authenticate,
      requireWorkspaceRouteContext,
      workspaceProviderRoutes,
    );

    const createRes = await ssoHeaders(
      request(workspaceApp).post('/api/workspaces/workspace-a/providers'),
    ).send({
      name: 'Organization Default',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-org-provider',
      },
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;

    const db = openEnterpriseDb(dbPath);
    try {
      db.prepare(`
        UPDATE provider_credentials
        SET scope = 'org', workspace_id = NULL, owner_user_id = NULL
        WHERE id = ?
      `).run(id);
    } finally {
      db.close();
    }

    const inherited = await ssoHeaders(
      request(workspaceApp).get(`/api/workspaces/workspace-a/providers/${id}`),
    );
    expect(inherited.status).toBe(200);

    const update = await ssoHeaders(request(workspaceApp)
      .patch(`/api/workspaces/workspace-a/providers/${id}`))
      .send({name: 'Updated Outside OIDC'});
    expect(update.status).toBe(200);

    const verifyDb = openEnterpriseDb(dbPath);
    try {
      const row = verifyDb.prepare(`
        SELECT scope, workspace_id, name, policy_json
        FROM provider_credentials
        WHERE id = ?
      `).get(id) as {
        scope: string;
        workspace_id: string | null;
        name: string;
        policy_json: string;
      };
      expect(row).toMatchObject({
        scope: 'org',
        workspace_id: null,
        name: 'Updated Outside OIDC',
      });
      expect(JSON.parse(row.policy_json).isActive).toBe(false);
    } finally {
      verifyDb.close();
    }
  });
});

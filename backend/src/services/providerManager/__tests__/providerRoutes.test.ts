// SPDX-License-Identifier: AGPL-3.0-or-later

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import {createServer, type Server} from 'http';
import {createLoopbackServerFixture} from '../../../../tests/helpers/loopbackServer';
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
import { PI_CATALOG_ROUTES } from '../providerTypes';
import { previousProviderAgentRuntime } from '../providerRuntimeMatrix';
import type { ProviderType } from '../types';

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
  const loopbackServers = createLoopbackServerFixture();
  let appServer: Server;
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `provider-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    resetProviderService();

    const { default: providerRoutes } = await import('../../../routes/providerRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/providers', providerRoutes);
    appServer = await loopbackServers.listen(app);
  });

  afterEach(async () => {
    await loopbackServers.close();
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

  it('refuses a local AI tool scan or import without a local page origin', async () => {
    for (const route of ['scan', 'import']) {
      const res = await request(appServer).post(`/api/v1/providers/local-import/${route}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('LOCAL_AI_IMPORT_UNAVAILABLE');
    }
    const foreign = await request(appServer)
      .post('/api/v1/providers/local-import/scan')
      .set('Origin', 'https://attacker.example.com')
      .send({});
    expect(foreign.status).toBe(403);
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
    const res = await request(appServer).get('/api/v1/providers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers).toEqual([]);
  });

  it('serves the API with an unreadable providers.json, refuses writes, and never echoes the file', async () => {
    const canary = 'sk-canary-route-5e8c1d';
    const broken = `[{"id":"kept","isActive":true,"models":{},"connection":{"apiKey":"${canary}"}}`;
    const file = path.join(dir, 'providers.json');
    await fsp.writeFile(file, broken);
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const)
      .map(method => jest.spyOn(console, method).mockImplementation(() => undefined));
    const bodies: string[] = [];
    try {
      const list = await request(appServer).get('/api/v1/providers');
      expect(list.status).toBe(200);
      expect(list.body.providers).toEqual([]);
      expect(list.body.store).toEqual({status: 'unreadable', code: 'provider_store_unreadable'});
      bodies.push(list.text);

      const effective = await request(appServer).get('/api/v1/providers/effective');
      expect(effective.status).toBe(200);
      expect(effective.body.store.status).toBe('unreadable');
      // Analyses that follow the active provider are refused, so neither the
      // provider nor the env fallback is the effective source.
      expect(effective.body.source).toBe('provider-store-unreadable');
      expect(effective.body.provider).toBeNull();
      bodies.push(effective.text);

      const writes: Array<() => request.Test> = [
        () => request(appServer).post('/api/v1/providers').send({
          name: 'New',
          category: 'official',
          type: 'anthropic',
          models: {primary: 'claude-sonnet-5', light: 'claude-haiku-4-5'},
          connection: {apiKey: 'sk-new'},
        }),
        () => request(appServer).patch('/api/v1/providers/kept').send({name: 'Renamed'}),
        () => request(appServer).delete('/api/v1/providers/kept'),
        () => request(appServer).post('/api/v1/providers/kept/activate'),
        () => request(appServer).post('/api/v1/providers/deactivate'),
        () => request(appServer).post('/api/v1/providers/kept/runtime').send({agentRuntime: 'openai-agents-sdk'}),
        () => request(appServer).post('/api/v1/providers/kept/rotate-secret'),
      ];
      for (const write of writes) {
        const res = await write();
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({success: false, code: 'provider_store_unreadable'});
        bodies.push(res.text);
      }
      expect(await fsp.readFile(file, 'utf-8')).toBe(broken);

      const consoleOutput = JSON.stringify(consoleSpies.map(spy => spy.mock.calls));
      for (const text of [...bodies, consoleOutput]) {
        expect(text).not.toContain(canary);
      }

      await fsp.writeFile(file, JSON.stringify([{
        id: 'kept',
        name: 'Kept',
        category: 'official',
        type: 'anthropic',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        models: {primary: 'claude-sonnet-5', light: 'claude-haiku-4-5'},
        connection: {apiKey: 'sk-repaired-key'},
      }]));
      const repaired = await request(appServer).get('/api/v1/providers');
      expect(repaired.body.store).toEqual({status: 'ok'});
      expect(repaired.body.providers.map((p: {id: string}) => p.id)).toEqual(['kept']);
      const renamed = await request(appServer).patch('/api/v1/providers/kept').send({name: 'Renamed'});
      expect(renamed.status).toBe(200);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('GET /api/v1/providers/templates returns provider templates including custom runtime entry', async () => {
    const res = await request(appServer).get('/api/v1/providers/templates');
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
      defaultConnection: { agentRuntime: 'pi-agent-core' },
    });
    // Each template carries the runtimes its type may select: Pi only. The hidden
    // legacy engines are never offered, and no template defaults to a retired runtime.
    for (const template of res.body.templates as Array<{type: string; supportedRuntimes: string[];
      defaultConnection?: {agentRuntime?: string}}>) {
      expect(template.supportedRuntimes).toEqual(['pi-agent-core']);
      expect([undefined, 'pi-agent-core']).toContain(template.defaultConnection?.agentRuntime);
    }
  });

  it('lists each provider with the runtimes its type may select', async () => {
    await request(appServer).post('/api/v1/providers').send({
      name: 'DeepSeek Pi', category: 'official', type: 'deepseek',
      models: {primary: 'deepseek-flash', light: 'deepseek-flash'},
      connection: {apiKey: 'sk-deepseek-test', agentRuntime: 'pi-agent-core'},
    });
    const res = await request(appServer).get('/api/v1/providers');
    expect(res.status).toBe(200);
    const provider = res.body.providers.find((item: {name: string}) => item.name === 'DeepSeek Pi');
    expect(provider.supportedRuntimes).toEqual(['pi-agent-core']);
    expect(JSON.stringify(provider)).not.toContain('sk-deepseek-test');
  });

  it('keeps live model suggestions isolated to the saved provider ID', async () => {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/models') {
        res.writeHead(404).end();
        return;
      }
      const model = req.headers.authorization === 'Bearer secret-a'
        ? 'gpt-live-model-a'
        : req.headers.authorization === 'Bearer secret-b'
          ? 'gpt-live-model-b'
          : undefined;
      if (!model) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({data: [{id: model}]}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const createProvider = (name: string, apiKey: string) =>
        request(appServer).post('/api/v1/providers').send({
        name,
        category: 'official',
        type: 'openai',
        models: {primary: 'gpt-5.6-terra', light: 'gpt-5.6-luna'},
        connection: {
          openaiApiKey: apiKey,
          openaiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          openaiProtocol: 'responses',
        },
      });
      const providerA = await createProvider('Catalog A', 'secret-a');
      const providerB = await createProvider('Catalog B', 'secret-b');
      expect(providerA.status).toBe(201);
      expect(providerB.status).toBe(201);

      const [modelsA, modelsB] = await Promise.all([
        request(appServer).get(`/api/v1/providers/${providerA.body.provider.id}/models`),
        request(appServer).get(`/api/v1/providers/${providerB.body.provider.id}/models`),
      ]);
      expect(modelsA.status).toBe(200);
      expect(modelsB.status).toBe(200);
      expect(modelsA.body.models).toContainEqual({
        id: 'gpt-live-model-a',
        name: 'gpt-live-model-a',
        tier: 'primary',
      });
      expect(modelsA.body.models).not.toContainEqual(
        expect.objectContaining({id: 'gpt-live-model-b'}),
      );
      expect(modelsB.body.models).toContainEqual(
        expect.objectContaining({id: 'gpt-live-model-b'}),
      );
      expect(modelsB.body.models).not.toContainEqual(
        expect.objectContaining({id: 'gpt-live-model-a'}),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it('requires provider management permission for provider access in enterprise SSO', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;

    const analystRes = await ssoHeaders(
      request(appServer).get('/api/v1/providers'),
      { userId: 'provider-analyst', role: 'analyst', scopes: 'trace:read,report:read' },
    );
    expect(analystRes.status).toBe(403);
    expect(analystRes.body.details).toContain('Provider management requires provider:manage_workspace permission');

    const adminRes = await ssoHeaders(request(appServer).get('/api/v1/providers/templates'));
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
  });

  it('POST + GET + DELETE lifecycle', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
      name: 'Test',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { apiKey: 'sk-test-key-12345678' },
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.provider.id;

    const getRes = await request(appServer).get(`/api/v1/providers/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.provider.connection.apiKey).toMatch(/^\*{4}/);

    const deleteRes = await request(appServer).delete(`/api/v1/providers/${id}`);
    expect(deleteRes.status).toBe(200);
  });

  it('POST /:id/activate sets active', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
      name: 'Activate Me',
      category: 'official',
      type: 'bedrock',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { awsRegion: 'us-east-1', awsBearerToken: 'tok' },
    });
    const id = createRes.body.provider.id;

    const activateRes = await request(appServer).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(appServer).get('/api/v1/providers/effective');
    expect(effectiveRes.body.source).toBe('provider-manager');
  });

  it('POST /:id/runtime accepts a retired runtime and lands on Pi on that runtime\'s endpoint', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
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

    const runtimeRes = await request(appServer)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'openai-agents-sdk' });

    expect(runtimeRes.status).toBe(200);
    expect(runtimeRes.body.provider.connection).toMatchObject({agentRuntime: 'pi-agent-core', apiSurface: 'openai'});
    expect(runtimeRes.body.provider.supportedRuntimes).toEqual(['pi-agent-core']);
  });

  it('POST /:id/runtime rejects unsupported SDK runtime for provider type', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
      name: 'Anthropic Only',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
      connection: { claudeApiKey: 'sk-test-key-12345678' },
    });
    const id = createRes.body.provider.id;

    const runtimeRes = await request(appServer)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'openai-agents-sdk' });

    expect(runtimeRes.status).toBe(400);
    expect(runtimeRes.body.error).toMatch(/does not support openai-agents-sdk/);
  });

  it('POST /:id/runtime accepts Pi for a provider type without a Pi catalog route', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
      name: 'Qwen Dual',
      category: 'official',
      type: 'qwen',
      models: { primary: 'qwen3.8-flash', light: 'qwen3.8-flash' },
      connection: {
        apiKey: 'sk-qwen-test',
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    });
    const id = createRes.body.provider.id;

    const runtimeRes = await request(appServer)
      .post(`/api/v1/providers/${id}/runtime`)
      .send({ agentRuntime: 'pi-agent-core' });

    expect(runtimeRes.status).toBe(200);
    expect(runtimeRes.body.provider.connection.agentRuntime).toBe('pi-agent-core');
  });

  it('keeps provider configuration available but blocks connection tests when AI is disabled', async () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const createRes = await request(appServer).post('/api/v1/providers').send({
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
    expect(await request(appServer).get(`/api/v1/providers/${id}`)).toHaveProperty('status', 200);
    expect(await request(appServer).post(`/api/v1/providers/${id}/activate`)).toHaveProperty('status', 200);

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const testRes = await request(appServer).post(`/api/v1/providers/${id}/test`);
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

  it('refuses a surface change over the API that would send the stored key to another origin', async () => {
    const created = await request(appServer).post('/api/v1/providers').send({
      name: 'Surface Custom',
      category: 'custom',
      type: 'custom',
      models: { primary: 'model-a', light: 'model-b' },
      connection: {
        apiKey: 'sk-route-secret-key',
        claudeBaseUrl: 'https://proxy.example/anthropic',
        openaiBaseUrl: 'https://openai.example/v1',
        apiSurface: 'claude',
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.provider.id;

    const refused = await request(appServer).patch(`/api/v1/providers/${id}`).send({connection: {apiSurface: 'openai'}});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("re-enter or clear credential field 'apiKey'");
    expect(JSON.stringify(refused.body)).not.toContain('sk-route-secret-key');

    const reentered = await request(appServer).patch(`/api/v1/providers/${id}`)
      .send({connection: {apiSurface: 'openai', apiKey: 'sk-route-reentered-key'}});
    expect(reentered.status).toBe(200);
    expect(reentered.body.provider.connection.apiSurface).toBe('openai');
  });

  it('GET /templates publishes each type\'s API-surface facts from the route tables', async () => {
    const res = await request(appServer).get('/api/v1/providers/templates');
    expect(res.status).toBe(200);
    const templates = res.body.templates as Array<{type: ProviderType; piCatalogRouteSurfaces: string[]; defaultApiSurface: string}>;
    const byType = new Map(templates.map(template => [template.type, template]));
    expect(byType.get('deepseek')!.piCatalogRouteSurfaces).toEqual(['openai']);
    expect(byType.get('minimax')!.piCatalogRouteSurfaces).toEqual(['claude']);
    expect(byType.get('anthropic')!.piCatalogRouteSurfaces).toEqual([]);
    expect(byType.get('openai')!.defaultApiSurface).toBe('openai');
    expect(byType.get('ollama')!.defaultApiSurface).toBe('openai');
    expect(byType.get('custom')!.defaultApiSurface).toBe('claude');
    expect(byType.get('glm')!.defaultApiSurface).toBe('claude');
    for (const template of templates) {
      const route = (PI_CATALOG_ROUTES as Record<string, {surface: string}>)[template.type];
      expect(template.piCatalogRouteSurfaces).toEqual(route ? [route.surface] : []);
      const previous = previousProviderAgentRuntime({type: template.type, connection: {}});
      expect(template.defaultApiSurface).toBe(previous === 'openai-agents-sdk' ? 'openai' : 'claude');
    }
  });

  it('creates and activates custom Pi agent-core providers without exposing model JSON', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
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
    const activateRes = await request(appServer).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(appServer).get('/api/v1/providers/effective');
    expect(effectiveRes.status).toBe(200);
    expect(effectiveRes.body.provider.connection.agentRuntime).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_AGENT_RUNTIME).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toMatch(/^\*{4}/);
    expect(JSON.stringify(effectiveRes.body)).not.toContain('sk-pi-secret');
  });

  it('maps a custom OpenCode provider to Pi without exposing its secrets', async () => {
    const createRes = await request(appServer).post('/api/v1/providers').send({
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
    expect(createRes.body.provider.connection).toMatchObject({agentRuntime: 'pi-agent-core', apiSurface: 'openai'});
    expect(createRes.body.provider.connection.openCodeModelJson).toBeUndefined();
    expect(createRes.body.provider.models.primary).toBe('opencode-test');
    expect(JSON.stringify(createRes.body)).not.toContain('sk-opencode-secret');

    const id = createRes.body.provider.id;
    const activateRes = await request(appServer).post(`/api/v1/providers/${id}/activate`);
    expect(activateRes.status).toBe(200);

    const effectiveRes = await request(appServer).get('/api/v1/providers/effective');
    expect(effectiveRes.status).toBe(200);
    expect(effectiveRes.body.provider.connection.agentRuntime).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_AGENT_RUNTIME).toBe('pi-agent-core');
    expect(effectiveRes.body.env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH).toBeUndefined();
    expect(JSON.stringify(effectiveRes.body)).not.toContain('sk-opencode-secret');
    expect(JSON.stringify(effectiveRes.body)).not.toContain('sk-opencode-openai');
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

    const createRes = await ssoHeaders(request(appServer).post('/api/v1/providers')).send({
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

    expect(await ssoHeaders(request(appServer).get(`/api/v1/providers/${id}`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(appServer).patch(`/api/v1/providers/${id}`)).send({
      name: 'Audited DeepSeek Updated',
    })).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(appServer).post(`/api/v1/providers/${id}/activate`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(appServer).post(`/api/v1/providers/${id}/runtime`)).send({
      agentRuntime: 'openai-agents-sdk',
    })).toHaveProperty('status', 200);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      expect(await ssoHeaders(request(appServer).post(`/api/v1/providers/${id}/test`))).toHaveProperty('status', 200);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await ssoHeaders(request(appServer).post(`/api/v1/providers/${id}/rotate-secret`))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(appServer).post('/api/v1/providers/deactivate'))).toHaveProperty('status', 200);
    expect(await ssoHeaders(request(appServer).delete(`/api/v1/providers/${id}`))).toHaveProperty('status', 200);

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
    const workspaceServer = await loopbackServers.listen(workspaceApp);

    const createRes = await ssoHeaders(
      request(workspaceServer).post('/api/workspaces/workspace-a/providers'),
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
      request(workspaceServer).post(`/api/workspaces/workspace-a/providers/${id}/activate`),
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
    const workspaceServer = await loopbackServers.listen(workspaceApp);

    const createRes = await ssoHeaders(
      request(workspaceServer).post('/api/workspaces/workspace-a/providers'),
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
      request(workspaceServer).get(`/api/workspaces/workspace-a/providers/${id}`),
    );
    expect(inherited.status).toBe(200);

    const update = await ssoHeaders(request(workspaceServer)
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

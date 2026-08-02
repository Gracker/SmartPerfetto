// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../enterpriseDb';
import { listEnterpriseAuditEvents } from '../../enterpriseAuditService';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../../enterpriseMigration';
import {
  SECRET_STORE_DIR_ENV,
  SECRET_STORE_MASTER_KEY_ENV,
} from '../localSecretStore';
import { ProviderService } from '../providerService';
import type { ProviderCreateInput, ProviderScope } from '../types';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  secretStoreDir: process.env[SECRET_STORE_DIR_ENV],
  secretStoreMasterKey: process.env[SECRET_STORE_MASTER_KEY_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
};
const oidcEnvKeys = [
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  'SMARTPERFETTO_OIDC_REDIRECT_URI',
  'SMARTPERFETTO_SERVER_SECRET',
  'FRONTEND_URL',
] as const;
const originalOidcEnv = Object.fromEntries(
  oidcEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof oidcEnvKeys)[number], string | undefined>;

interface ProviderCredentialRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  owner_user_id: string | null;
  scope: string;
  models_json: string;
  secret_ref: string;
  policy_json: string;
}

let tmpDir: string | undefined;
let dbPath: string;
let secretDir: string;
let svc: ProviderService;

const input: ProviderCreateInput = {
  name: 'Enterprise OpenAI',
  category: 'official',
  type: 'openai',
  models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
  connection: {
    openaiApiKey: 'sk-enterprise-secret-a',
    openaiBaseUrl: 'https://api.openai.com/v1',
  },
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function scope(userId: string): ProviderScope {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId,
  };
}

function workspaceScope(): ProviderScope {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
  };
}

function enableOidcTestMode(): void {
  process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
  process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
  process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
  process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
    'https://app.example.test/api/auth/oidc/callback';
  process.env.SMARTPERFETTO_SERVER_SECRET =
    'test-server-secret-at-least-32-bytes';
  process.env.FRONTEND_URL = 'https://app.example.test';
}

function readProviderRows(): ProviderCredentialRow[] {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], ProviderCredentialRow>(`
      SELECT *
      FROM provider_credentials
      ORDER BY owner_user_id
    `).all();
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-provider-store-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  secretDir = path.join(tmpDir, 'secrets');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[SECRET_STORE_DIR_ENV] = secretDir;
  process.env[SECRET_STORE_MASTER_KEY_ENV] = Buffer.alloc(32, 3).toString('base64');
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
  for (const key of oidcEnvKeys) delete process.env[key];
  svc = new ProviderService(path.join(tmpDir, 'providers.json'));
});

afterEach(async () => {
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(SECRET_STORE_DIR_ENV, originalEnv.secretStoreDir);
  restoreEnvValue(SECRET_STORE_MASTER_KEY_ENV, originalEnv.secretStoreMasterKey);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  for (const key of oidcEnvKeys) restoreEnvValue(key, originalOidcEnv[key]);
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('enterprise provider store', () => {
  it('keeps providers isolated when OIDC uses its default storage plan', () => {
    delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    delete process.env[ENTERPRISE_MIGRATION_PHASE_ENV];
    enableOidcTestMode();
    const oidcService = new ProviderService(path.join(tmpDir!, 'oidc-providers.json'));

    const providerA = oidcService.create({
      ...input,
      name: 'OIDC Provider A',
      connection: {openaiApiKey: 'sk-user-a'},
    }, scope('user-a'));
    const providerB = oidcService.create({
      ...input,
      name: 'OIDC Provider B',
      connection: {openaiApiKey: 'sk-user-b'},
    }, scope('user-b'));

    expect(oidcService.list(scope('user-a')).map(item => item.id)).toEqual([providerA.id]);
    expect(oidcService.list(scope('user-b')).map(item => item.id)).toEqual([providerB.id]);
    expect(oidcService.getRaw(providerB.id, scope('user-a'))).toBeUndefined();
    expect(oidcService.getRaw(providerA.id, scope('user-b'))).toBeUndefined();
  });

  it('tracks scoped provider mutation generations without leaking personal revisions', () => {
    expect(svc.getMutationGeneration(scope('user-a')).entries.map(entry => ({
      level: entry.scope.level,
      revision: entry.revision,
      inFlight: entry.inFlight,
    }))).toEqual([
      {level: 'org', revision: 0, inFlight: 0},
      {level: 'workspace', revision: 0, inFlight: 0},
      {level: 'personal', revision: 0, inFlight: 0},
    ]);

    svc.create(input, scope('user-a'));
    expect(svc.getMutationGeneration(scope('user-a')).entries[2])
      .toMatchObject({revision: 2, inFlight: 0});
    expect(svc.getMutationGeneration(scope('user-b')).entries[2])
      .toMatchObject({revision: 0, inFlight: 0});

    svc.create({...input, name: 'Workspace Provider'}, workspaceScope());
    expect(svc.getMutationGeneration(scope('user-a')).entries[1])
      .toMatchObject({revision: 2, inFlight: 0});
    expect(svc.getMutationGeneration(scope('user-b')).entries[1])
      .toMatchObject({revision: 2, inFlight: 0});
  });

  it('stores provider metadata in DB and encrypted secrets outside provider_credentials', async () => {
    const provider = svc.create(input, scope('user-a'));
    svc.activate(provider.id, scope('user-a'));

    const row = readProviderRows()[0];
    expect(row).toEqual(expect.objectContaining({
      id: provider.id,
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      owner_user_id: 'user-a',
      scope: 'personal',
    }));
    expect(row.models_json).toContain('gpt-5.5');
    expect(row.policy_json).toContain('openaiBaseUrl');
    expect(row.policy_json).not.toContain('sk-enterprise-secret-a');
    expect(row.secret_ref).toMatch(/^secret:provider:/);
    expect(JSON.parse(row.policy_json).secretVersion).toBe(2);

    const providerJsonPath = path.join(tmpDir!, 'providers.json');
    await expect(fs.access(providerJsonPath)).rejects.toBeTruthy();

    const secretFile = await fs.readFile(path.join(secretDir, 'provider-secrets.enc.json'), 'utf-8');
    expect(secretFile).toContain('libsodium-secretbox');
    expect(secretFile).not.toContain('sk-enterprise-secret-a');
    expect(svc.getEnvForProvider(provider.id, scope('user-a'))!.OPENAI_API_KEY)
      .toBe('sk-enterprise-secret-a');
  });

  it('stores third-party model JSON secrets outside provider_credentials', async () => {
    const piProvider = svc.create({
      name: 'Enterprise Pi',
      category: 'custom',
      type: 'custom',
      models: { primary: 'pi-primary', light: 'pi-light' },
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test","apiKey":"sk-enterprise-pi-json"}',
      },
    }, scope('user-a'));
    const openCodeProvider = svc.create({
      name: 'Enterprise OpenCode',
      category: 'custom',
      type: 'custom',
      models: { primary: 'opencode-primary', light: 'opencode-light' },
      connection: {
        agentRuntime: 'opencode',
        openCodeModelJson: '{"providerID":"test","modelID":"opencode-test","apiKey":"sk-enterprise-opencode-json"}',
      },
    }, scope('user-a'));

    const rows = readProviderRows();
    const piRow = rows.find(item => item.id === piProvider.id);
    const openCodeRow = rows.find(item => item.id === openCodeProvider.id);
    expect(piRow).toBeDefined();
    expect(openCodeRow).toBeDefined();
    expect(piRow!.policy_json).not.toContain('sk-enterprise-pi-json');
    expect(openCodeRow!.policy_json).not.toContain('sk-enterprise-opencode-json');

    const secretFile = await fs.readFile(path.join(secretDir, 'provider-secrets.enc.json'), 'utf-8');
    expect(secretFile).not.toContain('sk-enterprise-pi-json');
    expect(secretFile).not.toContain('sk-enterprise-opencode-json');
    expect(svc.getEnvForProvider(piProvider.id, scope('user-a'))!.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON)
      .toContain('sk-enterprise-pi-json');
    expect(svc.getEnvForProvider(openCodeProvider.id, scope('user-a'))!.SMARTPERFETTO_OPENCODE_MODEL_JSON)
      .toContain('sk-enterprise-opencode-json');
  });

  it('encrypts custom header and environment values outside policy_json', async () => {
    const provider = svc.create({
      ...input,
      name: 'Enterprise Custom',
      category: 'custom',
      type: 'custom',
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://gateway.example/v1',
      },
      custom: {
        headers: {Authorization: 'Bearer custom-header-secret'},
        envOverrides: {
          OPENAI_API_KEY: 'custom-env-secret',
          OPENAI_BASE_URL: 'https://override.example/v1',
        },
      },
    }, scope('user-a'));

    const row = readProviderRows().find(item => item.id === provider.id)!;
    expect(row.policy_json).not.toContain('custom-header-secret');
    expect(row.policy_json).not.toContain('custom-env-secret');
    expect(row.policy_json).not.toContain('https://override.example/v1');
    const encrypted = await fs.readFile(path.join(secretDir, 'provider-secrets.enc.json'), 'utf-8');
    expect(encrypted).not.toContain('custom-header-secret');
    expect(encrypted).not.toContain('custom-env-secret');

    const raw = svc.getRaw(provider.id, scope('user-a'))!;
    expect(raw.custom?.headers?.Authorization).toBe('Bearer custom-header-secret');
    expect(svc.getEnvForProvider(provider.id, scope('user-a'))?.OPENAI_API_KEY)
      .toBe('custom-env-secret');
  });

  it('keeps personal provider activation isolated by user scope', () => {
    const providerA = svc.create({
      ...input,
      name: 'Provider A',
      connection: { openaiApiKey: 'sk-user-a' },
    }, scope('user-a'));
    svc.activate(providerA.id, scope('user-a'));

    const providerB = svc.create({
      ...input,
      name: 'Provider B',
      connection: { openaiApiKey: 'sk-user-b' },
    }, scope('user-b'));
    svc.activate(providerB.id, scope('user-b'));

    expect(svc.list(scope('user-a')).map(provider => provider.id)).toEqual([providerA.id]);
    expect(svc.list(scope('user-b')).map(provider => provider.id)).toEqual([providerB.id]);
    expect(svc.getEffectiveEnv(scope('user-a'))!.OPENAI_API_KEY).toBe('sk-user-a');
    expect(svc.getEffectiveEnv(scope('user-b'))!.OPENAI_API_KEY).toBe('sk-user-b');
  });

  it('keeps workspace default active when a user activates a personal provider', () => {
    const workspaceProvider = svc.create({
      ...input,
      name: 'Workspace Default',
      connection: { openaiApiKey: 'sk-workspace-default' },
    }, workspaceScope());
    svc.activate(workspaceProvider.id, workspaceScope());

    expect(svc.getEffectiveEnv(scope('user-a'))!.OPENAI_API_KEY).toBe('sk-workspace-default');
    expect(svc.getEffectiveEnv(scope('user-b'))!.OPENAI_API_KEY).toBe('sk-workspace-default');

    const personalProvider = svc.create({
      ...input,
      name: 'User A Provider',
      connection: { openaiApiKey: 'sk-user-a-default' },
    }, scope('user-a'));
    svc.activate(personalProvider.id, scope('user-a'));

    expect(svc.getEffectiveEnv(scope('user-a'))!.OPENAI_API_KEY).toBe('sk-user-a-default');
    expect(svc.getEffectiveEnv(scope('user-b'))!.OPENAI_API_KEY).toBe('sk-workspace-default');

    const rows = readProviderRows();
    const workspaceRow = rows.find(row => row.id === workspaceProvider.id);
    const personalRow = rows.find(row => row.id === personalProvider.id);
    expect(workspaceRow).toEqual(expect.objectContaining({
      owner_user_id: null,
      scope: 'workspace',
    }));
    expect(workspaceRow?.secret_ref).toContain(':_workspace:');
    expect(JSON.parse(workspaceRow!.policy_json).isActive).toBe(true);
    expect(personalRow).toEqual(expect.objectContaining({
      owner_user_id: 'user-a',
      scope: 'personal',
    }));
    expect(JSON.parse(personalRow!.policy_json).isActive).toBe(true);
  });

  it('allows inherited provider reads without allowing cross-scope mutations', () => {
    enableOidcTestMode();
    const workspaceProvider = svc.create({
      ...input,
      name: 'Workspace Default',
      connection: {openaiApiKey: 'sk-workspace-default'},
    }, workspaceScope());

    expect(svc.getRaw(workspaceProvider.id, scope('user-a'))?.id)
      .toBe(workspaceProvider.id);
    expect(svc.getEnvForProvider(workspaceProvider.id, scope('user-a'))?.OPENAI_API_KEY)
      .toBe('sk-workspace-default');

    expect(() => svc.update(
      workspaceProvider.id,
      {name: 'Hijacked'},
      scope('user-a'),
    )).toThrow(/Provider not found/);
    expect(() => svc.activate(workspaceProvider.id, scope('user-a')))
      .toThrow(/Provider not found/);
    expect(() => svc.rotateSecret(workspaceProvider.id, scope('user-a')))
      .toThrow(/Provider not found/);
    expect(() => svc.delete(workspaceProvider.id, scope('user-a')))
      .toThrow(/Provider not found/);

    const storedRow = readProviderRows().find(row => row.id === workspaceProvider.id);
    expect(storedRow?.policy_json).toBeDefined();
    expect(storedRow && JSON.parse(storedRow.policy_json).isActive).toBe(false);
    const db = openEnterpriseDb(dbPath);
    try {
      const stored = db.prepare('SELECT name FROM provider_credentials WHERE id = ?')
        .get(workspaceProvider.id) as {name: string} | undefined;
      expect(stored?.name).toBe('Workspace Default');
    } finally {
      db.close();
    }
  });

  it('preserves inherited provider mutations outside OIDC', () => {
    const workspaceProvider = svc.create({
      ...input,
      name: 'Workspace Default',
      connection: {openaiApiKey: 'sk-workspace-default'},
    }, workspaceScope());

    expect(svc.update(
      workspaceProvider.id,
      {name: 'Updated From Personal Scope'},
      scope('user-a'),
    ).name).toBe('Updated From Personal Scope');
    expect(svc.rotateSecret(workspaceProvider.id, scope('user-a'))).toBeGreaterThan(0);
    expect(() => svc.delete(workspaceProvider.id, scope('user-a'))).not.toThrow();
    expect(svc.getRaw(workspaceProvider.id, workspaceScope())).toBeUndefined();

    const activatable = svc.create({
      ...input,
      name: 'Workspace Activatable',
    }, workspaceScope());
    expect(() => svc.activate(activatable.id, scope('user-a'))).not.toThrow();
  });

  it('preserves cross-scope dual writes outside OIDC', async () => {
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const filePath = path.join(tmpDir!, 'dual-write-providers.json');
    const dualWriteService = new ProviderService(filePath);
    const workspaceProvider = dualWriteService.create({
      ...input,
      name: 'Workspace Default',
      connection: {openaiApiKey: 'sk-workspace-default'},
    }, workspaceScope());

    expect(dualWriteService.update(
      workspaceProvider.id,
      {name: 'Hijacked'},
      scope('user-a'),
    ).name).toBe('Hijacked');

    const fileProviders = JSON.parse(await fs.readFile(filePath, 'utf8')) as Array<{
      id: string;
      name: string;
    }>;
    expect(fileProviders.find(provider => provider.id === workspaceProvider.id)?.name)
      .toBe('Hijacked');
    const db = openEnterpriseDb(dbPath);
    try {
      const stored = db.prepare('SELECT name FROM provider_credentials WHERE id = ?')
        .get(workspaceProvider.id) as {name: string} | undefined;
      expect(stored?.name).toBe('Hijacked');
    } finally {
      db.close();
    }
  });

  it('rotates provider secrets and audits secret lifecycle operations', () => {
    const provider = svc.create(input, scope('user-a'));
    expect(svc.getEnvForProvider(provider.id, scope('user-a'))!.OPENAI_API_KEY)
      .toBe('sk-enterprise-secret-a');

    expect(svc.rotateSecret(provider.id, scope('user-a'))).toBe(2);
    expect(svc.getEnvForProvider(provider.id, scope('user-a'))!.OPENAI_API_KEY)
      .toBe('sk-enterprise-secret-a');

    const row = readProviderRows()[0];
    expect(JSON.parse(row.policy_json).secretVersion).toBe(2);

    const db = openEnterpriseDb(dbPath);
    try {
      const actions = listEnterpriseAuditEvents(db)
        .filter(event => event.resource_type === 'provider_secret')
        .map(event => event.action);
      expect(actions).toEqual(expect.arrayContaining([
        'provider.secret.create',
        'provider.secret.read',
        'provider.secret.rotate',
      ]));
    } finally {
      db.close();
    }
  });
});

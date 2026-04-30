# Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralized LLM provider management with CRUD API, JSON persistence, and SDK env-var integration — backend only (frontend is a separate plan).

**Architecture:** A `providerManager` service module with an in-memory Map backed by a JSON file. A REST route layer exposes CRUD + activate + test-connection. `createSdkEnv()` is modified to pull env vars from the active provider before falling back to `process.env`.

**Tech Stack:** TypeScript strict, Express router, Node fs (atomic write), uuid, Jest for tests.

**Spec:** `docs/superpowers/specs/2026-04-30-provider-management-design.md`

---

## File Structure

```
backend/src/services/providerManager/
├── types.ts              # ProviderConfig, OfficialProviderTemplate, ModelOption, TestResult interfaces
├── templates.ts          # Built-in official provider template definitions
├── providerStore.ts      # JSON file persistence + in-memory Map singleton
├── providerService.ts    # Business logic: CRUD, activate, validate, toEnvVars, testConnection
├── index.ts              # Re-exports

backend/src/services/providerManager/__tests__/
├── providerStore.test.ts
├── providerService.test.ts
├── providerRoutes.test.ts

backend/src/routes/
└── providerRoutes.ts     # REST API router

Modify:
├── backend/src/agentv3/claudeConfig.ts        # createSdkEnv() integration
├── backend/src/agent/core/orchestratorTypes.ts # add providerId to AnalysisOptions
├── backend/src/routes/agentRoutes.ts          # pass providerId from request body
├── backend/src/index.ts                       # mount providerRoutes
```

---

### Task 1: Types & Templates

**Files:**
- Create: `backend/src/services/providerManager/types.ts`
- Create: `backend/src/services/providerManager/templates.ts`

- [ ] **Step 1: Create types.ts**

```typescript
// backend/src/services/providerManager/types.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ProviderModels {
  primary: string;
  light: string;
  subAgent?: string;
}

export interface ProviderConnection {
  baseUrl?: string;
  apiKey?: string;
  // Bedrock
  awsBearerToken?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsProfile?: string;
  awsRegion?: string;
  // Vertex
  gcpProjectId?: string;
  gcpRegion?: string;
}

export interface ProviderTuning {
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
  fullPerTurnMs?: number;
  quickPerTurnMs?: number;
  verifierTimeoutMs?: number;
  classifierTimeoutMs?: number;
  enableSubAgents?: boolean;
  enableVerification?: boolean;
}

export interface ProviderCustom {
  headers?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

export type ProviderType = 'anthropic' | 'bedrock' | 'vertex' | 'deepseek' | 'openai' | 'ollama' | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  category: 'official' | 'custom';
  type: ProviderType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning?: ProviderTuning;
  custom?: ProviderCustom;
}

export interface ModelOption {
  id: string;
  name: string;
  tier: 'primary' | 'light';
}

export interface OfficialProviderTemplate {
  type: Exclude<ProviderType, 'custom'>;
  displayName: string;
  requiredFields: string[];
  defaultModels: { primary: string; light: string };
  availableModels: ModelOption[];
  defaultConnection?: Partial<ProviderConnection>;
}

export interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
  modelVerified?: boolean;
}

export interface ProviderCreateInput {
  name: string;
  category: 'official' | 'custom';
  type: ProviderType;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning?: ProviderTuning;
  custom?: ProviderCustom;
}

export interface ProviderUpdateInput {
  name?: string;
  models?: Partial<ProviderModels>;
  connection?: Partial<ProviderConnection>;
  tuning?: ProviderTuning | null;
  custom?: ProviderCustom | null;
}
```

- [ ] **Step 2: Create templates.ts**

```typescript
// backend/src/services/providerManager/templates.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OfficialProviderTemplate } from './types';

export const officialTemplates: OfficialProviderTemplate[] = [
  {
    type: 'anthropic',
    displayName: 'Anthropic',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
  },
  {
    type: 'bedrock',
    displayName: 'AWS Bedrock',
    requiredFields: ['connection.awsRegion'],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
    defaultConnection: { awsRegion: 'us-east-1' },
  },
  {
    type: 'vertex',
    displayName: 'Google Vertex AI',
    requiredFields: ['connection.gcpProjectId', 'connection.gcpRegion'],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
    defaultConnection: { gcpRegion: 'us-central1' },
  },
  {
    type: 'deepseek',
    displayName: 'DeepSeek',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
    availableModels: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'light' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', tier: 'primary' },
    ],
    defaultConnection: { baseUrl: 'https://api.deepseek.com' },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
    availableModels: [
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'primary' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'light' },
    ],
    defaultConnection: { baseUrl: 'https://api.openai.com/v1' },
  },
  {
    type: 'ollama',
    displayName: 'Ollama (Local)',
    requiredFields: ['connection.baseUrl'],
    defaultModels: { primary: 'qwen3:30b', light: 'qwen3:30b' },
    availableModels: [],
    defaultConnection: { baseUrl: 'http://localhost:11434/v1' },
  },
];
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (files aren't imported yet, but should parse cleanly on their own)

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/providerManager/types.ts backend/src/services/providerManager/templates.ts
git commit -m "feat(provider): add types and official provider templates"
```

---

### Task 2: Provider Store (persistence + in-memory Map)

**Files:**
- Create: `backend/src/services/providerManager/providerStore.ts`
- Create: `backend/src/services/providerManager/__tests__/providerStore.test.ts`

- [ ] **Step 1: Write failing tests for providerStore**

```typescript
// backend/src/services/providerManager/__tests__/providerStore.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderStore } from '../providerStore';
import type { ProviderConfig } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-id-1',
    name: 'Test Provider',
    category: 'official',
    type: 'anthropic',
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    connection: { apiKey: 'sk-test-key' },
    ...overrides,
  };
}

describe('ProviderStore', () => {
  let dir: string;
  let store: ProviderStore;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    store = new ProviderStore(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('initializes with empty array when file does not exist', () => {
    store.load();
    expect(store.getAll()).toEqual([]);
  });

  it('loads existing providers from file', async () => {
    const providers = [makeProvider()];
    await fsp.writeFile(path.join(dir, 'providers.json'), JSON.stringify(providers));
    store.load();
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe('test-id-1');
  });

  it('gets a provider by id', () => {
    store.load();
    store.set(makeProvider({ id: 'abc' }));
    expect(store.get('abc')?.id).toBe('abc');
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('sets a provider and persists to file', async () => {
    store.load();
    store.set(makeProvider({ id: 'persist-test' }));

    const raw = await fsp.readFile(path.join(dir, 'providers.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('persist-test');
  });

  it('deletes a provider and persists', () => {
    store.load();
    store.set(makeProvider({ id: 'to-delete' }));
    expect(store.getAll()).toHaveLength(1);
    store.delete('to-delete');
    expect(store.getAll()).toHaveLength(0);
  });

  it('getActive returns the active provider', () => {
    store.load();
    store.set(makeProvider({ id: 'a', isActive: false }));
    store.set(makeProvider({ id: 'b', isActive: true }));
    expect(store.getActive()?.id).toBe('b');
  });

  it('getActive returns undefined when none active', () => {
    store.load();
    store.set(makeProvider({ id: 'a', isActive: false }));
    expect(store.getActive()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/services/providerManager/__tests__/providerStore.test.ts --no-coverage 2>&1 | tail -10`
Expected: FAIL — module `../providerStore` not found

- [ ] **Step 3: Implement providerStore**

```typescript
// backend/src/services/providerManager/providerStore.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs';
import * as path from 'path';
import type { ProviderConfig } from './types';

export class ProviderStore {
  private providers = new Map<string, ProviderConfig>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): void {
    this.providers.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const arr: ProviderConfig[] = JSON.parse(raw);
      for (const p of arr) this.providers.set(p.id, p);
    } catch {
      // Corrupted file — start fresh
    }
  }

  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  getActive(): ProviderConfig | undefined {
    for (const p of this.providers.values()) {
      if (p.isActive) return p;
    }
    return undefined;
  }

  set(provider: ProviderConfig): void {
    this.providers.set(provider.id, provider);
    this.persist();
  }

  delete(id: string): boolean {
    const deleted = this.providers.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.getAll(), null, 2));
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows */ }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/services/providerManager/__tests__/providerStore.test.ts --no-coverage 2>&1 | tail -10`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/providerManager/providerStore.ts backend/src/services/providerManager/__tests__/providerStore.test.ts
git commit -m "feat(provider): implement providerStore with JSON persistence"
```

---

### Task 3: Provider Service (business logic)

**Files:**
- Create: `backend/src/services/providerManager/providerService.ts`
- Create: `backend/src/services/providerManager/__tests__/providerService.test.ts`

- [ ] **Step 1: Write failing tests for providerService**

```typescript
// backend/src/services/providerManager/__tests__/providerService.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderService } from '../providerService';
import type { ProviderCreateInput } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('ProviderService', () => {
  let dir: string;
  let svc: ProviderService;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    svc = new ProviderService(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const validInput: ProviderCreateInput = {
    name: 'My Anthropic',
    category: 'official',
    type: 'anthropic',
    models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    connection: { apiKey: 'sk-ant-test123456' },
  };

  describe('create', () => {
    it('creates a provider with generated id and timestamps', () => {
      const result = svc.create(validInput);
      expect(result.id).toBeDefined();
      expect(result.name).toBe('My Anthropic');
      expect(result.isActive).toBe(false);
      expect(result.createdAt).toBeDefined();
    });

    it('throws on missing name', () => {
      expect(() => svc.create({ ...validInput, name: '' })).toThrow();
    });
  });

  describe('list (masked)', () => {
    it('masks apiKey in returned list', () => {
      svc.create(validInput);
      const list = svc.list();
      expect(list[0].connection.apiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.apiKey).not.toBe('sk-ant-test123456');
    });
  });

  describe('activate', () => {
    it('sets provider as active and deactivates others', () => {
      const p1 = svc.create({ ...validInput, name: 'P1' });
      const p2 = svc.create({ ...validInput, name: 'P2' });
      svc.activate(p1.id);
      expect(svc.get(p1.id)!.isActive).toBe(true);
      svc.activate(p2.id);
      expect(svc.get(p1.id)!.isActive).toBe(false);
      expect(svc.get(p2.id)!.isActive).toBe(true);
    });

    it('throws on nonexistent id', () => {
      expect(() => svc.activate('fake-id')).toThrow();
    });
  });

  describe('delete', () => {
    it('deletes inactive provider', () => {
      const p = svc.create(validInput);
      svc.delete(p.id);
      expect(svc.list()).toHaveLength(0);
    });

    it('throws when deleting active provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      expect(() => svc.delete(p.id)).toThrow(/active/i);
    });
  });

  describe('getEffectiveEnv', () => {
    it('returns null when no active provider', () => {
      expect(svc.getEffectiveEnv()).toBeNull();
    });

    it('returns env vars for active anthropic provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
      expect(env.CLAUDE_MODEL).toBe('claude-sonnet-4-6');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('claude-haiku-4-5');
    });

    it('returns bedrock env vars', () => {
      const p = svc.create({
        ...validInput,
        type: 'bedrock',
        connection: { awsRegion: 'us-west-2', awsBearerToken: 'tok123' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.AWS_REGION).toBe('us-west-2');
      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('tok123');
    });
  });

  describe('getEnvForProvider', () => {
    it('returns env for a specific provider by id', () => {
      const p = svc.create(validInput);
      const env = svc.getEnvForProvider(p.id)!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });

    it('returns null for nonexistent id', () => {
      expect(svc.getEnvForProvider('nope')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates name without touching credentials', () => {
      const p = svc.create(validInput);
      svc.update(p.id, { name: 'Renamed' });
      expect(svc.get(p.id)!.name).toBe('Renamed');
      // credential unchanged (access raw, not masked)
      expect(svc.getEnvForProvider(p.id)!.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest src/services/providerManager/__tests__/providerService.test.ts --no-coverage 2>&1 | tail -10`
Expected: FAIL — module `../providerService` not found

- [ ] **Step 3: Implement providerService**

```typescript
// backend/src/services/providerManager/providerService.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { v4 as uuidv4 } from 'uuid';
import { ProviderStore } from './providerStore';
import type {
  ProviderConfig,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderType,
} from './types';

const SENSITIVE_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'apiKey', 'awsBearerToken', 'awsAccessKeyId', 'awsSecretAccessKey', 'awsSessionToken',
];

function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}

function maskConnection(conn: ProviderConfig['connection']): ProviderConfig['connection'] {
  const masked = { ...conn };
  for (const field of SENSITIVE_FIELDS) {
    const val = masked[field];
    if (val) (masked as any)[field] = maskValue(val);
  }
  return masked;
}

function maskProvider(p: ProviderConfig): ProviderConfig {
  return { ...p, connection: maskConnection(p.connection) };
}

export class ProviderService {
  private store: ProviderStore;

  constructor(filePath: string) {
    this.store = new ProviderStore(filePath);
    this.store.load();
  }

  list(): ProviderConfig[] {
    return this.store.getAll().map(maskProvider);
  }

  get(id: string): ProviderConfig | undefined {
    const p = this.store.get(id);
    return p ? maskProvider(p) : undefined;
  }

  getRaw(id: string): ProviderConfig | undefined {
    return this.store.get(id);
  }

  create(input: ProviderCreateInput): ProviderConfig {
    if (!input.name?.trim()) throw new Error('Provider name is required');
    if (!input.type) throw new Error('Provider type is required');

    const now = new Date().toISOString();
    const provider: ProviderConfig = {
      id: uuidv4(),
      name: input.name.trim(),
      category: input.category,
      type: input.type,
      isActive: false,
      createdAt: now,
      updatedAt: now,
      models: input.models,
      connection: input.connection,
      ...(input.tuning ? { tuning: input.tuning } : {}),
      ...(input.custom ? { custom: input.custom } : {}),
    };

    this.store.set(provider);
    return provider;
  }

  update(id: string, input: ProviderUpdateInput): ProviderConfig {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Provider not found: ${id}`);

    const updated: ProviderConfig = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updated.name = input.name.trim();
    if (input.models) updated.models = { ...existing.models, ...input.models };
    if (input.connection) {
      const merged = { ...existing.connection };
      for (const [key, val] of Object.entries(input.connection)) {
        if (val !== undefined && !String(val).startsWith('****')) {
          (merged as any)[key] = val;
        }
      }
      updated.connection = merged;
    }
    if (input.tuning !== undefined) updated.tuning = input.tuning ?? undefined;
    if (input.custom !== undefined) updated.custom = input.custom ?? undefined;

    this.store.set(updated);
    return updated;
  }

  delete(id: string): void {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Provider not found: ${id}`);
    if (existing.isActive) throw new Error('Cannot delete the active provider. Deactivate or switch first.');
    this.store.delete(id);
  }

  activate(id: string): void {
    const target = this.store.get(id);
    if (!target) throw new Error(`Provider not found: ${id}`);

    // Deactivate current active
    const current = this.store.getActive();
    if (current && current.id !== id) {
      this.store.set({ ...current, isActive: false, updatedAt: new Date().toISOString() });
    }

    this.store.set({ ...target, isActive: true, updatedAt: new Date().toISOString() });
  }

  getEffectiveEnv(): Record<string, string> | null {
    const active = this.store.getActive();
    if (!active) return null;
    return this.toEnvVars(active);
  }

  getEnvForProvider(id: string): Record<string, string> | null {
    const provider = this.store.get(id);
    if (!provider) return null;
    return this.toEnvVars(provider);
  }

  private toEnvVars(provider: ProviderConfig): Record<string, string> {
    const env: Record<string, string> = {};

    switch (provider.type as ProviderType) {
      case 'anthropic':
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
        break;

      case 'bedrock':
        env.CLAUDE_CODE_USE_BEDROCK = '1';
        if (provider.connection.awsRegion) env.AWS_REGION = provider.connection.awsRegion;
        if (provider.connection.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = provider.connection.baseUrl;
        if (provider.connection.awsBearerToken) env.AWS_BEARER_TOKEN_BEDROCK = provider.connection.awsBearerToken;
        if (provider.connection.awsAccessKeyId) env.AWS_ACCESS_KEY_ID = provider.connection.awsAccessKeyId;
        if (provider.connection.awsSecretAccessKey) env.AWS_SECRET_ACCESS_KEY = provider.connection.awsSecretAccessKey;
        if (provider.connection.awsSessionToken) env.AWS_SESSION_TOKEN = provider.connection.awsSessionToken;
        if (provider.connection.awsProfile) env.AWS_PROFILE = provider.connection.awsProfile;
        break;

      case 'vertex':
        env.CLAUDE_CODE_USE_VERTEX = '1';
        if (provider.connection.gcpProjectId) env.ANTHROPIC_VERTEX_PROJECT_ID = provider.connection.gcpProjectId;
        if (provider.connection.gcpRegion) env.CLOUD_ML_REGION = provider.connection.gcpRegion;
        break;

      case 'deepseek':
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.deepseek.com';
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        break;

      case 'openai':
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.openai.com/v1';
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        break;

      case 'ollama':
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'http://localhost:11434/v1';
        env.ANTHROPIC_API_KEY = 'ollama';
        break;

      case 'custom':
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
        if (provider.custom?.envOverrides) Object.assign(env, provider.custom.envOverrides);
        break;
    }

    env.CLAUDE_MODEL = provider.models.primary;
    env.CLAUDE_LIGHT_MODEL = provider.models.light;
    if (provider.models.subAgent) env.CLAUDE_SUB_AGENT_MODEL = provider.models.subAgent;

    if (provider.tuning?.maxTurns) env.CLAUDE_MAX_TURNS = String(provider.tuning.maxTurns);
    if (provider.tuning?.effort) env.CLAUDE_EFFORT = provider.tuning.effort;
    if (provider.tuning?.maxBudgetUsd) env.CLAUDE_MAX_BUDGET_USD = String(provider.tuning.maxBudgetUsd);
    if (provider.tuning?.fullPerTurnMs) env.CLAUDE_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
    if (provider.tuning?.quickPerTurnMs) env.CLAUDE_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
    if (provider.tuning?.verifierTimeoutMs) env.CLAUDE_VERIFIER_TIMEOUT_MS = String(provider.tuning.verifierTimeoutMs);
    if (provider.tuning?.classifierTimeoutMs) env.CLAUDE_CLASSIFIER_TIMEOUT_MS = String(provider.tuning.classifierTimeoutMs);

    return env;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/services/providerManager/__tests__/providerService.test.ts --no-coverage 2>&1 | tail -15`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/providerManager/providerService.ts backend/src/services/providerManager/__tests__/providerService.test.ts
git commit -m "feat(provider): implement providerService with CRUD and env-var mapping"
```

---

### Task 4: Module Index + Singleton Initialization

**Files:**
- Create: `backend/src/services/providerManager/index.ts`

- [ ] **Step 1: Create index.ts with singleton**

```typescript
// backend/src/services/providerManager/index.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'path';
import { ProviderService } from './providerService';
import { officialTemplates } from './templates';

export type { ProviderConfig, ProviderCreateInput, ProviderUpdateInput, OfficialProviderTemplate, ModelOption, TestResult, ProviderType } from './types';
export { ProviderService } from './providerService';
export { ProviderStore } from './providerStore';
export { officialTemplates } from './templates';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

let instance: ProviderService | null = null;

export function getProviderService(): ProviderService {
  if (!instance) {
    instance = new ProviderService(PROVIDERS_FILE);
    const active = instance.list().find(p => p.isActive);
    if (active) {
      console.log(`[ProviderManager] Active: "${active.name}" (${active.type}, ${active.models.primary})`);
    } else {
      console.log('[ProviderManager] No active provider configured, using env fallback');
    }
  }
  return instance;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/providerManager/index.ts
git commit -m "feat(provider): add module index with singleton initialization"
```

---

### Task 5: REST API Routes

**Files:**
- Create: `backend/src/routes/providerRoutes.ts`
- Modify: `backend/src/index.ts` (mount route)

- [ ] **Step 1: Create providerRoutes.ts**

```typescript
// backend/src/routes/providerRoutes.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import express from 'express';
import { getProviderService, officialTemplates } from '../services/providerManager';
import type { ProviderCreateInput, ProviderUpdateInput } from '../services/providerManager';

const router = express.Router();

router.get('/', (req, res) => {
  const svc = getProviderService();
  res.json({ success: true, providers: svc.list() });
});

router.get('/templates', (_req, res) => {
  res.json({ success: true, templates: officialTemplates });
});

router.get('/effective', (_req, res) => {
  const svc = getProviderService();
  const env = svc.getEffectiveEnv();
  if (env) {
    const active = svc.list().find(p => p.isActive);
    res.json({ success: true, source: 'provider-manager', provider: active, env: maskEnvKeys(env) });
  } else {
    res.json({ success: true, source: 'env-fallback', provider: null });
  }
});

router.get('/:id', (req, res) => {
  const svc = getProviderService();
  const provider = svc.get(req.params.id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
  res.json({ success: true, provider });
});

router.post('/', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderCreateInput = req.body;
    const provider = svc.create(input);
    res.status(201).json({ success: true, provider });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderUpdateInput = req.body;
    const provider = svc.update(req.params.id, input);
    res.json({ success: true, provider });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    svc.delete(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.post('/:id/activate', (req, res) => {
  try {
    const svc = getProviderService();
    svc.activate(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.post('/:id/test', async (req, res) => {
  const svc = getProviderService();
  const provider = svc.getRaw(req.params.id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });

  const start = Date.now();
  try {
    // Lightweight connectivity test: we just verify the env vars are set correctly
    // and the provider can be resolved. Actual LLM call test is deferred to
    // a future iteration (requires SDK call with 1-token limit).
    const env = svc.getEnvForProvider(provider.id);
    if (!env) throw new Error('Failed to resolve env vars');

    const latencyMs = Date.now() - start;
    res.json({ success: true, result: { success: true, latencyMs, modelVerified: false } });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    res.json({ success: true, result: { success: false, latencyMs, error: err.message } });
  }
});

function maskEnvKeys(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  const sensitivePatterns = ['KEY', 'TOKEN', 'SECRET'];
  for (const [k, v] of Object.entries(env)) {
    if (sensitivePatterns.some(p => k.includes(p)) && v.length > 8) {
      masked[k] = `****${v.slice(-4)}`;
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export default router;
```

- [ ] **Step 2: Mount route in index.ts**

Add after line 29 (imports section) in `backend/src/index.ts`:

```typescript
import providerRoutes from './routes/providerRoutes';
```

Add after line 115 (routes section) in `backend/src/index.ts`:

```typescript
app.use('/api/v1/providers', providerRoutes);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/providerRoutes.ts backend/src/index.ts
git commit -m "feat(provider): add REST API routes and mount on /api/v1/providers"
```

---

### Task 6: Integration with createSdkEnv

**Files:**
- Modify: `backend/src/agentv3/claudeConfig.ts`
- Modify: `backend/src/agent/core/orchestratorTypes.ts`
- Modify: `backend/src/agentv3/claudeRuntime.ts` (3 call sites)
- Modify: `backend/src/routes/agentRoutes.ts`

- [ ] **Step 1: Modify createSdkEnv to accept optional providerId**

In `backend/src/agentv3/claudeConfig.ts`, replace the existing `createSdkEnv` function:

```typescript
/**
 * Create a sanitized copy of process.env for SDK subprocess spawning.
 * When a providerId is given, overlays that provider's env vars.
 * When no providerId is given, uses the active provider from providerManager.
 * Falls back to raw process.env when no provider is configured.
 */
export function createSdkEnv(sessionOverrideProviderId?: string): Record<string, string | undefined> {
  const env = { ...process.env };

  // Lazy import to avoid circular dependency at module load time
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();

  const providerEnv = sessionOverrideProviderId
    ? svc.getEnvForProvider(sessionOverrideProviderId)
    : svc.getEffectiveEnv();

  if (providerEnv) Object.assign(env, providerEnv);

  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  return env;
}
```

- [ ] **Step 2: Add providerId to AnalysisOptions**

In `backend/src/agent/core/orchestratorTypes.ts`, add inside `AnalysisOptions` interface (after `analysisMode`):

```typescript
  /** Provider override for this analysis session. When set, env vars are sourced
   *  from this provider instead of the global active provider. */
  providerId?: string;
```

- [ ] **Step 3: Pass providerId through ClaudeRuntime.analyze**

In `backend/src/agentv3/claudeRuntime.ts`, at the 3 call sites of `createSdkEnv()` (lines 450, 1367, and the correction stream around line 1013), change:

```typescript
// Before:
const sdkEnv = createSdkEnv();

// After:
const sdkEnv = createSdkEnv(options.providerId);
```

For the correction stream at line ~1013 where `options` might not be in scope, pass the same `providerId` that was captured at the start of `analyze()`:

At the top of the `analyze` method (after line 318), capture it:
```typescript
const providerId = options.providerId;
```

Then at each `createSdkEnv` call site, use `createSdkEnv(providerId)`.

- [ ] **Step 4: Pass providerId from agentRoutes**

In `backend/src/routes/agentRoutes.ts`, at the analyze call (~line 2262), add `providerId`:

```typescript
return session.orchestrator.analyze(query, sessionId, traceId, {
  traceProcessorService: options.traceProcessorService,
  packageName: options.packageName,
  timeRange: options.timeRange,
  taskTimeoutMs: options.taskTimeoutMs,
  blockedStrategyIds: options.blockedStrategyIds,
  adb: options.adb,
  selectionContext: options.selectionContext,
  analysisMode: options.analysisMode,
  traceContext: options.traceContext,
  providerId: options.providerId,
});
```

Also, where `options` is built from `req.body` (search for the request parsing section above line 2262), add:
```typescript
providerId: req.body.providerId,
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors

- [ ] **Step 6: Verify existing tests still pass**

Run: `cd backend && npx jest --no-coverage 2>&1 | tail -5`
Expected: All tests pass (the mock for claude-agent-sdk in jest config means runtime won't try to spawn)

- [ ] **Step 7: Commit**

```bash
git add backend/src/agentv3/claudeConfig.ts backend/src/agent/core/orchestratorTypes.ts backend/src/agentv3/claudeRuntime.ts backend/src/routes/agentRoutes.ts
git commit -m "feat(provider): integrate providerManager with createSdkEnv and analysis pipeline"
```

---

### Task 7: Health Check Enhancement

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Update health endpoint to show active provider info**

In `backend/src/index.ts`, update the `/health` handler's `aiEngine` section:

```typescript
import { getProviderService } from './services/providerManager';

// Inside the /health handler, replace the aiEngine block:
const providerSvc = getProviderService();
const activeProvider = providerSvc.list().find(p => p.isActive);
const aiEngineConfigured = useAgentV3
  ? (activeProvider != null || hasClaudeCredentials())
  : !!process.env.DEEPSEEK_API_KEY;

// In the response JSON:
aiEngine: {
  runtime: useAgentV3 ? 'agentv3' : 'agentv2',
  model: useAgentV3
    ? (activeProvider?.models.primary || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
    : (process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
  configured: aiEngineConfigured,
  source: activeProvider ? 'provider-manager' : 'env-fallback',
  ...(activeProvider ? {
    activeProvider: {
      id: activeProvider.id,
      name: activeProvider.name,
      type: activeProvider.type,
    },
  } : {}),
  authRequired: !!process.env.SMARTPERFETTO_API_KEY,
},
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(provider): enhance /health endpoint with active provider info"
```

---

### Task 8: Route Integration Test

**Files:**
- Create: `backend/src/services/providerManager/__tests__/providerRoutes.test.ts`

- [ ] **Step 1: Write integration test using supertest**

```typescript
// backend/src/services/providerManager/__tests__/providerRoutes.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import request from 'supertest';
import express from 'express';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

// We test the routes by building a minimal express app with the router.
// This avoids importing the full index.ts which starts servers.

describe('Provider Routes', () => {
  let app: express.Express;
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `provider-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });

    // Override the singleton by setting env before importing
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;

    // Dynamic import to pick up env override — but since we use a singleton,
    // we need to test against the actual route file with a fresh service.
    // For simplicity, test via the service directly through HTTP-like calls.
    // Using supertest with the actual providerRoutes but a test providerService.

    const { default: providerRoutes } = await import('../../../routes/providerRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/providers', providerRoutes);
  });

  afterEach(async () => {
    delete process.env.PROVIDER_DATA_DIR_OVERRIDE;
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
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest src/services/providerManager/__tests__/providerRoutes.test.ts --no-coverage 2>&1 | tail -15`
Expected: All tests PASS (or adjust if singleton needs an override mechanism — see Step 3)

- [ ] **Step 3: If singleton override is needed, update index.ts**

Add to `backend/src/services/providerManager/index.ts`:

```typescript
// Test support: allow overriding data directory
const dataDir = process.env.PROVIDER_DATA_DIR_OVERRIDE || DATA_DIR;
const PROVIDERS_FILE = path.join(dataDir, 'providers.json');
```

Replace the hardcoded `DATA_DIR` usage in `PROVIDERS_FILE`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/providerManager/__tests__/providerRoutes.test.ts backend/src/services/providerManager/index.ts
git commit -m "test(provider): add route integration tests with supertest"
```

---

### Task 9: Final Verification & Cleanup

**Files:**
- No new files

- [ ] **Step 1: Run full type check**

Run: `cd backend && npx tsc --noEmit 2>&1`
Expected: No errors

- [ ] **Step 2: Run all provider manager tests**

Run: `cd backend && npx jest src/services/providerManager --no-coverage 2>&1 | tail -15`
Expected: All tests pass

- [ ] **Step 3: Run existing regression tests to ensure no breakage**

Run: `cd backend && npx jest --no-coverage 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 4: Manual smoke test**

Run backend, then test API:
```bash
cd backend && npx tsx src/index.ts &
sleep 5

# Create a provider
curl -s -X POST http://localhost:3000/api/v1/providers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Bedrock","category":"official","type":"bedrock","models":{"primary":"claude-sonnet-4-6","light":"claude-haiku-4-5"},"connection":{"awsRegion":"us-east-1","awsBearerToken":"test-token"}}' | python3 -m json.tool

# List providers
curl -s http://localhost:3000/api/v1/providers | python3 -m json.tool

# Check health
curl -s http://localhost:3000/health | python3 -m json.tool

kill %1
```

Expected: Provider created, listed (with masked token), health shows env-fallback (not activated yet).

- [ ] **Step 5: Commit any fixes needed, then final commit**

```bash
git add -A
git commit -m "feat(provider): provider management backend complete"
```

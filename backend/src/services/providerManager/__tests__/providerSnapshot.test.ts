// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderService } from '../providerService';
import { resolveProviderRuntimeSnapshot } from '../providerSnapshot';
import type { ProviderCreateInput } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('provider runtime snapshot hash', () => {
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

  const openAIProvider: ProviderCreateInput = {
    name: 'OpenAI Provider',
    category: 'official',
    type: 'openai',
    models: { primary: 'gpt-5.2', light: 'gpt-5.2-mini' },
    connection: {
      agentRuntime: 'openai-agents-sdk',
      openaiBaseUrl: 'https://api.openai.example/v1',
      openaiApiKey: 'sk-openai-secret-value',
    },
    tuning: {
      fullPerTurnMs: 120000,
      quickPerTurnMs: 30000,
    },
  };

  it('is stable across activation-only metadata changes', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;

    svc.activate(provider.id);

    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).toBe(before);
  });

  it('changes when resolved model or endpoint changes', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;

    svc.update(provider.id, {
      models: { primary: 'gpt-5.2-pro' },
      connection: { openaiBaseUrl: 'https://api.changed.example/v1' },
    });

    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(before);
  });

  it('changes when secret material changes without storing plaintext secret', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id);

    svc.update(provider.id, {
      connection: { openaiApiKey: 'sk-openai-secret-value-v2' },
    });
    const after = resolveProviderRuntimeSnapshot(svc, provider.id);

    expect(after.snapshotHash).not.toBe(before.snapshotHash);
    expect(JSON.stringify(before.snapshot)).not.toContain('sk-openai-secret-value');
    expect(JSON.stringify(after.snapshot)).not.toContain('sk-openai-secret-value-v2');
    expect(after.snapshot.environment.OPENAI_API_KEY).toBeUndefined();
  });
});

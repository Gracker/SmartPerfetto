// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  localProviderMutationScope,
  ProviderMutationGenerationStore,
  type ProviderMutationOwner,
} from '../providerMutationGeneration';
import {ProviderService} from '../providerService';

function makeStore(
  databasePath: string,
  options: {
    hostName?: () => string;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): ProviderMutationGenerationStore {
  return new ProviderMutationGenerationStore({
    openDatabase: () => new Database(databasePath),
    ensureSchema: true,
    ...options,
  });
}

describe('provider mutation generations', () => {
  let directory: string;
  let databasePath: string;
  const scope = localProviderMutationScope();
  const owner: ProviderMutationOwner = {
    instanceId: 'instance-a',
    pid: 12345,
    host: 'host-a',
  };

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-mutation-generation-'));
    databasePath = path.join(directory, 'generations.sqlite');
  });

  afterEach(async () => {
    await fsp.rm(directory, {recursive: true, force: true});
  });

  it('tracks concurrent leases and a durable ABA-safe revision', () => {
    const store = makeStore(databasePath);
    expect(store.readVector([scope]).entries).toEqual([{
      scope,
      revision: 0,
      inFlight: 0,
    }]);

    const first = store.beginMutation(scope, owner);
    const second = store.beginMutation(scope, {
      instanceId: 'instance-b',
      pid: 54321,
      host: 'host-a',
    });
    expect(store.readVector([scope]).entries[0]).toMatchObject({
      revision: 2,
      inFlight: 2,
    });

    store.completeMutation(first);
    expect(store.readVector([scope]).entries[0]).toMatchObject({
      revision: 3,
      inFlight: 1,
    });

    store.completeMutation(second);
    expect(makeStore(databasePath).readVector([scope]).entries[0]).toMatchObject({
      revision: 4,
      inFlight: 0,
    });
  });

  it('rejects forged lease ownership without losing the real lease', () => {
    const store = makeStore(databasePath);
    const lease = store.beginMutation(scope, owner);

    expect(() => store.completeMutation({
      ...lease,
      owner: {...lease.owner, instanceId: 'forged-owner'},
    })).toThrow('provider_mutation_lease_not_owned');
    expect(store.listInFlight([scope])).toEqual([lease]);

    store.completeMutation(lease);
    expect(store.listInFlight([scope])).toEqual([]);
  });

  it('only recovers a same-host lease whose process is confirmed dead', () => {
    const deadStore = makeStore(databasePath, {
      hostName: () => 'host-a',
      isProcessAlive: () => false,
    });
    const deadLease = deadStore.beginMutation(scope, owner);

    expect(deadStore.recoverAbandonedMutation(deadLease.mutationId, scope)).toBe(true);
    expect(deadStore.readVector([scope]).entries[0]).toMatchObject({
      revision: 2,
      inFlight: 0,
    });
    expect(deadStore.recoverAbandonedMutation(deadLease.mutationId, scope)).toBe(false);

    const liveLease = deadStore.beginMutation(scope, owner);
    const liveStore = makeStore(databasePath, {
      hostName: () => 'host-a',
      isProcessAlive: () => true,
    });
    expect(() => liveStore.recoverAbandonedMutation(liveLease.mutationId, scope))
      .toThrow('provider_mutation_owner_still_alive');

    const remoteStore = makeStore(databasePath, {
      hostName: () => 'host-b',
      isProcessAlive: () => false,
    });
    expect(() => remoteStore.recoverAbandonedMutation(liveLease.mutationId, scope))
      .toThrow('provider_mutation_owner_liveness_unconfirmed');

    deadStore.completeMutation(liveLease);
  });

  it('wraps provider mutations, including failed writes, in generation changes', async () => {
    const serviceDirectory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'provider-mutation-service-'),
    );
    try {
      const service = new ProviderService(path.join(serviceDirectory, 'providers.json'));
      const revision = () => service.getMutationGeneration().entries[0];
      const provider = service.create({
        name: 'Provider',
        category: 'official',
        type: 'openai',
        models: {primary: 'gpt-test', light: 'gpt-test-light'},
        connection: {
          agentRuntime: 'openai-agents-sdk',
          openaiApiKey: 'secret',
        },
      });
      expect(revision()).toMatchObject({revision: 2, inFlight: 0});

      service.update(provider.id, {models: {primary: 'gpt-test-2'}});
      service.activate(provider.id);
      expect(revision()).toMatchObject({revision: 6, inFlight: 0});

      expect(() => service.delete(provider.id)).toThrow(/active/i);
      expect(revision()).toMatchObject({revision: 8, inFlight: 0});

      service.deactivateAll();
      service.delete(provider.id);
      expect(revision()).toMatchObject({revision: 12, inFlight: 0});
    } finally {
      await fsp.rm(serviceDirectory, {recursive: true, force: true});
    }
  });
});

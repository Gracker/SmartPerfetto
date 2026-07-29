// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  SelfEvolutionLifecycleSnapshot,
} from '../../../types/selfEvolution';
import {
  SelfEvolutionAdminService,
  selfEvolutionAdminServiceContract,
  type SelfEvolutionAdminDependencies,
} from '../selfEvolutionAdminService';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
const otherScope = {tenantId: 'tenant-a', workspaceId: 'workspace-b'};

describe('SelfEvolutionAdminService', () => {
  it('runs only an explicit curation operation and retains terminal events', async () => {
    const dependencies = fixture();
    const service = new SelfEvolutionAdminService(dependencies);
    const {operationId} = service.startCuration(scope);

    expect(service.operation(scope, operationId)).toMatchObject({
      state: 'running',
      events: [{type: 'started', stage: 'queued'}],
    });
    expect(() => service.operation(otherScope, operationId))
      .toThrow('self_evolution_operation_not_found');

    await flushMicrotasks();
    expect(service.operation(scope, operationId)).toMatchObject({
      state: 'completed',
      events: [
        {type: 'started'},
        {type: 'progress', stage: 'loading_feedback'},
        {type: 'progress', stage: 'curating'},
        {
          type: 'completed',
          proposalId: 'proposal-test-0001',
          diagnosticCodes: ['curation_threshold_not_met'],
        },
      ],
    });
    expect(dependencies.curate).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('keeps apply fail-closed when effective apply is disabled', async () => {
    const dependencies = fixture();
    const service = new SelfEvolutionAdminService(dependencies);

    await expect(service.apply(
      scope,
      'proposal-test-0001',
      'action-test-0001',
      {userId: 'admin-a'},
    )).rejects.toThrow('self_evolution_persistence_unavailable');
    expect(dependencies.apply).not.toHaveBeenCalled();
    service.close();
  });

  it('reports bounded operational counts without configuring an L2 judge', () => {
    const dependencies = fixture();
    dependencies.listProposals = jest.fn(() => [
      proposal('draft'),
      proposal('accepted'),
    ]);
    const service = new SelfEvolutionAdminService(dependencies);

    expect(service.overview(scope)).toMatchObject({
      proposalCounts: {draft: 1, accepted: 1, applied: 0},
      overlayCounts: {total: 0, effective: 0},
      operations: {running: 0, retained: 0},
      l2Judge: {
        status: 'not_configured',
        reason: 'explicit_external_judge_consent_required',
      },
    });
    expect(selfEvolutionAdminServiceContract).toEqual({
      maxOperations: 100,
      maxOperationsPerScope: 20,
      maxRunningOperationsPerScope: 4,
      maxEventsPerOperation: 64,
      terminalOperationTtlMs: 900_000,
      operationTimeoutMs: 300_000,
    });
    service.close();
  });

  it('rejects curation while the root feature remains disabled', () => {
    const dependencies = fixture();
    dependencies.lifecycle = () => lifecycle({
      enabled: false,
      applyEnabled: false,
    });
    const service = new SelfEvolutionAdminService(dependencies);

    expect(() => service.startCuration(scope))
      .toThrow('self_evolution_disabled');
    expect(dependencies.curate).not.toHaveBeenCalled();
    service.close();
  });

  it('isolates running-operation capacity by scope', () => {
    const dependencies = fixture();
    let nextId = 0;
    dependencies.operationId = () => `operation-${++nextId}`;
    dependencies.curate = jest.fn(() => new Promise<{
      proposal: CurationProposalV1 | null;
      diagnostics: Array<{code: string}>;
    }>(() => {}));
    const service = new SelfEvolutionAdminService(dependencies);

    for (let index = 0; index < 4; index += 1) {
      service.startCuration(scope);
    }

    expect(() => service.startCuration(scope))
      .toThrow('self_evolution_operation_scope_capacity_exceeded');
    service.startCuration(otherScope);
    expect(service.overview(scope).operations).toEqual({
      running: 4,
      retained: 4,
    });
    expect(service.overview(otherScope).operations).toEqual({
      running: 1,
      retained: 1,
    });
    service.close();
  });

  it('fails and releases a stuck curation operation after its timeout', () => {
    jest.useFakeTimers();
    try {
      const dependencies = fixture();
      dependencies.operationTimeoutMs = 100;
      dependencies.curate = jest.fn(() => new Promise<{
        proposal: CurationProposalV1 | null;
        diagnostics: Array<{code: string}>;
      }>(() => {}));
      const service = new SelfEvolutionAdminService(dependencies);
      const {operationId} = service.startCuration(scope);

      jest.advanceTimersByTime(100);

      expect(service.operation(scope, operationId)).toMatchObject({
        state: 'failed',
        events: expect.arrayContaining([
          expect.objectContaining({type: 'started'}),
          expect.objectContaining({
            type: 'failed',
            errorCode: 'self_evolution_operation_timeout',
          }),
        ]),
      });
      expect(service.overview(scope).operations.running).toBe(0);
      service.close();
    } finally {
      jest.useRealTimers();
    }
  });
});

function fixture(): SelfEvolutionAdminDependencies & {
  curate: jest.Mock;
  apply: jest.Mock;
} {
  return {
    lifecycle: () => lifecycle({enabled: true, applyEnabled: false}),
    listProposals: jest.fn(() => []),
    getProposal: jest.fn(() => proposal('draft')),
    latestGateAttempt: jest.fn(() => undefined),
    listAppliedRevisions: jest.fn(() => []),
    listOverlays: jest.fn(() => []),
    generationHead: jest.fn(() => null),
    latestReconciliation: jest.fn(() => null),
    curate: jest.fn(async () => ({
      proposal: proposal('draft'),
      diagnostics: [{code: 'curation_threshold_not_met'}],
    })),
    gate: jest.fn(async () => proposal('gated')),
    accept: jest.fn(() => proposal('accepted')),
    reject: jest.fn(() => proposal('rejected')),
    exportContribution: jest.fn(async () => ({} as never)),
    apply: jest.fn(async () => ({} as never)),
    revert: jest.fn(async () => ({} as never)),
    close: jest.fn(),
    operationId: () => 'operation-test-0001',
  };
}

function lifecycle(
  effectiveConfig: {enabled: boolean; applyEnabled: boolean},
): SelfEvolutionLifecycleSnapshot {
  return {
    initializedAt: 1,
    requestedConfig: effectiveConfig,
    effectiveConfig,
    persistence: {
      persistence: 'unavailable',
      reason: 'data_root_not_writable',
      configured: false,
      writable: false,
      outsidePackage: false,
      externalMount: false,
      dataRoot: '/tmp/data',
      packageRoot: '/tmp/package',
      checkedAt: 1,
    },
    migration: {status: 'not_attempted_persistence_unavailable'},
    currentBuildIdentity: {
      distribution: 'source',
      channel: 'stable',
      version: '1.3.0',
      commit: 'a'.repeat(40),
      target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
      signingMode: 'unsigned',
    },
    buildIdentityState: {
      status: 'not_loaded_persistence_unavailable',
      record: null,
    },
    warnings: [],
    errors: [],
  };
}

function proposal(
  status: CurationProposalV1['status'],
): CurationProposalV1 {
  const revision = status === 'draft'
    ? 1
    : status === 'gated'
      ? 2
      : status === 'accepted' || status === 'rejected'
        ? 3
        : status === 'applied'
          ? 4
          : 5;
  return {
    schemaVersion: 1,
    proposalId: 'proposal-test-0001',
    revision,
    idempotencyKey: 'a'.repeat(64),
    kind: 'skill_note',
    tier: 'T1',
    title: 'Test proposal',
    rationale: 'Test rationale',
    deltas: [{
      op: 'add',
      targetKind: 'skill_note',
      targetId: 'skill-a',
      operationId: 'operation-a',
      anchor: 'skillNotes[skillId="skill-a"]',
      baseContentHash: 'b'.repeat(64),
      after: 'Test note',
    }],
    expectedRegistryFingerprint: 'c'.repeat(64),
    expectedOverlayGeneration: `builtin:${'c'.repeat(64)}`,
    evidence: {
      negativeRunIds: ['run-a'],
      positiveRunIds: [],
      labeledCount: 3,
      negativeCount: 3,
      distinctTraceCount: 1,
      distinctSessionCount: 3,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: status === 'draft' ? 'not_run' : 'passed',
    expectedEffect: 'Improve evidence coverage',
    riskLevel: 'low',
    status,
    scope,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

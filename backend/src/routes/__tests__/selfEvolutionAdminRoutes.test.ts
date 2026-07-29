// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';

import type {
  CurationProposalV1,
  SelfEvolutionLifecycleSnapshot,
} from '../../types/selfEvolution';
import {
  SelfEvolutionAdminService,
  type SelfEvolutionAdminDependencies,
} from '../../services/selfEvolution/selfEvolutionAdminService';
import {createSelfEvolutionAdminRoutes} from '../selfEvolutionAdminRoutes';

const originalTrustedHeaders =
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const originalApiKey = process.env.SMARTPERFETTO_API_KEY;

beforeEach(() => {
  delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  process.env.SMARTPERFETTO_API_KEY = 'test-api-key';
});

afterEach(() => {
  restoreEnv(
    'SMARTPERFETTO_SSO_TRUSTED_HEADERS',
    originalTrustedHeaders,
  );
  restoreEnv('SMARTPERFETTO_API_KEY', originalApiKey);
});

describe('selfEvolutionAdminRoutes', () => {
  it('requires authentication and grants analysts read-only access', async () => {
    const service = new SelfEvolutionAdminService(fixture());
    const app = makeApp(service);

    await request(app)
      .get('/api/admin/self-evolution/overview')
      .expect(401);

    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const overview = await withIdentity(
      request(app).get('/api/admin/self-evolution/overview'),
      {role: 'analyst'},
    ).expect(200);
    expect(overview.body.proposalCounts.draft).toBe(1);

    await withIdentity(
      request(app).post('/api/admin/self-evolution/operations/curation'),
      {role: 'analyst'},
    ).expect(403);
    service.close();
  });

  it('streams a bounded explicit curation operation to a terminal event', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const dependencies = fixture();
    const service = new SelfEvolutionAdminService(dependencies);
    const app = makeApp(service);

    const start = await withIdentity(
      request(app).post('/api/admin/self-evolution/operations/curation'),
    ).expect(202);
    expect(start.body).toEqual({operationId: 'operation-test-0001'});

    const stream = await withIdentity(
      request(app).get(
        `/api/admin/self-evolution/operations/${start.body.operationId}/events`,
      ),
    ).expect('Content-Type', /text\/event-stream/).expect(200);

    expect(stream.text).toContain('event: started');
    expect(stream.text).toContain('event: completed');
    expect(stream.text).toContain('"proposalId":"proposal-test-0001"');
    expect(dependencies.curate).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('does not expose operation streams across workspaces', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const service = new SelfEvolutionAdminService(fixture());
    const app = makeApp(service);

    const start = await withIdentity(
      request(app).post('/api/admin/self-evolution/operations/curation'),
      {workspaceId: 'workspace-a'},
    ).expect(202);

    const response = await withIdentity(
      request(app).get(
        `/api/admin/self-evolution/operations/${start.body.operationId}/events`,
      ),
      {workspaceId: 'workspace-b'},
    ).expect(404);
    expect(response.body).toEqual({
      success: false,
      error: 'self_evolution_operation_not_found',
    });
    service.close();
  });

  it('returns 429 when one workspace exhausts its running-operation quota', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const dependencies = fixture();
    let nextId = 0;
    dependencies.operationId = () => `operation-${++nextId}`;
    dependencies.curate = jest.fn(() => new Promise<{
      proposal: CurationProposalV1 | null;
      diagnostics: Array<{code: string}>;
    }>(() => {}));
    const service = new SelfEvolutionAdminService(dependencies);
    const app = makeApp(service);

    for (let index = 0; index < 4; index += 1) {
      await withIdentity(
        request(app).post(
          '/api/admin/self-evolution/operations/curation',
        ),
      ).expect(202);
    }
    const response = await withIdentity(
      request(app).post(
        '/api/admin/self-evolution/operations/curation',
      ),
    ).expect(429);
    expect(response.body).toEqual({
      success: false,
      error: 'self_evolution_operation_scope_capacity_exceeded',
    });
    service.close();
  });

  it('keeps apply fail-closed before invoking persistence dependencies', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const dependencies = fixture();
    const service = new SelfEvolutionAdminService(dependencies);
    const app = makeApp(service);

    const response = await withIdentity(
      request(app)
        .post(
          '/api/admin/self-evolution/proposals/proposal-test-0001/apply',
        )
        .send({actionId: 'action-test-0001'}),
    ).expect(503);

    expect(response.body).toEqual({
      success: false,
      error: 'self_evolution_persistence_unavailable',
    });
    expect(dependencies.apply).not.toHaveBeenCalled();
    service.close();
  });
});

function makeApp(service: SelfEvolutionAdminService): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin/self-evolution',
    createSelfEvolutionAdminRoutes(service),
  );
  return app;
}

function withIdentity(
  test: request.Test,
  input: {role?: string; workspaceId?: string} = {},
): request.Test {
  return test
    .set('X-SmartPerfetto-SSO-User-Id', 'admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set(
      'X-SmartPerfetto-SSO-Workspace-Id',
      input.workspaceId ?? 'workspace-a',
    )
    .set(
      'X-SmartPerfetto-SSO-Roles',
      input.role ?? 'workspace_admin',
    );
}

function fixture(): SelfEvolutionAdminDependencies & {
  curate: jest.Mock;
  apply: jest.Mock;
} {
  return {
    lifecycle: () => lifecycle(),
    listProposals: jest.fn(() => [proposal()]),
    getProposal: jest.fn(() => proposal()),
    latestGateAttempt: jest.fn(() => undefined),
    listAppliedRevisions: jest.fn(() => []),
    listOverlays: jest.fn(() => []),
    generationHead: jest.fn(() => null),
    latestReconciliation: jest.fn(() => null),
    curate: jest.fn(async () => ({
      proposal: proposal(),
      diagnostics: [],
    })),
    gate: jest.fn(async () => proposal()),
    accept: jest.fn(() => proposal()),
    reject: jest.fn(() => proposal()),
    exportContribution: jest.fn(async () => ({} as never)),
    apply: jest.fn(async () => ({} as never)),
    revert: jest.fn(async () => ({} as never)),
    close: jest.fn(),
    operationId: () => 'operation-test-0001',
  };
}

function lifecycle(): SelfEvolutionLifecycleSnapshot {
  return {
    initializedAt: 1,
    requestedConfig: {enabled: true, applyEnabled: true},
    effectiveConfig: {enabled: true, applyEnabled: false},
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
      signingMode: 'source-checkout',
    },
    buildIdentityState: {
      status: 'not_loaded_persistence_unavailable',
      record: null,
    },
    warnings: [],
    errors: [],
  };
}

function proposal(): CurationProposalV1 {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-test-0001',
    revision: 1,
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
    pairedGateVerdict: 'not_run',
    expectedEffect: 'Improve evidence coverage',
    riskLevel: 'low',
    status: 'draft',
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

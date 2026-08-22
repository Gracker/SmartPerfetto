// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import { createAnalysisResultSnapshotRepository } from '../analysisResultSnapshotStore';
import { applyEnterpriseMinimalSchema } from '../enterpriseSchema';
import type {CapabilityManifestAttributionV1} from '../../types/capabilityManifest';
import {createDataEnvelope} from '../../types/dataContract';
import {buildEvidenceContract} from '../evidence/evidenceContractBuilder';
import {runDeterministicClaimVerifier} from '../verifier/deterministicClaimVerifier';

const capabilityManifest: CapabilityManifestAttributionV1 = {
  schemaVersion: 'capability_manifest_attribution@1',
  resolution: {
    status: 'ready',
    manifestId: `capability_manifest:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    manifestSchemaVersion: 'capability_manifest@1',
    traceFingerprintSha256: 'b'.repeat(64),
    traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64)},
  },
  probeCache: {hits: 4, misses: 1, bypasses: 0},
};
const traceSummary = {
  schemaVersion: 'trace_summary_attribution@1' as const, status: 'ready' as const,
  specId: 'smartperfetto.core.v1', specDigestSha256: '1'.repeat(64),
  traceFingerprintSha256: '2'.repeat(64),
  traceProcessor: {source: 'custom' as const, binarySha256: '3'.repeat(64)},
  resultDigestSha256: '4'.repeat(64),
  availableMetricIds: ['metric_a'], missingMetricIds: [],
};

function seedGraph(db: Database.Database): void {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-b', 'Tenant B', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  for (const [tenantId, workspaceId] of [
    ['tenant-a', 'workspace-a'],
    ['tenant-a', 'workspace-b'],
    ['tenant-b', 'workspace-c'],
  ]) {
    db.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspaceId, tenantId, workspaceId, now, now);
  }
  for (const [tenantId, userId] of [
    ['tenant-a', 'user-a'],
    ['tenant-a', 'user-b'],
    ['tenant-b', 'user-c'],
  ]) {
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, `${userId}@example.test`, userId, `oidc|${userId}`, now, now);
  }
  for (const [tenantId, workspaceId, userId, traceId, sessionId, runId] of [
    ['tenant-a', 'workspace-a', 'user-a', 'trace-a', 'session-a', 'run-a'],
    ['tenant-a', 'workspace-a', 'user-b', 'trace-b', 'session-b', 'run-b'],
    ['tenant-a', 'workspace-b', 'user-a', 'trace-c', 'session-c', 'run-c'],
    ['tenant-b', 'workspace-c', 'user-c', 'trace-d', 'session-d', 'run-d'],
  ]) {
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, created_at)
      VALUES
        (?, ?, ?, ?, ?, 100, 'ready', ?)
    `).run(traceId, tenantId, workspaceId, userId, `/tmp/${traceId}.pftrace`, now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, 'private', 'completed', ?, ?)
    `).run(sessionId, tenantId, workspaceId, traceId, userId, sessionId, now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
      VALUES
        (?, ?, ?, ?, 'agent', 'completed', 'analyze startup', ?, ?)
    `).run(runId, tenantId, workspaceId, sessionId, now, now);
  }
}

function snapshot(overrides: Partial<AnalysisResultSnapshot>): AnalysisResultSnapshot {
  const id = overrides.id ?? 'snapshot-a';
  return {
    id,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    runId: 'run-a',
    createdBy: 'user-a',
    visibility: 'private',
    sceneType: 'startup',
    title: id,
    userQuery: 'analyze startup',
    traceLabel: 'trace-a',
    traceMetadata: { deviceModel: 'Pixel' },
    summary: { headline: 'Startup analyzed', confidence: 0.8 },
    conclusionContract: {
      claims: [{
        id: 'Q1',
        text: 'Startup analyzed',
        references: [{ evidenceRefId: 'env-a', sourceRef: '表 1' }],
      }],
    },
    claimSupport: [{
      claimId: 'Q1',
      kind: 'numeric',
      text: 'Startup analyzed',
      anchors: [],
      supportLevel: 'verified',
    }],
    claimVerificationResult: {
      schemaVersion: 'claim_verifier@1',
      status: 'passed',
      policy: 'record_only',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
      claimResults: [{ claimId: 'Q1', status: 'verified' }],
      issues: [],
    },
    identityResolutions: [{
      version: 'identity_contract@1',
      identityRefId: 'identity-a',
      target: { traceId: 'trace-a', source: 'derived' },
      status: 'verified',
      processes: [],
      threads: [],
      warnings: [],
    }],
    metrics: [
      {
        key: 'startup.total_ms',
        label: 'Startup total duration',
        group: 'startup',
        value: 1234,
        unit: 'ms',
        direction: 'lower_is_better',
        aggregation: 'single',
        confidence: 0.9,
        source: { type: 'skill', skillId: 'startup_analysis', dataEnvelopeId: 'env-a' },
      },
    ],
    evidenceRefs: [
      {
        id: `evidence-${id}`,
        type: 'data_envelope',
        dataEnvelopeId: 'env-a',
        runId: overrides.runId ?? 'run-a',
      },
    ],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_001,
    ...overrides,
  };
}

describe('AnalysisResultSnapshotRepository', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
    seedGraph(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('persists snapshot, metrics, evidence, and audit event', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({}));

    const loaded = repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' },
      'snapshot-a',
    );

    expect(loaded).toEqual(expect.objectContaining({
      id: 'snapshot-a',
      traceId: 'trace-a',
      status: 'ready',
      schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    }));
    expect(loaded?.conclusionContract).toEqual(expect.objectContaining({
      claims: [expect.objectContaining({ id: 'Q1' })],
    }));
    expect(loaded?.claimSupport?.[0]).toEqual(expect.objectContaining({
      claimId: 'Q1',
      supportLevel: 'verified',
    }));
    expect(loaded?.claimVerificationResult).toEqual(expect.objectContaining({
      schemaVersion: 'claim_verifier@1',
      status: 'passed',
    }));
    expect(loaded?.identityResolutions?.[0]).toEqual(expect.objectContaining({
      identityRefId: 'identity-a',
      status: 'verified',
    }));
    expect(loaded?.metrics).toHaveLength(1);
    expect(loaded?.metrics[0]).toEqual(expect.objectContaining({
      key: 'startup.total_ms',
      value: 1234,
      source: expect.objectContaining({ skillId: 'startup_analysis' }),
    }));
    expect(loaded?.evidenceRefs).toEqual([
      expect.objectContaining({ id: 'evidence-snapshot-a', type: 'data_envelope' }),
    ]);

    const auditRows = db!.prepare<unknown[], { action: string }>(`
      SELECT action FROM audit_events WHERE resource_id = 'snapshot-a' ORDER BY created_at ASC
    `).all();
    expect(auditRows.map(row => row.action)).toEqual([
      'analysis_result.created',
      'analysis_result.read',
    ]);
  });

  test('round-trips Trace Summary attribution inside the existing summary JSON', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({
      id: 'snapshot-trace-summary',
      summary: {headline: 'summary', traceSummary},
    }));

    const loaded = repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-trace-summary',
    );
    expect(loaded?.summary.traceSummary).toEqual(traceSummary);
  });

  test('round-trips capability attribution in its own nullable column', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({id: 'snapshot-capability', capabilityManifest}));

    const raw = db!.prepare<[], {capability_manifest_json: string | null}>(`
      SELECT capability_manifest_json FROM analysis_result_snapshots
      WHERE id = 'snapshot-capability'
    `).get();
    const loaded = repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-capability',
    );

    expect(JSON.parse(raw?.capability_manifest_json || 'null')).toEqual(capabilityManifest);
    expect(loaded?.capabilityManifest).toEqual(capabilityManifest);
    expect(repo.listSnapshots(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
    )[0]?.capabilityManifest).toEqual(capabilityManifest);
    expect(repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-a',
    )).toBeNull();
  });

  test('round-trips binary relation anchors and rebuilds deterministic evidence', () => {
    const envelope = createDataEnvelope({
      columns: ['row_kind', 'utid', 'client_utid', 'server_utid'],
      rows: [
        ['client', 11, null, null],
        ['server', 22, null, null],
        ['proof', null, 11, 22],
      ],
    }, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'Binder proof',
      evidenceRefId: 'data:binder-proof',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: 'identity:binder',
      identityStatus: 'verified',
    });
    const endpoint = (row_kind: string) => ({
      evidenceRefId: 'data:binder-proof',
      rowSelector: {row_kind},
    });
    const evidence = buildEvidenceContract({
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims: [{
          id: 'claim-binder-relation',
          kind: 'causal',
          text: 'client binder call targets server',
          references: [],
          relationRefs: ['relation:binder-peer'],
        }],
        uncertainties: [],
        nextSteps: [],
      },
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:binder-peer',
        kind: 'binder_peer',
        direction: 'subject_to_object',
        subject: endpoint('client'),
        object: endpoint('server'),
        proof: endpoint('proof'),
        proofBindings: {
          subject: {endpointColumn: 'utid', proofColumn: 'client_utid'},
          object: {endpointColumn: 'utid', proofColumn: 'server_utid'},
        },
      }],
    });
    const verification = runDeterministicClaimVerifier({claimSupport: evidence.claimSupport});
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({
      id: 'snapshot-relation-graph',
      claimSupport: evidence.claimSupport,
      claimVerificationResult: verification,
    }));

    const loaded = repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-relation-graph',
    );
    expect(loaded?.claimSupport).toEqual(evidence.claimSupport);
    const support = loaded!.claimSupport![0];
    const relation = support.relations![0];
    const rebuiltAnchors = new Map((support.relationAnchors || []).map(anchor => [anchor.anchorId, anchor]));
    expect(relation.directEvidenceAnchorIds.every(anchorId => rebuiltAnchors.has(anchorId))).toBe(true);
    expect(rebuiltAnchors.get(relation.proofAnchorId!)?.cells).toEqual([
      expect.objectContaining({column: 'client_utid', value: 11, actualValue: 11}),
      expect.objectContaining({column: 'server_utid', value: 22, actualValue: 22}),
    ]);
    expect(runDeterministicClaimVerifier({claimSupport: loaded?.claimSupport})).toEqual(
      expect.objectContaining({status: 'passed', passed: true}),
    );
  });

  test('keeps snapshots without capability attribution readable', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({id: 'snapshot-legacy'}));

    expect(repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-legacy',
    )).not.toHaveProperty('capabilityManifest');
  });

  test('scopes evidence storage rows by snapshot so stable evidence ids can repeat across runs', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({
      id: 'snapshot-a',
      evidenceRefs: [{
        id: 'data:skill:startup_analysis:summary',
        type: 'data_envelope',
        dataEnvelopeId: 'env-a',
        runId: 'run-a',
      }],
    }));
    repo.createSnapshot(snapshot({
      id: 'snapshot-b',
      traceId: 'trace-b',
      sessionId: 'session-b',
      runId: 'run-b',
      createdBy: 'user-b',
      evidenceRefs: [{
        id: 'data:skill:startup_analysis:summary',
        type: 'data_envelope',
        dataEnvelopeId: 'env-b',
        runId: 'run-b',
      }],
    }));

    const rows = db!.prepare<unknown[], { id: string; snapshot_id: string }>(`
      SELECT id, snapshot_id
      FROM analysis_result_evidence_refs
      WHERE id LIKE '%data:skill:startup_analysis:summary'
      ORDER BY snapshot_id ASC
    `).all();

    expect(rows).toEqual([
      { id: 'snapshot-a:data:skill:startup_analysis:summary', snapshot_id: 'snapshot-a' },
      { id: 'snapshot-b:data:skill:startup_analysis:summary', snapshot_id: 'snapshot-b' },
    ]);
    expect(repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' },
      'snapshot-a',
    )?.evidenceRefs[0]?.id).toBe('data:skill:startup_analysis:summary');
    expect(repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-b' },
      'snapshot-b',
    )?.evidenceRefs[0]?.id).toBe('data:skill:startup_analysis:summary');
  });

  test('enforces private visibility by creator and workspace visible sharing', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({ id: 'private-a' }));
    repo.createSnapshot(snapshot({
      id: 'workspace-b',
      traceId: 'trace-b',
      sessionId: 'session-b',
      runId: 'run-b',
      createdBy: 'user-b',
      visibility: 'workspace',
    }));

    expect(repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-b' },
      'private-a',
    )).toBeNull();
    expect(repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' },
      'private-a',
    )?.id).toBe('private-a');
    expect(repo.getSnapshot(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' },
      'workspace-b',
    )?.id).toBe('workspace-b');

    const listForUserA = repo.listSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    });
    expect(listForUserA.map(item => item.id).sort()).toEqual(['private-a', 'workspace-b']);
    expect(listForUserA[0].conclusionContract).toBeUndefined();
    expect(repo.listSnapshots(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' },
      { includeConclusionContract: true },
    ).some(item => item.conclusionContract)).toBe(true);
  });

  test('does not leak across workspace or tenant and restricts visibility updates to owners', () => {
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({ id: 'snapshot-a' }));
    repo.createSnapshot(snapshot({
      id: 'snapshot-c',
      workspaceId: 'workspace-b',
      traceId: 'trace-c',
      sessionId: 'session-c',
      runId: 'run-c',
      createdBy: 'user-a',
    }));
    repo.createSnapshot(snapshot({
      id: 'snapshot-d',
      tenantId: 'tenant-b',
      workspaceId: 'workspace-c',
      traceId: 'trace-d',
      sessionId: 'session-d',
      runId: 'run-d',
      createdBy: 'user-c',
    }));

    expect(repo.listSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    }).map(item => item.id)).toEqual(['snapshot-a']);
    expect(repo.getSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    }, 'snapshot-d')).toBeNull();

    expect(repo.updateVisibility({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-b',
    }, 'snapshot-a', 'workspace')).toBeNull();
    expect(repo.updateVisibility({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    }, 'snapshot-a', 'workspace')?.visibility).toBe('workspace');
  });
});

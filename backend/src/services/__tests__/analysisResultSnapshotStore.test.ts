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
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {buildEvidenceContract} from '../evidence/evidenceContractBuilder';
import {runDeterministicClaimVerifier} from '../verifier/deterministicClaimVerifier';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {buildCompletedAnalysisResultSnapshot} from '../analysisResultSnapshotPipeline';
import {buildDeterministicComparisonResult} from '../comparisonResultService';
import {BIG_CORE_PCT_DEFINITION} from '../comparisonMetricProducerContract';

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

  test('round-trips exact final body, delivery metadata and claim verifier v2 without recomputation', () => {
    const repository = createAnalysisResultSnapshotRepository(db!);
    const body = 'A bounded answer\n\nwith exact spacing and no terminal punctuation';
    const value = snapshot({summary: {
      headline: 'A bounded answer', conclusion: body,
      completion: {schemaVersion: 1, runtimeKind: 'pi-agent-core', status: 'incomplete', reason: 'output_limit',
        candidateRef: 'candidate-a', runId: 'run-a', attemptId: 'attempt-a', conclusionFingerprint: analysisDeliveryFingerprint(body)},
      outputOrigin: 'assistant_stream',
      deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'failed', claims: 'failed',
        source: 'not_checked', identity: 'passed', report: 'coverage_incomplete'},
    }, claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed', policy: 'record_only', passed: false,
      checkedClaimCount: 1, unsupportedClaimCount: 1, claimResults: [{claimId: 'Q1', status: 'unsupported',
        referenceCells: [{evidenceRefId: 'env-a', status: 'matched'}],
        deterministicProof: {kind: 'numeric_cell', status: 'proved', reason: 'numeric_match', anchorIds: ['anchor-a'], evidenceRefIds: ['env-a']},
        propositionCoverage: {status: 'partial', covered: ['numeric_value'], uncovered: ['mechanism'], reason: 'incomplete_proposition'},
      }], issues: [{claimId: 'Q1', severity: 'error', code: 'semantic_mismatch', message: 'The supplied value does not establish the stated mechanism.'}]}});
    repository.createSnapshot(value);
    const loaded = repository.getSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'}, value.id);
    expect(loaded?.summary).toEqual(value.summary);
    expect(loaded?.summary.conclusion).toBe(body);
    expect(loaded?.claimVerificationResult).toEqual(value.claimVerificationResult);
    const legacy = snapshot({id: 'snapshot-legacy'});
    repository.createSnapshot(legacy);
    const restored = repository.getSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'}, legacy.id);
    expect(restored?.summary).not.toHaveProperty('completion');
    expect(restored?.summary).not.toHaveProperty('deliveryAssurance');
  });

  test('round-trips a long conclusion and all late claims and references without promoting verification', () => {
    const claims = Array.from({length: 240}, (_, index) => ({id: `phase-${index}`, kind: 'numeric',
      text: `Phase ${index} took ${index + 0.125} ms.`,
      references: [{evidenceRefId: `data:phase-${index}`, rowIndex: index + 1000,
        column: 'duration_ms', value: index + 0.125}]}));
    const body = claims.map(claim => `${claim.text} This phase is scoped to its original investigation interval. ` +
      'Overlapping work cannot be summed into the launch total, and its cause remains unresolved.\n').join('\n') +
      '\n| Final finding | Duration (ms) |\n| --- | ---: |\n| TAIL_PHASE_239 | 239.125 |\n' +
      '\nTAIL_LIMITATION: The last phase is measured, but no causal explanation has been verified.';
    const value = snapshot({summary: {headline: 'Per-phase measurements', conclusion: body},
      conclusionContract: {claims}, claimSupport: [],
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'not_checked', policy: 'record_only',
        passed: false, checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [], issues: []},
      evidenceRefs: claims.map((claim, index) => ({id: `reference-${index}`, type: 'data_envelope',
        dataEnvelopeId: claim.references[0].evidenceRefId, runId: 'run-a'})),
    });
    expect(body.length).toBeGreaterThan(40_000);
    const repository = createAnalysisResultSnapshotRepository(db!);
    repository.createSnapshot(value);
    const loaded = repository.getSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'}, value.id);

    expect(loaded?.summary.conclusion).toBe(body);
    expect(loaded?.conclusionContract).toEqual({claims});
    expect(loaded?.evidenceRefs).toHaveLength(value.evidenceRefs.length);
    expect(loaded?.evidenceRefs).toEqual(expect.arrayContaining(value.evidenceRefs));
    expect(loaded?.claimVerificationResult).toEqual(value.claimVerificationResult);
    expect(loaded?.claimSupport).toEqual([]);
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

  test('round-trips source-claim provenance through the existing conclusion JSON column', () => {
    const sourceReference = {
      id: 'source-ref-v1-aaaaaaaaaaaaaaaaaaaaaaaa',
      referenceId: 'lookup-1',
      codebaseId: 'app-source',
      filePath: 'src/main/Foo.kt',
      lookupKind: 'body',
    };
    const conclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{rank: 1, statement: 'Foo.run matches trace evidence'}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        text: 'Foo.run matches trace evidence',
        references: [{evidenceRefId: 'data:trace-1'}],
      }],
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['app-source'],
        status: 'corroborated',
        attemptedTools: ['read_codebase_file'],
        queriedCodebaseIds: ['app-source'],
        usedCodebaseIds: ['app-source'],
        references: [sourceReference],
      },
      sourceReferences: [sourceReference],
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['data:trace-1'],
      }],
      uncertainties: [],
      nextSteps: [],
    };
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({
      id: 'snapshot-source-contract',
      conclusionContract,
    }));

    const loaded = repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-source-contract',
    );

    expect(loaded?.conclusionContract).toEqual(conclusionContract);
    const columns = db!.prepare(`PRAGMA table_info(analysis_result_snapshots)`).all() as Array<{name: string}>;
    expect(columns.some(column => column.name === 'source_claim_bindings_json')).toBe(false);
  });

  test('keeps old snapshot rows without source fields byte-compatible', () => {
    const legacyContract = {claims: [{id: 'Q1', text: 'legacy', references: []}]};
    const repo = createAnalysisResultSnapshotRepository(db!);
    repo.createSnapshot(snapshot({
      id: 'snapshot-legacy-contract',
      conclusionContract: legacyContract,
    }));

    expect(repo.getSnapshot(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
      'snapshot-legacy-contract',
    )?.conclusionContract).toEqual(legacyContract);
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
    const restoredVerification = runDeterministicClaimVerifier({claimSupport: loaded?.claimSupport});
    expect(restoredVerification).toEqual(verification);
    expect(restoredVerification).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'partial', passed: false,
      claimResults: [{status: 'inference', deterministicProof: {kind: 'none', status: 'not_checked'}, propositionCoverage: {status: 'none'}}]});
    expect(loaded?.claimVerificationResult).toEqual(verification);
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

describe('scene report reference JSON round-trip', () => {
  test('stores the historical reference in the existing summary column and preserves owner access', () => {
    const db = new Database(':memory:');
    try {
      applyEnterpriseMinimalSchema(db);
      seedGraph(db);
      const repo = createAnalysisResultSnapshotRepository(db);
      const sceneReport = {schemaVersion: 'scene_report_ref@1' as const, reportId: 'scene-v3-round-trip',
        traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a', revision: 601,
        expiresAt: 1, manifestSha256: 'b'.repeat(64)};
      const value = snapshot({id: 'scene-reference-snapshot', summary: {headline: 'A historical scene result', sceneReport}});
      repo.createSnapshot(value);
      const loaded = repo.getSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'}, value.id);
      expect(loaded?.summary.sceneReport).toEqual(sceneReport);
      expect(JSON.stringify(loaded)).not.toContain('sceneTimeline');
      expect(repo.getSnapshot({tenantId: 'tenant-b', workspaceId: 'workspace-c', userId: 'user-c'}, value.id)).toBeNull();
      const row = db.prepare('SELECT summary_json FROM analysis_result_snapshots WHERE id = ?').get(value.id) as {summary_json: string};
      expect(JSON.parse(row.summary_json).sceneReport).toEqual(sceneReport);
    } finally {db.close();}
  });
});

// A producer may declare a metric's definition on its row
// (`<column>_definition`). Snapshots compare such a metric only under the same
// declaration, read back through the store as comparisons do.
describe('declared metric definitions across persistence', () => {
  const DECLARED = 'present_interval:p50@2';
  const owners = {
    old: {userId: 'user-a', traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a'},
    new: {userId: 'user-b', traceId: 'trace-b', sessionId: 'session-b', runId: 'run-b'},
  };

  function storedSnapshot(db: Database.Database, owner: keyof typeof owners, envelope: DataEnvelope) {
    const built = buildCompletedAnalysisResultSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a',
      ...owners[owner], query: 'analysis', conclusion: 'done', dataEnvelopes: [envelope]});
    const repository = createAnalysisResultSnapshotRepository(db);
    repository.createSnapshot(built!);
    return repository.getSnapshot({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: owners[owner].userId}, built!.id)!;
  }

  const fpsEnvelope = (row: Record<string, unknown>) =>
    createDataEnvelope({columns: Object.keys(row), rows: [Object.values(row)]}, {
      type: 'skill_result', source: 'scrolling_analysis:frame_summary', skillId: 'scrolling_analysis',
      stepId: 'frame_summary', title: 'frames',
    });

  function compare(db: Database.Database, metricKey: 'scrolling.avg_fps' | 'cpu.big_core_pct',
    baseline: DataEnvelope, candidate: DataEnvelope) {
    const before = storedSnapshot(db, 'old', baseline);
    const after = storedSnapshot(db, 'new', candidate);
    const result = buildDeterministicComparisonResult([before, after],
      {baselineSnapshotId: before.id, metricKeys: [metricKey]});
    return {before, after, result, delta: result.matrix.rows[0].deltas[0]};
  }

  function withDb<T>(run: (db: Database.Database) => T): T {
    const db = new Database(':memory:');
    try {
      applyEnterpriseMinimalSchema(db);
      seedGraph(db);
      return run(db);
    } finally { db.close(); }
  }

  test('keeps an undeclared value out of a declared delta and says why', () => withDb(db => {
    const {before, after, result, delta} = compare(db, 'scrolling.avg_fps',
      fpsEnvelope({avg_fps: 50}), fpsEnvelope({avg_fps: 58, avg_fps_definition: DECLARED}));
    expect(before.metrics.find(metric => metric.key === 'scrolling.avg_fps')?.source).not.toHaveProperty('metricDefinition');
    expect(after.metrics.find(metric => metric.key === 'scrolling.avg_fps')?.source.metricDefinition).toBe(DECLARED);
    expect(delta).toMatchObject({deltaValue: null, deltaPct: null, assessment: 'unknown'});
    expect(result.significantChanges).toEqual([]);
    const warning = `Metric scrolling.avg_fps uses different definitions in ${before.id} (undeclared) and ${after.id} (${DECLARED}); delta not computed`;
    expect(result.matrix.warnings).toContain(warning);
    expect(result.conclusion.uncertainty).toContain(warning);
  }));

  test('compares values under the same declaration', () => withDb(db => {
    const {result, delta} = compare(db, 'scrolling.avg_fps',
      fpsEnvelope({avg_fps: 50, avg_fps_definition: DECLARED}), fpsEnvelope({avg_fps: 58, avg_fps_definition: DECLARED}));
    expect(delta).toMatchObject({deltaValue: 8});
    expect(result.matrix.warnings.filter(warning => warning.includes('definitions'))).toEqual([]);
  }));

  test('leaves undeclared values comparing as before', () => withDb(db => {
    expect(compare(db, 'scrolling.avg_fps', fpsEnvelope({avg_fps: 50}), fpsEnvelope({avg_fps: 60})).delta)
      .toMatchObject({deltaValue: 10});
  }));

  test('takes a definition only from the row that declares it beside the value', () => withDb(db => {
    const declarationOnly = storedSnapshot(db, 'old', fpsEnvelope({avg_fps_definition: DECLARED, frame_count: 5}));
    expect(declarationOnly.metrics.find(metric => metric.key === 'scrolling.avg_fps')).toBeUndefined();
    const blank = storedSnapshot(db, 'new', fpsEnvelope({avg_fps: 40, avg_fps_definition: '  '}));
    expect(blank.metrics.find(metric => metric.key === 'scrolling.avg_fps')?.source).not.toHaveProperty('metricDefinition');
  }));

  // cpu.big_core_pct has a producer contract (comparisonMetricProducerContract.ts).
  const startupRow = (overrides: Record<string, unknown> = {}) => ({big_core_pct: 70, unknown_core_ns: 0,
    main_thread_count: 1, big_core_pct_definition: BIG_CORE_PCT_DEFINITION, ...overrides});
  /** startup_analysis's iterator envelope; item 0 returned no cpu rows. */
  function iterated(row: Record<string, unknown>) {
    const envelope = createDataEnvelope({columns: ['startup_id'], rows: [[1], [2]]}, {
      type: 'skill_result', source: 'startup_analysis:analyze_startups', skillId: 'startup_analysis',
      stepId: 'analyze_startups', title: 'startups'});
    (envelope.data as any).expandableData = [
      {item: {startup_id: 1}, result: {success: true, sections: {cpu_core_analysis: {title: 'cpu', data: []}}}},
      {item: {startup_id: 2}, result: {success: true, sections: {cpu_core_analysis: {title: 'cpu', data: [row]}}}},
    ];
    return envelope;
  }

  test('keeps the producer contract provenance of cpu.big_core_pct through the store', () => withDb(db => {
    const {before, after, delta, result} = compare(db, 'cpu.big_core_pct',
      iterated(startupRow()), iterated(startupRow({big_core_pct: 55})));
    expect(before.metrics.find(metric => metric.key === 'cpu.big_core_pct')).toMatchObject({value: 70,
      source: {skillId: 'startup_analysis', stepId: 'analyze_startups', section: 'cpu_core_analysis', itemIndex: 1,
        metricDefinition: BIG_CORE_PCT_DEFINITION}});
    expect(after.metrics.find(metric => metric.key === 'cpu.big_core_pct')?.value).toBe(55);
    expect(delta).toMatchObject({deltaValue: -15});
    expect(result.matrix.warnings).toEqual([]);
  }));

  test('keeps a withheld cpu.big_core_pct missing, with its reason, after the store', () => withDb(db => {
    const {after, result, delta} = compare(db, 'cpu.big_core_pct',
      iterated(startupRow()), iterated(startupRow({unknown_core_ns: 4000})));
    expect(after.metrics.find(metric => metric.key === 'cpu.big_core_pct')).toMatchObject({value: null,
      missingReason: 'producer_contract:unknown_core_time', source: {section: 'cpu_core_analysis', itemIndex: 1}});
    expect(after.status).toBe('partial');
    expect(delta.deltaValue).toBeNull();
    expect(result.matrix.missingMatrix[after.id]).toEqual({'cpu.big_core_pct': 'producer_contract:unknown_core_time'});
  }));
});

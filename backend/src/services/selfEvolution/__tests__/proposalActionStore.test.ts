// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {CurationProposalV1} from '../../../types/selfEvolution';
import {PROPOSAL_GATE_IDS} from '../../../types/selfEvolution';
import {canonicalContentHash, canonicalJsonString} from '../canonicalJson';
import {
  createProposalGateResultV1,
  parseCurationProposalV1,
  proposalDraftContentHash,
} from '../proposalGateContract';
import {ProposalStore} from '../proposalStore';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};

describe('ProposalStore M8 action saga', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-actions-'));
    databasePath = path.join(directory, 'proposals.db');
    createM7Database(databasePath, gatedProposal());
  });

  afterEach(() => {
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('migrates r2, accepts r3, and finalizes append-only r4/r5 revisions', () => {
    const store = new ProposalStore({databasePath});
    try {
      expect(store.accept(scope, 'proposal_action_test')).toMatchObject({
        revision: 3,
        status: 'accepted',
      });
      const apply = store.reserveAction({
        actionId: 'action_apply',
        scope,
        proposalId: 'proposal_action_test',
        kind: 'apply',
        sideEffectKind: 'runtime_overlay',
        now: 10,
      });
      expect(apply.state).toBe('pending');
      expect(store.get(scope, 'proposal_action_test')).toMatchObject({
        activeActionId: 'action_apply',
      });
      expect(() => store.reserveAction({
        actionId: 'action_other',
        scope,
        proposalId: 'proposal_action_test',
        kind: 'apply',
        sideEffectKind: 'runtime_overlay',
      })).toThrow('proposal_not_eligible_for_apply');

      store.markActionExecuting('action_apply', 11);
      const applied = store.finalizeAction({
        actionId: 'action_apply',
        generation: '1'.repeat(64),
        overlayIds: ['overlay_test'],
        receiptContentHashes: ['2'.repeat(64)],
        actor: {userId: 'maintainer'},
        now: 12,
      });
      expect(applied).toMatchObject({
        ordinal: 1,
        proposalRevision: 4,
        kind: 'apply',
      });
      expect(store.get(scope, 'proposal_action_test')).toMatchObject({
        revision: 4,
        status: 'applied',
      });
      expect(store.commitAppliedRevision({
        actionId: 'action_apply',
        generation: '1'.repeat(64),
        overlayIds: ['overlay_test'],
        receiptContentHashes: ['2'.repeat(64)],
        actor: {userId: 'maintainer'},
        now: 99,
      })).toEqual(applied);

      store.reserveAction({
        actionId: 'action_revert',
        scope,
        proposalId: 'proposal_action_test',
        kind: 'revert',
        sideEffectKind: 'runtime_overlay',
        now: 13,
      });
      store.markActionExecuting('action_revert', 14);
      store.finalizeAction({
        actionId: 'action_revert',
        generation: '3'.repeat(64),
        overlayIds: ['overlay_test'],
        receiptContentHashes: ['4'.repeat(64)],
        actor: {userId: 'maintainer'},
        now: 15,
      });

      expect(store.get(scope, 'proposal_action_test')).toMatchObject({
        revision: 5,
        status: 'reverted',
      });
      expect(store.listAppliedRevisions('proposal_action_test')).toEqual([
        expect.objectContaining({ordinal: 1, proposalRevision: 4}),
        expect.objectContaining({ordinal: 2, proposalRevision: 5}),
      ]);
    } finally {
      store.close();
    }
  });

  it('records append-only channel artifacts and revokes repository patches without applying them', () => {
    const store = new ProposalStore({databasePath});
    try {
      const active = store.recordChannelArtifact({
        scope,
        proposalId: 'proposal_action_test',
        channel: 'repository_patch',
        gateAttemptId: 'attempt_repository_patch',
        gateAttemptOrdinal: 1,
        gateResultContentHash: '1'.repeat(64),
        artifactId: 'repository-patch:proposal_action_test:test',
        artifactContentHash: '2'.repeat(64),
        createdAt: 10,
      });
      expect(active.state).toBe('active');
      const revoked = store.revokeChannelArtifact({
        scope,
        proposalId: 'proposal_action_test',
        channel: 'repository_patch',
        artifactId: active.artifactId,
        createdAt: 11,
      });
      expect(revoked).toMatchObject({
        ordinal: 2,
        state: 'revoked',
      });
      expect(store.revokeChannelArtifact({
        scope,
        proposalId: 'proposal_action_test',
        channel: 'repository_patch',
        artifactId: active.artifactId,
        createdAt: 12,
      })).toEqual(revoked);
      expect(store.listChannelArtifactRevisions(scope, 'proposal_action_test'))
        .toEqual([active, revoked]);
    } finally {
      store.close();
    }
  });

  it('rejects repository artifact revocation outside the proposal scope', () => {
    const store = new ProposalStore({databasePath});
    try {
      const active = store.recordChannelArtifact({
        scope,
        proposalId: 'proposal_action_test',
        channel: 'repository_patch',
        gateAttemptId: 'attempt_repository_patch',
        gateAttemptOrdinal: 1,
        gateResultContentHash: '1'.repeat(64),
        artifactId: 'repository-patch:proposal_action_test:scoped',
        artifactContentHash: '2'.repeat(64),
        createdAt: 10,
      });
      expect(() => store.revokeChannelArtifact({
        scope: {tenantId: 'other', workspaceId: 'workspace'},
        proposalId: 'proposal_action_test',
        channel: 'repository_patch',
        artifactId: active.artifactId,
        createdAt: 11,
      })).toThrow('proposal_channel_artifact_not_found');
      expect(store.listChannelArtifactRevisions(scope, 'proposal_action_test'))
        .toEqual([active]);
    } finally {
      store.close();
    }
  });

  it('clears terminal pre-side-effect failures and exposes recovery work', () => {
    const store = new ProposalStore({databasePath});
    try {
      store.accept(scope, 'proposal_action_test');
      store.reserveAction({
        actionId: 'action_terminal',
        scope,
        proposalId: 'proposal_action_test',
        kind: 'apply',
        sideEffectKind: 'runtime_overlay',
        now: 10,
      });
      store.failAction({
        actionId: 'action_terminal',
        failureClass: 'terminal_before_side_effect',
        errorCode: 'artifact_invalid',
        now: 11,
      });
      expect(store.get(scope, 'proposal_action_test')?.activeActionId)
        .toBeUndefined();
      expect(store.listRecoverableActions()).toEqual([]);

      store.reserveAction({
        actionId: 'action_recover',
        scope,
        proposalId: 'proposal_action_test',
        kind: 'apply',
        sideEffectKind: 'runtime_overlay',
        now: 12,
      });
      store.markActionExecuting('action_recover', 13);
      store.failAction({
        actionId: 'action_recover',
        failureClass: 'recovery_required_after_side_effect',
        errorCode: 'publish_interrupted',
        now: 14,
      });
      expect(store.listRecoverableActions()).toEqual([
        expect.objectContaining({
          actionId: 'action_recover',
          failureClass: 'recovery_required_after_side_effect',
        }),
      ]);
      expect(store.retryAction('action_recover', 15)).toMatchObject({
        state: 'pending',
      });
    } finally {
      store.close();
    }
  });

  it('preserves M7 gate foreign keys while widening proposal/evidence schemas', () => {
    const legacy = new Database(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE proposal_gate_attempts (
          attempt_id TEXT PRIMARY KEY,
          attempt_ordinal INTEGER NOT NULL,
          proposal_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          draft_content_hash TEXT NOT NULL,
          gate_policy_fingerprint TEXT NOT NULL,
          fence_token TEXT NOT NULL,
          state TEXT NOT NULL,
          verdict TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          gate_result_hash TEXT,
          gate_result_json TEXT,
          FOREIGN KEY(proposal_id)
            REFERENCES curation_proposals(proposal_id)
        );
        CREATE TABLE proposal_gate_evidence (
          attempt_id TEXT NOT NULL,
          evidence_kind TEXT NOT NULL CHECK(
            evidence_kind IN (
              'materialization_plan',
              'containment_probe',
              'containment_probe_final',
              'candidate_materialization',
              'base_snapshot_initial',
              'base_snapshot_final',
              'static_validation',
              'sql_regression',
              'paired_replay'
            )
          ),
          content_hash TEXT NOT NULL,
          artifact_json TEXT NOT NULL,
          PRIMARY KEY(attempt_id, evidence_kind),
          FOREIGN KEY(attempt_id)
            REFERENCES proposal_gate_attempts(attempt_id)
        );
      `);
    } finally {
      legacy.close();
    }

    const store = new ProposalStore({databasePath});
    store.close();

    const migrated = new Database(databasePath);
    try {
      expect(migrated.pragma('foreign_key_check')).toEqual([]);
      expect(migrated.pragma(
        'foreign_key_list(proposal_gate_attempts)',
      )).toEqual([
        expect.objectContaining({table: 'curation_proposals'}),
      ]);
      const evidenceSchema = migrated.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'proposal_gate_evidence'
      `).get() as {sql: string};
      expect(evidenceSchema.sql).toContain("'repository_target_binding'");
    } finally {
      migrated.close();
    }
  });
});

function draftProposal(): CurationProposalV1 {
  return {
    schemaVersion: 1,
    proposalId: 'proposal_action_test',
    revision: 1,
    idempotencyKey: canonicalContentHash('proposal-action-test'),
    kind: 'skill_note',
    tier: 'T1',
    title: 'Improve bounded evidence',
    rationale: 'Repeated failures justify one narrow note.',
    deltas: [{
      op: 'add',
      targetKind: 'skill_note',
      targetId: 'startup_analysis',
      operationId: 'operation_note',
      anchor: 'skillNotes[skillId="startup_analysis"]',
      baseContentHash: '5'.repeat(64),
      after: 'Collect one bounded fallback view.',
    }],
    expectedRegistryFingerprint: '6'.repeat(64),
    expectedOverlayGeneration: 'builtin:test',
    evidence: {
      negativeRunIds: ['negative-1', 'negative-2', 'negative-3'],
      positiveRunIds: [
        'positive-1',
        'positive-2',
        'positive-3',
        'positive-4',
        'positive-5',
      ],
      labeledCount: 8,
      negativeCount: 3,
      distinctTraceCount: 1,
      distinctSessionCount: 8,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'not_run',
    expectedEffect: 'Improve evidence coverage.',
    riskLevel: 'low',
    status: 'draft',
    scope,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function gatedProposal(): CurationProposalV1 {
  const draft = draftProposal();
  const planHash = canonicalContentHash('plan');
  const candidateHash = canonicalContentHash('candidate');
  const pairedHash = canonicalContentHash('paired');
  const checks = PROPOSAL_GATE_IDS.map((gateId, index) => ({
    schemaVersion: 1 as const,
    gateId,
    verdict: 'passed' as const,
    reasonCodes: [],
    evidenceContentHashes: index === 1
      ? [planHash]
      : index === 4
        ? [candidateHash]
        : index === 7
          ? [pairedHash]
          : [],
    durationMs: 1,
  }));
  const gateResult = createProposalGateResultV1({
    proposalId: draft.proposalId,
    gateAttemptId: 'attempt-action',
    gateAttemptOrdinal: 1,
    gatePolicyFingerprint: '7'.repeat(64),
    draftRevision: 1,
    gatedRevision: 2,
    draftContentHash: proposalDraftContentHash(draft),
    startedAt: '2026-07-29T00:00:01.000Z',
    completedAt: '2026-07-29T00:00:02.000Z',
    checks,
    overallVerdict: 'passed',
    pairedGateVerdict: 'passed',
    materializationPlanContentHash: planHash,
    candidateMaterializationContentHash: candidateHash,
    pairedReplayProofContentHash: pairedHash,
  });
  return parseCurationProposalV1({
    ...draft,
    revision: 2,
    pairedGateVerdict: 'passed',
    gateResult,
    status: 'gated',
  });
}

function createM7Database(
  databasePath: string,
  proposal: CurationProposalV1,
): void {
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE curation_proposals (
        proposal_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','gated')),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, workspace_id, idempotency_key)
      );
    `);
    db.prepare(`
      INSERT INTO curation_proposals (
        proposal_id, tenant_id, workspace_id, revision,
        idempotency_key, status, proposal_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.proposalId,
      proposal.scope.tenantId,
      proposal.scope.workspaceId,
      proposal.revision,
      proposal.idempotencyKey,
      proposal.status,
      canonicalJsonString(proposal),
      proposal.createdAt,
    );
  } finally {
    db.close();
  }
}

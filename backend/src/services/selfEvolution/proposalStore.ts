// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  AppliedProposalRevisionV1,
  CurationProposalV1,
  ProposalActionFailureClass,
  ProposalActionRecordV1,
  ProposalCandidateMaterializationV1,
  ProposalGateCheckV1,
  ProposalGateResultV1,
  ProposalGateVerdict,
  ProposalPairedReplayProofV1,
  ProposalChannelArtifactRevisionV1,
  RepositoryTargetBindingV1,
  ProposalSqlRegressionProofV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  ScopedLeaseLostError,
  ScopedOutbox,
  type ScopedLease,
  type ScopedLeaseFence,
} from '../evolutionLifecycle/scopedOutbox';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import type {SelectedCurationCandidate} from './curationContracts';
import {selectSingleCurationCandidate} from './curationCoordinator';
import {parseM6DraftProposal} from './proposalContract';
import {
  createProposalGateResultV1,
  parseCurationProposalV1,
  parseProposalCandidateMaterializationV1,
  parseProposalGateResultV1,
  parseProposalMaterializationPlanV1,
  parseProposalPairedReplayProofV1,
  parseRepositoryTargetBindingV1,
  parseProposalSqlRegressionProofV1,
  proposalDraftContentHash,
  assertProposalEligibleForAcceptance,
  assertProposalEligibleForApply,
} from './proposalGateContract';
import {
  createAppliedProposalRevisionV1,
  createProposalChannelArtifactRevisionV1,
  parseAppliedProposalRevisionV1,
  parseProposalChannelArtifactRevisionV1,
} from './evolutionOverlayContract';
import {
  parseProposalContainmentProbeV1,
  type ProposalContainmentProbeV1,
} from './proposalContainmentGate';
import {
  parseProposalStaticValidationProofV1,
  type ProposalStaticValidationProofV1,
} from './proposalStaticGate';
import type {ProposalBaseSnapshotV1} from './proposalSemanticGate';
import {assertTrustedProposalPairedReplayProof} from './proposalPairedReplayGate';
import {assertTrustedProposalSqlRegressionProof} from './proposalSqlRegression';

export type ProposalGateEvidenceKind =
  | 'materialization_plan'
  | 'containment_probe'
  | 'containment_probe_final'
  | 'candidate_materialization'
  | 'base_snapshot_initial'
  | 'base_snapshot_final'
  | 'repository_target_binding'
  | 'static_validation'
  | 'sql_regression'
  | 'paired_replay';

export interface ProposalGateAttemptSessionV1 {
  schemaVersion: 1;
  attemptId: string;
  ordinal: number;
  scope: RunManifestScope;
  proposalId: string;
  draftContentHash: string;
  gatePolicyFingerprint: string;
  fenceToken: string;
  startedAt: string;
}

export interface ProposalGateSnapshotEvidenceV1 {
  schemaVersion: 1;
  snapshot: ProposalBaseSnapshotV1;
  snapshotHash: string;
  contentHash: string;
}

export interface ProposalGateAttemptRecordV1 {
  session: Omit<ProposalGateAttemptSessionV1, 'fenceToken'>;
  state: 'running' | 'completed' | 'abandoned';
  verdict?: Exclude<ProposalGateVerdict, 'not_run'>;
  gateResult?: ProposalGateResultV1;
  completedAt?: string;
}

export interface ProposalApplicationGateEvidenceV1 {
  candidate: ProposalCandidateMaterializationV1;
  pairedReplayProof: ProposalPairedReplayProofV1;
}

interface GateAttemptRow {
  attempt_id: string;
  attempt_ordinal: number;
  tenant_id: string;
  workspace_id: string;
  proposal_id: string;
  draft_content_hash: string;
  gate_policy_fingerprint: string;
  fence_token: string;
  state: 'running' | 'completed' | 'abandoned';
  verdict: Exclude<ProposalGateVerdict, 'not_run'> | null;
  started_at: string;
  completed_at: string | null;
  gate_result_json: string | null;
}

interface ProposalJob {
  jobId: string;
  candidate: SelectedCurationCandidate;
  attempts: number;
}

interface ProposalFailure {
  reason: string;
  maxAttempts: number;
}

export interface ProposalStoreOptions {
  databasePath?: string;
}

export class ProposalStore {
  private readonly db: Database.Database;
  private readonly lifecycle: ScopedOutbox<
    ProposalJob,
    CurationProposalV1,
    ProposalFailure
  >;

  constructor(options: ProposalStoreOptions = {}) {
    const databasePath = options.databasePath ??
      userDataPath('self_improve', 'proposals.db');
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), {recursive: true});
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
    this.lifecycle = new ScopedOutbox({
      claim: input => this.claimJob(input),
      assertActive: (fence, now) => this.assertLease(fence, now),
      renew: (fence, now, leaseUntil) =>
        this.renewLeaseRow(fence, now, leaseUntil),
      complete: (fence, proposal, now) =>
        this.completeDraftRow(fence, proposal, now),
      fail: (fence, failure, now) =>
        this.failLeaseRow(fence, failure, now),
      release: (fence, now) => this.releaseLeaseRow(fence, now),
    });
  }

  enqueue(candidate: SelectedCurationCandidate): {
    jobId: string;
    idempotent: boolean;
  } {
    const jobId = `curation-job-${candidate.idempotencyKey}`;
    const payload = canonicalJsonString(candidate);
    const result = this.db.prepare(`
      INSERT INTO curation_jobs (
        job_id, tenant_id, workspace_id, state, attempts,
        input_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(job_id) DO NOTHING
    `).run(
      jobId,
      candidate.sourceState.scope.tenantId,
      candidate.sourceState.scope.workspaceId,
      payload,
      Date.now(),
      Date.now(),
    );
    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT tenant_id, workspace_id, input_json
        FROM curation_jobs
        WHERE job_id = ?
      `).get(jobId) as {
        tenant_id: string;
        workspace_id: string;
        input_json: string;
      } | undefined;
      if (
        !existing ||
        existing.tenant_id !== candidate.sourceState.scope.tenantId ||
        existing.workspace_id !== candidate.sourceState.scope.workspaceId ||
        existing.input_json !== payload
      ) {
        throw new Error('curation_job_idempotency_conflict');
      }
    }
    return {jobId, idempotent: result.changes === 0};
  }

  leaseNext(input: {
    scope: RunManifestScope;
    jobId?: string;
    owner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
    now?: number;
  }): ScopedLease<ProposalJob> | null {
    return this.lifecycle.claim({
      scope: input.scope,
      jobId: input.jobId,
      owner: input.owner,
      leaseDurationMs: input.leaseDurationMs ?? 5 * 60 * 1000,
      maxAttempts: input.maxAttempts ?? 3,
      now: input.now,
    });
  }

  completeDraft(
    fence: ScopedLeaseFence,
    proposal: CurationProposalV1,
    now: number = Date.now(),
  ): void {
    this.lifecycle.complete(fence, parseM6DraftProposal(proposal), now);
  }

  failLease(
    fence: ScopedLeaseFence,
    reason: string,
    maxAttempts: number = 3,
    now: number = Date.now(),
  ): void {
    this.lifecycle.fail(fence, {reason, maxAttempts}, now);
  }

  get(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1 | undefined {
    const row = this.db.prepare(`
      SELECT proposal_json
      FROM curation_proposals
      WHERE tenant_id = ? AND workspace_id = ? AND proposal_id = ?
    `).get(
      scope.tenantId,
      scope.workspaceId,
      proposalId,
    ) as {proposal_json: string} | undefined;
    return row
      ? parseCurationProposalV1(JSON.parse(row.proposal_json))
      : undefined;
  }

  getByIdempotencyKey(
    scope: RunManifestScope,
    idempotencyKey: string,
  ): CurationProposalV1 | undefined {
    const row = this.db.prepare(`
      SELECT proposal_json
      FROM curation_proposals
      WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?
    `).get(
      scope.tenantId,
      scope.workspaceId,
      idempotencyKey,
    ) as {proposal_json: string} | undefined;
    return row
      ? parseCurationProposalV1(JSON.parse(row.proposal_json))
      : undefined;
  }

  list(scope: RunManifestScope): CurationProposalV1[] {
    const rows = this.db.prepare(`
      SELECT proposal_json
      FROM curation_proposals
      WHERE tenant_id = ? AND workspace_id = ?
      ORDER BY created_at, proposal_id
    `).all(
      scope.tenantId,
      scope.workspaceId,
    ) as Array<{proposal_json: string}>;
    return rows.map(row =>
      parseCurationProposalV1(JSON.parse(row.proposal_json)));
  }

  accept(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1 {
    return this.db.transaction(() => {
      const current = this.get(scope, proposalId);
      if (!current) throw new Error('curation_proposal_not_found');
      const eligible = assertProposalEligibleForAcceptance(current);
      const accepted = parseCurationProposalV1({
        ...eligible,
        revision: 3,
        status: 'accepted',
      });
      this.compareAndSwapProposal(eligible, accepted);
      return accepted;
    })();
  }

  reject(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1 {
    return this.db.transaction(() => {
      const current = this.get(scope, proposalId);
      if (!current) throw new Error('curation_proposal_not_found');
      const eligible = assertProposalEligibleForAcceptance(current);
      const rejected = parseCurationProposalV1({
        ...eligible,
        revision: 3,
        status: 'rejected',
      });
      this.compareAndSwapProposal(eligible, rejected);
      return rejected;
    })();
  }

  reserveAction(input: {
    actionId: string;
    scope: RunManifestScope;
    proposalId: string;
    kind: 'apply' | 'revert';
    sideEffectKind: ProposalActionRecordV1['sideEffectKind'];
    artifactContentHashes?: string[];
    now?: number;
  }): ProposalActionRecordV1 {
    return this.db.transaction(() => {
      const existing = this.getAction(input.actionId);
      if (existing) {
        assertSameActionReservation(existing, input);
        return existing;
      }
      const proposal = this.get(input.scope, input.proposalId);
      if (!proposal) throw new Error('curation_proposal_not_found');
      if (input.kind === 'apply') {
        assertProposalEligibleForApply(proposal);
      } else if (
        proposal.status !== 'applied'
        || proposal.revision !== 4
        || proposal.activeActionId !== undefined
      ) {
        throw new Error('proposal_not_eligible_for_revert');
      }
      const now = input.now ?? Date.now();
      const artifactContentHashes = [
        ...new Set(input.artifactContentHashes ?? []),
      ].sort();
      if (!artifactContentHashes.every(value => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error('proposal_action_artifact_hash_invalid');
      }
      const action = parseProposalActionRecordV1({
        schemaVersion: 1,
        actionId: input.actionId,
        kind: input.kind,
        scope: input.scope,
        proposalId: input.proposalId,
        artifactContentHashes,
        expectedRevision: input.kind === 'apply' ? 3 : 4,
        targetRevision: input.kind === 'apply' ? 4 : 5,
        state: 'pending',
        sideEffectKind: input.sideEffectKind,
        createdAt: now,
        updatedAt: now,
      });
      const reservedProposal = parseCurationProposalV1({
        ...proposal,
        activeActionId: action.actionId,
      });
      this.db.prepare(`
        INSERT INTO proposal_actions (
          action_id, tenant_id, workspace_id, proposal_id,
          state, failure_class, action_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
      `).run(
        action.actionId,
        action.scope.tenantId,
        action.scope.workspaceId,
        action.proposalId,
        canonicalJsonString(action),
        action.createdAt,
        action.updatedAt,
      );
      this.compareAndSwapProposal(proposal, reservedProposal, action.actionId);
      return action;
    })();
  }

  markActionExecuting(
    actionId: string,
    now: number = Date.now(),
  ): ProposalActionRecordV1 {
    return this.transitionProposalAction({
      actionId,
      fromStates: ['pending'],
      now,
      update: current => ({...current, state: 'executing'}),
    });
  }

  recordActionSideEffectReceipt(
    actionId: string,
    sideEffectReceiptHash: string,
    now: number = Date.now(),
  ): ProposalActionRecordV1 {
    if (!/^[0-9a-f]{64}$/.test(sideEffectReceiptHash)) {
      throw new Error('proposal_action_receipt_hash_invalid');
    }
    return this.transitionProposalAction({
      actionId,
      fromStates: ['executing'],
      now,
      update: current => ({
        ...current,
        sideEffectReceiptHash,
      }),
    });
  }

  failAction(input: {
    actionId: string;
    failureClass: ProposalActionFailureClass;
    errorCode: string;
    now?: number;
  }): ProposalActionRecordV1 {
    if (!input.errorCode.trim()) {
      throw new Error('proposal_action_error_code_invalid');
    }
    return this.db.transaction(() => {
      const failed = this.transitionProposalAction({
        actionId: input.actionId,
        fromStates: ['pending', 'executing'],
        now: input.now ?? Date.now(),
        update: current => ({
          ...current,
          state: 'failed',
          failureClass: input.failureClass,
          errorCode: input.errorCode,
        }),
      });
      if (input.failureClass === 'terminal_before_side_effect') {
        this.clearActionReservation(failed);
      }
      return failed;
    })();
  }

  retryAction(
    actionId: string,
    now: number = Date.now(),
  ): ProposalActionRecordV1 {
    return this.transitionProposalAction({
      actionId,
      fromStates: ['failed'],
      now,
      update: current => {
        if (current.failureClass === 'terminal_before_side_effect') {
          throw new Error('proposal_action_terminal');
        }
        const {
          failureClass: _failureClass,
          errorCode: _errorCode,
          ...retryable
        } = current;
        return {...retryable, state: 'pending'};
      },
    });
  }

  getAction(actionId: string): ProposalActionRecordV1 | undefined {
    const row = this.db.prepare(`
      SELECT action_json FROM proposal_actions WHERE action_id = ?
    `).get(actionId) as {action_json: string} | undefined;
    return row
      ? parseProposalActionRecordV1(JSON.parse(row.action_json))
      : undefined;
  }

  listRecoverableActions(): ProposalActionRecordV1[] {
    const rows = this.db.prepare(`
      SELECT action_json
      FROM proposal_actions
      WHERE state IN ('pending', 'executing')
        OR (
          state = 'failed'
          AND failure_class IN (
            'retryable_before_side_effect',
            'recovery_required_after_side_effect'
          )
        )
      ORDER BY created_at, action_id
    `).all() as Array<{action_json: string}>;
    return rows.map(row =>
      parseProposalActionRecordV1(JSON.parse(row.action_json)));
  }

  commitAppliedRevision(input: {
    actionId: string;
    generation: string;
    overlayIds: string[];
    receiptContentHashes: string[];
    actor: {userId?: string};
    now?: number;
  }): AppliedProposalRevisionV1 {
    if (
      !input.generation.trim()
      || !input.overlayIds.every(value => value.trim())
      || !input.receiptContentHashes.every(value =>
        /^[0-9a-f]{64}$/.test(value))
    ) {
      throw new Error('applied_proposal_revision_input_invalid');
    }
    return this.db.transaction(() => {
      const prior = this.db.prepare(`
        SELECT revision_json
        FROM applied_proposal_revisions
        WHERE action_id = ?
      `).get(input.actionId) as {revision_json: string} | undefined;
      if (prior) {
        return parseAppliedProposalRevisionV1(JSON.parse(prior.revision_json));
      }
      const action = this.getAction(input.actionId);
      if (!action || action.state !== 'executing') {
        throw new Error('proposal_action_not_executing');
      }
      const proposal = this.get(action.scope, action.proposalId);
      if (
        !proposal
        || proposal.revision !== action.expectedRevision
        || proposal.activeActionId !== action.actionId
      ) {
        throw new Error('proposal_action_reservation_lost');
      }
      const ordinalRow = this.db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM applied_proposal_revisions
        WHERE proposal_id = ?
      `).get(action.proposalId) as {ordinal: number};
      const applied = createAppliedProposalRevisionV1({
        ordinal: ordinalRow.ordinal,
        proposalId: action.proposalId,
        proposalRevision: action.targetRevision,
        actionId: action.actionId,
        kind: action.kind,
        scope: action.scope,
        overlayIds: [...new Set(input.overlayIds)].sort(),
        generation: input.generation,
        receiptContentHashes:
          [...new Set(input.receiptContentHashes)].sort(),
        actor: input.actor.userId ? {userId: input.actor.userId} : {},
        createdAt: input.now ?? Date.now(),
      });
      this.db.prepare(`
        INSERT INTO applied_proposal_revisions (
          proposal_id, ordinal, action_id, proposal_revision,
          revision_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        applied.proposalId,
        applied.ordinal,
        applied.actionId,
        applied.proposalRevision,
        canonicalJsonString(applied),
        applied.createdAt,
      );
      const {
        activeActionId: _activeActionId,
        ...proposalWithoutReservation
      } = proposal;
      const finalizedProposal = parseCurationProposalV1({
        ...proposalWithoutReservation,
        revision: action.targetRevision,
        status: action.kind === 'apply' ? 'applied' : 'reverted',
      });
      this.compareAndSwapProposal(proposal, finalizedProposal, null);
      return applied;
    })();
  }

  finalizeActionRecord(
    actionId: string,
    now: number = Date.now(),
  ): ProposalActionRecordV1 {
    return this.transitionProposalAction({
      actionId,
      fromStates: ['executing'],
      now,
      update: current => ({...current, state: 'finalized'}),
    });
  }

  finalizeAction(input: {
    actionId: string;
    generation: string;
    overlayIds: string[];
    receiptContentHashes: string[];
    actor: {userId?: string};
    now?: number;
  }): AppliedProposalRevisionV1 {
    const applied = this.commitAppliedRevision(input);
    this.finalizeActionRecord(input.actionId, input.now ?? Date.now());
    return applied;
  }

  listAppliedRevisions(
    proposalId: string,
  ): AppliedProposalRevisionV1[] {
    const rows = this.db.prepare(`
      SELECT revision_json
      FROM applied_proposal_revisions
      WHERE proposal_id = ?
      ORDER BY ordinal
    `).all(proposalId) as Array<{revision_json: string}>;
    return rows.map(row =>
      parseAppliedProposalRevisionV1(JSON.parse(row.revision_json)));
  }

  recordChannelArtifact(input: Omit<
    ProposalChannelArtifactRevisionV1,
    'schemaVersion' | 'ordinal' | 'state' | 'contentHash'
  > & {scope: RunManifestScope}): ProposalChannelArtifactRevisionV1 {
    return this.db.transaction(() => {
      if (!this.get(input.scope, input.proposalId)) {
        throw new Error('proposal_channel_artifact_not_found');
      }
      const prior = this.db.prepare(`
        SELECT revision_json
        FROM proposal_channel_artifact_revisions
        WHERE proposal_id = ? AND channel = ? AND artifact_id = ?
        ORDER BY ordinal DESC
        LIMIT 1
      `).get(
        input.proposalId,
        input.channel,
        input.artifactId,
      ) as {revision_json: string} | undefined;
      if (prior) {
        const existing = parseProposalChannelArtifactRevisionV1(
          JSON.parse(prior.revision_json),
        );
        if (
          existing.state === 'active'
          && existing.artifactContentHash === input.artifactContentHash
          && existing.gateAttemptId === input.gateAttemptId
          && existing.gateAttemptOrdinal === input.gateAttemptOrdinal
          && existing.gateResultContentHash === input.gateResultContentHash
        ) {
          return existing;
        }
        throw new Error('proposal_channel_artifact_idempotency_conflict');
      }
      const ordinal = this.nextChannelArtifactOrdinal(input.proposalId);
      const {scope: _scope, ...revisionInput} = input;
      const revision = createProposalChannelArtifactRevisionV1({
        ...revisionInput,
        ordinal,
        state: 'active',
      });
      this.db.prepare(`
        INSERT INTO proposal_channel_artifact_revisions (
          proposal_id, ordinal, channel, artifact_id,
          state, revision_json, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(
        revision.proposalId,
        revision.ordinal,
        revision.channel,
        revision.artifactId,
        canonicalJsonString(revision),
        revision.createdAt,
      );
      return revision;
    })();
  }

  revokeChannelArtifact(input: {
    scope: RunManifestScope;
    proposalId: string;
    channel: ProposalChannelArtifactRevisionV1['channel'];
    artifactId: string;
    createdAt?: number;
  }): ProposalChannelArtifactRevisionV1 {
    return this.db.transaction(() => {
      if (!this.get(input.scope, input.proposalId)) {
        throw new Error('proposal_channel_artifact_not_found');
      }
      const prior = this.db.prepare(`
        SELECT revision_json
        FROM proposal_channel_artifact_revisions
        WHERE proposal_id = ? AND channel = ? AND artifact_id = ?
        ORDER BY ordinal DESC
        LIMIT 1
      `).get(
        input.proposalId,
        input.channel,
        input.artifactId,
      ) as {revision_json: string} | undefined;
      if (!prior) throw new Error('proposal_channel_artifact_not_found');
      const current = parseProposalChannelArtifactRevisionV1(
        JSON.parse(prior.revision_json),
      );
      if (current.state === 'revoked') return current;
      const {
        schemaVersion: _schemaVersion,
        contentHash: _contentHash,
        ordinal: _ordinal,
        state: _state,
        ...binding
      } = current;
      const revision = createProposalChannelArtifactRevisionV1({
        ...binding,
        ordinal: this.nextChannelArtifactOrdinal(input.proposalId),
        state: 'revoked',
        createdAt: input.createdAt ?? Date.now(),
      });
      this.db.prepare(`
        INSERT INTO proposal_channel_artifact_revisions (
          proposal_id, ordinal, channel, artifact_id,
          state, revision_json, created_at
        ) VALUES (?, ?, ?, ?, 'revoked', ?, ?)
      `).run(
        revision.proposalId,
        revision.ordinal,
        revision.channel,
        revision.artifactId,
        canonicalJsonString(revision),
        revision.createdAt,
      );
      return revision;
    })();
  }

  listChannelArtifactRevisions(
    scope: RunManifestScope,
    proposalId: string,
  ): ProposalChannelArtifactRevisionV1[] {
    if (!this.get(scope, proposalId)) {
      throw new Error('proposal_channel_artifact_not_found');
    }
    const rows = this.db.prepare(`
      SELECT revision_json
      FROM proposal_channel_artifact_revisions
      WHERE proposal_id = ?
      ORDER BY ordinal
    `).all(proposalId) as Array<{revision_json: string}>;
    return rows.map(row =>
      parseProposalChannelArtifactRevisionV1(JSON.parse(row.revision_json)));
  }

  beginGateAttempt(input: {
    scope: RunManifestScope;
    proposalId: string;
    gatePolicyFingerprint: string;
    startedAt?: string;
  }): ProposalGateAttemptSessionV1 {
    if (!/^[0-9a-f]{64}$/.test(input.gatePolicyFingerprint)) {
      throw new Error('curation_gate_policy_fingerprint_invalid');
    }
    return this.db.transaction(() => {
      const proposal = this.get(input.scope, input.proposalId);
      if (!proposal) throw new Error('curation_proposal_not_found');
      if (proposal.status !== 'draft' || proposal.revision !== 1) {
        throw new Error('curation_proposal_not_gateable');
      }
      const draft = parseM6DraftProposal(proposal);
      const draftContentHash = proposalDraftContentHash(draft);
      const startedAt = input.startedAt ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(startedAt))) {
        throw new Error('curation_gate_attempt_time_invalid');
      }
      this.db.prepare(`
        UPDATE proposal_gate_attempts
        SET state = 'abandoned', completed_at = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND proposal_id = ?
          AND state = 'running'
      `).run(
        startedAt,
        input.scope.tenantId,
        input.scope.workspaceId,
        input.proposalId,
      );
      const ordinalRow = this.db.prepare(`
        SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
        FROM proposal_gate_attempts
        WHERE tenant_id = ? AND workspace_id = ? AND proposal_id = ?
      `).get(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.proposalId,
      ) as {ordinal: number};
      const session: ProposalGateAttemptSessionV1 = {
        schemaVersion: 1,
        attemptId: randomUUID(),
        ordinal: ordinalRow.ordinal,
        scope: immutableCanonicalSnapshot(input.scope),
        proposalId: input.proposalId,
        draftContentHash,
        gatePolicyFingerprint: input.gatePolicyFingerprint,
        fenceToken: randomUUID(),
        startedAt,
      };
      this.db.prepare(`
        INSERT INTO proposal_gate_attempts (
          attempt_id, attempt_ordinal, tenant_id, workspace_id,
          proposal_id, draft_content_hash, gate_policy_fingerprint,
          fence_token, state, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        session.attemptId,
        session.ordinal,
        session.scope.tenantId,
        session.scope.workspaceId,
        session.proposalId,
        session.draftContentHash,
        session.gatePolicyFingerprint,
        session.fenceToken,
        session.startedAt,
      );
      return immutableCanonicalSnapshot(session);
    })();
  }

  recordGateEvidence(
    session: ProposalGateAttemptSessionV1,
    kind: ProposalGateEvidenceKind,
    value: unknown,
  ): string {
    const artifact = parseGateEvidence(kind, value);
    const contentHash = evidenceContentHash(artifact);
    return this.db.transaction(() => {
      this.assertGateAttempt(session);
      const existing = this.db.prepare(`
        SELECT content_hash, artifact_json
        FROM proposal_gate_evidence
        WHERE attempt_id = ? AND evidence_kind = ?
      `).get(session.attemptId, kind) as {
        content_hash: string;
        artifact_json: string;
      } | undefined;
      const payload = canonicalJsonString(artifact);
      if (existing) {
        if (
          existing.content_hash !== contentHash
          || existing.artifact_json !== payload
        ) {
          throw new Error('curation_gate_evidence_conflict');
        }
        return existing.content_hash;
      }
      this.db.prepare(`
        INSERT INTO proposal_gate_evidence (
          attempt_id, evidence_kind, content_hash, artifact_json
        ) VALUES (?, ?, ?, ?)
      `).run(session.attemptId, kind, contentHash, payload);
      return contentHash;
    })();
  }

  finalizeGateAttempt(input: {
    session: ProposalGateAttemptSessionV1;
    checks: ProposalGateCheckV1[];
    trustedEvidence?: {
      sqlRegressionProof?: ProposalSqlRegressionProofV1;
      pairedReplayProof?: ProposalPairedReplayProofV1;
    };
    completedAt?: string;
  }): CurationProposalV1 {
    return this.db.transaction(() => {
      const attempt = this.assertGateAttempt(input.session, true);
      const current = this.get(
        input.session.scope,
        input.session.proposalId,
      );
      if (!current) throw new Error('curation_proposal_not_found');
      if (attempt.state === 'completed') {
        if (!attempt.gate_result_json) {
          throw new Error('curation_gate_attempt_result_missing');
        }
        const existingResult = parseProposalGateResultV1(
          JSON.parse(attempt.gate_result_json),
        );
        if (
          canonicalJsonString(existingResult.checks)
            !== canonicalJsonString(input.checks)
        ) {
          throw new Error('curation_gate_attempt_idempotency_conflict');
        }
        return current;
      }
      if (attempt.state !== 'running') {
        throw new Error('curation_gate_attempt_not_active');
      }
      if (current.status !== 'draft' || current.revision !== 1) {
        throw new Error('curation_gate_result_revision_conflict');
      }
      const proposal = parseM6DraftProposal(current);
      if (
        proposalDraftContentHash(proposal)
          !== input.session.draftContentHash
      ) {
        throw new Error('curation_gate_result_draft_hash_conflict');
      }
      const evidence = this.loadGateEvidence(input.session.attemptId);
      assertTrustedGateEvidence(evidence, input.trustedEvidence);
      const finalized = validateGateEvidenceBundle({
        proposal,
        session: input.session,
        checks: input.checks,
        evidence,
      });
      const completedAt = input.completedAt ?? new Date().toISOString();
      if (
        !Number.isFinite(Date.parse(completedAt))
        || Date.parse(completedAt) < Date.parse(input.session.startedAt)
      ) {
        throw new Error('curation_gate_attempt_time_invalid');
      }
      const gateResult = createGateResultFromEvidence({
        proposal,
        session: input.session,
        checks: input.checks,
        evidence: finalized,
        completedAt,
      });
      const changedAttempt = this.db.prepare(`
        UPDATE proposal_gate_attempts
        SET state = 'completed',
            verdict = ?,
            completed_at = ?,
            gate_result_hash = ?,
            gate_result_json = ?
        WHERE attempt_id = ? AND fence_token = ? AND state = 'running'
      `).run(
        gateResult.overallVerdict,
        completedAt,
        gateResult.contentHash,
        canonicalJsonString(gateResult),
        input.session.attemptId,
        input.session.fenceToken,
      );
      if (changedAttempt.changes !== 1) {
        throw new Error('curation_gate_attempt_fence_lost');
      }
      if (gateResult.overallVerdict !== 'passed') return proposal;

      const gated = parseCurationProposalV1({
        ...proposal,
        revision: 2,
        pairedGateVerdict: gateResult.pairedGateVerdict,
        gateResult,
        status: 'gated',
      });
      const changed = this.db.prepare(`
        UPDATE curation_proposals
        SET revision = 2,
            status = 'gated',
            proposal_json = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND proposal_id = ?
          AND revision = 1
          AND status = 'draft'
          AND proposal_json = ?
      `).run(
        canonicalJsonString(gated),
        input.session.scope.tenantId,
        input.session.scope.workspaceId,
        input.session.proposalId,
        canonicalJsonString(proposal),
      );
      if (changed.changes !== 1) {
        throw new Error('curation_gate_result_compare_and_swap_failed');
      }
      return gated;
    })();
  }

  getLatestGateAttempt(
    scope: RunManifestScope,
    proposalId: string,
  ): ProposalGateAttemptRecordV1 | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM proposal_gate_attempts
      WHERE tenant_id = ? AND workspace_id = ? AND proposal_id = ?
      ORDER BY attempt_ordinal DESC
      LIMIT 1
    `).get(
      scope.tenantId,
      scope.workspaceId,
      proposalId,
    ) as GateAttemptRow | undefined;
    return row ? gateAttemptRecord(row) : undefined;
  }

  getApplicationGateEvidence(
    scope: RunManifestScope,
    proposalId: string,
  ): ProposalApplicationGateEvidenceV1 {
    const proposal = this.get(scope, proposalId);
    const gateResult = proposal?.gateResult;
    if (
      !proposal
      || proposal.status !== 'accepted'
      || proposal.revision !== 3
      || proposal.pairedGateVerdict !== 'passed'
      || gateResult?.overallVerdict !== 'passed'
      || gateResult.pairedGateVerdict !== 'passed'
      || !gateResult.candidateMaterializationContentHash
      || !gateResult.pairedReplayProofContentHash
    ) {
      throw new Error('proposal_application_gate_evidence_invalid');
    }
    const attempt = this.db.prepare(`
      SELECT gate_result_hash
      FROM proposal_gate_attempts
      WHERE attempt_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND proposal_id = ?
        AND state = 'completed'
        AND verdict = 'passed'
    `).get(
      gateResult.gateAttemptId,
      scope.tenantId,
      scope.workspaceId,
      proposalId,
    ) as {gate_result_hash: string | null} | undefined;
    if (attempt?.gate_result_hash !== gateResult.contentHash) {
      throw new Error('proposal_application_gate_evidence_invalid');
    }
    const evidence = this.loadGateEvidence(gateResult.gateAttemptId);
    const candidate = evidence.get('candidate_materialization') as
      ProposalCandidateMaterializationV1 | undefined;
    const pairedReplayProof = evidence.get('paired_replay') as
      ProposalPairedReplayProofV1 | undefined;
    if (
      !candidate
      || !pairedReplayProof
      || candidate.proposalId !== proposalId
      || candidate.draftContentHash !== gateResult.draftContentHash
      || candidate.contentHash
        !== gateResult.candidateMaterializationContentHash
      || pairedReplayProof.proposalId !== proposalId
      || pairedReplayProof.gateAttemptId !== gateResult.gateAttemptId
      || pairedReplayProof.gateAttemptOrdinal
        !== gateResult.gateAttemptOrdinal
      || pairedReplayProof.gatePolicyFingerprint
        !== gateResult.gatePolicyFingerprint
      || pairedReplayProof.draftContentHash !== gateResult.draftContentHash
      || pairedReplayProof.candidateMaterializationContentHash
        !== candidate.contentHash
      || pairedReplayProof.candidateContentHash !== candidate.contentHash
      || pairedReplayProof.contentHash
        !== gateResult.pairedReplayProofContentHash
      || pairedReplayProof.verdict !== 'passed'
    ) {
      throw new Error('proposal_application_gate_evidence_invalid');
    }
    return immutableCanonicalSnapshot({candidate, pairedReplayProof});
  }

  getLatestRepositoryTargetBinding(
    scope: RunManifestScope,
    proposalId: string,
  ): {
    attemptId: string;
    attemptOrdinal: number;
    gateResultContentHash: string;
    binding: RepositoryTargetBindingV1;
  } | undefined {
    const row = this.db.prepare(`
      SELECT
        attempt.attempt_id,
        attempt.attempt_ordinal,
        attempt.gate_result_hash,
        evidence.artifact_json
      FROM proposal_gate_attempts AS attempt
      JOIN proposal_gate_evidence AS evidence
        ON evidence.attempt_id = attempt.attempt_id
      WHERE attempt.tenant_id = ?
        AND attempt.workspace_id = ?
        AND attempt.proposal_id = ?
        AND attempt.state = 'completed'
        AND evidence.evidence_kind = 'repository_target_binding'
      ORDER BY attempt.attempt_ordinal DESC
      LIMIT 1
    `).get(
      scope.tenantId,
      scope.workspaceId,
      proposalId,
    ) as {
      attempt_id: string;
      attempt_ordinal: number;
      gate_result_hash: string;
      artifact_json: string;
    } | undefined;
    if (!row?.gate_result_hash) return undefined;
    return immutableCanonicalSnapshot({
      attemptId: row.attempt_id,
      attemptOrdinal: row.attempt_ordinal,
      gateResultContentHash: row.gate_result_hash,
      binding: parseRepositoryTargetBindingV1(
        JSON.parse(row.artifact_json),
      ),
    });
  }

  /**
   * M7 gate results may only be finalized from a fenced attempt whose full
   * evidence bundle was persisted first. The old hash-only entry point is
   * intentionally fail-closed.
   */
  recordGateResult(_input: {
    scope: RunManifestScope;
    proposalId: string;
    expectedRevision: 1;
    draftContentHash: string;
    gateResult: ProposalGateResultV1;
  }): never {
    throw new Error('curation_gate_attempt_required');
  }

  private compareAndSwapProposal(
    current: CurationProposalV1,
    updated: CurationProposalV1,
    activeActionId: string | null =
      updated.activeActionId ?? null,
  ): void {
    const changed = this.db.prepare(`
      UPDATE curation_proposals
      SET revision = ?,
          status = ?,
          active_action_id = ?,
          proposal_json = ?
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND proposal_id = ?
        AND revision = ?
        AND status = ?
        AND proposal_json = ?
    `).run(
      updated.revision,
      updated.status,
      activeActionId,
      canonicalJsonString(updated),
      current.scope.tenantId,
      current.scope.workspaceId,
      current.proposalId,
      current.revision,
      current.status,
      canonicalJsonString(current),
    );
    if (changed.changes !== 1) {
      throw new Error('curation_proposal_compare_and_swap_failed');
    }
  }

  private nextChannelArtifactOrdinal(proposalId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
      FROM proposal_channel_artifact_revisions
      WHERE proposal_id = ?
    `).get(proposalId) as {ordinal: number};
    return row.ordinal;
  }

  private transitionProposalAction(input: {
    actionId: string;
    fromStates: ProposalActionRecordV1['state'][];
    now: number;
    update(
      current: ProposalActionRecordV1,
    ): Omit<ProposalActionRecordV1, 'updatedAt'>;
  }): ProposalActionRecordV1 {
    return this.db.transaction(() => {
      const current = this.getAction(input.actionId);
      if (!current || !input.fromStates.includes(current.state)) {
        throw new Error('proposal_action_state_conflict');
      }
      const updated = parseProposalActionRecordV1({
        ...input.update(current),
        updatedAt: input.now,
      });
      const changed = this.db.prepare(`
        UPDATE proposal_actions
        SET state = ?,
            failure_class = ?,
            action_json = ?,
            updated_at = ?
        WHERE action_id = ? AND state = ? AND action_json = ?
      `).run(
        updated.state,
        updated.failureClass ?? null,
        canonicalJsonString(updated),
        updated.updatedAt,
        current.actionId,
        current.state,
        canonicalJsonString(current),
      );
      if (changed.changes !== 1) {
        throw new Error('proposal_action_compare_and_swap_failed');
      }
      return updated;
    })();
  }

  private clearActionReservation(action: ProposalActionRecordV1): void {
    const proposal = this.get(action.scope, action.proposalId);
    if (!proposal || proposal.activeActionId !== action.actionId) {
      throw new Error('proposal_action_reservation_lost');
    }
    const {
      activeActionId: _activeActionId,
      ...withoutReservation
    } = proposal;
    this.compareAndSwapProposal(
      proposal,
      parseCurationProposalV1(withoutReservation),
      null,
    );
  }

  private assertGateAttempt(
    session: ProposalGateAttemptSessionV1,
    allowCompleted = false,
  ): GateAttemptRow {
    const row = this.db.prepare(`
      SELECT *
      FROM proposal_gate_attempts
      WHERE attempt_id = ?
    `).get(session.attemptId) as GateAttemptRow | undefined;
    if (
      !row
      || row.attempt_ordinal !== session.ordinal
      || row.tenant_id !== session.scope.tenantId
      || row.workspace_id !== session.scope.workspaceId
      || row.proposal_id !== session.proposalId
      || row.draft_content_hash !== session.draftContentHash
      || row.gate_policy_fingerprint !== session.gatePolicyFingerprint
      || row.fence_token !== session.fenceToken
      || row.started_at !== session.startedAt
      || (!allowCompleted && row.state !== 'running')
    ) {
      throw new Error('curation_gate_attempt_fence_lost');
    }
    return row;
  }

  private loadGateEvidence(
    attemptId: string,
  ): Map<ProposalGateEvidenceKind, unknown> {
    const rows = this.db.prepare(`
      SELECT evidence_kind, artifact_json
      FROM proposal_gate_evidence
      WHERE attempt_id = ?
      ORDER BY evidence_kind
    `).all(attemptId) as Array<{
      evidence_kind: ProposalGateEvidenceKind;
      artifact_json: string;
    }>;
    return new Map(rows.map(row => [
      row.evidence_kind,
      parseGateEvidence(
        row.evidence_kind,
        JSON.parse(row.artifact_json),
      ),
    ]));
  }

  expireStaleLeases(now: number = Date.now()): number {
    return this.db.prepare(`
      UPDATE curation_jobs
      SET lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          updated_at = ?
      WHERE state = 'pending'
        AND lease_owner IS NOT NULL
        AND lease_until <= ?
    `).run(now, now).changes;
  }

  getJob(jobId: string): {
    state: string;
    attempts: number;
    leaseOwner: string | null;
    leaseToken: string | null;
  } | undefined {
    return this.db.prepare(`
      SELECT
        state,
        attempts,
        lease_owner AS leaseOwner,
        lease_token AS leaseToken
      FROM curation_jobs
      WHERE job_id = ?
    `).get(jobId) as {
      state: string;
      attempts: number;
      leaseOwner: string | null;
      leaseToken: string | null;
    } | undefined;
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS curation_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_token TEXT,
        lease_until INTEGER,
        input_json TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_curation_jobs_claim
        ON curation_jobs(
          tenant_id,
          workspace_id,
          state,
          created_at
        );

    `);
    this.migrateProposalTable();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposal_gate_attempts (
        attempt_id TEXT PRIMARY KEY,
        attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal > 0),
        proposal_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        draft_content_hash TEXT NOT NULL,
        gate_policy_fingerprint TEXT NOT NULL,
        fence_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN ('running','completed','abandoned')
        ),
        verdict TEXT CHECK(
          verdict IS NULL OR verdict IN ('passed','failed','inconclusive')
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        gate_result_hash TEXT,
        gate_result_json TEXT,
        UNIQUE(tenant_id, workspace_id, proposal_id, attempt_ordinal),
        FOREIGN KEY(proposal_id) REFERENCES curation_proposals(proposal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_proposal_gate_attempts_scope
        ON proposal_gate_attempts(
          tenant_id,
          workspace_id,
          proposal_id,
          attempt_ordinal
        );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_gate_attempt_running
        ON proposal_gate_attempts(tenant_id, workspace_id, proposal_id)
        WHERE state = 'running';
      CREATE TABLE IF NOT EXISTS proposal_gate_evidence (
        attempt_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK(
          evidence_kind IN (
            'materialization_plan',
            'containment_probe',
            'containment_probe_final',
            'candidate_materialization',
            'base_snapshot_initial',
            'base_snapshot_final',
            'repository_target_binding',
            'static_validation',
            'sql_regression',
            'paired_replay'
          )
        ),
        content_hash TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY(attempt_id, evidence_kind),
        FOREIGN KEY(attempt_id) REFERENCES proposal_gate_attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS proposal_actions (
        action_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN ('pending','executing','finalized','failed')
        ),
        failure_class TEXT CHECK(
          failure_class IS NULL OR failure_class IN (
            'terminal_before_side_effect',
            'retryable_before_side_effect',
            'recovery_required_after_side_effect'
          )
        ),
        action_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES curation_proposals(proposal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_proposal_actions_recovery
        ON proposal_actions(state, failure_class, created_at);
      CREATE TABLE IF NOT EXISTS applied_proposal_revisions (
        proposal_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        action_id TEXT NOT NULL UNIQUE,
        proposal_revision INTEGER NOT NULL CHECK(
          proposal_revision IN (4, 5)
        ),
        revision_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(proposal_id, ordinal),
        FOREIGN KEY(proposal_id) REFERENCES curation_proposals(proposal_id),
        FOREIGN KEY(action_id) REFERENCES proposal_actions(action_id)
      );
      CREATE TABLE IF NOT EXISTS proposal_channel_artifact_revisions (
        proposal_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        channel TEXT NOT NULL CHECK(
          channel IN ('repository_patch', 'contribution_bundle')
        ),
        artifact_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
        revision_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(proposal_id, ordinal),
        FOREIGN KEY(proposal_id) REFERENCES curation_proposals(proposal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_proposal_channel_artifact_lookup
        ON proposal_channel_artifact_revisions(
          proposal_id, channel, artifact_id, ordinal
        );
    `);
    this.migrateProposalGateEvidenceTable();
  }

  private migrateProposalGateEvidenceTable(): void {
    const current = this.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'proposal_gate_evidence'
    `).get() as {sql: string} | undefined;
    if (!current || /'repository_target_binding'/i.test(current.sql)) return;
    this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE proposal_gate_evidence
          RENAME TO proposal_gate_evidence_m7;
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
              'repository_target_binding',
              'static_validation',
              'sql_regression',
              'paired_replay'
            )
          ),
          content_hash TEXT NOT NULL,
          artifact_json TEXT NOT NULL,
          PRIMARY KEY(attempt_id, evidence_kind),
          FOREIGN KEY(attempt_id) REFERENCES proposal_gate_attempts(attempt_id)
        );
        INSERT INTO proposal_gate_evidence (
          attempt_id, evidence_kind, content_hash, artifact_json
        )
        SELECT attempt_id, evidence_kind, content_hash, artifact_json
        FROM proposal_gate_evidence_m7;
        DROP TABLE proposal_gate_evidence_m7;
      `);
    })();
  }

  private migrateProposalTable(): void {
    const current = this.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'curation_proposals'
    `).get() as {sql: string} | undefined;
    if (!current) {
      this.createProposalTable();
      return;
    }
    const supportsM8States = [
      'draft',
      'gated',
      'accepted',
      'applied',
      'rejected',
      'reverted',
    ].every(status => current.sql.includes(`'${status}'`));
    const columns = this.db.prepare(`
      PRAGMA table_info(curation_proposals)
    `).all() as Array<{name: string}>;
    const hasActiveAction = columns.some(
      column => column.name === 'active_action_id',
    );
    if (supportsM8States && hasActiveAction) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_curation_proposals_scope
          ON curation_proposals(tenant_id, workspace_id, created_at);
      `);
      return;
    }
    const hasGateAttempts = this.tableExists('proposal_gate_attempts');
    const hasGateEvidence = this.tableExists('proposal_gate_evidence');
    const foreignKeysEnabled =
      this.db.pragma('foreign_keys', {simple: true}) === 1;
    if (foreignKeysEnabled) this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_curation_proposals_scope;
          DROP INDEX IF EXISTS idx_curation_proposals_active_action;
          ALTER TABLE curation_proposals
            RENAME TO curation_proposals_pre_m8;
        `);
        this.createProposalTable();
        this.db.exec(hasActiveAction ? `
          INSERT INTO curation_proposals (
            proposal_id, tenant_id, workspace_id, revision,
            idempotency_key, status, active_action_id,
            proposal_json, created_at
          )
          SELECT
            proposal_id, tenant_id, workspace_id, revision,
            idempotency_key, status, active_action_id,
            proposal_json, created_at
          FROM curation_proposals_pre_m8;
        ` : `
          INSERT INTO curation_proposals (
            proposal_id, tenant_id, workspace_id, revision,
            idempotency_key, status, active_action_id,
            proposal_json, created_at
          )
          SELECT
            proposal_id, tenant_id, workspace_id, revision,
            idempotency_key, status, NULL,
            proposal_json, created_at
          FROM curation_proposals_pre_m8;
        `);
        if (hasGateAttempts) {
          this.rebuildGateTablesForProposalMigration(hasGateEvidence);
        }
        this.db.exec('DROP TABLE curation_proposals_pre_m8;');
      })();
    } finally {
      if (foreignKeysEnabled) this.db.pragma('foreign_keys = ON');
    }
  }

  private rebuildGateTablesForProposalMigration(
    hasGateEvidence: boolean,
  ): void {
    if (hasGateEvidence) {
      this.db.exec(`
        ALTER TABLE proposal_gate_evidence
          RENAME TO proposal_gate_evidence_pre_m8;
      `);
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_proposal_gate_attempts_scope;
      DROP INDEX IF EXISTS idx_proposal_gate_attempt_running;
      ALTER TABLE proposal_gate_attempts
        RENAME TO proposal_gate_attempts_pre_m8;
      CREATE TABLE proposal_gate_attempts (
        attempt_id TEXT PRIMARY KEY,
        attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal > 0),
        proposal_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        draft_content_hash TEXT NOT NULL,
        gate_policy_fingerprint TEXT NOT NULL,
        fence_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN ('running','completed','abandoned')
        ),
        verdict TEXT CHECK(
          verdict IS NULL OR verdict IN ('passed','failed','inconclusive')
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        gate_result_hash TEXT,
        gate_result_json TEXT,
        UNIQUE(tenant_id, workspace_id, proposal_id, attempt_ordinal),
        FOREIGN KEY(proposal_id) REFERENCES curation_proposals(proposal_id)
      );
      INSERT INTO proposal_gate_attempts (
        attempt_id, attempt_ordinal, proposal_id, tenant_id, workspace_id,
        draft_content_hash, gate_policy_fingerprint, fence_token, state,
        verdict, started_at, completed_at, gate_result_hash, gate_result_json
      )
      SELECT
        attempt_id, attempt_ordinal, proposal_id, tenant_id, workspace_id,
        draft_content_hash, gate_policy_fingerprint, fence_token, state,
        verdict, started_at, completed_at, gate_result_hash, gate_result_json
      FROM proposal_gate_attempts_pre_m8;
      CREATE INDEX idx_proposal_gate_attempts_scope
        ON proposal_gate_attempts(
          tenant_id, workspace_id, proposal_id, attempt_ordinal
        );
      CREATE UNIQUE INDEX idx_proposal_gate_attempt_running
        ON proposal_gate_attempts(tenant_id, workspace_id, proposal_id)
        WHERE state = 'running';
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
            'repository_target_binding',
            'static_validation',
            'sql_regression',
            'paired_replay'
          )
        ),
        content_hash TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY(attempt_id, evidence_kind),
        FOREIGN KEY(attempt_id) REFERENCES proposal_gate_attempts(attempt_id)
      );
    `);
    if (hasGateEvidence) {
      this.db.exec(`
        INSERT INTO proposal_gate_evidence (
          attempt_id, evidence_kind, content_hash, artifact_json
        )
        SELECT attempt_id, evidence_kind, content_hash, artifact_json
        FROM proposal_gate_evidence_pre_m8;
        DROP TABLE proposal_gate_evidence_pre_m8;
      `);
    }
    this.db.exec('DROP TABLE proposal_gate_attempts_pre_m8;');
  }

  private tableExists(name: string): boolean {
    return this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(name) !== undefined;
  }

  private createProposalTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS curation_proposals (
        proposal_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(
          status IN (
            'draft','gated','accepted','applied','rejected','reverted'
          )
        ),
        active_action_id TEXT,
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, workspace_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_curation_proposals_scope
        ON curation_proposals(tenant_id, workspace_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_proposals_active_action
        ON curation_proposals(active_action_id)
        WHERE active_action_id IS NOT NULL;
    `);
  }

  private claimJob(input: {
    scope?: RunManifestScope;
    jobId?: string;
    owner: string;
    token: string;
    now: number;
    leaseUntil: number;
    maxAttempts: number;
  }) {
    if (!input.scope) throw new Error('curation_job_scope_required');
    return this.db.transaction(() => {
      const selected = this.db.prepare(`
        SELECT job_id
        FROM curation_jobs
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND (? IS NULL OR job_id = ?)
          AND state = 'pending'
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND attempts < ?
        ORDER BY created_at, job_id
        LIMIT 1
      `).get(
        input.scope!.tenantId,
        input.scope!.workspaceId,
        input.jobId ?? null,
        input.jobId ?? null,
        input.maxAttempts,
      ) as {job_id: string} | undefined;
      if (!selected) return {changes: 0};
      const changed = this.db.prepare(`
        UPDATE curation_jobs
        SET lease_owner = ?,
            lease_token = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE job_id = ?
          AND tenant_id = ?
          AND workspace_id = ?
          AND state = 'pending'
          AND lease_owner IS NULL
          AND lease_token IS NULL
      `).run(
        input.owner,
        input.token,
        input.leaseUntil,
        input.now,
        selected.job_id,
        input.scope!.tenantId,
        input.scope!.workspaceId,
      );
      if (changed.changes !== 1) return {changes: changed.changes};
      const row = this.db.prepare(`
        SELECT input_json, attempts
        FROM curation_jobs
        WHERE job_id = ?
      `).get(selected.job_id) as {
        input_json: string;
        attempts: number;
      };
      return {
        changes: 1,
        job: {
          jobId: selected.job_id,
          candidate: JSON.parse(row.input_json) as SelectedCurationCandidate,
          attempts: row.attempts,
        },
        scope: {...input.scope!},
        jobId: selected.job_id,
      };
    })();
  }

  private assertLease(fence: ScopedLeaseFence, now: number): number {
    return this.fencedUpdate(fence, now, 'updated_at = updated_at').changes;
  }

  private renewLeaseRow(
    fence: ScopedLeaseFence,
    now: number,
    leaseUntil: number,
  ): number {
    return this.fencedUpdate(
      fence,
      now,
      'lease_until = @leaseUntil, updated_at = @now',
      {leaseUntil},
    ).changes;
  }

  private completeDraftRow(
    fence: ScopedLeaseFence,
    proposalValue: CurationProposalV1,
    now: number,
  ): number {
    const proposal = parseM6DraftProposal(proposalValue);
    if (
      proposal.scope.tenantId !== fence.scope.tenantId ||
      proposal.scope.workspaceId !== fence.scope.workspaceId
    ) {
      throw new Error('curation_proposal_scope_mismatch');
    }
    return this.db.transaction(() => {
      const job = this.db.prepare(`
        SELECT input_json
        FROM curation_jobs
        WHERE job_id = ?
      `).get(fence.jobId) as {input_json: string} | undefined;
      if (!job) throw new Error('curation_job_not_found');
      const candidate = JSON.parse(job.input_json) as SelectedCurationCandidate;
      assertProposalMatchesCandidate(candidate, proposal);
      const payload = canonicalJsonString(proposal);
      const inserted = this.db.prepare(`
        INSERT INTO curation_proposals (
          proposal_id, tenant_id, workspace_id, revision,
          idempotency_key, status, proposal_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
        ON CONFLICT(proposal_id) DO NOTHING
      `).run(
        proposal.proposalId,
        proposal.scope.tenantId,
        proposal.scope.workspaceId,
        proposal.revision,
        proposal.idempotencyKey,
        payload,
        proposal.createdAt,
      );
      if (inserted.changes === 0) {
        const existing = this.db.prepare(`
          SELECT proposal_json
          FROM curation_proposals
          WHERE proposal_id = ?
        `).get(proposal.proposalId) as {proposal_json: string} | undefined;
        if (!existing || existing.proposal_json !== payload) {
          throw new Error('curation_proposal_append_conflict');
        }
      }
      const completed = this.fencedUpdate(
        fence,
        now,
        [
          "state = 'done'",
          'lease_owner = NULL',
          'lease_token = NULL',
          'lease_until = NULL',
          'last_error = NULL',
          'updated_at = @now',
        ].join(', '),
      );
      if (completed.changes !== 1) {
        throw new ScopedLeaseLostError('complete', fence);
      }
      return 1;
    })();
  }

  private failLeaseRow(
    fence: ScopedLeaseFence,
    failure: ProposalFailure,
    now: number,
  ): number {
    return this.fencedUpdate(
      fence,
      now,
      [
        "state = CASE WHEN attempts >= @maxAttempts THEN 'failed' ELSE 'pending' END",
        'lease_owner = NULL',
        'lease_token = NULL',
        'lease_until = NULL',
        'last_error = @reason',
        'updated_at = @now',
      ].join(', '),
      {
        maxAttempts: failure.maxAttempts,
        reason: failure.reason.slice(0, 1000),
      },
    ).changes;
  }

  private releaseLeaseRow(fence: ScopedLeaseFence, now: number): number {
    return this.fencedUpdate(
      fence,
      now,
      [
        'lease_owner = NULL',
        'lease_token = NULL',
        'lease_until = NULL',
        'updated_at = @now',
      ].join(', '),
    ).changes;
  }

  private fencedUpdate(
    fence: ScopedLeaseFence,
    now: number,
    setClause: string,
    extra: Record<string, unknown> = {},
  ): Database.RunResult {
    return this.db.prepare(`
      UPDATE curation_jobs
      SET ${setClause}
      WHERE job_id = @jobId
        AND tenant_id = @tenantId
        AND workspace_id = @workspaceId
        AND state = 'pending'
        AND lease_owner = @owner
        AND lease_token = @token
        AND lease_until > @now
    `).run({
      jobId: fence.jobId,
      tenantId: fence.scope.tenantId,
      workspaceId: fence.scope.workspaceId,
      owner: fence.owner,
      token: fence.token,
      now,
      ...extra,
    });
  }
}

type ParsedPlan = ReturnType<typeof parseProposalMaterializationPlanV1>;
type ParsedCandidate =
  ReturnType<typeof parseProposalCandidateMaterializationV1>;
type ParsedSql = ReturnType<typeof parseProposalSqlRegressionProofV1>;
type ParsedPaired = ReturnType<typeof parseProposalPairedReplayProofV1>;

interface ValidatedGateEvidence {
  plan?: ParsedPlan;
  containment?: ProposalContainmentProbeV1;
  finalContainment?: ProposalContainmentProbeV1;
  candidate?: ParsedCandidate;
  initialBase?: ProposalGateSnapshotEvidenceV1;
  finalBase?: ProposalGateSnapshotEvidenceV1;
  staticProof?: ProposalStaticValidationProofV1;
  sqlProof?: ParsedSql;
  pairedProof?: ParsedPaired;
}

function assertTrustedGateEvidence(
  evidence: Map<ProposalGateEvidenceKind, unknown>,
  trusted: {
    sqlRegressionProof?: ProposalSqlRegressionProofV1;
    pairedReplayProof?: ProposalPairedReplayProofV1;
  } | undefined,
): void {
  const storedSql = evidence.get('sql_regression') as ParsedSql | undefined;
  if (storedSql) {
    if (
      !trusted?.sqlRegressionProof
      || storedSql.contentHash !== trusted.sqlRegressionProof.contentHash
    ) {
      throw new Error('curation_gate_sql_evidence_not_authoritative');
    }
    assertTrustedProposalSqlRegressionProof(trusted.sqlRegressionProof);
  } else if (trusted?.sqlRegressionProof) {
    throw new Error('curation_gate_sql_evidence_not_recorded');
  }

  const storedPaired = evidence.get('paired_replay') as
    ParsedPaired | undefined;
  if (storedPaired) {
    if (
      !trusted?.pairedReplayProof
      || storedPaired.contentHash !== trusted.pairedReplayProof.contentHash
    ) {
      throw new Error('curation_gate_paired_evidence_not_authoritative');
    }
    assertTrustedProposalPairedReplayProof(trusted.pairedReplayProof);
  } else if (trusted?.pairedReplayProof) {
    throw new Error('curation_gate_paired_evidence_not_recorded');
  }
}

function parseGateEvidence(
  kind: ProposalGateEvidenceKind,
  value: unknown,
): unknown {
  switch (kind) {
    case 'materialization_plan':
      return parseProposalMaterializationPlanV1(value);
    case 'containment_probe':
    case 'containment_probe_final':
      return parseProposalContainmentProbeV1(value);
    case 'candidate_materialization':
      return parseProposalCandidateMaterializationV1(value);
    case 'base_snapshot_initial':
    case 'base_snapshot_final':
      return parseSnapshotEvidence(value);
    case 'repository_target_binding':
      return parseRepositoryTargetBindingV1(value);
    case 'static_validation':
      return parseProposalStaticValidationProofV1(value);
    case 'sql_regression':
      return parseProposalSqlRegressionProofV1(value);
    case 'paired_replay':
      return parseProposalPairedReplayProofV1(value);
  }
}

function parseSnapshotEvidence(
  value: unknown,
): ProposalGateSnapshotEvidenceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('curation_gate_snapshot_evidence_invalid');
  }
  const evidence = value as ProposalGateSnapshotEvidenceV1;
  const snapshot = evidence.snapshot;
  if (
    evidence.schemaVersion !== 1
    || Object.keys(evidence).some(key =>
      !['schemaVersion', 'snapshot', 'snapshotHash', 'contentHash'].includes(
        key,
      ))
    || !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || Object.keys(snapshot).some(key => ![
      'targetId',
      'contentHash',
      'content',
      'anchorContent',
      'registryFingerprint',
      'skillRegistryFingerprint',
      'strategyRegistryFingerprint',
      'overlayGeneration',
    ].includes(key))
    || !snapshot.targetId?.trim()
    || (
      snapshot.content !== undefined
      && typeof snapshot.content !== 'string'
    )
    || (
      snapshot.anchorContent !== undefined
      && typeof snapshot.anchorContent !== 'string'
    )
    || !snapshot.overlayGeneration?.trim()
    || [
      snapshot.contentHash,
      snapshot.registryFingerprint,
      snapshot.skillRegistryFingerprint,
      snapshot.strategyRegistryFingerprint,
      evidence.snapshotHash,
      evidence.contentHash,
    ].some(hash => !/^[0-9a-f]{64}$/.test(hash))
    || evidence.snapshotHash !== canonicalContentHash(snapshot)
  ) {
    throw new Error('curation_gate_snapshot_evidence_invalid');
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    snapshot: immutableCanonicalSnapshot(snapshot),
    snapshotHash: evidence.snapshotHash,
  };
  if (canonicalContentHash(withoutHash) !== evidence.contentHash) {
    throw new Error('curation_gate_snapshot_evidence_hash_mismatch');
  }
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: evidence.contentHash,
  });
}

export function createProposalGateSnapshotEvidenceV1(
  snapshot: ProposalBaseSnapshotV1,
): ProposalGateSnapshotEvidenceV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    snapshot: immutableCanonicalSnapshot(snapshot),
    snapshotHash: canonicalContentHash(snapshot),
  };
  return parseSnapshotEvidence({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

function evidenceContentHash(value: unknown): string {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !('contentHash' in value)
    || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.contentHash)
  ) {
    throw new Error('curation_gate_evidence_hash_invalid');
  }
  return value.contentHash;
}

function parseProposalActionRecordV1(
  value: unknown,
): ProposalActionRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('proposal_action_invalid');
  }
  const action = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'actionId',
    'kind',
    'scope',
    'proposalId',
    'artifactContentHashes',
    'expectedRevision',
    'targetRevision',
    'state',
    'failureClass',
    'sideEffectKind',
    'sideEffectReceiptHash',
    'errorCode',
    'createdAt',
    'updatedAt',
  ]);
  const required = [
    'schemaVersion',
    'actionId',
    'kind',
    'scope',
    'proposalId',
    'artifactContentHashes',
    'expectedRevision',
    'targetRevision',
    'state',
    'sideEffectKind',
    'createdAt',
    'updatedAt',
  ];
  const scope = action.scope as Record<string, unknown> | undefined;
  if (
    Object.keys(action).some(key => !allowed.has(key))
    || required.some(key => !(key in action))
    || action.schemaVersion !== 1
    || typeof action.actionId !== 'string'
    || !action.actionId.trim()
    || !['apply', 'revert'].includes(String(action.kind))
    || !scope
    || typeof scope !== 'object'
    || Array.isArray(scope)
    || Object.keys(scope).some(key =>
      !['tenantId', 'workspaceId'].includes(key))
    || typeof scope.tenantId !== 'string'
    || !scope.tenantId.trim()
    || typeof scope.workspaceId !== 'string'
    || !scope.workspaceId.trim()
    || typeof action.proposalId !== 'string'
    || !action.proposalId.trim()
    || !Array.isArray(action.artifactContentHashes)
    || action.artifactContentHashes.some(value =>
      typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    || action.artifactContentHashes.some((value, index, values) =>
      index > 0 && value <= values[index - 1])
    || !['pending', 'executing', 'finalized', 'failed']
      .includes(String(action.state))
    || ![
      'runtime_overlay',
      'repository_patch',
      'case_retract',
      'skill_note_disable',
    ].includes(String(action.sideEffectKind))
    || !Number.isSafeInteger(action.createdAt)
    || Number(action.createdAt) < 0
    || !Number.isSafeInteger(action.updatedAt)
    || Number(action.updatedAt) < Number(action.createdAt)
    || (
      action.kind === 'apply'
      && (action.expectedRevision !== 3 || action.targetRevision !== 4)
    )
    || (
      action.kind === 'revert'
      && (action.expectedRevision !== 4 || action.targetRevision !== 5)
    )
    || (
      action.failureClass !== undefined
      && ![
        'terminal_before_side_effect',
        'retryable_before_side_effect',
        'recovery_required_after_side_effect',
      ].includes(String(action.failureClass))
    )
    || (
      action.state === 'failed'
      && (
        action.failureClass === undefined
        || typeof action.errorCode !== 'string'
        || !action.errorCode.trim()
      )
    )
    || (
      action.state !== 'failed'
      && (
        action.failureClass !== undefined
        || action.errorCode !== undefined
      )
    )
    || (
      action.sideEffectReceiptHash !== undefined
      && (
        typeof action.sideEffectReceiptHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(action.sideEffectReceiptHash)
      )
    )
  ) {
    throw new Error('proposal_action_invalid');
  }
  return immutableCanonicalSnapshot(action) as unknown as
    ProposalActionRecordV1;
}

function assertSameActionReservation(
  existing: ProposalActionRecordV1,
  requested: {
    actionId: string;
    scope: RunManifestScope;
    proposalId: string;
    kind: 'apply' | 'revert';
    sideEffectKind: ProposalActionRecordV1['sideEffectKind'];
    artifactContentHashes?: string[];
  },
): void {
  const requestedArtifactContentHashes = [
    ...new Set(requested.artifactContentHashes ?? []),
  ].sort();
  if (
    existing.actionId !== requested.actionId
    || existing.scope.tenantId !== requested.scope.tenantId
    || existing.scope.workspaceId !== requested.scope.workspaceId
    || existing.proposalId !== requested.proposalId
    || existing.kind !== requested.kind
    || existing.sideEffectKind !== requested.sideEffectKind
    || existing.artifactContentHashes.length
      !== requestedArtifactContentHashes.length
    || existing.artifactContentHashes.some(
      (value, index) => value !== requestedArtifactContentHashes[index],
    )
  ) {
    throw new Error('proposal_action_idempotency_conflict');
  }
}

function validateGateEvidenceBundle(input: {
  proposal: CurationProposalV1;
  session: ProposalGateAttemptSessionV1;
  checks: ProposalGateCheckV1[];
  evidence: Map<ProposalGateEvidenceKind, unknown>;
}): ValidatedGateEvidence {
  const get = <T>(kind: ProposalGateEvidenceKind): T | undefined =>
    input.evidence.get(kind) as T | undefined;
  const bundle: ValidatedGateEvidence = {
    plan: get<ParsedPlan>('materialization_plan'),
    containment: get<ProposalContainmentProbeV1>('containment_probe'),
    finalContainment:
      get<ProposalContainmentProbeV1>('containment_probe_final'),
    candidate: get<ParsedCandidate>('candidate_materialization'),
    initialBase:
      get<ProposalGateSnapshotEvidenceV1>('base_snapshot_initial'),
    finalBase: get<ProposalGateSnapshotEvidenceV1>('base_snapshot_final'),
    staticProof:
      get<ProposalStaticValidationProofV1>('static_validation'),
    sqlProof: get<ParsedSql>('sql_regression'),
    pairedProof: get<ParsedPaired>('paired_replay'),
  };
  const allowedHashes = new Set([
    input.session.draftContentHash,
    ...[...input.evidence.values()].map(evidenceContentHash),
  ]);
  if (
    input.checks.length !== 8
    || input.checks.some(check =>
      check.evidenceContentHashes.some(hash => !allowedHashes.has(hash)))
  ) {
    throw new Error('curation_gate_evidence_reference_untrusted');
  }
  const passed = (index: number) =>
    input.checks[index]?.verdict === 'passed';
  if (
    passed(1)
    && (
      !bundle.plan
      || !bundle.containment
      || bundle.containment.verdict !== 'passed'
      || bundle.plan.proposalId !== input.proposal.proposalId
      || bundle.plan.draftContentHash !== input.session.draftContentHash
      || bundle.containment.planContentHash !== bundle.plan.contentHash
      || bundle.containment.materializationRegistryContentHash
        !== bundle.plan.materializationRegistryContentHash
    )
  ) {
    throw new Error('curation_gate_containment_evidence_invalid');
  }
  if (
    passed(4)
    && (
      !bundle.candidate
      || !bundle.plan
      || bundle.candidate.proposalId !== input.proposal.proposalId
      || bundle.candidate.draftContentHash
        !== input.session.draftContentHash
      || bundle.candidate.planContentHash !== bundle.plan.contentHash
    )
  ) {
    throw new Error('curation_gate_candidate_evidence_invalid');
  }
  if (
    passed(5)
    && (
      !bundle.initialBase
      || !bundle.finalBase
      || !bundle.containment
      || !bundle.finalContainment
      || bundle.initialBase.snapshotHash !== bundle.finalBase.snapshotHash
      || bundle.containment.contentHash
        !== bundle.finalContainment.contentHash
      || bundle.initialBase.snapshot.targetId
        !== input.proposal.deltas[0].targetId
      || bundle.initialBase.snapshot.contentHash
        !== input.proposal.deltas[0].baseContentHash
      || bundle.initialBase.snapshot.registryFingerprint
        !== input.proposal.expectedRegistryFingerprint
      || bundle.initialBase.snapshot.overlayGeneration
        !== input.proposal.expectedOverlayGeneration
    )
  ) {
    throw new Error('curation_gate_optimistic_evidence_invalid');
  }
  if (
    passed(6)
    && (
      !bundle.staticProof
      || !bundle.candidate
      || !bundle.initialBase
      || bundle.staticProof.verdict !== 'passed'
      || bundle.staticProof.proposalId !== input.proposal.proposalId
      || bundle.staticProof.candidateMaterializationContentHash
        !== bundle.candidate.contentHash
      || bundle.staticProof.gateAttemptId !== input.session.attemptId
      || bundle.staticProof.gateAttemptOrdinal !== input.session.ordinal
      || bundle.staticProof.gatePolicyFingerprint
        !== input.session.gatePolicyFingerprint
      || bundle.staticProof.baseSkillRegistryFingerprint
        !== bundle.initialBase.snapshot.skillRegistryFingerprint
      || bundle.staticProof.baseStrategyRegistryFingerprint
        !== bundle.initialBase.snapshot.strategyRegistryFingerprint
    )
  ) {
    throw new Error('curation_gate_static_evidence_invalid');
  }
  if (
    bundle.staticProof?.sqlRegressionProof
    && (
      !bundle.sqlProof
      || bundle.sqlProof.contentHash
        !== bundle.staticProof.sqlRegressionProof.contentHash
      || bundle.sqlProof.gateAttemptId !== input.session.attemptId
      || bundle.sqlProof.gateAttemptOrdinal !== input.session.ordinal
      || bundle.sqlProof.gatePolicyFingerprint
        !== input.session.gatePolicyFingerprint
    )
  ) {
    throw new Error('curation_gate_sql_evidence_invalid');
  }
  if (
    passed(7)
    && (
      !bundle.pairedProof
      || !bundle.candidate
      || bundle.pairedProof.verdict !== 'passed'
      || bundle.pairedProof.proposalId !== input.proposal.proposalId
      || bundle.pairedProof.draftContentHash
        !== input.session.draftContentHash
      || bundle.pairedProof.candidateMaterializationContentHash
        !== bundle.candidate.contentHash
      || bundle.pairedProof.candidateContentHash
        !== bundle.candidate.contentHash
      || bundle.pairedProof.gateAttemptId !== input.session.attemptId
      || bundle.pairedProof.gateAttemptOrdinal !== input.session.ordinal
      || bundle.pairedProof.gatePolicyFingerprint
        !== input.session.gatePolicyFingerprint
    )
  ) {
    throw new Error('curation_gate_paired_evidence_invalid');
  }
  return bundle;
}

function createGateResultFromEvidence(input: {
  proposal: CurationProposalV1;
  session: ProposalGateAttemptSessionV1;
  checks: ProposalGateCheckV1[];
  evidence: ValidatedGateEvidence;
  completedAt: string;
}): ProposalGateResultV1 {
  const overallVerdict = input.checks.every(check =>
    check.verdict === 'passed')
    ? 'passed'
    : input.checks.some(check => check.verdict === 'failed')
      ? 'failed'
      : 'inconclusive';
  return createProposalGateResultV1({
    proposalId: input.proposal.proposalId,
    gateAttemptId: input.session.attemptId,
    gateAttemptOrdinal: input.session.ordinal,
    gatePolicyFingerprint: input.session.gatePolicyFingerprint,
    draftRevision: 1,
    gatedRevision: 2,
    draftContentHash: input.session.draftContentHash,
    startedAt: input.session.startedAt,
    completedAt: input.completedAt,
    checks: input.checks,
    overallVerdict,
    pairedGateVerdict: input.checks[7].verdict,
    ...(input.evidence.plan
      ? {materializationPlanContentHash: input.evidence.plan.contentHash}
      : {}),
    ...(input.evidence.candidate
      ? {
          candidateMaterializationContentHash:
            input.evidence.candidate.contentHash,
        }
      : {}),
    ...(input.evidence.sqlProof
      ? {
          sqlRegressionProofContentHash:
            input.evidence.sqlProof.contentHash,
        }
      : {}),
    ...(input.evidence.pairedProof
      ? {
          pairedReplayProofContentHash:
            input.evidence.pairedProof.contentHash,
        }
      : {}),
  });
}

function gateAttemptRecord(
  row: GateAttemptRow,
): ProposalGateAttemptRecordV1 {
  return immutableCanonicalSnapshot({
    session: {
      schemaVersion: 1 as const,
      attemptId: row.attempt_id,
      ordinal: row.attempt_ordinal,
      scope: {
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
      },
      proposalId: row.proposal_id,
      draftContentHash: row.draft_content_hash,
      gatePolicyFingerprint: row.gate_policy_fingerprint,
      startedAt: row.started_at,
    },
    state: row.state,
    ...(row.verdict ? {verdict: row.verdict} : {}),
    ...(row.gate_result_json
      ? {
          gateResult: parseProposalGateResultV1(
            JSON.parse(row.gate_result_json),
          ),
        }
      : {}),
    ...(row.completed_at ? {completedAt: row.completed_at} : {}),
  });
}

function assertProposalMatchesCandidate(
  candidate: SelectedCurationCandidate,
  proposal: CurationProposalV1,
): void {
  const reselected = selectSingleCurationCandidate({
    candidates: [candidate],
    templateContentHash: candidate.templateContentHash,
  });
  if (
    !reselected ||
    reselected.proposalId !== candidate.proposalId ||
    reselected.operationId !== candidate.operationId ||
    reselected.idempotencyKey !== candidate.idempotencyKey
  ) {
    throw new Error('curation_proposal_job_mismatch');
  }
  const {afterMode, ...candidateDelta} = candidate.delta;
  const {after: _after, ...proposalDelta} = proposal.deltas[0];
  const expected = {
    proposalId: candidate.proposalId,
    idempotencyKey: candidate.idempotencyKey,
    kind: candidate.kind,
    tier: candidate.tier,
    delta: {
      ...candidateDelta,
      operationId: candidate.operationId,
    },
    evidence: candidate.evidence,
    scope: candidate.sourceState.scope,
    expectedRegistryFingerprint:
      candidate.sourceState.expectedRegistryFingerprint,
    expectedOverlayGeneration:
      candidate.sourceState.expectedOverlayGeneration,
  };
  const actual = {
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    kind: proposal.kind,
    tier: proposal.tier,
    delta: proposalDelta,
    evidence: {
      negativeRunIds: proposal.evidence.negativeRunIds,
      positiveRunIds: proposal.evidence.positiveRunIds,
      labeledCount: proposal.evidence.labeledCount,
      negativeCount: proposal.evidence.negativeCount,
      distinctTraceCount: proposal.evidence.distinctTraceCount,
      distinctSessionCount: proposal.evidence.distinctSessionCount,
    },
    scope: proposal.scope,
    expectedRegistryFingerprint: proposal.expectedRegistryFingerprint,
    expectedOverlayGeneration: proposal.expectedOverlayGeneration,
  };
  if (
    canonicalJsonString(actual) !== canonicalJsonString(expected) ||
    (afterMode === 'none' && proposal.deltas[0].after !== undefined) ||
    (afterMode === 'generated' && proposal.deltas[0].after === undefined)
  ) {
    throw new Error('curation_proposal_job_mismatch');
  }
}

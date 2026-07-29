// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  CurationProposalV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  ScopedLeaseLostError,
  ScopedOutbox,
  type ScopedLease,
  type ScopedLeaseFence,
} from '../evolutionLifecycle/scopedOutbox';
import {canonicalJsonString} from './canonicalJson';
import type {SelectedCurationCandidate} from './curationContracts';
import {selectSingleCurationCandidate} from './curationCoordinator';
import {parseM6DraftProposal} from './proposalContract';

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
      ? parseM6DraftProposal(JSON.parse(row.proposal_json))
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
      ? parseM6DraftProposal(JSON.parse(row.proposal_json))
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
      parseM6DraftProposal(JSON.parse(row.proposal_json)));
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

      CREATE TABLE IF NOT EXISTS curation_proposals (
        proposal_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status = 'draft'),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, workspace_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_curation_proposals_scope
        ON curation_proposals(tenant_id, workspace_id, created_at);
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

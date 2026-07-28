// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import {
  openCaseCandidateOutbox,
  type CaseCandidateOutboxHandle,
  __testing,
} from '../caseCandidateOutbox';

function candidate(overrides: Partial<CaseCandidate> = {}): CaseCandidate {
  return {
    candidateId: overrides.candidateId || `cand-${Math.random().toString(36).slice(2)}`,
    schemaVersion: 'case_candidate@2',
    provenance: {
      sourceSessionId: 'session-1',
      sourceAnalysisRunId: 'run-1',
      sourceTurnIndex: 1,
      traceContentHash: 'trace-hash',
      capturedAt: 1000,
      engine: 'claude',
      sceneType: 'scrolling',
      architectureType: 'unknown',
      originScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    },
    cluster: {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      responsibility: 'app',
      severity: 'warning',
      frameCount: 4,
      percentage: 18,
      evidenceSignatures: {reason_code: 'shader_compile'},
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
    },
    verification: {
      claimSupportSummary: 'claims verified',
      verifierStatus: 'passed',
      verifierIssueSeverities: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      confidenceNumeric: 0.9,
      confidenceBucket: 'high',
    },
    ...overrides,
  };
}

function review(candidateId: string): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader compilation causes jank',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: {
        required: [{field: 'reason_code', op: 'eq', value: 'shader_compile'}],
        supportive: [],
      },
      findings: [{id: 'finding-1', title: 'Shader compile frames', evidence_refs: ['ev-1'], confidence: 'high'}],
      recommendations: {
        app: [{id: 'rec-1', priority: 'P1', action: 'Warm shader cache', applies_when: 'shader_compile', risks: 'May increase startup work'}],
        oem: [],
      },
      relations: {},
    },
    evidenceSummary: 'Supported by root-cause evidence',
    risks: [],
  };
}

describe('caseCandidateOutbox', () => {
  let outbox: CaseCandidateOutboxHandle;

  beforeEach(() => {
    outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
  });

  afterEach(() => {
    outbox.close();
  });

  it('applies migration v1 and enables foreign keys', () => {
    expect(outbox.schemaVersion()).toBe(__testing.SCHEMA_VERSION_LATEST);
    expect(outbox.foreignKeysEnabled()).toBe(true);
  });

  it('migrates legacy unscoped candidates without rejecting pending work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-case-outbox-'));
    const dbPath = path.join(dir, 'case-evolution.db');
    const initial = openCaseCandidateOutbox({dbPath});
    const legacy = candidate({candidateId: 'legacy-candidate'}) as any;
    delete legacy.provenance.originScope;
    legacy.schemaVersion = 'case_candidate@1';
    expect(initial.enqueue(legacy, {dedupeKey: 'legacy::dedupe'}).enqueued).toBe(true);
    initial.close();

    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    raw.prepare(`
      UPDATE case_candidates SET payload_json = ?, dedupe_key = ? WHERE candidate_id = ?
    `).run(JSON.stringify(legacy), 'legacy::dedupe', legacy.candidateId);
    raw.close();

    const migrated = openCaseCandidateOutbox({dbPath});
    try {
      const row = migrated.getCandidate(legacy.candidateId)!;
      expect(migrated.schemaVersion()).toBe(3);
      expect(row.state).toBe('pending_review');
      expect(row.candidate.schemaVersion).toBe('case_candidate@2');
      expect(row.candidate.provenance.originScope).toEqual({
        tenantId: 'default-dev-tenant',
        workspaceId: 'default-workspace',
      });
      expect(row.dedupeKey).toBe(
        'default-dev-tenant::default-workspace::trace-hash::scrolling::shader_compile',
      );
    } finally {
      migrated.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('computes supported from overwrite-only effective feedback projection', () => {
    const item = candidate({candidateId: 'cand-supported'});
    const enqueued = outbox.enqueue(item, {dedupeKey: 'trace::scrolling::shader_compile'});
    expect(enqueued.enqueued).toBe(true);

    outbox.applyFeedbackProjection(item.candidateId, [
      {rating: 'positive'},
      {rating: 'positive'},
      {rating: 'positive'},
    ]);
    expect(outbox.getCandidate(item.candidateId)!.supported).toBe(0);

    outbox.markReviewed(item.candidateId, {review: review(item.candidateId), notePath: 'logs/case_candidates/cand-supported.json'});
    expect(outbox.getCandidate(item.candidateId)!.supported).toBe(1);
  });

  it('dedupes active pending and reviewed rows by dedupe_key', () => {
    const first = outbox.enqueue(candidate({candidateId: 'cand-1'}), {dedupeKey: 'dup'});
    expect(first.enqueued).toBe(true);
    expect(outbox.enqueue(candidate({candidateId: 'cand-2'}), {dedupeKey: 'dup'})).toMatchObject({
      enqueued: false,
      reason: 'duplicate_active',
    });

    outbox.markReviewed('cand-1', {review: review('cand-1')});
    expect(outbox.enqueue(candidate({candidateId: 'cand-3'}), {dedupeKey: 'dup'})).toMatchObject({
      enqueued: false,
      reason: 'duplicate_active',
    });
  });

  it('leases pending rows without changing lifecycle state', () => {
    const item = candidate({candidateId: 'cand-lease'});
    outbox.enqueue(item, {dedupeKey: 'lease', priority: 5});

    const leased = outbox.leaseNext({workerOwner: 'worker-1', leaseDurationMs: 60_000});
    expect(leased).not.toBeNull();
    expect(leased!.candidateId).toBe(item.candidateId);
    expect(leased!.state).toBe('pending_review');
    expect(leased!.attempts).toBe(1);
    expect(leased!.leaseOwner).toBe('worker-1');
    expect(leased!.leaseUntil).toBeGreaterThan(Date.now());
  });

  it('expires stale leases back to leasable pending rows', () => {
    outbox.enqueue(candidate({candidateId: 'cand-stale'}), {dedupeKey: 'stale'});
    outbox.leaseNext({workerOwner: 'worker-1', leaseDurationMs: 1});

    expect(outbox.expireStaleLeases(Date.now() + 10_000)).toBe(1);
    const row = outbox.getCandidate('cand-stale')!;
    expect(row.state).toBe('pending_review');
    expect(row.leaseOwner).toBeNull();
    expect(row.leaseUntil).toBeNull();
  });

  it('retries failures until max attempts, then rejects', () => {
    outbox.enqueue(candidate({candidateId: 'cand-fail'}), {dedupeKey: 'fail'});
    const first = outbox.leaseNext({workerOwner: 'worker-1', maxAttempts: 2})!;
    outbox.markFailed(first.candidateId, 'transient', 2);
    expect(outbox.getCandidate(first.candidateId)!.state).toBe('pending_review');

    outbox.leaseNext({workerOwner: 'worker-1', maxAttempts: 2});
    outbox.markFailed(first.candidateId, 'fatal', 2);
    const row = outbox.getCandidate(first.candidateId)!;
    expect(row.state).toBe('rejected');
    expect(row.lastError).toBe('fatal');
  });

  it('keeps the legacy candidate_feedback table read-only', () => {
    outbox.enqueue(candidate({candidateId: 'cand-feedback'}), {dedupeKey: 'feedback'});
    expect(outbox.addFeedback('cand-feedback', {sourceSessionId: 'source-session', rating: 'positive'})).toMatchObject({
      added: false,
      reason: 'legacy_read_only',
    });
    expect(outbox.legacyFeedbackStats()).toEqual({
      totalPositive: 0,
      totalNegative: 0,
      distinctSessions: 0,
    });
  });

  it('exports only legacy feedback rows accepted into candidate counts', () => {
    const dir = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'smartperfetto-case-feedback-migration-',
    ));
    const dbPath = path.join(dir, 'case-evolution.db');
    const persisted = openCaseCandidateOutbox({dbPath});
    const item = candidate({candidateId: 'cand-legacy-feedback'});
    persisted.enqueue(item, {dedupeKey: 'legacy-feedback'});
    persisted.close();

    const raw = new Database(dbPath);
    const insert = raw.prepare(`
      INSERT INTO candidate_feedback (
        candidate_id, source_session_id, source_analysis_run_id, rating,
        received_at, received_within_seconds, within_time_window, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    insert.run(
      item.candidateId,
      'session-accepted',
      'run-1',
      'positive',
      20_000,
      20,
      'short',
    );
    insert.run(
      item.candidateId,
      'session-audit-only',
      'run-1',
      'negative',
      90_000_000,
      90_000,
      'audit_only',
    );
    raw.close();

    const reopened = openCaseCandidateOutbox({dbPath});
    try {
      expect(reopened.listAcceptedLegacyFeedback({
        tenantId: 'default-dev-tenant',
        workspaceId: 'default-workspace',
      })).toEqual([{
        sourceRowId: 1,
        candidateId: item.candidateId,
        sourceSessionId: 'session-accepted',
        sourceAnalysisRunId: 'run-1',
        rating: 'positive',
        receivedAt: 20_000,
      }]);
      expect(reopened.listAcceptedLegacyFeedback({
        tenantId: 'other-tenant',
        workspaceId: 'default-workspace',
      })).toEqual([]);
    } finally {
      reopened.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('reverses feedback-only rejection without changing intrinsic governance state', () => {
    const item = candidate({candidateId: 'cand-reversible'});
    outbox.enqueue(item, {dedupeKey: 'reversible'});
    outbox.markReviewed(item.candidateId, {review: review(item.candidateId)});

    expect(outbox.applyFeedbackProjection(item.candidateId, [
      {rating: 'negative'},
      {rating: 'negative'},
    ])).toMatchObject({rejected: true});
    expect(outbox.getCandidate(item.candidateId)).toMatchObject({
      state: 'rejected',
      intrinsicState: 'reviewed',
      feedbackProjectionRejected: true,
    });

    outbox.applyFeedbackProjection(item.candidateId, []);
    expect(outbox.getCandidate(item.candidateId)).toMatchObject({
      state: 'reviewed',
      intrinsicState: 'reviewed',
      feedbackProjectionRejected: false,
    });
  });

  it('keeps reversible rejected candidates in the active dedupe set', () => {
    const first = candidate({candidateId: 'cand-reversible-dedupe'});
    const duplicate = candidate({candidateId: 'cand-reversible-duplicate'});
    outbox.enqueue(first, {dedupeKey: 'reversible-dedupe'});
    outbox.applyFeedbackProjection(first.candidateId, [
      {rating: 'negative'},
      {rating: 'negative'},
    ]);

    expect(outbox.enqueue(duplicate, {
      dedupeKey: 'reversible-dedupe',
    })).toMatchObject({
      enqueued: false,
      reason: 'duplicate_active',
    });
    expect(outbox.applyFeedbackProjection(first.candidateId, []))
      .toMatchObject({found: true, rejected: false});
    expect(outbox.getCandidate(first.candidateId)?.state)
      .toBe('pending_review');
  });

  // MAJOR-5 regression: after one worker has leased the only pending row, a
  // second leaseNext must return null rather than handing the same (now-owned)
  // row to a competing worker. The original implementation returned the row
  // unconditionally after the UPDATE, ignoring whether the claim succeeded.
  it('does not return an already-leased row to a second leaseNext call', () => {
    outbox.enqueue(candidate({candidateId: 'cand-race'}), {dedupeKey: 'race'});
    const firstLease = outbox.leaseNext({workerOwner: 'worker-1'});
    expect(firstLease).not.toBeNull();
    expect(firstLease!.candidateId).toBe('cand-race');

    // The row is now leased by worker-1. A second claim attempt must NOT
    // return it — there are no other leasable rows.
    const secondLease = outbox.leaseNext({workerOwner: 'worker-2'});
    expect(secondLease).toBeNull();
  });
});

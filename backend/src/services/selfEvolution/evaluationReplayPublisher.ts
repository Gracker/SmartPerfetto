// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {
  createEvaluationRoleInjectionContract,
  assertEvaluationExposureMatchesContract,
  type EvaluationRoleInjectionContractV1,
} from './evaluationInjectionContext';
import {
  parseEvaluationRoleProofV2,
  type EvaluationRoleProofV2,
} from './evaluationPairAttestation';
import {
  parseEvaluationEnvironmentProof,
  type EvaluationEnvironmentProofV1,
  type EvaluationEnvironmentStartV1,
} from './evaluationEnvironmentProof';
import {evalScoreKey, parseEvalScore} from './evalContracts';
import type {EvalCaseStore} from './evalCaseStore';
import type {
  EvaluationPublicationFenceV1,
  PublishedReplayResult,
  ReplayResultPublisher,
} from './replayRunner';

export interface EvaluationReplayPublishedRecordV1
  extends PublishedReplayResult {
  schemaVersion: 1;
  resultRef: string;
  environmentProof: EvaluationEnvironmentProofV1;
  frozenArtifactsHash: string;
  executionFence: EvaluationPublicationFenceV1;
  contentHash: string;
}

export interface EvaluationReplayPublisherOptions {
  persistence: SelfEvolutionPersistenceCapability;
  evalCaseStore: EvalCaseStore;
  resolveBaselineContext(input: {
    evalCase: EvalCaseV1;
    pinned: EvalPinnedEnvironmentV1;
    candidateId: string;
  }): {
    environmentStart: EvaluationEnvironmentStartV1;
    roleContract: EvaluationRoleInjectionContractV1;
    fullTreatmentContractHash: string;
  } | Promise<{
    environmentStart: EvaluationEnvironmentStartV1;
    roleContract: EvaluationRoleInjectionContractV1;
    fullTreatmentContractHash: string;
  }>;
  isPublicationCommitted(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    resultRef: string;
  }): boolean;
  databasePath?: string;
  openDatabase?: (databasePath: string) => Database.Database;
}

interface PublishedRow {
  record_json: string;
}

function parseRoleContract(
  value: EvaluationRoleInjectionContractV1,
): EvaluationRoleInjectionContractV1 {
  const normalized = createEvaluationRoleInjectionContract({
    role: value.role,
    mode: value.mode,
    selected: value.selected,
    reservedTreatmentNamespace: value.reservedTreatmentNamespace,
    expectedMaterializedRefs: value.expectedMaterializedRefs,
    expectedObservedRefs: value.expectedObservedRefs,
    forbiddenObservedRefs: value.forbiddenObservedRefs,
  });
  if (normalized.contractHash !== value.contractHash) {
    throw new Error('evaluation_role_contract_hash_mismatch');
  }
  return normalized;
}

function recordHash(
  value: Omit<EvaluationReplayPublishedRecordV1, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

function createPublishedRecord(input: {
  resultRef: string;
  score: EvalScoreV1;
  environmentProof: EvaluationEnvironmentProofV1;
  roleProof: EvaluationRoleProofV2;
  roleContract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
  frozenArtifactsHash: string;
  executionFence: EvaluationPublicationFenceV1;
}): EvaluationReplayPublishedRecordV1 {
  const score = parseEvalScore(input.score);
  const environmentProof = parseEvaluationEnvironmentProof(
    input.environmentProof,
  );
  const roleProof = parseEvaluationRoleProofV2(input.roleProof);
  const roleContract = parseRoleContract(input.roleContract);
  assertEvaluationExposureMatchesContract({
    contract: roleContract,
    receipt: roleProof.exposureReceipt,
  });
  if (
    roleProof.role !== score.role
    || roleProof.runId !== score.runId
    || roleProof.runManifestId !== score.runManifestId
    || roleProof.baseEnvironmentProofContentHash
      !== environmentProof.contentHash
    || roleProof.roleContractHash !== roleContract.contractHash
    || (
      score.role === 'candidate'
      && roleProof.materialization.artifactId !== score.candidateId
    )
    || (
      score.role === 'baseline'
      && !roleProof.materialization.artifactId.startsWith('baseline:')
    )
    || !/^[0-9a-f]{64}$/.test(input.fullTreatmentContractHash)
    || !/^[0-9a-f]{64}$/.test(input.frozenArtifactsHash)
    || !input.executionFence.taskId?.trim()
    || !input.executionFence.executionToken?.trim()
  ) {
    throw new Error('evaluation_published_result_binding_mismatch');
  }
  const withoutHash: Omit<
    EvaluationReplayPublishedRecordV1,
    'contentHash'
  > = {
    schemaVersion: 1,
    resultRef: input.resultRef,
    score,
    environmentProof,
    roleProof,
    roleContract,
    fullTreatmentContractHash: input.fullTreatmentContractHash,
    frozenArtifactsHash: input.frozenArtifactsHash,
    executionFence: immutableCanonicalSnapshot(input.executionFence),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: recordHash(withoutHash),
  });
}

function parsePublishedRecord(
  value: EvaluationReplayPublishedRecordV1,
): EvaluationReplayPublishedRecordV1 {
  if (!value || value.schemaVersion !== 1) {
    throw new Error('evaluation_published_result_invalid');
  }
  const normalized = createPublishedRecord(value);
  if (normalized.contentHash !== value.contentHash) {
    throw new Error('evaluation_published_result_hash_mismatch');
  }
  return normalized;
}

function scopedKey(scope: RunManifestScope, resultRef: string): string {
  return `${scope.tenantId}\0${scope.workspaceId}\0${resultRef}`;
}

export class EvaluationReplayPublisher implements ReplayResultPublisher {
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly evalCaseStore: EvalCaseStore;
  private readonly resolveBaselineContext:
    EvaluationReplayPublisherOptions['resolveBaselineContext'];
  private readonly isPublicationCommitted:
    EvaluationReplayPublisherOptions['isPublicationCommitted'];
  private readonly databasePath: string;
  private readonly openDatabase: NonNullable<
    EvaluationReplayPublisherOptions['openDatabase']
  >;
  private readonly ephemeral = new Map<string, string>();
  private database: Database.Database | undefined;

  constructor(options: EvaluationReplayPublisherOptions) {
    this.persistence = options.persistence;
    this.evalCaseStore = options.evalCaseStore;
    this.resolveBaselineContext = options.resolveBaselineContext;
    this.isPublicationCommitted = options.isPublicationCommitted;
    this.databasePath = options.databasePath
      ?? userDataPath('self_improve', 'eval.db');
    this.openDatabase = options.openDatabase
      ?? (databasePath => new Database(databasePath));
  }

  async lookupBaseline(input: {
    evalCase: EvalCaseV1;
    pinned: EvalPinnedEnvironmentV1;
    candidateId: string;
  }) {
    const context = await this.resolveBaselineContext(input);
    const hit = this.evalCaseStore.lookupBaseline({
      scope: input.evalCase.scope,
      evalCase: input.evalCase,
      pinned: input.pinned,
      currentEnvironmentStart: context.environmentStart,
    });
    if (!hit) return undefined;
    const record = this.get(input.evalCase.scope, hit.token.baselineScoreKey);
    if (
      !record
      || record.score.role !== 'baseline'
      || record.environmentProof.contentHash !== hit.proof.contentHash
      || record.roleProof.baseEnvironmentProofContentHash
        !== hit.proof.contentHash
      || record.roleContract.contractHash
        !== context.roleContract.contractHash
      || record.fullTreatmentContractHash
        !== context.fullTreatmentContractHash
      || canonicalJsonString(record.score) !== canonicalJsonString(hit.score)
      || !this.isPublicationCommitted({
        scope: input.evalCase.scope,
        ...record.executionFence,
        resultRef: record.resultRef,
      })
    ) {
      return undefined;
    }
    return {
      score: record.score,
      environmentProof: record.environmentProof,
      roleProof: record.roleProof,
      roleContract: record.roleContract,
      fullTreatmentContractHash: record.fullTreatmentContractHash,
      resultRef: record.resultRef,
    };
  }

  async publish(input: {
    score: EvalScoreV1;
    environmentProof: EvaluationEnvironmentProofV1;
    roleProof: EvaluationRoleProofV2;
    roleContract: EvaluationRoleInjectionContractV1;
    fullTreatmentContractHash: string;
    frozenArtifactsHash: string;
    executionFence: EvaluationPublicationFenceV1;
    isAuthoritative: () => boolean;
  }): Promise<string> {
    if (!input.isAuthoritative()) {
      throw new Error('evaluation_execution_fence_lost');
    }
    const resultRef = evalScoreKey(input.score);
    const record = createPublishedRecord({
      resultRef,
      ...input,
    });
    this.put(input.score.scope, record);
    if (!input.isAuthoritative()) {
      throw new Error('evaluation_execution_fence_lost');
    }
    return resultRef;
  }

  async commitPublication(input: {
    scope: RunManifestScope;
    resultRef: string;
  }): Promise<void> {
    const record = this.get(input.scope, input.resultRef);
    if (!record) throw new Error('evaluation_published_result_not_found');
    if (!this.isPublicationCommitted({
      scope: input.scope,
      ...record.executionFence,
      resultRef: record.resultRef,
    })) {
      throw new Error('evaluation_publication_not_committed');
    }
    const stored = this.evalCaseStore.storeScoreWithProof(
      input.scope,
      record.score,
      record.environmentProof,
    );
    if (stored.scoreKey !== record.resultRef) {
      throw new Error('evaluation_published_result_key_mismatch');
    }
    if (record.score.role === 'baseline') {
      this.evalCaseStore.publishBaseline(
        input.scope,
        record.score.caseId,
        record.resultRef,
      );
    }
  }

  async loadPublished(input: {
    scope: RunManifestScope;
    resultRef: string;
  }): Promise<PublishedReplayResult | undefined> {
    const record = this.get(input.scope, input.resultRef);
    if (
      !record
      || !this.isPublicationCommitted({
        scope: input.scope,
        ...record.executionFence,
        resultRef: record.resultRef,
      })
    ) {
      return undefined;
    }
    await this.commitPublication(input);
    return {
      score: record.score,
      roleProof: record.roleProof,
      roleContract: record.roleContract,
      fullTreatmentContractHash: record.fullTreatmentContractHash,
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private get(
    scope: RunManifestScope,
    resultRef: string,
  ): EvaluationReplayPublishedRecordV1 | undefined {
    if (this.persistence.persistence === 'available') {
      const row = this.db().prepare(`
        SELECT record_json
        FROM evaluation_replay_results
        WHERE tenant_id = ? AND workspace_id = ? AND result_ref = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        resultRef,
      ) as PublishedRow | undefined;
      return row
        ? parsePublishedRecord(JSON.parse(row.record_json))
        : undefined;
    }
    const payload = this.ephemeral.get(scopedKey(scope, resultRef));
    return payload
      ? parsePublishedRecord(JSON.parse(payload))
      : undefined;
  }

  private put(
    scope: RunManifestScope,
    record: EvaluationReplayPublishedRecordV1,
  ): void {
    const payload = canonicalJsonString(record);
    if (this.persistence.persistence === 'available') {
      const existing = this.db().prepare(`
        SELECT record_json
        FROM evaluation_replay_results
        WHERE tenant_id = ? AND workspace_id = ? AND result_ref = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        record.resultRef,
      ) as PublishedRow | undefined;
      if (existing) {
        if (existing.record_json !== payload) {
          throw new Error('evaluation_published_result_conflict');
        }
        return;
      }
      this.db().prepare(`
        INSERT INTO evaluation_replay_results (
          tenant_id,
          workspace_id,
          result_ref,
          record_json,
          content_hash
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.workspaceId,
        record.resultRef,
        payload,
        record.contentHash,
      );
      return;
    }
    const key = scopedKey(scope, record.resultRef);
    const existing = this.ephemeral.get(key);
    if (existing && existing !== payload) {
      throw new Error('evaluation_published_result_conflict');
    }
    this.ephemeral.set(key, payload);
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = this.openDatabase(this.databasePath);
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_replay_results (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        result_ref TEXT NOT NULL,
        record_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, result_ref)
      );
    `);
    return this.database;
  }
}

export const __testing = {
  createPublishedRecord,
  parsePublishedRecord,
};

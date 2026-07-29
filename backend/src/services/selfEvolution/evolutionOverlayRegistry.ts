// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  EvolutionBaseRelation,
  EvolutionDegradationAlertV1,
  EvolutionGenerationRecordV1,
  EvolutionOverlayRegistryEntryV1,
  EvolutionOverlayProvenanceV1,
  EvolutionOverlayValidationState,
  EvolutionRollbackReceiptV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
  UpgradeReconciliationReportV1,
} from '../../types/selfEvolution';
import {
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {
  createEvolutionOverlayRegistryEntryV1,
  deriveEvolutionOverlayActivationState,
  parseEvolutionDegradationAlertV1,
  parseEvolutionOverlayRegistryEntryV1,
  parseEvolutionRollbackReceiptV1,
  parseUpgradeReconciliationReportV1,
} from './evolutionOverlayContract';

interface EvolutionOverlayRegistryOptions {
  databasePath?: string;
  persistence: SelfEvolutionPersistenceCapability;
}

interface GenerationHeadRow {
  candidate_generation: string | null;
  published_generation: string | null;
  fence: number;
  state: 'prepared' | 'published' | 'aborted' | null;
}

export interface EvolutionGenerationHeadV1 {
  scope: RunManifestScope;
  candidateGeneration: string | null;
  publishedGeneration: string | null;
  fence: number;
  state: 'prepared' | 'published' | 'aborted' | null;
}

export class EvolutionOverlayRegistry {
  private readonly db: Database.Database;

  constructor(options: EvolutionOverlayRegistryOptions) {
    if (options.persistence.persistence !== 'available') {
      throw new Error('self_evolution_persistence_unavailable');
    }
    const databasePath = options.databasePath
      ?? userDataPath('self_improve', 'evolution_registry.db');
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), {recursive: true, mode: 0o700});
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
  }

  stageEntry(
    input: Omit<
      EvolutionOverlayRegistryEntryV1,
      | 'schemaVersion'
      | 'actionState'
      | 'activationState'
      | 'effectiveEnabled'
    >,
  ): EvolutionOverlayRegistryEntryV1 {
    const entry = createEvolutionOverlayRegistryEntryV1({
      ...input,
      actionState: 'staged',
    });
    const payload = canonicalJsonString(entry);
    const result = this.db.prepare(`
      INSERT INTO evolution_overlay_entries (
        entry_id, tenant_id, workspace_id, overlay_id, action_id,
        action_state, artifact_content_hash, entry_json
      ) VALUES (?, ?, ?, ?, ?, 'staged', ?, ?)
      ON CONFLICT(entry_id) DO NOTHING
    `).run(
      entry.entryId,
      entry.scope.tenantId,
      entry.scope.workspaceId,
      entry.overlayId,
      entry.actionId,
      entry.artifactContentHash,
      payload,
    );
    if (result.changes === 0) {
      const existing = this.getEntry(entry.scope, entry.entryId);
      if (
        !existing
        || !sameImmutableEntryBinding(existing, entry)
        || existing.actionState === 'aborted'
      ) {
        throw new Error('evolution_overlay_entry_idempotency_conflict');
      }
      return existing;
    }
    return entry;
  }

  commitAction(actionId: string): number {
    return this.transitionAction(actionId, 'staged', 'committed');
  }

  abortAction(actionId: string): number {
    return this.transitionAction(actionId, 'staged', 'aborted');
  }

  getEntry(
    scope: RunManifestScope,
    entryId: string,
  ): EvolutionOverlayRegistryEntryV1 | undefined {
    const row = this.db.prepare(`
      SELECT entry_json
      FROM evolution_overlay_entries
      WHERE tenant_id = ? AND workspace_id = ? AND entry_id = ?
    `).get(
      scope.tenantId,
      scope.workspaceId,
      entryId,
    ) as {entry_json: string} | undefined;
    return row
      ? parseEvolutionOverlayRegistryEntryV1(JSON.parse(row.entry_json))
      : undefined;
  }

  listEntries(
    scope: RunManifestScope,
    options: {actionState?: 'staged' | 'committed' | 'aborted'} = {},
  ): EvolutionOverlayRegistryEntryV1[] {
    const rows = options.actionState
      ? this.db.prepare(`
          SELECT entry_json
          FROM evolution_overlay_entries
          WHERE tenant_id = ? AND workspace_id = ? AND action_state = ?
          ORDER BY overlay_id, entry_id
        `).all(scope.tenantId, scope.workspaceId, options.actionState)
      : this.db.prepare(`
          SELECT entry_json
          FROM evolution_overlay_entries
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY overlay_id, entry_id
        `).all(scope.tenantId, scope.workspaceId);
    return (rows as Array<{entry_json: string}>).map(row =>
      parseEvolutionOverlayRegistryEntryV1(JSON.parse(row.entry_json)));
  }

  listScopes(): RunManifestScope[] {
    const rows = this.db.prepare(`
      SELECT tenant_id, workspace_id
      FROM evolution_overlay_entries
      UNION
      SELECT tenant_id, workspace_id
      FROM evolution_generation_heads
      ORDER BY tenant_id, workspace_id
    `).all() as Array<{tenant_id: string; workspace_id: string}>;
    return rows.map(row => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
    }));
  }

  listEffectiveEntries(
    scope: RunManifestScope,
  ): EvolutionOverlayRegistryEntryV1[] {
    return this.listEntries(scope, {actionState: 'committed'})
      .filter(entry => entry.effectiveEnabled);
  }

  reconcileEntry(input: {
    scope: RunManifestScope;
    entryId: string;
    baseRelation: EvolutionBaseRelation;
    validationState: EvolutionOverlayValidationState;
    validationReason?: string;
    userDisabled?: boolean;
    provenance?: EvolutionOverlayProvenanceV1;
    reconciledAt?: number;
  }): EvolutionOverlayRegistryEntryV1 {
    return this.db.transaction(() => {
      const existing = this.getEntry(input.scope, input.entryId);
      if (!existing) throw new Error('evolution_overlay_entry_not_found');
      const activation = deriveEvolutionOverlayActivationState({
        userDisabled: input.userDisabled ?? existing.userDisabled,
        baseRelation: input.baseRelation,
        validationState: input.validationState,
      });
      const {
        validationReason: _priorValidationReason,
        ...entryWithoutValidationReason
      } = existing;
      const updated = parseEvolutionOverlayRegistryEntryV1({
        ...entryWithoutValidationReason,
        baseRelation: input.baseRelation,
        validationState: input.validationState,
        ...activation,
        userDisabled: input.userDisabled ?? existing.userDisabled,
        provenance: input.provenance ?? existing.provenance,
        ...(input.validationReason === undefined
          ? {}
          : {validationReason: input.validationReason}),
        reconciledAt: input.reconciledAt ?? Date.now(),
      });
      const result = this.db.prepare(`
        UPDATE evolution_overlay_entries
        SET entry_json = ?
        WHERE tenant_id = ? AND workspace_id = ? AND entry_id = ?
          AND entry_json = ?
      `).run(
        canonicalJsonString(updated),
        input.scope.tenantId,
        input.scope.workspaceId,
        input.entryId,
        canonicalJsonString(existing),
      );
      if (result.changes !== 1) {
        throw new Error('evolution_overlay_entry_compare_and_swap_failed');
      }
      return updated;
    })();
  }

  generationHead(scope: RunManifestScope): EvolutionGenerationHeadV1 {
    const row = this.db.prepare(`
      SELECT candidate_generation, published_generation, fence, state
      FROM evolution_generation_heads
      WHERE tenant_id = ? AND workspace_id = ?
    `).get(scope.tenantId, scope.workspaceId) as
      GenerationHeadRow | undefined;
    return immutableCanonicalSnapshot({
      scope,
      candidateGeneration: row?.candidate_generation ?? null,
      publishedGeneration: row?.published_generation ?? null,
      fence: row?.fence ?? 0,
      state: row?.state ?? null,
    });
  }

  prepareGeneration(input: {
    scope: RunManifestScope;
    candidateGeneration: string;
    expectedFence: number;
    actionId?: string;
    persistedAt?: number;
  }): EvolutionGenerationRecordV1 {
    assertGeneration(input.candidateGeneration);
    return this.db.transaction(() => {
      const head = this.generationHead(input.scope);
      if (head.fence !== input.expectedFence || head.state === 'prepared') {
        throw new Error('evolution_generation_fence_conflict');
      }
      const persistedAt = input.persistedAt ?? Date.now();
      const nextFence = head.fence + 1;
      const record: EvolutionGenerationRecordV1 =
        immutableCanonicalSnapshot({
          schemaVersion: 1,
          scope: input.scope,
          candidateGeneration: input.candidateGeneration,
          publishedGeneration: head.publishedGeneration,
          fence: nextFence,
          state: 'prepared',
          ...(input.actionId ? {actionId: input.actionId} : {}),
          persistedAt,
        });
      this.db.prepare(`
        INSERT INTO evolution_generation_records (
          tenant_id, workspace_id, candidate_generation,
          fence, state, record_json
        ) VALUES (?, ?, ?, ?, 'prepared', ?)
      `).run(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        nextFence,
        canonicalJsonString(record),
      );
      this.db.prepare(`
        INSERT INTO evolution_generation_heads (
          tenant_id, workspace_id, candidate_generation,
          published_generation, fence, state
        ) VALUES (?, ?, ?, ?, ?, 'prepared')
        ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET
          candidate_generation = excluded.candidate_generation,
          fence = excluded.fence,
          state = 'prepared'
      `).run(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        head.publishedGeneration,
        nextFence,
      );
      return record;
    })();
  }

  publishGeneration(input: {
    scope: RunManifestScope;
    candidateGeneration: string;
    fence: number;
  }): EvolutionGenerationRecordV1 {
    return this.db.transaction(() => {
      const head = this.generationHead(input.scope);
      if (
        head.state !== 'prepared'
        || head.candidateGeneration !== input.candidateGeneration
        || head.fence !== input.fence
      ) {
        throw new Error('evolution_generation_publish_fence_lost');
      }
      const row = this.db.prepare(`
        SELECT record_json
        FROM evolution_generation_records
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).get(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      ) as {record_json: string} | undefined;
      if (!row) throw new Error('evolution_generation_prepared_missing');
      const prepared = JSON.parse(row.record_json) as
        EvolutionGenerationRecordV1;
      const published = immutableCanonicalSnapshot({
        ...prepared,
        publishedGeneration: input.candidateGeneration,
        state: 'published' as const,
      });
      const updated = this.db.prepare(`
        UPDATE evolution_generation_records
        SET state = 'published', record_json = ?
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).run(
        canonicalJsonString(published),
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      );
      const updatedHead = this.db.prepare(`
        UPDATE evolution_generation_heads
        SET published_generation = candidate_generation,
            state = 'published'
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).run(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      );
      if (updated.changes !== 1 || updatedHead.changes !== 1) {
        throw new Error('evolution_generation_publish_compare_and_swap_failed');
      }
      return published;
    })();
  }

  abortPreparedGeneration(input: {
    scope: RunManifestScope;
    candidateGeneration: string;
    fence: number;
  }): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT record_json
        FROM evolution_generation_records
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).get(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      ) as {record_json: string} | undefined;
      if (!row) {
        throw new Error('evolution_generation_abort_fence_lost');
      }
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      const updated = this.db.prepare(`
        UPDATE evolution_generation_records
        SET state = 'aborted',
            record_json = ?
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).run(
        canonicalJsonString({...record, state: 'aborted'}),
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      );
      const head = this.db.prepare(`
        UPDATE evolution_generation_heads
        SET state = 'aborted'
        WHERE tenant_id = ? AND workspace_id = ?
          AND candidate_generation = ? AND fence = ?
          AND state = 'prepared'
      `).run(
        input.scope.tenantId,
        input.scope.workspaceId,
        input.candidateGeneration,
        input.fence,
      );
      if (updated.changes !== 1 || head.changes !== 1) {
        throw new Error('evolution_generation_abort_fence_lost');
      }
    })();
  }

  saveReport(
    value: UpgradeReconciliationReportV1,
  ): UpgradeReconciliationReportV1 {
    const report = parseUpgradeReconciliationReportV1(value);
    this.insertImmutable(
      'evolution_reconciliation_reports',
      'report_id',
      report.reportId,
      canonicalJsonString(report),
    );
    return report;
  }

  latestReport(
    scope: RunManifestScope,
  ): UpgradeReconciliationReportV1 | undefined {
    const row = this.db.prepare(`
      SELECT artifact_json
      FROM evolution_reconciliation_reports
      WHERE tenant_id = ? AND workspace_id = ?
      ORDER BY created_at DESC, report_id DESC
      LIMIT 1
    `).get(scope.tenantId, scope.workspaceId) as
      {artifact_json: string} | undefined;
    return row
      ? parseUpgradeReconciliationReportV1(JSON.parse(row.artifact_json))
      : undefined;
  }

  saveRollbackReceipt(
    value: EvolutionRollbackReceiptV1,
  ): EvolutionRollbackReceiptV1 {
    const receipt = parseEvolutionRollbackReceiptV1(value);
    const payload = canonicalJsonString(receipt);
    const result = this.db.prepare(`
      INSERT INTO evolution_rollback_receipts (
        tenant_id, workspace_id, action_id, kind, target_id, artifact_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        tenant_id, workspace_id, action_id, kind, target_id
      ) DO NOTHING
    `).run(
      receipt.scope.tenantId,
      receipt.scope.workspaceId,
      receipt.actionId,
      receipt.kind,
      receipt.targetId,
      payload,
    );
    if (result.changes === 0) {
      const row = this.db.prepare(`
        SELECT artifact_json
        FROM evolution_rollback_receipts
        WHERE tenant_id = ? AND workspace_id = ?
          AND action_id = ? AND kind = ? AND target_id = ?
      `).get(
        receipt.scope.tenantId,
        receipt.scope.workspaceId,
        receipt.actionId,
        receipt.kind,
        receipt.targetId,
      ) as
        {artifact_json: string};
      if (row.artifact_json !== payload) {
        throw new Error('evolution_rollback_receipt_idempotency_conflict');
      }
    }
    return receipt;
  }

  listRollbackReceipts(
    scope: RunManifestScope,
    actionId: string,
  ): EvolutionRollbackReceiptV1[] {
    const rows = this.db.prepare(`
      SELECT artifact_json
      FROM evolution_rollback_receipts
      WHERE tenant_id = ? AND workspace_id = ? AND action_id = ?
      ORDER BY kind, target_id
    `).all(
      scope.tenantId,
      scope.workspaceId,
      actionId,
    ) as Array<{artifact_json: string}>;
    return rows.map(row =>
      parseEvolutionRollbackReceiptV1(JSON.parse(row.artifact_json)));
  }

  saveDegradationAlert(
    value: EvolutionDegradationAlertV1,
  ): EvolutionDegradationAlertV1 {
    const alert = parseEvolutionDegradationAlertV1(value);
    this.insertImmutable(
      'evolution_degradation_alerts',
      'alert_id',
      alert.alertId,
      canonicalJsonString(alert),
    );
    return alert;
  }

  listDegradationAlerts(
    scope: RunManifestScope,
  ): EvolutionDegradationAlertV1[] {
    const rows = this.db.prepare(`
      SELECT artifact_json
      FROM evolution_degradation_alerts
      WHERE tenant_id = ? AND workspace_id = ?
      ORDER BY created_at, alert_id
    `).all(scope.tenantId, scope.workspaceId) as
      Array<{artifact_json: string}>;
    return rows.map(row =>
      parseEvolutionDegradationAlertV1(JSON.parse(row.artifact_json)));
  }

  close(): void {
    this.db.close();
  }

  private transitionAction(
    actionId: string,
    from: 'staged',
    to: 'committed' | 'aborted',
  ): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT entry_id, entry_json
        FROM evolution_overlay_entries
        WHERE action_id = ? AND action_state = ?
        ORDER BY entry_id
      `).all(actionId, from) as Array<{
        entry_id: string;
        entry_json: string;
      }>;
      for (const row of rows) {
        const current = parseEvolutionOverlayRegistryEntryV1(
          JSON.parse(row.entry_json),
        );
        const updated = parseEvolutionOverlayRegistryEntryV1({
          ...current,
          actionState: to,
        });
        this.db.prepare(`
          UPDATE evolution_overlay_entries
          SET action_state = ?, entry_json = ?
          WHERE entry_id = ? AND action_state = ?
        `).run(to, canonicalJsonString(updated), row.entry_id, from);
      }
      return rows.length;
    })();
  }

  private insertImmutable(
    table: string,
    idColumn: string,
    id: string,
    payload: string,
  ): void {
    const value = JSON.parse(payload) as {
      scope: RunManifestScope;
      createdAt: number;
    };
    const result = this.db.prepare(`
      INSERT INTO ${table} (
        ${idColumn}, tenant_id, workspace_id, created_at, artifact_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(${idColumn}) DO NOTHING
    `).run(
      id,
      value.scope.tenantId,
      value.scope.workspaceId,
      value.createdAt,
      payload,
    );
    if (result.changes === 0) {
      const row = this.db.prepare(`
        SELECT artifact_json FROM ${table} WHERE ${idColumn} = ?
      `).get(id) as {artifact_json: string} | undefined;
      if (!row || row.artifact_json !== payload) {
        throw new Error('evolution_registry_immutable_conflict');
      }
    }
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evolution_overlay_entries (
        entry_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        overlay_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        action_state TEXT NOT NULL
          CHECK (action_state IN ('staged', 'committed', 'aborted')),
        artifact_content_hash TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        UNIQUE (tenant_id, workspace_id, overlay_id)
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_overlay_scope_state
        ON evolution_overlay_entries (
          tenant_id, workspace_id, action_state, overlay_id
        );

      CREATE TABLE IF NOT EXISTS evolution_generation_records (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        candidate_generation TEXT NOT NULL,
        fence INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('prepared', 'published', 'aborted')),
        record_json TEXT NOT NULL,
        PRIMARY KEY (
          tenant_id, workspace_id, candidate_generation, fence
        )
      );
      CREATE TABLE IF NOT EXISTS evolution_generation_heads (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        candidate_generation TEXT,
        published_generation TEXT,
        fence INTEGER NOT NULL,
        state TEXT CHECK (
          state IS NULL OR state IN ('prepared', 'published', 'aborted')
        ),
        PRIMARY KEY (tenant_id, workspace_id)
      );

      CREATE TABLE IF NOT EXISTS evolution_reconciliation_reports (
        report_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        artifact_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_reports_scope
        ON evolution_reconciliation_reports (
          tenant_id, workspace_id, created_at
        );

      CREATE TABLE IF NOT EXISTS evolution_rollback_receipts (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY (
          tenant_id, workspace_id, action_id, kind, target_id
        )
      );

      CREATE TABLE IF NOT EXISTS evolution_degradation_alerts (
        alert_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        artifact_json TEXT NOT NULL
      );
    `);
  }
}

function assertGeneration(value: string): void {
  if (
    !/^[0-9a-f]{64}$/.test(value)
    && !/^builtin:[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    throw new Error('evolution_generation_invalid');
  }
}

function sameImmutableEntryBinding(
  left: EvolutionOverlayRegistryEntryV1,
  right: EvolutionOverlayRegistryEntryV1,
): boolean {
  return left.entryId === right.entryId
    && left.overlayId === right.overlayId
    && left.overlayKind === right.overlayKind
    && left.scope.tenantId === right.scope.tenantId
    && left.scope.workspaceId === right.scope.workspaceId
    && left.proposalId === right.proposalId
    && left.proposalRevision === right.proposalRevision
    && left.artifactContentHash === right.artifactContentHash
    && left.actionId === right.actionId
    && canonicalJsonString(provenanceBinding(left.provenance))
      === canonicalJsonString(provenanceBinding(right.provenance));
}

function provenanceBinding(provenance: EvolutionOverlayProvenanceV1) {
  const {
    validation: _validation,
    reconciledAt: _reconciledAt,
    ...binding
  } = provenance;
  return binding;
}

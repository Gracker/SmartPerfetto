// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';
import os from 'os';
import type Database from 'better-sqlite3';

export type ProviderMutationScopeLevel =
  | 'local'
  | 'org'
  | 'workspace'
  | 'personal';

export interface ProviderMutationScope {
  level: ProviderMutationScopeLevel;
  tenantId: string;
  workspaceId: string | null;
  userId: string | null;
}

export interface ProviderMutationOwner {
  instanceId: string;
  pid: number;
  host: string;
}

export interface ProviderMutationLease {
  mutationId: string;
  scope: ProviderMutationScope;
  owner: ProviderMutationOwner;
  startedAt: number;
}

export interface ProviderMutationGenerationEntry {
  scope: ProviderMutationScope;
  revision: number;
  inFlight: number;
}

export interface ProviderMutationGenerationVectorV1 {
  schemaVersion: 1;
  entries: ProviderMutationGenerationEntry[];
}

interface RevisionRow {
  revision: number;
}

interface LeaseRow {
  mutation_id: string;
  scope_key: string;
  owner_instance_id: string;
  owner_pid: number;
  owner_host: string;
  started_at: number;
}

export interface ProviderMutationGenerationStoreOptions {
  openDatabase: () => Database.Database;
  ensureSchema?: boolean;
  now?: () => number;
  hostName?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

function scopeKey(scope: ProviderMutationScope): string {
  return JSON.stringify([
    scope.level,
    scope.tenantId,
    scope.workspaceId,
    scope.userId,
  ]);
}

function sameScope(
  left: ProviderMutationScope,
  right: ProviderMutationScope,
): boolean {
  return left.level === right.level
    && left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId
    && left.userId === right.userId;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function assertRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('provider_mutation_revision_invalid');
  }
  return value;
}

export function localProviderMutationScope(): ProviderMutationScope {
  return {
    level: 'local',
    tenantId: 'local',
    workspaceId: null,
    userId: null,
  };
}

export function providerMutationRequestScopes(input: {
  tenantId: string;
  workspaceId: string;
  userId: string | null;
}): ProviderMutationScope[] {
  return [
    {
      level: 'org',
      tenantId: input.tenantId,
      workspaceId: null,
      userId: null,
    },
    {
      level: 'workspace',
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId: null,
    },
    ...(input.userId
      ? [{
          level: 'personal' as const,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: input.userId,
        }]
      : []),
  ];
}

export class ProviderMutationGenerationStore {
  private readonly openDatabase: () => Database.Database;
  private readonly ensureSchema: boolean;
  private readonly now: () => number;
  private readonly hostName: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: ProviderMutationGenerationStoreOptions) {
    this.openDatabase = options.openDatabase;
    this.ensureSchema = options.ensureSchema ?? false;
    this.now = options.now ?? Date.now;
    this.hostName = options.hostName ?? os.hostname;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  beginMutation(
    scope: ProviderMutationScope,
    owner: ProviderMutationOwner,
  ): ProviderMutationLease {
    const lease: ProviderMutationLease = {
      mutationId: randomUUID(),
      scope: {...scope},
      owner: {...owner},
      startedAt: this.now(),
    };
    const db = this.db();
    try {
      const begin = db.transaction(() => {
        this.ensureRevisionRow(db, scope, lease.startedAt);
        this.incrementRevision(db, scope, lease.startedAt);
        db.prepare(`
          INSERT INTO provider_mutation_leases (
            mutation_id,
            scope_key,
            owner_instance_id,
            owner_pid,
            owner_host,
            started_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          lease.mutationId,
          scopeKey(scope),
          owner.instanceId,
          owner.pid,
          owner.host,
          lease.startedAt,
        );
      });
      begin.immediate();
      return lease;
    } finally {
      db.close();
    }
  }

  completeMutation(lease: ProviderMutationLease): void {
    const completedAt = this.now();
    const db = this.db();
    try {
      const complete = db.transaction(() => {
        const row = this.getLeaseRow(db, lease.mutationId);
        if (
          !row
          || row.owner_instance_id !== lease.owner.instanceId
          || row.owner_pid !== lease.owner.pid
          || row.owner_host !== lease.owner.host
          || row.scope_key !== scopeKey(lease.scope)
        ) {
          throw new Error('provider_mutation_lease_not_owned');
        }
        const deleted = db.prepare(`
          DELETE FROM provider_mutation_leases
          WHERE mutation_id = ?
        `).run(lease.mutationId);
        if (deleted.changes !== 1) {
          throw new Error('provider_mutation_lease_not_owned');
        }
        this.incrementRevision(db, lease.scope, completedAt);
      });
      complete.immediate();
    } finally {
      db.close();
    }
  }

  readVector(
    scopes: readonly ProviderMutationScope[],
  ): ProviderMutationGenerationVectorV1 {
    const db = this.db();
    try {
      const read = db.transaction(() => ({
        schemaVersion: 1 as const,
        entries: scopes.map(scope => {
          const key = scopeKey(scope);
          const revision = db.prepare<[string], RevisionRow>(`
            SELECT revision
            FROM provider_mutation_revisions
            WHERE scope_key = ?
          `).get(key)?.revision ?? 0;
          const inFlight = db.prepare<[string], {count: number}>(`
            SELECT COUNT(*) AS count
            FROM provider_mutation_leases
            WHERE scope_key = ?
          `).get(key)?.count ?? 0;
          return {
            scope: {...scope},
            revision: assertRevision(revision),
            inFlight: assertRevision(inFlight),
          };
        }),
      }));
      return read();
    } finally {
      db.close();
    }
  }

  listInFlight(
    scopes: readonly ProviderMutationScope[],
  ): ProviderMutationLease[] {
    if (scopes.length === 0) return [];
    const scopeByKey = new Map(scopes.map(scope => [scopeKey(scope), scope]));
    const placeholders = scopes.map(() => '?').join(', ');
    const db = this.db();
    try {
      const rows = db.prepare(`
        SELECT *
        FROM provider_mutation_leases
        WHERE scope_key IN (${placeholders})
        ORDER BY started_at, mutation_id
      `).all(...scopeByKey.keys()) as LeaseRow[];
      return rows.map(row => {
        const scope = scopeByKey.get(row.scope_key);
        if (!scope) throw new Error('provider_mutation_scope_missing');
        return this.leaseFromRow(row, scope);
      });
    } finally {
      db.close();
    }
  }

  recoverAbandonedMutation(
    mutationId: string,
    expectedScope: ProviderMutationScope,
  ): boolean {
    const db = this.db();
    try {
      const row = this.getLeaseRow(db, mutationId);
      if (!row) return false;
      if (row.scope_key !== scopeKey(expectedScope)) {
        throw new Error('provider_mutation_recovery_scope_mismatch');
      }
      if (row.owner_host !== this.hostName()) {
        throw new Error('provider_mutation_owner_liveness_unconfirmed');
      }
      if (this.isProcessAlive(row.owner_pid)) {
        throw new Error('provider_mutation_owner_still_alive');
      }
      const recoveredAt = this.now();
      const recover = db.transaction(() => {
        const current = this.getLeaseRow(db, mutationId);
        if (!current) return false;
        if (
          current.scope_key !== row.scope_key
          || current.owner_instance_id !== row.owner_instance_id
          || current.owner_pid !== row.owner_pid
          || current.owner_host !== row.owner_host
        ) {
          throw new Error('provider_mutation_lease_changed');
        }
        const deleted = db.prepare(`
          DELETE FROM provider_mutation_leases
          WHERE mutation_id = ?
        `).run(mutationId);
        if (deleted.changes !== 1) return false;
        this.incrementRevision(db, expectedScope, recoveredAt);
        return true;
      });
      return recover.immediate();
    } finally {
      db.close();
    }
  }

  private db(): Database.Database {
    const db = this.openDatabase();
    db.pragma('busy_timeout = 5000');
    if (this.ensureSchema) {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_mutation_revisions (
          scope_key TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          owner_user_id TEXT,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_mutation_revisions_scope
          ON provider_mutation_revisions(tenant_id, workspace_id, owner_user_id);

        CREATE TABLE IF NOT EXISTS provider_mutation_leases (
          mutation_id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          owner_host TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          FOREIGN KEY (scope_key) REFERENCES provider_mutation_revisions(scope_key) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_provider_mutation_leases_scope
          ON provider_mutation_leases(scope_key, started_at);
      `);
    }
    return db;
  }

  private ensureRevisionRow(
    db: Database.Database,
    scope: ProviderMutationScope,
    updatedAt: number,
  ): void {
    db.prepare(`
      INSERT OR IGNORE INTO provider_mutation_revisions (
        scope_key,
        tenant_id,
        workspace_id,
        owner_user_id,
        revision,
        updated_at
      ) VALUES (?, ?, ?, ?, 0, ?)
    `).run(
      scopeKey(scope),
      scope.tenantId,
      scope.workspaceId,
      scope.userId,
      updatedAt,
    );
  }

  private incrementRevision(
    db: Database.Database,
    scope: ProviderMutationScope,
    updatedAt: number,
  ): void {
    this.ensureRevisionRow(db, scope, updatedAt);
    const result = db.prepare(`
      UPDATE provider_mutation_revisions
      SET revision = revision + 1, updated_at = ?
      WHERE scope_key = ? AND revision < ?
    `).run(updatedAt, scopeKey(scope), Number.MAX_SAFE_INTEGER);
    if (result.changes !== 1) {
      throw new Error('provider_mutation_revision_exhausted');
    }
  }

  private getLeaseRow(
    db: Database.Database,
    mutationId: string,
  ): LeaseRow | undefined {
    return db.prepare<[string], LeaseRow>(`
      SELECT *
      FROM provider_mutation_leases
      WHERE mutation_id = ?
    `).get(mutationId);
  }

  private leaseFromRow(
    row: LeaseRow,
    scope: ProviderMutationScope,
  ): ProviderMutationLease {
    return {
      mutationId: row.mutation_id,
      scope: {...scope},
      owner: {
        instanceId: row.owner_instance_id,
        pid: row.owner_pid,
        host: row.owner_host,
      },
      startedAt: row.started_at,
    };
  }
}

export const __testing = {
  sameScope,
  scopeKey,
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  RunManifestScope,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {canonicalJsonString, immutableCanonicalSnapshot} from './canonicalJson';
import {getSelfEvolutionLifecycleSnapshot} from './selfEvolutionLifecycle';

export interface RunManifestStoreOptions {
  persistence: SelfEvolutionPersistenceCapability;
  databasePath?: string;
  ephemeralCapacity?: number;
  openDatabase?: (databasePath: string) => Database.Database;
  onDiagnostic?: (code: string, details?: Record<string, unknown>) => void;
}

export interface AppendRunManifestResult {
  manifest: RunManifestV1;
  storage: 'sqlite' | 'ephemeral';
  idempotent: boolean;
}

const DEFAULT_EPHEMERAL_CAPACITY = 256;

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function manifestKey(scope: RunManifestScope, runManifestId: string): string {
  return `${scopeKey(scope)}\0${runManifestId}`;
}

function runKey(scope: RunManifestScope, runId: string): string {
  return `${scopeKey(scope)}\0${runId}`;
}

function parseManifest(payload: string): RunManifestV1 {
  return immutableCanonicalSnapshot(JSON.parse(payload) as RunManifestV1);
}

export class RunManifestStore {
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly databasePath: string;
  private readonly ephemeralCapacity: number;
  private readonly openDatabase: NonNullable<RunManifestStoreOptions['openDatabase']>;
  private readonly onDiagnostic?: RunManifestStoreOptions['onDiagnostic'];
  private readonly ephemeralById = new Map<string, string>();
  private readonly ephemeralIdByRun = new Map<string, string>();
  private readonly activeEphemeralIds = new Set<string>();
  private database: Database.Database | undefined;

  constructor(options: RunManifestStoreOptions) {
    this.persistence = options.persistence;
    this.databasePath = options.databasePath
      ?? userDataPath('self_improve', 'run_manifests.db');
    this.ephemeralCapacity = Math.max(
      1,
      options.ephemeralCapacity ?? DEFAULT_EPHEMERAL_CAPACITY,
    );
    this.openDatabase = options.openDatabase ?? (databasePath => new Database(databasePath));
    this.onDiagnostic = options.onDiagnostic;
  }

  get storageMode(): 'sqlite' | 'ephemeral' {
    return this.persistence.persistence === 'available'
      ? 'sqlite'
      : 'ephemeral';
  }

  append(scope: RunManifestScope, manifest: RunManifestV1): AppendRunManifestResult {
    this.assertScope(scope, manifest.scope);
    const payload = canonicalJsonString(manifest);
    return this.storageMode === 'sqlite'
      ? this.appendSqlite(scope, manifest, payload)
      : this.appendEphemeral(scope, manifest, payload);
  }

  get(scope: RunManifestScope, runManifestId: string): RunManifestV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT manifest_json AS manifestJson
        FROM run_manifests
        WHERE tenant_id = ? AND workspace_id = ? AND run_manifest_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        runManifestId,
      ) as {manifestJson: string} | undefined;
      return row ? parseManifest(row.manifestJson) : undefined;
    }
    const key = manifestKey(scope, runManifestId);
    const payload = this.ephemeralById.get(key);
    if (!payload) return undefined;
    this.touchEphemeral(key, payload);
    return parseManifest(payload);
  }

  getByRunId(scope: RunManifestScope, runId: string): RunManifestV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT manifest_json AS manifestJson
        FROM run_manifests
        WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        runId,
      ) as {manifestJson: string} | undefined;
      return row ? parseManifest(row.manifestJson) : undefined;
    }
    const id = this.ephemeralIdByRun.get(runKey(scope, runId));
    return id ? this.get(scope, id) : undefined;
  }

  pin(scope: RunManifestScope, runManifestId: string): void {
    if (this.storageMode !== 'ephemeral') return;
    this.activeEphemeralIds.add(manifestKey(scope, runManifestId));
  }

  unpin(scope: RunManifestScope, runManifestId: string): void {
    if (this.storageMode !== 'ephemeral') return;
    this.activeEphemeralIds.delete(manifestKey(scope, runManifestId));
    this.evictEphemeralIfNeeded();
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private appendSqlite(
    scope: RunManifestScope,
    manifest: RunManifestV1,
    payload: string,
  ): AppendRunManifestResult {
    const database = this.db();
    const append = database.transaction(() => {
      const existingById = database.prepare(`
        SELECT manifest_json AS manifestJson
        FROM run_manifests
        WHERE run_manifest_id = ?
      `).get(manifest.runManifestId) as {manifestJson: string} | undefined;
      if (existingById) {
        if (existingById.manifestJson !== payload) {
          throw new Error(
            `run_manifest_append_conflict:${manifest.runManifestId}`,
          );
        }
        return true;
      }
      const existingByRun = database.prepare(`
        SELECT run_manifest_id AS runManifestId, manifest_json AS manifestJson
        FROM run_manifests
        WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        manifest.runId,
      ) as {runManifestId: string; manifestJson: string} | undefined;
      if (existingByRun) {
        if (
          existingByRun.runManifestId !== manifest.runManifestId ||
          existingByRun.manifestJson !== payload
        ) {
          throw new Error(
            `run_manifest_run_conflict:${scope.tenantId}:${scope.workspaceId}:${manifest.runId}`,
          );
        }
        return true;
      }
      database.prepare(`
        INSERT INTO run_manifests (
          run_manifest_id,
          tenant_id,
          workspace_id,
          run_id,
          session_id,
          sealed_at,
          manifest_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifest.runManifestId,
        scope.tenantId,
        scope.workspaceId,
        manifest.runId,
        manifest.sessionId,
        manifest.sealedAt,
        payload,
      );
      return false;
    });
    const idempotent = append();
    return {
      manifest,
      storage: 'sqlite',
      idempotent,
    };
  }

  private appendEphemeral(
    scope: RunManifestScope,
    manifest: RunManifestV1,
    payload: string,
  ): AppendRunManifestResult {
    const key = manifestKey(scope, manifest.runManifestId);
    const existing = this.ephemeralById.get(key);
    if (existing) {
      if (existing !== payload) {
        throw new Error(`run_manifest_append_conflict:${manifest.runManifestId}`);
      }
      this.touchEphemeral(key, existing);
      return {manifest, storage: 'ephemeral', idempotent: true};
    }
    const scopedRunKey = runKey(scope, manifest.runId);
    const existingId = this.ephemeralIdByRun.get(scopedRunKey);
    if (existingId && existingId !== manifest.runManifestId) {
      throw new Error(
        `run_manifest_run_conflict:${scope.tenantId}:${scope.workspaceId}:${manifest.runId}`,
      );
    }
    this.ephemeralById.set(key, payload);
    this.ephemeralIdByRun.set(scopedRunKey, manifest.runManifestId);
    this.onDiagnostic?.('run_manifest_ephemeral', {
      runManifestId: manifest.runManifestId,
      reason: this.persistence.reason,
    });
    this.evictEphemeralIfNeeded();
    return {manifest, storage: 'ephemeral', idempotent: false};
  }

  private touchEphemeral(key: string, payload: string): void {
    this.ephemeralById.delete(key);
    this.ephemeralById.set(key, payload);
  }

  private evictEphemeralIfNeeded(): void {
    if (this.ephemeralById.size <= this.ephemeralCapacity) return;
    for (const [key, payload] of this.ephemeralById) {
      if (this.ephemeralById.size <= this.ephemeralCapacity) break;
      if (this.activeEphemeralIds.has(key)) continue;
      const manifest = JSON.parse(payload) as RunManifestV1;
      this.ephemeralById.delete(key);
      this.ephemeralIdByRun.delete(runKey(manifest.scope, manifest.runId));
    }
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    if (this.persistence.persistence !== 'available') {
      throw new Error('run_manifest_sqlite_persistence_unavailable');
    }
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = this.openDatabase(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_manifests (
        run_manifest_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sealed_at INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        UNIQUE (tenant_id, workspace_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_manifests_scope_session
        ON run_manifests (tenant_id, workspace_id, session_id, sealed_at);
    `);
    return this.database;
  }

  private assertScope(
    expected: RunManifestScope,
    actual: RunManifestScope,
  ): void {
    if (
      expected.tenantId !== actual.tenantId ||
      expected.workspaceId !== actual.workspaceId
    ) {
      throw new Error('run_manifest_scope_mismatch');
    }
  }
}

let defaultStore: RunManifestStore | undefined;
let defaultStoreKey: string | undefined;

export function getRunManifestStore(): RunManifestStore {
  const persistence = getSelfEvolutionLifecycleSnapshot().persistence;
  const key = canonicalJsonString({
    persistence: persistence.persistence,
    reason: persistence.reason ?? null,
    dataRoot: persistence.dataRoot,
  });
  if (!defaultStore || defaultStoreKey !== key) {
    defaultStore?.close();
    defaultStore = new RunManifestStore({persistence});
    defaultStoreKey = key;
  }
  return defaultStore;
}

export function resetRunManifestStoreForTests(): void {
  defaultStore?.close();
  defaultStore = undefined;
  defaultStoreKey = undefined;
}

export const __testing = {
  DEFAULT_EPHEMERAL_CAPACITY,
  manifestKey,
  runKey,
  scopeKey,
};

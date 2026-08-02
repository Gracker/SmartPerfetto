// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import {
  applyEnterpriseMinimalSchema,
  ENTERPRISE_CORE_SCHEMA_TABLES,
} from '../enterpriseSchema';

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all();
  return new Set(rows.map(row => row.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map(row => row.name));
}

function indexNames(db: Database.Database): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `).all();
  return new Set(rows.map(row => row.name));
}

function expectColumns(db: Database.Database, table: string, columns: string[]): void {
  expect([...columnNames(db, table)]).toEqual(expect.arrayContaining(columns));
}

function seedCoreGraph(db: Database.Database, now = Date.now()): void {
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES ('user-a', 'tenant-a', 'a@example.test', 'User A', 'oidc|a', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
    VALUES ('tenant-a', 'workspace-a', 'user-a', 'admin', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, created_at)
    VALUES
      ('trace-a', 'tenant-a', 'workspace-a', 'user-a', '/tmp/trace-a.pftrace', 'abc123', 1024, 'ready', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO provider_snapshots
      (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
    VALUES
      ('provider-snapshot-a', 'tenant-a', 'provider-a', 'hash-a', 'openai-agents-sdk', '{"models":{}}', 'v1', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id, visibility, status, created_at, updated_at)
    VALUES
      ('session-a', 'tenant-a', 'workspace-a', 'trace-a', 'user-a', 'provider-snapshot-a', 'private', 'running', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
    VALUES
      ('run-a', 'tenant-a', 'workspace-a', 'session-a', 'full', 'running', 'analyze', ?)
  `).run(now);
}

describe('enterprise core schema', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('creates the §10.2 core enterprise tables and key columns', () => {
    applyEnterpriseMinimalSchema(db!);

    const tables = tableNames(db!);
    for (const table of ENTERPRISE_CORE_SCHEMA_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
    expect(tables.has('enterprise_schema_migrations')).toBe(true);
    expect(tables.has('sso_sessions')).toBe(true);
    expectColumns(db!, 'sso_personal_workspaces', [
      'tenant_id',
      'user_id',
      'workspace_id',
      'created_at',
    ]);
    expectColumns(db!, 'sso_tenant_admin_grants', [
      'tenant_id',
      'user_id',
      'source',
      'created_at',
      'updated_at',
    ]);

    expectColumns(db!, 'organizations', [
      'id',
      'name',
      'status',
      'plan',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'workspaces', [
      'id',
      'tenant_id',
      'name',
      'retention_policy',
      'quota_policy',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'users', [
      'id',
      'tenant_id',
      'email',
      'display_name',
      'idp_subject',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'memberships', [
      'tenant_id',
      'workspace_id',
      'user_id',
      'role',
      'created_at',
    ]);
    expectColumns(db!, 'api_keys', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'key_hash',
      'scopes',
      'expires_at',
      'revoked_at',
    ]);
    expectColumns(db!, 'trace_assets', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'local_path',
      'sha256',
      'size_bytes',
      'status',
      'metadata_json',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'trace_processor_leases', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'mode',
      'state',
      'rss_bytes',
      'heartbeat_at',
      'expires_at',
    ]);
    expectColumns(db!, 'trace_processor_holders', [
      'id',
      'lease_id',
      'holder_type',
      'holder_ref',
      'window_id',
      'heartbeat_at',
      'expires_at',
      'created_at',
      'metadata_json',
    ]);
    expectColumns(db!, 'analysis_sessions', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'created_by',
      'provider_snapshot_id',
      'title',
      'visibility',
      'status',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'analysis_runs', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'mode',
      'status',
      'question',
      'started_at',
      'completed_at',
      'heartbeat_at',
      'updated_at',
      'error_json',
    ]);
    expectColumns(db!, 'conversation_turns', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'role',
      'content_json',
      'created_at',
    ]);
    expectColumns(db!, 'agent_events', [
      'id',
      'tenant_id',
      'workspace_id',
      'run_id',
      'cursor',
      'event_type',
      'payload_json',
      'created_at',
    ]);
    expectColumns(db!, 'analysis_result_snapshots', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'session_id',
      'run_id',
      'report_id',
      'created_by',
      'visibility',
      'scene_type',
      'title',
      'user_query',
      'trace_label',
      'trace_metadata_json',
      'summary_json',
      'conclusion_contract_json',
      'claim_support_json',
      'claim_verification_json',
      'identity_resolutions_json',
      'status',
      'schema_version',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'analysis_result_metrics', [
      'id',
      'snapshot_id',
      'metric_key',
      'metric_group',
      'label',
      'value_json',
      'numeric_value',
      'unit',
      'direction',
      'aggregation',
      'confidence',
      'missing_reason',
      'source_json',
    ]);
    expectColumns(db!, 'analysis_result_evidence_refs', [
      'id',
      'snapshot_id',
      'ref_type',
      'ref_json',
      'created_at',
    ]);
    expectColumns(db!, 'analysis_result_window_states', [
      'tenant_id',
      'workspace_id',
      'window_id',
      'user_id',
      'trace_id',
      'backend_trace_id',
      'active_session_id',
      'latest_snapshot_id',
      'trace_title',
      'scene_type',
      'metadata_json',
      'updated_at',
      'expires_at',
    ]);
    expectColumns(db!, 'multi_trace_comparison_runs', [
      'id',
      'tenant_id',
      'workspace_id',
      'created_by',
      'baseline_snapshot_id',
      'query',
      'status',
      'result_json',
      'report_id',
      'error',
      'schema_version',
      'created_at',
      'completed_at',
    ]);
    expectColumns(db!, 'multi_trace_comparison_inputs', [
      'comparison_id',
      'snapshot_id',
      'role',
      'ordinal',
    ]);
    expectColumns(db!, 'runtime_snapshots', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'runtime_type',
      'snapshot_json',
      'created_at',
    ]);
    expectColumns(db!, 'provider_credentials', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'scope',
      'name',
      'type',
      'models_json',
      'secret_ref',
      'policy_json',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'provider_mutation_revisions', [
      'scope_key',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'revision',
      'updated_at',
    ]);
    expectColumns(db!, 'provider_mutation_leases', [
      'mutation_id',
      'scope_key',
      'owner_instance_id',
      'owner_pid',
      'owner_host',
      'started_at',
    ]);
    expectColumns(db!, 'provider_snapshots', [
      'id',
      'tenant_id',
      'provider_id',
      'snapshot_hash',
      'runtime_kind',
      'resolved_config_json',
      'secret_version',
      'created_at',
    ]);
    expectColumns(db!, 'report_artifacts', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'local_path',
      'content_hash',
      'visibility',
      'created_by',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'memory_entries', [
      'id',
      'tenant_id',
      'workspace_id',
      'scope',
      'source_run_id',
      'content_json',
      'embedding_ref',
      'rag_registry_origin',
      'rag_codebase_id',
      'rag_knowledge_source_id',
      'rag_source_generation',
      'rag_scope_fingerprint',
      'rag_unsupported_reason',
      'rag_vendor',
      'rag_build_id',
      'rag_language',
      'rag_symbol',
      'rag_lookup_path',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'skill_registry_entries', [
      'id',
      'tenant_id',
      'workspace_id',
      'scope',
      'version',
      'enabled',
      'source_path',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'tenant_tombstones', [
      'tenant_id',
      'requested_by',
      'requested_at',
      'purge_after',
      'status',
      'proof_hash',
    ]);
    expectColumns(db!, 'audit_events', [
      'id',
      'tenant_id',
      'workspace_id',
      'actor_user_id',
      'action',
      'resource_type',
      'resource_id',
      'metadata_json',
      'created_at',
    ]);
  });

  test('creates owner-guard, replay, migration, audit, and tombstone indexes', () => {
    applyEnterpriseMinimalSchema(db!);

    const indexes = indexNames(db!);
    for (const index of [
      'idx_trace_assets_owner_guard',
      'idx_trace_assets_tenant_workspace_id_unique',
      'idx_trace_processor_leases_owner_guard',
      'idx_trace_processor_leases_trace',
      'idx_trace_processor_holders_lease',
      'idx_trace_processor_holders_expiry',
      'idx_analysis_sessions_owner_guard',
      'idx_analysis_sessions_tenant_workspace_id_unique',
      'idx_analysis_runs_status',
      'idx_analysis_runs_heartbeat',
      'idx_analysis_runs_tenant_workspace_id_unique',
      'idx_conversation_turns_session',
      'idx_conversation_turns_run',
      'idx_agent_events_replay',
      'idx_agent_events_owner_guard',
      'idx_analysis_result_snapshots_trace',
      'idx_analysis_result_snapshots_scene',
      'idx_analysis_result_snapshots_visibility',
      'idx_analysis_result_snapshots_owner_guard',
      'idx_analysis_result_snapshots_run',
      'idx_analysis_result_metrics_snapshot',
      'idx_analysis_result_metrics_key',
      'idx_analysis_result_evidence_refs_snapshot',
      'idx_analysis_result_window_states_workspace',
      'idx_analysis_result_window_states_trace',
      'idx_analysis_result_window_states_snapshot',
      'idx_multi_trace_comparison_runs_workspace',
      'idx_multi_trace_comparison_runs_status',
      'idx_multi_trace_comparison_inputs_snapshot',
      'idx_runtime_snapshots_session',
      'idx_runtime_snapshots_run',
      'idx_provider_credentials_scope',
      'idx_provider_credentials_owner',
      'idx_provider_snapshots_provider',
      'idx_report_artifacts_owner_guard',
      'idx_report_artifacts_session',
      'idx_memory_entries_scope',
      'idx_memory_entries_rag_codebase_generation',
      'idx_memory_entries_rag_source_generation',
      'idx_memory_entries_rag_symbol',
      'idx_memory_entries_rag_path',
      'idx_skill_registry_entries_scope',
      'idx_audit_events_tenant_time',
      'idx_audit_events_actor',
      'idx_tenant_tombstones_status',
      'idx_sso_sessions_user',
      'idx_sso_sessions_expiry',
      'idx_api_keys_scope',
      'idx_api_keys_owner',
      'idx_api_keys_expiry',
      'idx_sso_personal_workspaces_workspace',
      'idx_sso_tenant_admin_grants_user',
    ]) {
      expect(indexes.has(index)).toBe(true);
    }
  });

  test('backfills an existing large RAG store through bounded migration batches', () => {
    db!.exec(`
      CREATE TABLE enterprise_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_run_id TEXT,
        content_json TEXT NOT NULL,
        embedding_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const markMigration = db!.prepare(`
      INSERT INTO enterprise_schema_migrations(version, applied_at) VALUES (?, 1)
    `);
    for (let version = 1; version <= 13; version += 1) markMigration.run(version);

    const insert = db!.prepare(`
      INSERT INTO memory_entries(
        id, tenant_id, workspace_id, scope, content_json, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'workspace-a', 'rag:app_source', ?, 1, 1)
    `);
    const seed = db!.transaction(() => {
      for (let index = 0; index < 1_505; index += 1) {
        insert.run(`legacy-rag-${index}`, JSON.stringify({
          kind: 'rag_chunk',
          record: {
            chunkId: `legacy-rag-${index}`,
            kind: 'app_source',
            registryOrigin: 'codebase_registry',
            codebaseId: 'legacy-codebase',
            sourceGeneration: 'codebase_7',
            knowledgeScopeFingerprint: 'legacy-fingerprint',
            filePath: `src/my_app/File${index}.ts`,
            snippet: `legacy migration token ${index}`,
          },
        }));
      }
    });
    seed();

    applyEnterpriseMinimalSchema(db!);

    const materialized = db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count
      FROM memory_entries
      WHERE rag_codebase_id = 'legacy-codebase'
        AND rag_source_generation = 'codebase_7'
        AND rag_lookup_path LIKE 'src/my\\_app/%' ESCAPE '\\'
    `).get()?.count;
    const indexed = db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count
      FROM rag_knowledge_fts
      WHERE rag_knowledge_fts MATCH 'legacy AND migration'
    `).get()?.count;
    expect(materialized).toBe(1_505);
    expect(indexed).toBe(1_505);
  });

  test('resumes the RAG backfill from its last atomic checkpoint after interruption', () => {
    db!.exec(`
      CREATE TABLE enterprise_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_run_id TEXT,
        content_json TEXT NOT NULL,
        embedding_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const markMigration = db!.prepare(`
      INSERT INTO enterprise_schema_migrations(version, applied_at) VALUES (?, 1)
    `);
    for (let version = 1; version <= 13; version += 1) markMigration.run(version);
    const insert = db!.prepare(`
      INSERT INTO memory_entries(
        id, tenant_id, workspace_id, scope, content_json, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'workspace-a', 'rag:app_source', ?, 1, 1)
    `);
    const seed = db!.transaction(() => {
      for (let index = 0; index < 600; index += 1) {
        insert.run(`resume-rag-${index}`, JSON.stringify({
          kind: 'rag_chunk',
          record: {
            chunkId: `resume-rag-${index}`,
            kind: 'app_source',
            registryOrigin: 'codebase_registry',
            codebaseId: 'resume-codebase',
            sourceGeneration: 'codebase_9',
            filePath: `src/File${index}.ts`,
            snippet: `resume checkpoint token ${index}`,
          },
        }));
      }
    });
    seed();
    db!.exec(`
      CREATE TRIGGER interrupt_rag_backfill
      BEFORE UPDATE OF rag_registry_origin ON memory_entries
      WHEN NEW.rowid > 250
      BEGIN
        SELECT RAISE(ABORT, 'simulated backfill interruption');
      END;
    `);

    expect(() => applyEnterpriseMinimalSchema(db!))
      .toThrow('simulated backfill interruption');
    expect(db!.prepare<unknown[], {cursor: number}>(`
      SELECT cursor FROM enterprise_schema_backfill_progress WHERE migration_version = 14
    `).get()?.cursor).toBe(250);
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM memory_entries WHERE rag_codebase_id = 'resume-codebase'
    `).get()?.count).toBe(250);
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM enterprise_schema_migrations WHERE version = 14
    `).get()?.count).toBe(0);

    db!.exec('DROP TRIGGER interrupt_rag_backfill');
    applyEnterpriseMinimalSchema(db!);

    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM memory_entries WHERE rag_codebase_id = 'resume-codebase'
    `).get()?.count).toBe(600);
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM rag_knowledge_fts WHERE entry_id LIKE 'resume-rag-%'
    `).get()?.count).toBe(600);
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM enterprise_schema_migrations WHERE version = 14
    `).get()?.count).toBe(1);
  });

  test('keeps legacy rolling-deploy RAG writes materialized and indexed', () => {
    db!.exec(`
      CREATE TABLE enterprise_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_run_id TEXT,
        content_json TEXT NOT NULL,
        embedding_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const markMigration = db!.prepare(`
      INSERT INTO enterprise_schema_migrations(version, applied_at) VALUES (?, 1)
    `);
    for (let version = 1; version <= 13; version += 1) markMigration.run(version);
    applyEnterpriseMinimalSchema(db!);

    const legacyInsert = db!.prepare(`
      INSERT INTO memory_entries(
        id, tenant_id, workspace_id, scope, content_json, created_at, updated_at
      ) VALUES (
        'rolling-rag', 'tenant-a', 'workspace-a', 'rag:app_source', ?, 1, 1
      )
    `);
    legacyInsert.run(JSON.stringify({
      kind: 'rag_chunk',
      record: {
        registryOrigin: 'codebase_registry',
        codebaseId: 'rolling-codebase',
        sourceGeneration: 'generation-1',
        filePath: 'src/LegacyWriter.kt',
        symbol: 'LegacyWriter.start',
        snippet: 'rolling deploy compatibility token',
      },
    }));

    expect(db!.prepare<unknown[], {
      rag_codebase_id: string;
      rag_source_generation: string;
      rag_lookup_path: string;
    }>(`
      SELECT rag_codebase_id, rag_source_generation, rag_lookup_path
      FROM memory_entries WHERE id = 'rolling-rag'
    `).get()).toEqual({
      rag_codebase_id: 'rolling-codebase',
      rag_source_generation: 'generation-1',
      rag_lookup_path: 'src/LegacyWriter.kt',
    });
    expect(db!.prepare<unknown[], {state: string}>(`
      SELECT rag_index_state AS state FROM memory_entries WHERE id = 'rolling-rag'
    `).get()?.state).toBe('legacy_pending');
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM rag_knowledge_fts WHERE entry_id = 'rolling-rag'
    `).get()?.count).toBe(0);

    db!.prepare(`
      UPDATE memory_entries SET content_json = ?, updated_at = 2
      WHERE id = 'rolling-rag'
    `).run(JSON.stringify({
      kind: 'rag_chunk',
      record: {
        registryOrigin: 'codebase_registry',
        codebaseId: 'rolling-codebase',
        sourceGeneration: 'generation-2',
        filePath: 'src/UpdatedWriter.kt',
        snippet: 'updated compatibility token',
      },
    }));
    expect(db!.prepare<unknown[], {
      rag_source_generation: string;
      rag_lookup_path: string;
    }>(`
      SELECT rag_source_generation, rag_lookup_path
      FROM memory_entries WHERE id = 'rolling-rag'
    `).get()).toEqual({
      rag_source_generation: 'generation-2',
      rag_lookup_path: 'src/UpdatedWriter.kt',
    });
    expect(db!.prepare<unknown[], {state: string}>(`
      SELECT rag_index_state AS state FROM memory_entries WHERE id = 'rolling-rag'
    `).get()?.state).toBe('legacy_pending');
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM rag_knowledge_fts WHERE entry_id = 'rolling-rag'
    `).get()?.count).toBe(0);

    db!.prepare("DELETE FROM memory_entries WHERE id = 'rolling-rag'").run();
    expect(db!.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM rag_knowledge_fts WHERE entry_id = 'rolling-rag'
    `).get()?.count).toBe(0);
  });

  test('requires an explicit maintenance restart for large blocking index builds', () => {
    db!.exec(`
      CREATE TABLE enterprise_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_run_id TEXT,
        content_json TEXT NOT NULL,
        embedding_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const markMigration = db!.prepare(`
      INSERT INTO enterprise_schema_migrations(version, applied_at) VALUES (?, 1)
    `);
    for (let version = 1; version <= 13; version += 1) markMigration.run(version);
    const insert = db!.prepare(`
      INSERT INTO memory_entries(
        id, tenant_id, workspace_id, scope, content_json, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'workspace-a', 'workspace', '{}', 1, 1)
    `);
    insert.run('row-1');
    insert.run('row-2');

    const oldLimit = process.env.SMARTPERFETTO_SCHEMA_MIGRATION_MAX_AUTOMATIC_ROWS;
    const oldAllow = process.env.SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION;
    try {
      process.env.SMARTPERFETTO_SCHEMA_MIGRATION_MAX_AUTOMATIC_ROWS = '1';
      delete process.env.SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION;
      expect(() => applyEnterpriseMinimalSchema(db!))
        .toThrow('SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION=1');
      expect(db!.prepare<unknown[], {count: number}>(`
        SELECT COUNT(*) AS count FROM enterprise_schema_migrations WHERE version = 14
      `).get()?.count).toBe(0);

      process.env.SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION = '1';
      applyEnterpriseMinimalSchema(db!);
      expect(db!.prepare<unknown[], {count: number}>(`
        SELECT COUNT(*) AS count FROM enterprise_schema_migrations WHERE version = 14
      `).get()?.count).toBe(1);
    } finally {
      if (oldLimit === undefined) {
        delete process.env.SMARTPERFETTO_SCHEMA_MIGRATION_MAX_AUTOMATIC_ROWS;
      } else {
        process.env.SMARTPERFETTO_SCHEMA_MIGRATION_MAX_AUTOMATIC_ROWS = oldLimit;
      }
      if (oldAllow === undefined) {
        delete process.env.SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION;
      } else {
        process.env.SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION = oldAllow;
      }
    }
  });

  test('is idempotent and records every applied schema version once', () => {
    applyEnterpriseMinimalSchema(db!);
    applyEnterpriseMinimalSchema(db!);

    const rows = db!.prepare<unknown[], { version: number }>(
      'SELECT version FROM enterprise_schema_migrations ORDER BY version',
    ).all();
    expect(rows).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
    ]);
  });

  test('enforces the full tenant workspace session run event chain', () => {
    applyEnterpriseMinimalSchema(db!);
    const now = Date.now();
    seedCoreGraph(db!, now);

    db!.prepare(`
      INSERT INTO trace_processor_leases
        (id, tenant_id, workspace_id, trace_id, mode, state, rss_bytes, heartbeat_at, expires_at)
      VALUES
        ('lease-a', 'tenant-a', 'workspace-a', 'trace-a', 'shared', 'active', 1234, ?, ?)
    `).run(now, now + 60_000);
    db!.prepare(`
      INSERT INTO trace_processor_holders
        (id, lease_id, holder_type, holder_ref, window_id, heartbeat_at, created_at)
      VALUES
        ('holder-a', 'lease-a', 'agent_run', 'run-a', 'window-a', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO conversation_turns
        (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
      VALUES
        ('turn-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'user', '{"text":"analyze"}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO agent_events
        (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
      VALUES
        ('event-a-1', 'tenant-a', 'workspace-a', 'run-a', 1, 'progress', '{}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO runtime_snapshots
        (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
      VALUES
        ('runtime-snapshot-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'claude-agent-sdk', '{}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO provider_credentials
        (id, tenant_id, workspace_id, owner_user_id, scope, name, type, models_json, secret_ref, policy_json, created_at, updated_at)
      VALUES
        ('provider-credential-a', 'tenant-a', 'workspace-a', 'user-a', 'workspace', 'Provider A', 'openai', '[]', 'secret:v1', '{}', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at)
      VALUES
        ('report-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', '/tmp/report-a.html', 'hash-report', 'private', 'user-a', ?, ?)
    `).run(now, now + 60_000);
    db!.prepare(`
      INSERT INTO memory_entries
        (id, tenant_id, workspace_id, scope, source_run_id, content_json, embedding_ref, created_at, updated_at)
      VALUES
        ('memory-a', 'tenant-a', 'workspace-a', 'workspace', 'run-a', '{}', 'embedding:a', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO skill_registry_entries
        (id, tenant_id, workspace_id, scope, version, enabled, source_path, created_at, updated_at)
      VALUES
        ('skill-a', 'tenant-a', 'workspace-a', 'workspace', '1', 1, 'skills/custom.skill.yaml', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO tenant_tombstones
        (tenant_id, requested_by, requested_at, purge_after, status, proof_hash)
      VALUES
        ('tenant-a', 'user-a', ?, ?, 'pending', 'proof-a')
    `).run(now, now + 7 * 24 * 60 * 60 * 1000);
    db!.prepare(`
      INSERT INTO audit_events
        (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
      VALUES
        ('audit-a', 'tenant-a', 'workspace-a', 'user-a', 'tenant.delete.requested', 'tenant', 'tenant-a', '{}', ?)
    `).run(now);

    expect(() => {
      db!.prepare(`
        INSERT INTO agent_events
          (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
        VALUES
          ('event-a-duplicate', 'tenant-a', 'workspace-a', 'run-a', 1, 'progress', '{}', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO trace_processor_holders
          (id, lease_id, holder_type, holder_ref, created_at)
        VALUES
          ('holder-missing', 'missing-lease', 'agent_run', 'run-a', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO runtime_snapshots
          (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
        VALUES
          ('runtime-snapshot-missing', 'tenant-a', 'workspace-a', 'session-a', 'missing-run', 'claude-agent-sdk', '{}', ?)
      `).run(now);
    }).toThrow();
  });

  test('rejects cross-tenant workspace and session/run references on new core tables', () => {
    applyEnterpriseMinimalSchema(db!);
    const now = Date.now();
    seedCoreGraph(db!, now);

    db!.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-b', 'Tenant B', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES ('workspace-b', 'tenant-b', 'Workspace B', ?, ?)
    `).run(now, now);

    expect(() => {
      db!.prepare(`
        INSERT INTO trace_processor_leases
          (id, tenant_id, workspace_id, trace_id, mode, state, heartbeat_at)
        VALUES
          ('lease-cross-workspace', 'tenant-a', 'workspace-b', 'trace-a', 'shared', 'active', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO conversation_turns
          (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
        VALUES
          ('turn-cross-session', 'tenant-b', 'workspace-b', 'session-a', 'run-a', 'user', '{}', ?)
      `).run(now);
    }).toThrow();
  });
});

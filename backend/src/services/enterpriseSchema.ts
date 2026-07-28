// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import {buildRagSearchTokenText} from './rag/searchTokens';

interface MigrationStep {
  version: number;
  up: (db: Database.Database) => void;
  /** Large data backfills must manage short, recoverable transactions themselves. */
  transactional?: boolean;
}

const AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT_ENV =
  'SMARTPERFETTO_SCHEMA_MIGRATION_MAX_AUTOMATIC_ROWS';
const ALLOW_BLOCKING_INDEX_MIGRATION_ENV =
  'SMARTPERFETTO_ALLOW_BLOCKING_SCHEMA_MIGRATION';
const DEFAULT_AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT = 50_000;

function automaticIndexMigrationRowLimit(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT_ENV]?.trim();
  if (!configured) return DEFAULT_AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT;
}

function assertBlockingIndexMigrationAllowed(db: Database.Database): void {
  const rowCount = db.prepare<unknown[], {count: number}>(
    'SELECT COUNT(*) AS count FROM memory_entries',
  ).get()?.count ?? 0;
  const automaticLimit = automaticIndexMigrationRowLimit();
  if (rowCount <= automaticLimit) return;
  if (process.env[ALLOW_BLOCKING_INDEX_MIGRATION_ENV] === '1') return;
  throw new Error(
    `Enterprise schema migration 14 must build RAG indexes over ${rowCount} rows. ` +
    `Drain older writers and set ${ALLOW_BLOCKING_INDEX_MIGRATION_ENV}=1 for the ` +
    `maintenance restart, or raise ${AUTOMATIC_INDEX_MIGRATION_ROW_LIMIT_ENV} after ` +
    'validating the database lock window.',
  );
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableHasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const ENTERPRISE_CORE_SCHEMA_TABLES = [
  'organizations',
  'workspaces',
  'users',
  'memberships',
  'api_keys',
  'trace_assets',
  'trace_processor_leases',
  'trace_processor_holders',
  'analysis_sessions',
  'analysis_runs',
  'conversation_turns',
  'agent_events',
  'analysis_result_snapshots',
  'analysis_result_metrics',
  'analysis_result_evidence_refs',
  'analysis_result_window_states',
  'multi_trace_comparison_runs',
  'multi_trace_comparison_inputs',
  'runtime_snapshots',
  'provider_credentials',
  'provider_mutation_revisions',
  'provider_mutation_leases',
  'provider_snapshots',
  'report_artifacts',
  'memory_entries',
  'skill_registry_entries',
  'batch_trace_runs',
  'batch_trace_inputs',
  'batch_trace_results',
  'batch_trace_metrics',
  'tenant_tombstones',
  'audit_events',
] as const;

export const ENTERPRISE_MINIMAL_SCHEMA_TABLES = [
  ...ENTERPRISE_CORE_SCHEMA_TABLES,
  'sso_sessions',
] as const;

export type EnterpriseCoreSchemaTable = typeof ENTERPRISE_CORE_SCHEMA_TABLES[number];
export type EnterpriseMinimalSchemaTable = typeof ENTERPRISE_MINIMAL_SCHEMA_TABLES[number];

const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          plan TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_organizations_status
          ON organizations(status);

        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          retention_policy TEXT,
          quota_policy TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_tenant
          ON workspaces(tenant_id);

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          email TEXT NOT NULL,
          display_name TEXT,
          idp_subject TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          UNIQUE (tenant_id, email),
          UNIQUE (tenant_id, idp_subject)
        );
        CREATE INDEX IF NOT EXISTS idx_users_tenant
          ON users(tenant_id);

        CREATE TABLE IF NOT EXISTS memberships (
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, workspace_id, user_id),
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_memberships_user
          ON memberships(tenant_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_memberships_workspace
          ON memberships(tenant_id, workspace_id);

        CREATE TABLE IF NOT EXISTS trace_assets (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          owner_user_id TEXT,
          local_path TEXT NOT NULL,
          sha256 TEXT,
          size_bytes INTEGER,
          status TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trace_assets_owner_guard
          ON trace_assets(tenant_id, workspace_id, id);
        CREATE INDEX IF NOT EXISTS idx_trace_assets_status
          ON trace_assets(tenant_id, workspace_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_trace_assets_sha256
          ON trace_assets(tenant_id, workspace_id, sha256);

        CREATE TABLE IF NOT EXISTS provider_snapshots (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          resolved_config_json TEXT NOT NULL,
          secret_version TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          UNIQUE (tenant_id, snapshot_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_provider_snapshots_provider
          ON provider_snapshots(tenant_id, provider_id, created_at);

        CREATE TABLE IF NOT EXISTS analysis_sessions (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          created_by TEXT,
          provider_snapshot_id TEXT,
          title TEXT,
          visibility TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (trace_id) REFERENCES trace_assets(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (provider_snapshot_id) REFERENCES provider_snapshots(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_sessions_owner_guard
          ON analysis_sessions(tenant_id, workspace_id, id);
        CREATE INDEX IF NOT EXISTS idx_analysis_sessions_trace
          ON analysis_sessions(tenant_id, workspace_id, trace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_sessions_status
          ON analysis_sessions(tenant_id, workspace_id, status, updated_at);

        CREATE TABLE IF NOT EXISTS analysis_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          question TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error_json TEXT,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES analysis_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_runs_session
          ON analysis_runs(session_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_runs_status
          ON analysis_runs(tenant_id, workspace_id, status, started_at);

        CREATE TABLE IF NOT EXISTS agent_events (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          cursor INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
          UNIQUE (run_id, cursor)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_events_replay
          ON agent_events(run_id, cursor);
        CREATE INDEX IF NOT EXISTS idx_agent_events_owner_guard
          ON agent_events(tenant_id, workspace_id, run_id, cursor);
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          actor_user_id TEXT,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time
          ON audit_events(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_events_actor
          ON audit_events(tenant_id, actor_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_events_resource
          ON audit_events(tenant_id, resource_type, resource_id, created_at);

        CREATE TABLE IF NOT EXISTS sso_sessions (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          user_id TEXT NOT NULL,
          selected_workspace_id TEXT,
          auth_context_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (selected_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sso_sessions_user
          ON sso_sessions(tenant_id, user_id, expires_at);
        CREATE INDEX IF NOT EXISTS idx_sso_sessions_expiry
          ON sso_sessions(expires_at, revoked_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          owner_user_id TEXT,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          scopes TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          revoked_at INTEGER,
          last_used_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_scope
          ON api_keys(tenant_id, workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_keys_owner
          ON api_keys(tenant_id, owner_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_keys_expiry
          ON api_keys(expires_at, revoked_at);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_tenant_id_unique
          ON workspaces(tenant_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_id_unique
          ON users(tenant_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trace_assets_tenant_workspace_id_unique
          ON trace_assets(tenant_id, workspace_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_sessions_tenant_workspace_id_unique
          ON analysis_sessions(tenant_id, workspace_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_runs_tenant_workspace_id_unique
          ON analysis_runs(tenant_id, workspace_id, id);

        CREATE TABLE IF NOT EXISTS trace_processor_leases (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          state TEXT NOT NULL,
          rss_bytes INTEGER,
          heartbeat_at INTEGER,
          expires_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, trace_id) REFERENCES trace_assets(tenant_id, workspace_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_trace_processor_leases_owner_guard
          ON trace_processor_leases(tenant_id, workspace_id, id);
        CREATE INDEX IF NOT EXISTS idx_trace_processor_leases_trace
          ON trace_processor_leases(tenant_id, workspace_id, trace_id, state);
        CREATE INDEX IF NOT EXISTS idx_trace_processor_leases_state
          ON trace_processor_leases(tenant_id, workspace_id, state, heartbeat_at);
        CREATE INDEX IF NOT EXISTS idx_trace_processor_leases_expiry
          ON trace_processor_leases(expires_at, heartbeat_at);

        CREATE TABLE IF NOT EXISTS trace_processor_holders (
          id TEXT PRIMARY KEY,
          lease_id TEXT NOT NULL,
          holder_type TEXT NOT NULL,
          holder_ref TEXT NOT NULL,
          window_id TEXT,
          heartbeat_at INTEGER,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY (lease_id) REFERENCES trace_processor_leases(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_trace_processor_holders_lease
          ON trace_processor_holders(lease_id, holder_type, holder_ref);
        CREATE INDEX IF NOT EXISTS idx_trace_processor_holders_window
          ON trace_processor_holders(window_id, heartbeat_at);
        CREATE INDEX IF NOT EXISTS idx_trace_processor_holders_expiry
          ON trace_processor_holders(expires_at, heartbeat_at);

        CREATE TABLE IF NOT EXISTS conversation_turns (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, session_id) REFERENCES analysis_sessions(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES analysis_runs(tenant_id, workspace_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_turns_session
          ON conversation_turns(tenant_id, workspace_id, session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversation_turns_run
          ON conversation_turns(tenant_id, workspace_id, run_id, created_at);

        CREATE TABLE IF NOT EXISTS runtime_snapshots (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          runtime_type TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, session_id) REFERENCES analysis_sessions(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES analysis_runs(tenant_id, workspace_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_session
          ON runtime_snapshots(tenant_id, workspace_id, session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_run
          ON runtime_snapshots(tenant_id, workspace_id, run_id, created_at);

        CREATE TABLE IF NOT EXISTS provider_credentials (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          owner_user_id TEXT,
          scope TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          models_json TEXT NOT NULL,
          secret_ref TEXT NOT NULL,
          policy_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_credentials_scope
          ON provider_credentials(tenant_id, workspace_id, scope, created_at);
        CREATE INDEX IF NOT EXISTS idx_provider_credentials_owner
          ON provider_credentials(tenant_id, owner_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_provider_credentials_name
          ON provider_credentials(tenant_id, workspace_id, name);

        CREATE TABLE IF NOT EXISTS report_artifacts (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          local_path TEXT NOT NULL,
          content_hash TEXT,
          visibility TEXT NOT NULL,
          created_by TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, session_id) REFERENCES analysis_sessions(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES analysis_runs(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_report_artifacts_owner_guard
          ON report_artifacts(tenant_id, workspace_id, id);
        CREATE INDEX IF NOT EXISTS idx_report_artifacts_session
          ON report_artifacts(tenant_id, workspace_id, session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_report_artifacts_run
          ON report_artifacts(tenant_id, workspace_id, run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_report_artifacts_expiry
          ON report_artifacts(expires_at, created_at);

        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          source_run_id TEXT,
          content_json TEXT NOT NULL,
          embedding_ref TEXT,
          rag_registry_origin TEXT,
          rag_codebase_id TEXT,
          rag_knowledge_source_id TEXT,
          rag_source_generation TEXT,
          rag_scope_fingerprint TEXT,
          rag_unsupported_reason TEXT,
          rag_vendor TEXT,
          rag_build_id TEXT,
          rag_language TEXT,
          rag_symbol TEXT,
          rag_lookup_path TEXT,
          rag_index_state TEXT,
          rag_indexed_updated_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (source_run_id) REFERENCES analysis_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
          ON memory_entries(tenant_id, workspace_id, scope, updated_at);
        CREATE INDEX IF NOT EXISTS idx_memory_entries_source_run
          ON memory_entries(tenant_id, workspace_id, source_run_id);

        CREATE TABLE IF NOT EXISTS skill_registry_entries (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          source_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_skill_registry_entries_scope
          ON skill_registry_entries(tenant_id, workspace_id, scope, enabled, updated_at);
        CREATE INDEX IF NOT EXISTS idx_skill_registry_entries_source
          ON skill_registry_entries(tenant_id, workspace_id, source_path, version);

        CREATE TABLE IF NOT EXISTS tenant_tombstones (
          tenant_id TEXT PRIMARY KEY,
          requested_by TEXT,
          requested_at INTEGER NOT NULL,
          purge_after INTEGER NOT NULL,
          status TEXT NOT NULL,
          proof_hash TEXT,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_tombstones_status
          ON tenant_tombstones(status, purge_after);
        CREATE INDEX IF NOT EXISTS idx_tenant_tombstones_requested_by
          ON tenant_tombstones(tenant_id, requested_by, requested_at);
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      addColumnIfMissing(db, 'trace_processor_holders', 'expires_at', 'INTEGER');
      addColumnIfMissing(db, 'trace_processor_holders', 'metadata_json', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trace_processor_holders_expiry
          ON trace_processor_holders(expires_at, heartbeat_at);
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      addColumnIfMissing(db, 'analysis_runs', 'heartbeat_at', 'INTEGER');
      addColumnIfMissing(db, 'analysis_runs', 'updated_at', 'INTEGER');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_analysis_runs_heartbeat
          ON analysis_runs(tenant_id, workspace_id, status, heartbeat_at);
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analysis_result_snapshots (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          report_id TEXT,
          created_by TEXT,
          visibility TEXT NOT NULL,
          scene_type TEXT NOT NULL,
          title TEXT NOT NULL,
          user_query TEXT NOT NULL,
          trace_label TEXT NOT NULL,
          trace_metadata_json TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          conclusion_contract_json TEXT,
          claim_support_json TEXT,
          claim_verification_json TEXT,
          identity_resolutions_json TEXT,
          status TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, trace_id) REFERENCES trace_assets(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, session_id) REFERENCES analysis_sessions(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES analysis_runs(tenant_id, workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_result_snapshots_trace
          ON analysis_result_snapshots(tenant_id, workspace_id, trace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_snapshots_scene
          ON analysis_result_snapshots(tenant_id, workspace_id, scene_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_snapshots_visibility
          ON analysis_result_snapshots(tenant_id, workspace_id, visibility, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_snapshots_owner_guard
          ON analysis_result_snapshots(tenant_id, workspace_id, id);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_snapshots_run
          ON analysis_result_snapshots(tenant_id, workspace_id, run_id, created_at);

        CREATE TABLE IF NOT EXISTS analysis_result_metrics (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          metric_key TEXT NOT NULL,
          metric_group TEXT NOT NULL,
          label TEXT NOT NULL,
          value_json TEXT,
          numeric_value REAL,
          unit TEXT,
          direction TEXT,
          aggregation TEXT,
          confidence REAL NOT NULL,
          missing_reason TEXT,
          source_json TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES analysis_result_snapshots(id) ON DELETE CASCADE,
          UNIQUE(snapshot_id, metric_key)
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_result_metrics_snapshot
          ON analysis_result_metrics(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_metrics_key
          ON analysis_result_metrics(snapshot_id, metric_key);

        CREATE TABLE IF NOT EXISTS analysis_result_evidence_refs (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          ref_type TEXT NOT NULL,
          ref_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES analysis_result_snapshots(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_result_evidence_refs_snapshot
          ON analysis_result_evidence_refs(snapshot_id);
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analysis_result_window_states (
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          user_id TEXT,
          trace_id TEXT,
          backend_trace_id TEXT,
          active_session_id TEXT,
          latest_snapshot_id TEXT,
          trace_title TEXT,
          scene_type TEXT,
          metadata_json TEXT,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, workspace_id, window_id),
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_result_window_states_workspace
          ON analysis_result_window_states(tenant_id, workspace_id, expires_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_window_states_trace
          ON analysis_result_window_states(tenant_id, workspace_id, trace_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_result_window_states_snapshot
          ON analysis_result_window_states(tenant_id, workspace_id, latest_snapshot_id, updated_at);
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS multi_trace_comparison_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          created_by TEXT,
          baseline_snapshot_id TEXT,
          query TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          report_id TEXT,
          error TEXT,
          schema_version TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (baseline_snapshot_id) REFERENCES analysis_result_snapshots(id) ON DELETE SET NULL,
          FOREIGN KEY (report_id) REFERENCES report_artifacts(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_multi_trace_comparison_runs_workspace
          ON multi_trace_comparison_runs(tenant_id, workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_multi_trace_comparison_runs_status
          ON multi_trace_comparison_runs(tenant_id, workspace_id, status, created_at);

        CREATE TABLE IF NOT EXISTS multi_trace_comparison_inputs (
          comparison_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          role TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY(comparison_id, snapshot_id),
          FOREIGN KEY(comparison_id) REFERENCES multi_trace_comparison_runs(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES analysis_result_snapshots(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_multi_trace_comparison_inputs_snapshot
          ON multi_trace_comparison_inputs(snapshot_id, comparison_id);
      `);
    },
  },
  {
    version: 10,
    up: (db) => {
      addColumnIfMissing(db, 'analysis_result_snapshots', 'conclusion_contract_json', 'TEXT');
    },
  },
  {
    version: 11,
    up: (db) => {
      addColumnIfMissing(db, 'analysis_result_snapshots', 'claim_support_json', 'TEXT');
      addColumnIfMissing(db, 'analysis_result_snapshots', 'claim_verification_json', 'TEXT');
      addColumnIfMissing(db, 'analysis_result_snapshots', 'identity_resolutions_json', 'TEXT');
    },
  },
  {
    version: 12,
    up: (db) => {
      addColumnIfMissing(db, 'skill_registry_entries', 'metadata_json', 'TEXT');
    },
  },
  {
    version: 13,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS batch_trace_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          created_by TEXT,
          skill_id TEXT NOT NULL,
          status TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          params_json TEXT NOT NULL,
          aggregate_json TEXT,
          report_json TEXT,
          comparison_id TEXT,
          run_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_batch_trace_runs_workspace
          ON batch_trace_runs(tenant_id, workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_batch_trace_runs_status
          ON batch_trace_runs(tenant_id, workspace_id, status, created_at);

        CREATE TABLE IF NOT EXISTS batch_trace_inputs (
          run_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          source TEXT NOT NULL,
          trace_id TEXT,
          trace_path TEXT,
          label TEXT,
          size_bytes INTEGER,
          PRIMARY KEY(run_id, ordinal),
          FOREIGN KEY(run_id) REFERENCES batch_trace_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_batch_trace_inputs_trace
          ON batch_trace_inputs(tenant_id, workspace_id, trace_id);

        CREATE TABLE IF NOT EXISTS batch_trace_results (
          run_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          trace_id TEXT,
          status TEXT NOT NULL,
          diagnostics_json TEXT NOT NULL,
          evidence_envelope_ids_json TEXT NOT NULL,
          execution_time_ms INTEGER NOT NULL,
          error TEXT,
          promoted_snapshot_id TEXT,
          PRIMARY KEY(run_id, ordinal),
          FOREIGN KEY(run_id) REFERENCES batch_trace_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_batch_trace_results_status
          ON batch_trace_results(tenant_id, workspace_id, status);

        CREATE TABLE IF NOT EXISTS batch_trace_metrics (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          metric_key TEXT NOT NULL,
          label TEXT NOT NULL,
          value_json TEXT,
          numeric_value REAL,
          unit TEXT,
          source_json TEXT NOT NULL,
          promotable_metric_key TEXT,
          missing_reason TEXT,
          FOREIGN KEY(run_id) REFERENCES batch_trace_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_batch_trace_metrics_run_key
          ON batch_trace_metrics(run_id, metric_key);
      `);
    },
  },
  {
    version: 14,
    transactional: false,
    up: (db) => {
      for (const [column, definition] of [
        ['rag_registry_origin', 'TEXT'],
        ['rag_codebase_id', 'TEXT'],
        ['rag_knowledge_source_id', 'TEXT'],
        ['rag_source_generation', 'TEXT'],
        ['rag_scope_fingerprint', 'TEXT'],
        ['rag_unsupported_reason', 'TEXT'],
        ['rag_vendor', 'TEXT'],
        ['rag_build_id', 'TEXT'],
        ['rag_language', 'TEXT'],
        ['rag_symbol', 'TEXT'],
        ['rag_lookup_path', 'TEXT'],
        ['rag_index_state', 'TEXT'],
        ['rag_indexed_updated_at', 'INTEGER'],
      ] as const) {
        addColumnIfMissing(db, 'memory_entries', column, definition);
      }
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS rag_knowledge_fts USING fts5(
          entry_id UNINDEXED,
          tenant_id UNINDEXED,
          workspace_id UNINDEXED,
          scope UNINDEXED,
          search_tokens,
          tokenize = 'unicode61'
        );
        CREATE TABLE IF NOT EXISTS enterprise_schema_backfill_progress (
          migration_version INTEGER PRIMARY KEY,
          cursor INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Rolling-deploy compatibility: an older writer only updates
        -- content_json. Triggers keep authorization/materialized columns
        -- coherent, mark rows for the bounded JavaScript-tokenized fallback,
        -- and remove any stale FTS row. A new writer repairs the canonical FTS
        -- entry and marks token_v1 after its application-side tokenizer runs.
        CREATE TRIGGER IF NOT EXISTS trg_memory_entries_rag_legacy_insert
        AFTER INSERT ON memory_entries
        WHEN NEW.scope LIKE 'rag:%'
          AND json_valid(NEW.content_json) = 1
          AND json_extract(NEW.content_json, '$.kind') = 'rag_chunk'
          AND NEW.rag_index_state IS NULL
        BEGIN
          UPDATE memory_entries
          SET rag_registry_origin = json_extract(NEW.content_json, '$.record.registryOrigin'),
              rag_codebase_id = json_extract(NEW.content_json, '$.record.codebaseId'),
              rag_knowledge_source_id = json_extract(NEW.content_json, '$.record.knowledgeSourceId'),
              rag_source_generation = json_extract(NEW.content_json, '$.record.sourceGeneration'),
              rag_scope_fingerprint = json_extract(NEW.content_json, '$.record.knowledgeScopeFingerprint'),
              rag_unsupported_reason = json_extract(NEW.content_json, '$.record.unsupportedReason'),
              rag_vendor = json_extract(NEW.content_json, '$.record.vendor'),
              rag_build_id = json_extract(NEW.content_json, '$.record.buildId'),
              rag_language = json_extract(NEW.content_json, '$.record.language'),
              rag_symbol = json_extract(NEW.content_json, '$.record.symbol'),
              rag_lookup_path = COALESCE(
                json_extract(NEW.content_json, '$.record.filePath'),
                json_extract(NEW.content_json, '$.record.uri')
              ),
              rag_index_state = 'legacy_pending',
              rag_indexed_updated_at = NEW.updated_at
          WHERE id = NEW.id;
          DELETE FROM rag_knowledge_fts WHERE entry_id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_memory_entries_rag_legacy_update
        AFTER UPDATE OF content_json, scope, tenant_id, workspace_id ON memory_entries
        WHEN NEW.scope LIKE 'rag:%'
          AND json_valid(NEW.content_json) = 1
          AND json_extract(NEW.content_json, '$.kind') = 'rag_chunk'
          AND NEW.content_json IS NOT OLD.content_json
          AND NEW.rag_indexed_updated_at IS OLD.rag_indexed_updated_at
        BEGIN
          UPDATE memory_entries
          SET rag_registry_origin = json_extract(NEW.content_json, '$.record.registryOrigin'),
              rag_codebase_id = json_extract(NEW.content_json, '$.record.codebaseId'),
              rag_knowledge_source_id = json_extract(NEW.content_json, '$.record.knowledgeSourceId'),
              rag_source_generation = json_extract(NEW.content_json, '$.record.sourceGeneration'),
              rag_scope_fingerprint = json_extract(NEW.content_json, '$.record.knowledgeScopeFingerprint'),
              rag_unsupported_reason = json_extract(NEW.content_json, '$.record.unsupportedReason'),
              rag_vendor = json_extract(NEW.content_json, '$.record.vendor'),
              rag_build_id = json_extract(NEW.content_json, '$.record.buildId'),
              rag_language = json_extract(NEW.content_json, '$.record.language'),
              rag_symbol = json_extract(NEW.content_json, '$.record.symbol'),
              rag_lookup_path = COALESCE(
                json_extract(NEW.content_json, '$.record.filePath'),
                json_extract(NEW.content_json, '$.record.uri')
              ),
              rag_index_state = 'legacy_pending',
              rag_indexed_updated_at = NEW.updated_at
          WHERE id = NEW.id;
          DELETE FROM rag_knowledge_fts WHERE entry_id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_memory_entries_rag_legacy_delete
        AFTER DELETE ON memory_entries
        BEGIN
          DELETE FROM rag_knowledge_fts WHERE entry_id = OLD.id;
        END;
      `);

      type LegacyRagRow = {
        row_number: number;
        id: string;
        tenant_id: string;
        workspace_id: string;
        scope: string;
        content_json: string;
        updated_at: number;
      };
      type MaterializedRagRow = LegacyRagRow & {
        values: Array<string | number | null>;
        searchTokens: string;
      };
      const selectBatch = db.prepare<[number, number], LegacyRagRow>(`
        SELECT rowid AS row_number, id, tenant_id, workspace_id, scope, content_json, updated_at
        FROM memory_entries
        WHERE rowid > ? AND scope LIKE 'rag:%'
        ORDER BY rowid
        LIMIT ?
      `);
      const update = db.prepare(`
        UPDATE memory_entries
        SET rag_registry_origin = ?,
            rag_codebase_id = ?,
            rag_knowledge_source_id = ?,
            rag_source_generation = ?,
            rag_scope_fingerprint = ?,
            rag_unsupported_reason = ?,
            rag_vendor = ?,
            rag_build_id = ?,
            rag_language = ?,
            rag_symbol = ?,
            rag_lookup_path = ?,
            rag_index_state = ?,
            rag_indexed_updated_at = ?
        WHERE id = ? AND content_json = ?
      `);
      const insertFts = db.prepare(`
        INSERT INTO rag_knowledge_fts(entry_id, tenant_id, workspace_id, scope, search_tokens)
        VALUES (?, ?, ?, ?, ?)
      `);
      const deleteFts = db.prepare('DELETE FROM rag_knowledge_fts WHERE entry_id = ?');
      const saveProgress = db.prepare(`
        INSERT INTO enterprise_schema_backfill_progress(migration_version, cursor, updated_at)
        VALUES (14, ?, ?)
        ON CONFLICT(migration_version) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `);
      const commitBatch = db.transaction((rows: MaterializedRagRow[], nextCursor: number) => {
        for (const row of rows) {
          const result = update.run(...row.values, row.id, row.content_json);
          if (result.changes !== 1) continue;
          deleteFts.run(row.id);
          insertFts.run(
            row.id,
            row.tenant_id,
            row.workspace_id,
            row.scope,
            row.searchTokens,
          );
        }
        saveProgress.run(nextCursor, Date.now());
      });
      const progress = db.prepare<[], {cursor: number}>(`
        SELECT cursor
        FROM enterprise_schema_backfill_progress
        WHERE migration_version = 14
      `).get();
      // Keep each WAL write lock short; JSON parsing/tokenization happens before
      // the transaction, and the cursor is committed atomically with the batch.
      const backfillBatchSize = 250;
      let lastRowNumber = progress?.cursor ?? 0;
      while (true) {
        const rows = selectBatch.all(lastRowNumber, backfillBatchSize);
        if (rows.length === 0) break;
        const materializedRows: MaterializedRagRow[] = [];
        for (const row of rows) {
          try {
            const envelope = JSON.parse(row.content_json) as {kind?: unknown; record?: Record<string, unknown>};
            if (envelope.kind !== 'rag_chunk' || !envelope.record) continue;
            const record = envelope.record;
            materializedRows.push({
              ...row,
              values: [
                typeof record.registryOrigin === 'string' ? record.registryOrigin : null,
                typeof record.codebaseId === 'string' ? record.codebaseId : null,
                typeof record.knowledgeSourceId === 'string' ? record.knowledgeSourceId : null,
                typeof record.sourceGeneration === 'string' ? record.sourceGeneration : null,
                typeof record.knowledgeScopeFingerprint === 'string' ? record.knowledgeScopeFingerprint : null,
                typeof record.unsupportedReason === 'string' ? record.unsupportedReason : null,
                typeof record.vendor === 'string' ? record.vendor : null,
                typeof record.buildId === 'string' ? record.buildId : null,
                typeof record.language === 'string' ? record.language : null,
                typeof record.symbol === 'string' ? record.symbol : null,
                typeof record.filePath === 'string'
                  ? record.filePath
                  : typeof record.uri === 'string' ? record.uri : null,
                'token_v1',
                row.updated_at,
              ],
              searchTokens: buildRagSearchTokenText(record),
            });
          } catch {
            // Invalid envelopes remain readable to the generic audit/export path,
            // but are intentionally absent from the retrieval index.
          }
        }
        lastRowNumber = rows[rows.length - 1].row_number;
        commitBatch(materializedRows, lastRowNumber);
      }

      // SQLite cannot build indexes concurrently. Small stores are safe to
      // migrate during startup; larger stores require an explicit maintenance
      // restart so rolling-deploy writers are drained before the lock window.
      assertBlockingIndexMigrationAllowed(db);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_entries_rag_codebase_generation
          ON memory_entries(
            tenant_id, workspace_id, rag_codebase_id, rag_source_generation, scope
          );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_rag_source_generation
          ON memory_entries(
            tenant_id, workspace_id, rag_knowledge_source_id, rag_source_generation, scope
          );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_rag_symbol
          ON memory_entries(tenant_id, workspace_id, scope, rag_symbol);
        CREATE INDEX IF NOT EXISTS idx_memory_entries_rag_path
          ON memory_entries(tenant_id, workspace_id, scope, rag_lookup_path);
      `);
    },
  },
  {
    version: 15,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_mutation_revisions (
          scope_key TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          workspace_id TEXT,
          owner_user_id TEXT,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
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
    },
  },
];

export function applyEnterpriseMinimalSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS enterprise_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare<unknown[], { version: number }>(
      'SELECT version FROM enterprise_schema_migrations',
    ).all().map(row => row.version),
  );
  for (const step of MIGRATIONS) {
    if (applied.has(step.version)) continue;
    if (step.transactional === false) {
      step.up(db);
      const finalize = db.transaction(() => {
        db.prepare(
          'INSERT OR IGNORE INTO enterprise_schema_migrations (version, applied_at) VALUES (?, ?)',
        ).run(step.version, Date.now());
        db.prepare(
          'DELETE FROM enterprise_schema_backfill_progress WHERE migration_version = ?',
        ).run(step.version);
      });
      finalize();
      continue;
    }
    const tx = db.transaction(() => {
      step.up(db);
      db.prepare(
        'INSERT INTO enterprise_schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(step.version, Date.now());
    });
    tx();
  }
}

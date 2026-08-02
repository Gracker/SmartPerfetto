// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ENTERPRISE_FEATURE_FLAG_ENV,
  resolveAuthConfig,
  resolveFeatureConfig,
} from '../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb, resolveEnterpriseDbPath } from './enterpriseDb';
import { ENTERPRISE_MINIMAL_SCHEMA_TABLES } from './enterpriseSchema';

export const ENTERPRISE_MIGRATION_PHASE_ENV = 'SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE';
export const ENTERPRISE_MIGRATION_SNAPSHOT_DIR_ENV = 'SMARTPERFETTO_ENTERPRISE_MIGRATION_SNAPSHOT_DIR';
export const ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV = 'SMARTPERFETTO_ENTERPRISE_CUTOVER_CONFIRMED';

export type EnterpriseMigrationPhase = 'legacy' | 'dual-write' | 'cutover' | 'retired';
export type EnterpriseReadAuthority = 'filesystem' | 'db';

export interface EnterpriseMigrationPlan {
  enterpriseEnabled: boolean;
  phase: EnterpriseMigrationPhase;
  readAuthority: EnterpriseReadAuthority;
  writeFilesystem: boolean;
  writeDb: boolean;
  legacyReadOnly: boolean;
  rollback: 'disable-enterprise' | 'delete-db' | 'restore-snapshots';
}

export interface MigrationFilesystemFingerprint {
  label: string;
  path: string;
  exists: boolean;
  kind: 'file' | 'directory';
  fileCount: number;
  totalBytes: number;
  sha256: string | null;
  failures: string[];
}

export interface MigrationDatabaseFingerprint {
  path: string;
  exists: boolean;
  totalRows: number;
  tableCounts: Record<string, number>;
  sha256: string | null;
  failures: string[];
}

export interface EnterpriseMigrationDryRunReport {
  generatedAt: string;
  phase: EnterpriseMigrationPhase;
  plan: EnterpriseMigrationPlan;
  filesystem: MigrationFilesystemFingerprint[];
  database: MigrationDatabaseFingerprint;
  failures: string[];
  fingerprint: string;
}

export interface EnterpriseMigrationSnapshotOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  snapshotRoot?: string;
  snapshotId?: string;
}

export interface EnterpriseMigrationSnapshotManifest extends EnterpriseMigrationDryRunReport {
  snapshotId: string;
  snapshotDir: string;
  filesystemSnapshots: Array<{
    label: string;
    sourcePath: string;
    snapshotPath: string;
    kind: 'file' | 'directory';
    copied: boolean;
  }>;
  databaseSnapshot: {
    sourcePath: string;
    snapshotPath: string;
    copied: boolean;
  };
}

export interface EnterpriseMigrationRestoreResult {
  snapshotId: string;
  restoredAt: string;
  restoredFilesystem: Array<{
    label: string;
    targetPath: string;
    restored: boolean;
  }>;
  restoredDatabase: {
    targetPath: string;
    restored: boolean;
  };
}

interface FilesystemSource {
  label: string;
  path: string;
  kind: 'file' | 'directory';
}

const DATA_DIR_ENV = 'SMARTPERFETTO_DATA_DIR';
const LOGS_DIR_ENV = 'SMARTPERFETTO_LOGS_DIR';
const PROVIDER_DATA_DIR_ENV = 'PROVIDER_DATA_DIR_OVERRIDE';
const UPLOAD_DIR_ENV = 'UPLOAD_DIR';

function parseEnterpriseMigrationPhase(
  value: string | undefined,
  enterpriseEnabled: boolean,
): EnterpriseMigrationPhase {
  if (!enterpriseEnabled) return 'legacy';
  if (!value || value.trim().length === 0) return 'dual-write';
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (['legacy', 'off', 'filesystem'].includes(normalized)) return 'legacy';
  if (['p-a', 'pa', 'dual', 'dualwrite', 'dual-write'].includes(normalized)) return 'dual-write';
  if (['p-b', 'pb', 'cut-read', 'cutover', 'db', 'db-authoritative'].includes(normalized)) return 'cutover';
  if (['p-c', 'pc', 'retire', 'retired'].includes(normalized)) return 'retired';
  throw new Error(
    `Invalid ${ENTERPRISE_MIGRATION_PHASE_ENV}: ${value}. Expected dual-write, cutover, or retired.`,
  );
}

export function resolveEnterpriseMigrationPlan(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseMigrationPlan {
  const authConfig = resolveAuthConfig(env);
  const enterpriseEnabled = resolveFeatureConfig(env).enterprise;
  const phase = parseEnterpriseMigrationPhase(
    env[ENTERPRISE_MIGRATION_PHASE_ENV]
      || (authConfig.oidcEnabled ? 'retired' : undefined),
    enterpriseEnabled,
  );
  if (authConfig.oidcEnabled && (phase === 'legacy' || phase === 'dual-write')) {
    throw new Error(
      `Built-in OIDC requires DB-authoritative storage; unset ${ENTERPRISE_MIGRATION_PHASE_ENV} or set it to retired`,
    );
  }
  if (
    phase === 'cutover' &&
    !['1', 'true', 'yes', 'on'].includes(
      (env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] ?? '').trim().toLowerCase(),
    )
  ) {
    throw new Error(
      `${ENTERPRISE_MIGRATION_PHASE_ENV}=cutover requires ${ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV}=true after filesystem-to-DB reconciliation and snapshot verification`,
    );
  }

  if (!enterpriseEnabled || phase === 'legacy') {
    return {
      enterpriseEnabled,
      phase: 'legacy',
      readAuthority: 'filesystem',
      writeFilesystem: true,
      writeDb: false,
      legacyReadOnly: false,
      rollback: 'disable-enterprise',
    };
  }

  if (phase === 'dual-write') {
    return {
      enterpriseEnabled: true,
      phase,
      readAuthority: 'filesystem',
      writeFilesystem: true,
      writeDb: true,
      legacyReadOnly: false,
      rollback: 'delete-db',
    };
  }

  if (phase === 'cutover') {
    return {
      enterpriseEnabled: true,
      phase,
      readAuthority: 'db',
      writeFilesystem: false,
      writeDb: true,
      legacyReadOnly: true,
      rollback: 'restore-snapshots',
    };
  }

  return {
    enterpriseEnabled: true,
    phase: 'retired',
    readAuthority: 'db',
    writeFilesystem: false,
    writeDb: true,
    legacyReadOnly: false,
    rollback: 'restore-snapshots',
  };
}

export function enterpriseDbReadAuthorityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnterpriseMigrationPlan(env).readAuthority === 'db';
}

export function enterpriseDbWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnterpriseMigrationPlan(env).writeDb;
}

export function legacyFilesystemReadAuthorityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnterpriseMigrationPlan(env).readAuthority === 'filesystem';
}

export function legacyFilesystemWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnterpriseMigrationPlan(env).writeFilesystem;
}

function resolveUploadRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env[UPLOAD_DIR_ENV] || './uploads');
}

function resolveDataRoot(env: NodeJS.ProcessEnv): string {
  const configured = env[DATA_DIR_ENV];
  return path.resolve(configured && configured.trim().length > 0 ? configured : 'data');
}

function resolveLogsRoot(env: NodeJS.ProcessEnv): string {
  const configured = env[LOGS_DIR_ENV];
  return path.resolve(configured && configured.trim().length > 0 ? configured : 'logs');
}

function resolveProviderFile(env: NodeJS.ProcessEnv): string {
  const providerDir = env[PROVIDER_DATA_DIR_ENV] || path.resolve(process.cwd(), 'data');
  return path.join(path.resolve(providerDir), 'providers.json');
}

function defaultSnapshotRoot(env: NodeJS.ProcessEnv): string {
  const configured = env[ENTERPRISE_MIGRATION_SNAPSHOT_DIR_ENV];
  return path.resolve(
    configured && configured.trim().length > 0
      ? configured
      : path.join(process.cwd(), 'enterprise-migration-snapshots'),
  );
}

function snapshotIdForDate(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function filesystemSources(env: NodeJS.ProcessEnv): FilesystemSource[] {
  return [
    {label: 'uploads', path: resolveUploadRoot(env), kind: 'directory'},
    {label: 'logs', path: resolveLogsRoot(env), kind: 'directory'},
    {label: 'data', path: resolveDataRoot(env), kind: 'directory'},
    {label: 'provider-file', path: resolveProviderFile(env), kind: 'file'},
  ];
}

function emptyHash(): string {
  return crypto.createHash('sha256').digest('hex');
}

function hashFile(filePath: string): {bytes: number; sha256: string} {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return {bytes: data.byteLength, sha256: hash.digest('hex')};
}

function fingerprintPath(source: FilesystemSource, snapshotRoot: string): MigrationFilesystemFingerprint {
  const failures: string[] = [];
  if (!fs.existsSync(source.path)) {
    return {
      label: source.label,
      path: source.path,
      exists: false,
      kind: source.kind,
      fileCount: 0,
      totalBytes: 0,
      sha256: null,
      failures,
    };
  }

  const aggregate = crypto.createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;

  try {
    if (source.kind === 'file') {
      const stat = fs.statSync(source.path);
      if (!stat.isFile()) {
        throw new Error(`Expected file, got non-file path`);
      }
      const fileHash = hashFile(source.path);
      aggregate.update(path.basename(source.path));
      aggregate.update('\0');
      aggregate.update(String(fileHash.bytes));
      aggregate.update('\0');
      aggregate.update(fileHash.sha256);
      fileCount = 1;
      totalBytes = fileHash.bytes;
    } else {
      const files = listFiles(source.path, snapshotRoot);
      for (const file of files) {
        const rel = path.relative(source.path, file).split(path.sep).join('/');
        const fileHash = hashFile(file);
        aggregate.update(rel);
        aggregate.update('\0');
        aggregate.update(String(fileHash.bytes));
        aggregate.update('\0');
        aggregate.update(fileHash.sha256);
        aggregate.update('\0');
        fileCount += 1;
        totalBytes += fileHash.bytes;
      }
    }
  } catch (err) {
    failures.push((err as Error).message);
  }

  return {
    label: source.label,
    path: source.path,
    exists: true,
    kind: source.kind,
    fileCount,
    totalBytes,
    sha256: failures.length > 0 ? null : (fileCount === 0 ? emptyHash() : aggregate.digest('hex')),
    failures,
  };
}

function isUnderPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function listFiles(root: string, snapshotRoot: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (isUnderPath(current, snapshotRoot)) continue;
    const entries = fs.readdirSync(current, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (isUnderPath(child, snapshotRoot)) continue;
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function fingerprintDatabase(env: NodeJS.ProcessEnv): MigrationDatabaseFingerprint {
  const dbPath = resolveEnterpriseDbPath(env);
  const failures: string[] = [];
  let tableCounts: Record<string, number> = {};
  let totalRows = 0;

  try {
    const db = openEnterpriseDb(dbPath);
    try {
      db.pragma('wal_checkpoint(FULL)');
      for (const table of ENTERPRISE_MINIMAL_SCHEMA_TABLES) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count: number};
          tableCounts[table] = row.count;
          totalRows += row.count;
        } catch (err) {
          tableCounts[table] = 0;
          failures.push(`${table}: ${(err as Error).message}`);
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    failures.push((err as Error).message);
    tableCounts = {};
  }

  let sha256: string | null = null;
  if (fs.existsSync(dbPath)) {
    try {
      sha256 = hashFile(dbPath).sha256;
    } catch (err) {
      failures.push((err as Error).message);
    }
  }

  return {
    path: dbPath,
    exists: fs.existsSync(dbPath),
    totalRows,
    tableCounts,
    sha256,
    failures,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function reportFingerprint(report: Omit<EnterpriseMigrationDryRunReport, 'fingerprint'>): string {
  return crypto.createHash('sha256').update(stableJson({
    phase: report.phase,
    filesystem: report.filesystem.map(item => ({
      label: item.label,
      path: item.path,
      exists: item.exists,
      kind: item.kind,
      fileCount: item.fileCount,
      totalBytes: item.totalBytes,
      sha256: item.sha256,
    })),
    database: {
      path: report.database.path,
      exists: report.database.exists,
      totalRows: report.database.totalRows,
      tableCounts: report.database.tableCounts,
      sha256: report.database.sha256,
    },
  })).digest('hex');
}

export function buildEnterpriseMigrationDryRun(
  options: EnterpriseMigrationSnapshotOptions = {},
): EnterpriseMigrationDryRunReport {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const snapshotRoot = options.snapshotRoot
    ? path.resolve(options.snapshotRoot)
    : defaultSnapshotRoot(env);
  const plan = resolveEnterpriseMigrationPlan(env);
  const filesystem = filesystemSources(env)
    .map(source => fingerprintPath(source, snapshotRoot));
  const database = fingerprintDatabase(env);
  const failures = [
    ...filesystem.flatMap(item => item.failures.map(failure => `${item.label}: ${failure}`)),
    ...database.failures.map(failure => `database: ${failure}`),
  ];
  const reportWithoutFingerprint = {
    generatedAt: now.toISOString(),
    phase: plan.phase,
    plan,
    filesystem,
    database,
    failures,
  };
  return {
    ...reportWithoutFingerprint,
    fingerprint: reportFingerprint(reportWithoutFingerprint),
  };
}

function copySnapshotSource(
  source: FilesystemSource,
  snapshotDir: string,
): EnterpriseMigrationSnapshotManifest['filesystemSnapshots'][number] {
  const snapshotPath = path.join(snapshotDir, 'filesystem', source.label);
  if (!fs.existsSync(source.path)) {
    return {
      label: source.label,
      sourcePath: source.path,
      snapshotPath,
      kind: source.kind,
      copied: false,
    };
  }
  fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
  if (source.kind === 'file') {
    fs.copyFileSync(source.path, snapshotPath);
  } else {
    fs.cpSync(source.path, snapshotPath, {
      recursive: true,
      force: true,
      filter: candidate => !isUnderPath(candidate, snapshotDir),
    });
  }
  return {
    label: source.label,
    sourcePath: source.path,
    snapshotPath,
    kind: source.kind,
    copied: true,
  };
}

async function backupDatabase(env: NodeJS.ProcessEnv, snapshotDir: string): Promise<EnterpriseMigrationSnapshotManifest['databaseSnapshot']> {
  const sourcePath = resolveEnterpriseDbPath(env);
  const snapshotPath = path.join(snapshotDir, 'database', path.basename(sourcePath));
  fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
  const db = openEnterpriseDb(sourcePath);
  try {
    db.pragma('wal_checkpoint(FULL)');
    await (db as unknown as {backup: (destination: string) => Promise<unknown>}).backup(snapshotPath);
  } finally {
    db.close();
  }
  return {
    sourcePath,
    snapshotPath,
    copied: fs.existsSync(snapshotPath),
  };
}

export async function createEnterpriseMigrationSnapshot(
  options: EnterpriseMigrationSnapshotOptions = {},
): Promise<EnterpriseMigrationSnapshotManifest> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const snapshotId = options.snapshotId ?? snapshotIdForDate(now);
  const snapshotRoot = options.snapshotRoot
    ? path.resolve(options.snapshotRoot)
    : defaultSnapshotRoot(env);
  const snapshotDir = path.join(snapshotRoot, snapshotId);
  fs.mkdirSync(snapshotDir, {recursive: true});

  const dryRun = buildEnterpriseMigrationDryRun({
    env,
    now,
    snapshotRoot,
    snapshotId,
  });
  const filesystemSnapshots = filesystemSources(env)
    .map(source => copySnapshotSource(source, snapshotDir));
  const databaseSnapshot = await backupDatabase(env, snapshotDir);
  const manifest: EnterpriseMigrationSnapshotManifest = {
    ...dryRun,
    snapshotId,
    snapshotDir,
    filesystemSnapshots,
    databaseSnapshot,
  };
  fs.writeFileSync(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
  return manifest;
}

function loadSnapshotManifest(snapshotDir: string): EnterpriseMigrationSnapshotManifest {
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as EnterpriseMigrationSnapshotManifest;
  if (!manifest.snapshotId || !Array.isArray(manifest.filesystemSnapshots)) {
    throw new Error(`Invalid migration snapshot manifest: ${manifestPath}`);
  }
  return manifest;
}

function assertRestoreTargetSafe(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved.length < parsed.root.length + 2) {
    throw new Error(`Refusing to restore over unsafe path: ${targetPath}`);
  }
}

export async function restoreEnterpriseMigrationSnapshot(
  snapshotDir: string,
  options: {env?: NodeJS.ProcessEnv; now?: Date} = {},
): Promise<EnterpriseMigrationRestoreResult> {
  const manifest = loadSnapshotManifest(path.resolve(snapshotDir));
  const restoredFilesystem: EnterpriseMigrationRestoreResult['restoredFilesystem'] = [];
  for (const item of manifest.filesystemSnapshots) {
    if (!item.copied || !fs.existsSync(item.snapshotPath)) {
      restoredFilesystem.push({
        label: item.label,
        targetPath: item.sourcePath,
        restored: false,
      });
      continue;
    }
    assertRestoreTargetSafe(item.sourcePath);
    fs.rmSync(item.sourcePath, {recursive: true, force: true});
    fs.mkdirSync(path.dirname(item.sourcePath), {recursive: true});
    if (item.kind === 'file') {
      fs.copyFileSync(item.snapshotPath, item.sourcePath);
    } else {
      fs.cpSync(item.snapshotPath, item.sourcePath, {recursive: true, force: true});
    }
    restoredFilesystem.push({
      label: item.label,
      targetPath: item.sourcePath,
      restored: true,
    });
  }

  const env = options.env ?? process.env;
  const targetDbPath = resolveEnterpriseDbPath(env);
  let restoredDb = false;
  if (manifest.databaseSnapshot.copied && fs.existsSync(manifest.databaseSnapshot.snapshotPath)) {
    assertRestoreTargetSafe(targetDbPath);
    fs.mkdirSync(path.dirname(targetDbPath), {recursive: true});
    fs.rmSync(targetDbPath, {force: true});
    fs.rmSync(`${targetDbPath}-wal`, {force: true});
    fs.rmSync(`${targetDbPath}-shm`, {force: true});
    fs.copyFileSync(manifest.databaseSnapshot.snapshotPath, targetDbPath);
    restoredDb = true;
  }

  return {
    snapshotId: manifest.snapshotId,
    restoredAt: (options.now ?? new Date()).toISOString(),
    restoredFilesystem,
    restoredDatabase: {
      targetPath: targetDbPath,
      restored: restoredDb,
    },
  };
}

export function describeEnterpriseMigrationRollback(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const plan = resolveEnterpriseMigrationPlan(env);
  if (!plan.enterpriseEnabled) {
    return `Enterprise mode is disabled via ${ENTERPRISE_FEATURE_FLAG_ENV}; legacy filesystem storage is authoritative.`;
  }
  if (plan.phase === 'dual-write') {
    return 'P-A rollback: stop enterprise mode or delete the SQLite DB; legacy filesystem data remains authoritative.';
  }
  if (plan.phase === 'cutover') {
    return 'P-B rollback: restore the verified pre-cutover filesystem and SQLite snapshots; dual-write is not a reverse importer.';
  }
  return 'P-C rollback: restore the pre-retirement filesystem snapshot and SQLite DB snapshot; reverse conversion is not promised.';
}

export const ENTERPRISE_MIGRATION_ENV_KEYS = [
  ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
  ENTERPRISE_MIGRATION_SNAPSHOT_DIR_ENV,
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_DB_PATH_ENV,
  DATA_DIR_ENV,
  LOGS_DIR_ENV,
  PROVIDER_DATA_DIR_ENV,
  UPLOAD_DIR_ENV,
] as const;

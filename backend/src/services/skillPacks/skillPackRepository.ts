// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import {
  createEnterpriseWorkspaceRepository,
  type EnterpriseRepositoryScope,
} from '../enterpriseRepository';
import type {
  InstalledSkillPackRecord,
  SkillPackRecordMetadata,
} from './skillPackTypes';
import { SkillPackRequestError } from './skillPackRequestError';

export interface SkillRegistryEntryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  workspace_id: string;
  scope: string;
  version: string;
  enabled: number;
  source_path: string;
  created_at: number;
  updated_at: number;
  metadata_json?: string | null;
}

function recordId(scope: EnterpriseRepositoryScope, packId: string): string {
  return `skillpack_${createHash('sha256')
    .update(`${scope.tenantId}\0${scope.workspaceId}\0${packId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function parseMetadata(row: SkillRegistryEntryRow): SkillPackRecordMetadata | null {
  if (!row.metadata_json) return null;
  const parsed: unknown = JSON.parse(row.metadata_json);
  if (!parsed || typeof parsed !== 'object') return null;
  const metadata = parsed as Partial<SkillPackRecordMetadata>;
  if (metadata.schemaVersion !== 1 || typeof metadata.packId !== 'string') return null;
  return metadata as SkillPackRecordMetadata;
}

function rowToRecord(row: SkillRegistryEntryRow): InstalledSkillPackRecord | null {
  const metadata = parseMetadata(row);
  if (!metadata) return null;
  return {
    id: metadata.packId,
    scope: 'workspace',
    version: row.version,
    enabled: row.enabled === 1,
    sourcePath: row.source_path,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SkillPackRepository {
  private readonly repository;

  constructor(db: Database.Database) {
    this.repository = createEnterpriseWorkspaceRepository<SkillRegistryEntryRow>(
      db,
      'skill_registry_entries',
    );
  }

  get(scope: EnterpriseRepositoryScope, packId: string): InstalledSkillPackRecord | null {
    const row = this.repository.getById(scope, recordId(scope, packId));
    return row ? rowToRecord(row) : null;
  }

  list(scope: EnterpriseRepositoryScope): InstalledSkillPackRecord[] {
    return this.repository
      .list(scope, { scope: 'workspace' }, { orderBy: 'updated_at', direction: 'DESC' })
      .map(rowToRecord)
      .filter((record): record is InstalledSkillPackRecord => record !== null);
  }

  upsert(
    scope: EnterpriseRepositoryScope,
    record: InstalledSkillPackRecord,
  ): InstalledSkillPackRecord {
    this.repository.upsertById(scope, recordId(scope, record.id), {
      scope: 'workspace',
      version: record.version,
      enabled: record.enabled ? 1 : 0,
      source_path: record.sourcePath,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      metadata_json: JSON.stringify(record.metadata),
    });
    const saved = this.get(scope, record.id);
    if (!saved) {
      throw new Error('skill_pack_persist_failed');
    }
    return saved;
  }

  update(scope: EnterpriseRepositoryScope, record: InstalledSkillPackRecord): InstalledSkillPackRecord {
    const changes = this.repository.updateById(scope, recordId(scope, record.id), {
      version: record.version,
      enabled: record.enabled ? 1 : 0,
      source_path: record.sourcePath,
      updated_at: record.updatedAt,
      metadata_json: JSON.stringify(record.metadata),
    });
    if (changes === 0) {
      throw new SkillPackRequestError('skill_pack_not_found', 404);
    }
    const saved = this.get(scope, record.id);
    if (!saved) {
      throw new SkillPackRequestError('skill_pack_not_found', 404);
    }
    return saved;
  }
}

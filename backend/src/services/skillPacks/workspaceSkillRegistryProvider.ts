// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { openEnterpriseDb } from '../enterpriseDb';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import { generateRenderingPipelineDetectionSkill } from '../renderingPipelineDetectionSkillGenerator';
import {
  getSkillsDir,
  SkillRegistry,
  type SkillRootDescriptor,
} from '../skillEngine/skillLoader';
import { SkillPackRepository } from './skillPackRepository';
import type {
  InstalledSkillPackRecord,
  SkillOriginMetadata,
} from './skillPackTypes';
import {buildSkillRegistryAttribution} from '../selfEvolution/skillFingerprint';

export interface WorkspaceSkillRegistryHandle {
  registry: SkillRegistry;
  registryFingerprint: string;
  enabledPacks: InstalledSkillPackRecord[];
  getSkillOrigin(skillId: string): SkillOriginMetadata | undefined;
}

export interface WorkspaceSkillRegistryProviderOptions {
  db?: Database.Database;
  openDb?: () => Database.Database;
  builtInSkillsDir?: string;
}

interface CacheEntry {
  fingerprint: string;
  handle: WorkspaceSkillRegistryHandle;
}

const cache = new Map<string, CacheEntry>();

function scopeKey(scope: EnterpriseRepositoryScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function compareRecords(a: InstalledSkillPackRecord, b: InstalledSkillPackRecord): number {
  const byId = a.id.localeCompare(b.id);
  return byId !== 0 ? byId : a.version.localeCompare(b.version);
}

function listEnabledPackRecords(
  scope: EnterpriseRepositoryScope,
  options: WorkspaceSkillRegistryProviderOptions = {},
): InstalledSkillPackRecord[] {
  const db = options.db ?? options.openDb?.() ?? openEnterpriseDb();
  const shouldClose = !options.db;
  try {
    return new SkillPackRepository(db)
      .list(scope)
      .filter(record => record.enabled)
      .sort(compareRecords);
  } finally {
    if (shouldClose) db.close();
  }
}

function walkRuntimeRelevantFiles(root: string): Array<{ path: string; size: number; mtimeMs: number }> {
  if (!fs.existsSync(root)) return [];
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (
        !entry.isFile()
        || (!entry.name.endsWith('.skill.yaml') && !entry.name.endsWith('.skill.yml') && !entry.name.endsWith('.sql'))
      ) {
        continue;
      }
      const stat = fs.statSync(fullPath);
      out.push({
        path: path.relative(root, fullPath).split(path.sep).join('/'),
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
      });
    }
  };
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function assertNoEnabledPackCollisions(records: InstalledSkillPackRecord[]): void {
  const skillOwners = new Map<string, string>();
  const fragmentOwners = new Map<string, string>();

  for (const record of records) {
    for (const skillId of record.metadata.skillIds) {
      const owner = skillOwners.get(skillId);
      if (owner && owner !== record.id) {
        throw new Error(`workspace_skill_pack_skill_collision:${skillId}`);
      }
      skillOwners.set(skillId, record.id);
    }
    for (const fragmentKey of record.metadata.fragmentKeys) {
      const owner = fragmentOwners.get(fragmentKey);
      if (owner && owner !== record.id) {
        throw new Error(`workspace_skill_pack_fragment_collision:${fragmentKey}`);
      }
      fragmentOwners.set(fragmentKey, record.id);
    }
  }
}

function buildRegistryFingerprint(
  builtInSkillsDir: string,
  records: InstalledSkillPackRecord[],
): string {
  // Filesystem-only cache invalidation identity. This intentionally includes
  // path/mtime inputs and must never be exposed as run attribution.
  const payload = {
    builtInRoot: path.resolve(builtInSkillsDir),
    builtInFiles: walkRuntimeRelevantFiles(builtInSkillsDir),
    packs: records.map(record => ({
      id: record.id,
      version: record.version,
      contentHash: record.metadata.contentHash,
      sourcePath: record.sourcePath,
      skillIds: record.metadata.skillIds,
      fragmentKeys: record.metadata.fragmentKeys,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function rootsForRecords(
  builtInSkillsDir: string,
  records: InstalledSkillPackRecord[],
): SkillRootDescriptor[] {
  return [
    { rootPath: builtInSkillsDir, origin: 'built_in' },
    ...records.map(record => ({
      rootPath: record.sourcePath,
      origin: 'external_pack' as const,
      packId: record.id,
      packVersion: record.version,
      trustState: record.metadata.trustState,
      sourcePath: record.sourcePath,
    })),
  ];
}

async function buildHandle(
  records: InstalledSkillPackRecord[],
  builtInSkillsDir: string,
): Promise<WorkspaceSkillRegistryHandle> {
  const registry = new SkillRegistry();
  await registry.loadSkillRoots(rootsForRecords(builtInSkillsDir, records));

  const generatedSkill = await generateRenderingPipelineDetectionSkill();
  const generatedOrigin = registry.getSkillOrigin(generatedSkill.name);
  if (generatedOrigin?.origin === 'external_pack') {
    throw new Error(`skill_id_collision:${generatedSkill.name}`);
  }
  registry.upsertSkill(generatedSkill);
  const attribution = buildSkillRegistryAttribution(registry);

  return {
    registry,
    registryFingerprint: attribution.registryFingerprint,
    enabledPacks: records,
    getSkillOrigin(skillId: string): SkillOriginMetadata | undefined {
      return registry.getSkillOrigin(skillId);
    },
  };
}

export async function getWorkspaceSkillRegistry(
  scope: EnterpriseRepositoryScope,
  options: WorkspaceSkillRegistryProviderOptions = {},
): Promise<WorkspaceSkillRegistryHandle> {
  const key = scopeKey(scope);
  const builtInSkillsDir = options.builtInSkillsDir ?? getSkillsDir();
  const records = listEnabledPackRecords(scope, options);
  assertNoEnabledPackCollisions(records);
  const fingerprint = buildRegistryFingerprint(builtInSkillsDir, records);
  const cached = cache.get(key);
  if (cached?.fingerprint === fingerprint) {
    return cached.handle;
  }

  const handle = await buildHandle(records, builtInSkillsDir);
  cache.set(key, { fingerprint, handle });
  return handle;
}

export function invalidateWorkspaceSkillRegistry(scope: EnterpriseRepositoryScope): void {
  cache.delete(scopeKey(scope));
}

export function clearWorkspaceSkillRegistryCache(): void {
  cache.clear();
}

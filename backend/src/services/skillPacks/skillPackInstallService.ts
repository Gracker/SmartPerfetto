// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { backendDataPath } from '../../runtimePaths';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import {
  SkillPackRepository,
} from './skillPackRepository';
import { assertSafePackAssetPath, SKILL_PACK_MANIFEST_FILE } from './skillPackManifest';
import type {
  InstalledSkillPackRecord,
  SkillPackManifestV1,
  SkillPackManifestAssetV1,
  SkillPackPreviewResult,
  SkillPackRecordMetadata,
} from './skillPackTypes';
import { SkillPackRequestError } from './skillPackRequestError';

export interface SkillPackInstallServiceOptions {
  now?: () => number;
  resolveManagedRoot?: (scope: EnterpriseRepositoryScope, manifest: SkillPackManifestV1) => string;
  invalidate?: (scope: EnterpriseRepositoryScope) => void;
}

function requireInstallablePreview(preview: SkillPackPreviewResult): {
  manifest: SkillPackManifestV1;
  manifestHash: string;
  contentHash: string;
} {
  if (!preview.success || !preview.manifest || !preview.manifestHash || !preview.contentHash) {
    throw new SkillPackRequestError('skill_pack_preview_not_installable');
  }
  return {
    manifest: preview.manifest,
    manifestHash: preview.manifestHash,
    contentHash: preview.contentHash,
  };
}

function defaultManagedRoot(scope: EnterpriseRepositoryScope, manifest: SkillPackManifestV1): string {
  return backendDataPath('skill-packs', scope.tenantId, scope.workspaceId, manifest.packId, manifest.version);
}

function readVerifiedAsset(preview: SkillPackPreviewResult, asset: SkillPackManifestAssetV1): Buffer {
  assertSafePackAssetPath(asset.path);
  const sourcePath = path.join(preview.sourcePath, asset.path);
  const content = fs.readFileSync(sourcePath);
  if (content.byteLength !== asset.sizeBytes) {
    throw new SkillPackRequestError('asset_size_mismatch', 409, asset.path);
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== asset.sha256) {
    throw new SkillPackRequestError('asset_hash_mismatch', 409, asset.path);
  }
  return content;
}

function copyDeclaredAssets(preview: SkillPackPreviewResult, destinationRoot: string): void {
  if (!preview.manifest) {
    throw new SkillPackRequestError('skill_pack_preview_not_installable');
  }
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  fs.writeFileSync(
    path.join(destinationRoot, SKILL_PACK_MANIFEST_FILE),
    JSON.stringify(preview.manifest, null, 2),
    'utf8',
  );
  for (const asset of preview.manifest.assets) {
    const content = readVerifiedAsset(preview, asset);
    const destinationPath = path.join(destinationRoot, asset.path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, content);
  }
}

export class SkillPackInstallService {
  constructor(
    private readonly repository: SkillPackRepository,
    private readonly options: SkillPackInstallServiceOptions = {},
  ) {}

  async installSkillPack(
    scope: EnterpriseRepositoryScope,
    actorUserId: string,
    preview: SkillPackPreviewResult,
  ): Promise<InstalledSkillPackRecord> {
    const installable = requireInstallablePreview(preview);
    const { manifest, manifestHash, contentHash } = installable;
    const existing = this.repository.get(scope, manifest.packId);
    if (
      existing
      && existing.version === manifest.version
      && existing.metadata.contentHash !== contentHash
    ) {
      // The same version with different content: the caller bumps the version.
      throw new SkillPackRequestError('installed_pack_content_hash_mismatch', 409);
    }

    const now = this.options.now?.() ?? Date.now();
    const sourcePath = this.options.resolveManagedRoot?.(scope, manifest)
      ?? defaultManagedRoot(scope, manifest);
    copyDeclaredAssets(preview, sourcePath);

    const metadata: SkillPackRecordMetadata = {
      schemaVersion: 1,
      packId: manifest.packId,
      name: manifest.name,
      publisher: manifest.publisher,
      manifestHash,
      contentHash,
      trustState: 'approved',
      approvedBy: actorUserId,
      approvedAt: now,
      skillIds: [...preview.skillIds],
      fragmentKeys: [...preview.fragmentKeys],
      docPaths: [...preview.docPaths],
    };
    const record = this.repository.upsert(scope, {
      id: manifest.packId,
      scope: 'workspace',
      version: manifest.version,
      enabled: true,
      sourcePath,
      metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.options.invalidate?.(scope);
    return record;
  }

  async setSkillPackEnabled(
    scope: EnterpriseRepositoryScope,
    packId: string,
    enabled: boolean,
  ): Promise<InstalledSkillPackRecord> {
    const existing = this.repository.get(scope, packId);
    if (!existing) {
      throw new SkillPackRequestError('skill_pack_not_found', 404);
    }
    const now = this.options.now?.() ?? Date.now();
    const metadata: SkillPackRecordMetadata = {
      ...existing.metadata,
      ...(enabled ? {} : { disabledAt: now }),
    };
    if (enabled) {
      delete metadata.disabledAt;
    }
    const record = this.repository.update(scope, {
      ...existing,
      enabled,
      metadata,
      updatedAt: now,
    });
    this.options.invalidate?.(scope);
    return record;
  }

  async removeSkillPack(scope: EnterpriseRepositoryScope, packId: string): Promise<InstalledSkillPackRecord> {
    const existing = this.repository.get(scope, packId);
    if (!existing) {
      throw new SkillPackRequestError('skill_pack_not_found', 404);
    }
    const now = this.options.now?.() ?? Date.now();
    const disabled = this.repository.update(scope, {
      ...existing,
      enabled: false,
      metadata: {
        ...existing.metadata,
        disabledAt: now,
      },
      updatedAt: now,
    });
    fs.rmSync(disabled.sourcePath, { recursive: true, force: true });
    this.options.invalidate?.(scope);
    return disabled;
  }
}

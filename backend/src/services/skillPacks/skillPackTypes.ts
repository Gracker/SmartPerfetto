// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type SkillPackAssetKind = 'skill' | 'fragment' | 'doc';
export type SkillPackTrustState = 'local_unverified' | 'approved';
export type SkillOriginKind = 'built_in' | 'external_pack';

export interface SkillPackManifestAssetV1 {
  kind: SkillPackAssetKind;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface SkillPackManifestV1 {
  schemaVersion: 1;
  packId: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  assets: SkillPackManifestAssetV1[];
  compatibility: {
    smartPerfettoMinVersion: string;
  };
  trust?: {
    signature?: string;
    publicKeyId?: string;
  };
}

export interface ParsedSkillPackManifest {
  manifest: SkillPackManifestV1;
  manifestHash: string;
}

export interface SkillPackPreviewIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SkillPackPreviewResult {
  success: boolean;
  sourcePath: string;
  manifest?: SkillPackManifestV1;
  manifestHash?: string;
  contentHash?: string;
  skillIds: string[];
  fragmentKeys: string[];
  docPaths: string[];
  errors: SkillPackPreviewIssue[];
  warnings: SkillPackPreviewIssue[];
}

export interface SkillPackRecordMetadata {
  schemaVersion: 1;
  packId: string;
  name: string;
  publisher: string;
  manifestHash: string;
  contentHash: string;
  trustState: SkillPackTrustState;
  approvedBy: string;
  approvedAt: number;
  disabledAt?: number;
  skillIds: string[];
  fragmentKeys: string[];
  docPaths: string[];
}

export interface SkillOriginMetadata {
  origin: SkillOriginKind;
  packId?: string;
  packVersion?: string;
  trustState?: SkillPackTrustState;
  sourcePath?: string;
}

export interface InstalledSkillPackRecord {
  id: string;
  scope: 'workspace';
  version: string;
  enabled: boolean;
  sourcePath: string;
  metadata: SkillPackRecordMetadata;
  createdAt: number;
  updatedAt: number;
}

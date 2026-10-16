// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import path from 'path';
import type {
  ParsedSkillPackManifest,
  SkillPackAssetKind,
  SkillPackManifestAssetV1,
  SkillPackManifestV1,
} from './skillPackTypes';
import { SkillPackRequestError } from './skillPackRequestError';
import { PACK_SKILL_DIRS, SKILL_FILE_PATTERN, SKILL_LAYOUT } from '../skillEngine/skillLayout';

export const SKILL_PACK_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SKILL_PACK_MANIFEST_FILE = 'smartperfetto-skill-pack.json';
export const MAX_SKILL_PACK_ASSET_COUNT = 512;
export const MAX_SKILL_PACK_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_PACK_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;

const PACK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/;
const VERSION_RE = /^[A-Za-z0-9_.+-]{1,96}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ALLOWED_SKILL_ROOTS: ReadonlySet<string> = new Set(PACK_SKILL_DIRS);
const ALLOWED_ROOTS: ReadonlySet<string> = new Set([
  ...ALLOWED_SKILL_ROOTS,
  SKILL_LAYOUT.fragmentsDir,
  SKILL_LAYOUT.docsDir,
]);
const EXECUTABLE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.dylib',
  '.so',
  '.dll',
  '.exe',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, errorCode: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SkillPackRequestError(errorCode);
  }
  return value.trim();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function manifestHashFor(value: SkillPackManifestV1): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function isAllowedPackAssetKind(kind: string): kind is SkillPackAssetKind {
  return kind === 'skill' || kind === 'fragment' || kind === 'doc';
}

export function assertSafePackAssetPath(assetPath: string): void {
  if (typeof assetPath !== 'string' || assetPath.trim().length === 0) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
  const raw = assetPath.trim();
  if (raw.includes('\\') || path.posix.isAbsolute(raw)) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized === '.' || normalized.startsWith('../')) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
  const root = parts[0];
  if (!ALLOWED_ROOTS.has(root)) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
  if (EXECUTABLE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw new SkillPackRequestError('invalid_asset_path');
  }
}

function normalizeAsset(value: unknown): SkillPackManifestAssetV1 {
  if (!isRecord(value)) {
    throw new SkillPackRequestError('invalid_asset');
  }
  const kindRaw = requireString(value.kind, 'unsupported_asset_kind');
  if (!isAllowedPackAssetKind(kindRaw)) {
    throw new SkillPackRequestError('unsupported_asset_kind');
  }
  const assetPath = requireString(value.path, 'invalid_asset_path');
  assertSafePackAssetPath(assetPath);

  const root = assetPath.split('/')[0];
  if (kindRaw === 'skill') {
    if (!ALLOWED_SKILL_ROOTS.has(root) || !SKILL_FILE_PATTERN.test(assetPath)) {
      throw new SkillPackRequestError('invalid_asset_path');
    }
  } else if (kindRaw === 'fragment') {
    if (root !== SKILL_LAYOUT.fragmentsDir || assetPath.split('/').length !== 2 || !assetPath.endsWith('.sql')) {
      throw new SkillPackRequestError('invalid_asset_path');
    }
  } else if (kindRaw === 'doc' && root !== SKILL_LAYOUT.docsDir) {
    throw new SkillPackRequestError('invalid_asset_path');
  }

  const sha256 = requireString(value.sha256, 'invalid_sha256').toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    throw new SkillPackRequestError('invalid_sha256');
  }
  const sizeBytes = value.sizeBytes;
  if (
    typeof sizeBytes !== 'number'
    || !Number.isInteger(sizeBytes)
    || sizeBytes < 0
    || sizeBytes > MAX_SKILL_PACK_ASSET_BYTES
  ) {
    throw new SkillPackRequestError('asset_too_large');
  }
  return {
    kind: kindRaw,
    path: assetPath,
    sha256,
    sizeBytes,
  };
}

export function parseSkillPackManifest(value: unknown): ParsedSkillPackManifest {
  if (!isRecord(value) || value.schemaVersion !== SKILL_PACK_MANIFEST_SCHEMA_VERSION) {
    throw new SkillPackRequestError('invalid_schema_version');
  }
  const packId = requireString(value.packId, 'invalid_pack_id');
  if (!PACK_ID_RE.test(packId)) {
    throw new SkillPackRequestError('invalid_pack_id');
  }
  const version = requireString(value.version, 'invalid_version');
  if (!VERSION_RE.test(version)) {
    throw new SkillPackRequestError('invalid_version');
  }
  if (!Array.isArray(value.assets)) {
    throw new SkillPackRequestError('invalid_assets');
  }
  if (value.assets.length === 0 || value.assets.length > MAX_SKILL_PACK_ASSET_COUNT) {
    throw new SkillPackRequestError('invalid_asset_count');
  }
  const assets = value.assets.map(normalizeAsset);
  const totalAssetBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  if (totalAssetBytes > MAX_SKILL_PACK_TOTAL_ASSET_BYTES) {
    throw new SkillPackRequestError('asset_total_too_large');
  }
  const compatibility = isRecord(value.compatibility) ? value.compatibility : {};
  const smartPerfettoMinVersion = requireString(
    compatibility.smartPerfettoMinVersion,
    'invalid_compatibility',
  );

  const manifest: SkillPackManifestV1 = {
    schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
    packId,
    name: requireString(value.name, 'invalid_name'),
    version,
    publisher: requireString(value.publisher, 'invalid_publisher'),
    description: requireString(value.description, 'invalid_description'),
    license: requireString(value.license, 'invalid_license'),
    assets,
    compatibility: {
      smartPerfettoMinVersion,
    },
  };
  if (isRecord(value.trust)) {
    const trust: SkillPackManifestV1['trust'] = {};
    if (typeof value.trust.signature === 'string' && value.trust.signature.trim()) {
      trust.signature = value.trust.signature.trim();
    }
    if (typeof value.trust.publicKeyId === 'string' && value.trust.publicKeyId.trim()) {
      trust.publicKeyId = value.trust.publicKeyId.trim();
    }
    if (trust.signature || trust.publicKeyId) {
      manifest.trust = trust;
    }
  }

  return {
    manifest,
    manifestHash: manifestHashFor(manifest),
  };
}

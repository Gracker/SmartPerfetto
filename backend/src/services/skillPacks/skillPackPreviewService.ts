// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  assertSafePackAssetPath,
  canonicalJson,
  parseSkillPackManifest,
  SKILL_PACK_MANIFEST_FILE,
} from './skillPackManifest';
import type {
  SkillPackManifestAssetV1,
  SkillPackPreviewIssue,
  SkillPackPreviewResult,
} from './skillPackTypes';
import { SkillRegistry, SkillRegistryRejectionError, getSkillsDir } from '../skillEngine/skillLoader';
import { SkillPackRequestError } from './skillPackRequestError';

export interface PreviewSkillPackInput {
  sourcePath: string;
  builtInSkillsDir?: string;
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function issue(code: string, message: string, assetPath?: string): SkillPackPreviewIssue {
  return assetPath ? { code, message, path: assetPath } : { code, message };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function walkFiles(root: string, errors: SkillPackPreviewIssue[]): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = toPosixRelative(root, fullPath);
      if (entry.name.startsWith('.')) {
        errors.push(issue('invalid_asset_path', 'hidden files are not allowed', relativePath));
        continue;
      }
      if (entry.isSymbolicLink()) {
        errors.push(issue('symlink_not_allowed', 'symlinks are not allowed in skill packs', relativePath));
        continue;
      }
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function contentHashFor(manifestHash: string, assets: SkillPackManifestAssetV1[]): string {
  return createHash('sha256')
    .update(canonicalJson({
      manifestHash,
      assets: [...assets].sort((a, b) => a.path.localeCompare(b.path)),
    }), 'utf8')
    .digest('hex');
}

function skillIdFromAsset(root: string, asset: SkillPackManifestAssetV1): string | undefined {
  if (asset.kind !== 'skill') return undefined;
  const loaded = yaml.load(fs.readFileSync(path.join(root, asset.path), 'utf8'));
  if (loaded && typeof loaded === 'object' && 'name' in loaded) {
    const name = (loaded as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }
  return undefined;
}

/**
 * A preview issue code. Pack validation throws reason tokens; a JSON parse,
 * filesystem or Skill loader error can quote file content or server paths, so
 * it is logged and reported as the fallback code.
 */
function previewIssueCode(error: unknown, fallback: string): string {
  if (error instanceof SkillPackRequestError || error instanceof SkillRegistryRejectionError) return error.message;
  console.warn('[SkillPackPreview] Validation error', error);
  return fallback;
}

export async function previewSkillPack(input: PreviewSkillPackInput): Promise<SkillPackPreviewResult> {
  const sourcePath = path.resolve(input.sourcePath);
  const errors: SkillPackPreviewIssue[] = [];
  const warnings: SkillPackPreviewIssue[] = [];
  const baseResult = {
    success: false,
    sourcePath,
    skillIds: [],
    fragmentKeys: [],
    docPaths: [],
    errors,
    warnings,
  };

  if (/^https?:\/\//i.test(input.sourcePath) || /\.(zip|tgz|tar|tar\.gz)$/i.test(input.sourcePath)) {
    errors.push(issue('unsupported_source', 'only local directory skill packs are supported'));
    return baseResult;
  }
  if (!path.isAbsolute(input.sourcePath)) {
    errors.push(issue('source_path_must_be_absolute', 'sourcePath must be an absolute local directory path'));
    return baseResult;
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    errors.push(issue('source_not_directory', 'sourcePath must point to a local directory'));
    return baseResult;
  }

  const manifestPath = path.join(sourcePath, SKILL_PACK_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    errors.push(issue('missing_manifest', `${SKILL_PACK_MANIFEST_FILE} is required`));
    return baseResult;
  }

  let parsed;
  try {
    parsed = parseSkillPackManifest(readJsonFile(manifestPath));
  } catch (error) {
    errors.push(issue(previewIssueCode(error, 'invalid_manifest'), 'manifest validation failed'));
    return baseResult;
  }

  const declaredAssets = new Map(parsed.manifest.assets.map(asset => [asset.path, asset]));
  const actualFiles = walkFiles(sourcePath, errors).filter(file => file !== SKILL_PACK_MANIFEST_FILE);
  for (const actualPath of actualFiles) {
    try {
      assertSafePackAssetPath(actualPath);
    } catch (error) {
      errors.push(issue(previewIssueCode(error, 'invalid_asset_path'), 'asset path is not allowed', actualPath));
      continue;
    }
    if (!declaredAssets.has(actualPath)) {
      errors.push(issue('undeclared_asset', 'asset is not declared in the manifest', actualPath));
    }
  }

  const skillIds: string[] = [];
  const seenSkillIds = new Set<string>();
  for (const asset of parsed.manifest.assets) {
    const assetPath = path.join(sourcePath, asset.path);
    if (!fs.existsSync(assetPath)) {
      errors.push(issue('missing_asset', 'declared asset is missing', asset.path));
      continue;
    }
    const stat = fs.statSync(assetPath);
    if (stat.size !== asset.sizeBytes) {
      errors.push(issue('asset_size_mismatch', 'asset size does not match manifest', asset.path));
    }
    const actualHash = sha256File(assetPath);
    if (actualHash !== asset.sha256) {
      errors.push(issue('asset_hash_mismatch', 'asset sha256 does not match manifest', asset.path));
    }
    const skillId = skillIdFromAsset(sourcePath, asset);
    if (skillId) {
      if (seenSkillIds.has(skillId)) {
        errors.push(issue('duplicate_skill_id', `duplicate skill id ${skillId}`, asset.path));
      } else {
        seenSkillIds.add(skillId);
        skillIds.push(skillId);
      }
    }
  }

  const fragmentKeys = parsed.manifest.assets
    .filter(asset => asset.kind === 'fragment')
    .map(asset => asset.path);
  const docPaths = parsed.manifest.assets
    .filter(asset => asset.kind === 'doc')
    .map(asset => asset.path);

  if (errors.length === 0) {
    const registry = new SkillRegistry();
    try {
      await registry.loadSkillRoots([
        {
          rootPath: input.builtInSkillsDir ?? getSkillsDir(),
          origin: 'built_in',
        },
        {
          rootPath: sourcePath,
          origin: 'external_pack',
          packId: parsed.manifest.packId,
          packVersion: parsed.manifest.version,
          trustState: 'local_unverified',
          sourcePath,
        },
      ]);
    } catch (error) {
      errors.push(issue(
        previewIssueCode(error, 'skill_pack_validation_failed'),
        'isolated skill registry validation failed',
      ));
    }
  }

  return {
    success: errors.length === 0,
    sourcePath,
    manifest: parsed.manifest,
    manifestHash: parsed.manifestHash,
    contentHash: contentHashFor(parsed.manifestHash, parsed.manifest.assets),
    skillIds,
    fragmentKeys,
    docPaths,
    errors,
    warnings,
  };
}

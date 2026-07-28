// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';
import {createHash} from 'crypto';
import {execFile} from 'child_process';
import {promisify} from 'util';

import type {CodebaseRef} from '../codebase/codebaseRegistry';
import {
  DEFAULT_SOURCE_MAX_TOTAL_BYTES,
  type PathSecurityGate,
  type PathPreviewFile,
  type PathPreviewResult,
} from '../codebase/pathSecurityGate';

export const MAX_SOURCE_CHUNKS_PER_GENERATION = 20_000;
export const SOURCE_INGEST_WRITE_BATCH_SIZE = 500;
const execFileAsync = promisify(execFile);

export interface SourceGenerationProvenance {
  contentFingerprint: string;
  fileContentHashes: ReadonlyMap<string, string>;
  indexedRevision?: string;
  sourceDirty: boolean;
  commitProvenance: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
}

export function normalizeSourceRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function sourceAbsolutePath(rootRealpath: string, relativePath: string): string {
  return path.join(rootRealpath, ...normalizeSourceRelativePath(relativePath).split('/'));
}

export function assertCodebaseRootIdentity(
  registeredRootRealpath: string,
  previewRootRealpath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  if (normalize(registeredRootRealpath) !== normalize(previewRootRealpath)) {
    throw new Error('codebase_root_realpath_drift');
  }
}

export function previewRegisteredCodebaseRoot(
  gate: PathSecurityGate,
  ref: Pick<CodebaseRef, 'rootRealpath' | 'rootAuthorization'>,
): Promise<PathPreviewResult> {
  return gate.preview(
    ref.rootRealpath,
    ref.rootAuthorization === 'native_picker'
      ? {additionalAllowlistRoots: [ref.rootRealpath]}
      : undefined,
  );
}

export function resolveMaxChunkChars(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 256 || Number(value) > 65_536) {
    throw new Error('maxChunkChars must be an integer between 256 and 65536');
  }
  return Number(value);
}

export function resolveMaxSourceChunks(value: unknown): number {
  if (value === undefined) return MAX_SOURCE_CHUNKS_PER_GENERATION;
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_SOURCE_CHUNKS_PER_GENERATION
  ) {
    throw new Error(
      `maxChunks must be an integer between 1 and ${MAX_SOURCE_CHUNKS_PER_GENERATION}`,
    );
  }
  return Number(value);
}

export function isCodebaseIngestLeaseLost(error: unknown): error is Error {
  return error instanceof Error && error.message === 'codebase_reindex_lease_lost';
}

export function isSourceChunkLimitExceeded(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('source_chunk_limit_exceeded:');
}

export function resolveSourcePathPrefix(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 1024) {
    throw new Error('pathPrefix must be a string of at most 1024 characters');
  }
  return value;
}

export function resolveSourcePathPatterns(
  value: unknown,
  fieldName: 'pathFilters' | 'excludeGlobs',
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${fieldName} must be an array with at most 128 entries`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName}[${index}] must be a string`);
    }
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0')) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string of at most 1024 characters`);
    }
    if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
      throw new Error(`${fieldName}[${index}] must be relative`);
    }
    const normalized = normalizeSourceRelativePath(trimmed);
    if (normalized.split('/').includes('..')) {
      throw new Error(`${fieldName}[${index}] must not traverse parent directories`);
    }
    return normalized;
  });
}

function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  const normalized = normalizeSourceRelativePath(glob);
  let pattern = '^';
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      index++;
      if (normalized[index + 1] === '/') {
        index++;
        pattern += '(?:.*/)?';
      } else {
        pattern += '.*';
      }
      continue;
    }
    if (character === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (character === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${pattern}$`, caseInsensitive ? 'i' : undefined);
}

function pathMatchesPrefix(relativePath: string, prefix: string, caseInsensitive: boolean): boolean {
  const normalizedPrefix = normalizeSourceRelativePath(prefix).replace(/\/$/, '');
  const comparablePath = caseInsensitive ? relativePath.toLocaleLowerCase('en-US') : relativePath;
  const comparablePrefix = caseInsensitive ? normalizedPrefix.toLocaleLowerCase('en-US') : normalizedPrefix;
  return !comparablePrefix || comparablePath === comparablePrefix || comparablePath.startsWith(`${comparablePrefix}/`);
}

export function selectCodebasePreviewFiles(
  preview: PathPreviewResult,
  ref: CodebaseRef,
  pathPrefix?: string,
  platform: NodeJS.Platform = process.platform,
): PathPreviewFile[] {
  const caseInsensitive = platform === 'win32';
  const registeredPrefixes = (ref.pathFilters ?? [])
    .filter(Boolean)
    .map(normalizeSourceRelativePath);
  const requestedPrefix = pathPrefix ? normalizeSourceRelativePath(pathPrefix) : undefined;
  const excludePatterns = (ref.excludeGlobs ?? [])
    .filter(Boolean)
    .map(pattern => globToRegExp(pattern, caseInsensitive));
  return preview.acceptedFiles.filter(file => {
    const relativePath = normalizeSourceRelativePath(file.relativePath);
    if (
      registeredPrefixes.length > 0 &&
      !registeredPrefixes.some(prefix => pathMatchesPrefix(relativePath, prefix, caseInsensitive))
    ) {
      return false;
    }
    if (requestedPrefix && !pathMatchesPrefix(relativePath, requestedPrefix, caseInsensitive)) {
      return false;
    }
    return !excludePatterns.some(pattern => pattern.test(relativePath));
  });
}

/**
 * Hash the exact source bytes selected for a generation before staging any
 * chunks. A second-pass hash check during ingestion prevents a generation from
 * silently mixing files that changed while the index was being built.
 */
export async function inspectSourceGeneration(
  rootRealpath: string,
  files: readonly PathPreviewFile[],
  readFile: (root: string, relativePath: string) => string | Promise<string>,
  maxTotalBytes = DEFAULT_SOURCE_MAX_TOTAL_BYTES,
): Promise<SourceGenerationProvenance> {
  const fileContentHashes = new Map<string, string>();
  const corpusHash = createHash('sha256');
  let actualTotalBytes = 0;
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    // Secure file opening remains synchronous, but yielding per file prevents
    // a 50k-file provenance pass from monopolizing the HTTP event loop.
    await new Promise<void>(resolve => setImmediate(resolve));
    const relativePath = normalizeSourceRelativePath(file.relativePath);
    const content = await readFile(rootRealpath, relativePath);
    actualTotalBytes += Buffer.byteLength(content, 'utf8');
    if (actualTotalBytes > maxTotalBytes) {
      throw new Error(`source_total_bytes_exceeded:${maxTotalBytes}`);
    }
    const contentHash = createHash('sha256')
      .update(content)
      .digest('hex');
    fileContentHashes.set(relativePath, contentHash);
    corpusHash.update(relativePath).update('\0').update(contentHash).update('\n');
  }

  let indexedRevision: string | undefined;
  let sourceDirty = false;
  try {
    indexedRevision = (await execFileAsync('git', ['-C', rootRealpath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })).stdout.trim() || undefined;
    sourceDirty = (await execFileAsync(
      'git',
      ['-C', rootRealpath, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
    )).stdout.trim().length > 0;
  } catch {
    indexedRevision = undefined;
    sourceDirty = false;
  }

  return {
    contentFingerprint: corpusHash.digest('hex'),
    fileContentHashes,
    ...(indexedRevision ? {indexedRevision} : {}),
    sourceDirty,
    commitProvenance: indexedRevision
      ? (sourceDirty ? 'dirty_git_worktree' : 'clean_git_revision')
      : 'content_only',
  };
}

export function assertSourceFileUnchanged(
  provenance: SourceGenerationProvenance,
  relativePath: string,
  content: string,
): void {
  const normalizedPath = normalizeSourceRelativePath(relativePath);
  const expected = provenance.fileContentHashes.get(normalizedPath);
  const actual = createHash('sha256').update(content).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`source_changed_during_ingest:${normalizedPath}`);
  }
}

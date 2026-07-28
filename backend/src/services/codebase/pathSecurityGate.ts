// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const DEFAULT_EXCLUDES = [
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  'build',
  'out',
  'target',
  'secrets',
];

export const DEFAULT_SOURCE_MAX_FILE_BYTES = 200 * 1024;
export const DEFAULT_SOURCE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const DEFAULT_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  '.py',
  '.kts',
  '.gradle',
  '.mk',
  '.bp',
  '.rc',
  '.te',
  '.conf',
  '.properties',
  '.aidl',
  '.proto',
  '.xml',
]);

export interface PathSecurityGateOptions {
  allowlistRoots?: string[];
  /** Environment variable read lazily when allowlistRoots is not provided. */
  allowlistEnvironmentVariable?: string;
  excludeNames?: string[];
  allowedExtensions?: readonly string[];
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxVisitedEntries?: number;
  maxDirectories?: number;
  maxSkippedDiagnostics?: number;
  /** Test/portable override; defaults to the current runtime platform. */
  platform?: NodeJS.Platform;
}

export interface PathPreviewFile {
  relativePath: string;
  sizeBytes: number;
}

export interface PathPreviewResult {
  rootPath: string;
  rootRealpath: string;
  acceptedFiles: PathPreviewFile[];
  skippedFiles: Array<{relativePath: string; reason: string}>;
  /** Total skipped paths; skippedFiles is only a bounded diagnostic sample. */
  skippedFileCount: number;
  blocked: boolean;
  blockedReason?: string;
}

export interface PathPreviewOptions {
  /**
   * Request-scoped roots that have already been authorized by a trusted
   * caller, such as a one-time native directory selection. These roots are
   * never retained on the gate or added to the process-wide environment
   * allowlist.
   */
  additionalAllowlistRoots?: readonly string[];
}

function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function configuredAllowlistRoots(environmentVariable: string): string[] {
  const roots = parsePathList(process.env[environmentVariable]);
  const unsafeDevRoot = environmentVariable === 'SMARTPERFETTO_CODEBASE_ROOTS'
    ? process.env.SMARTPERFETTO_DEV_UNSAFE_CODEBASE_ROOT
    : undefined;
  if (unsafeDevRoot && process.env.NODE_ENV !== 'production') {
    roots.push(unsafeDevRoot);
  }
  return roots;
}

function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

async function safeRealpathAsync(target: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(target);
  } catch {
    return null;
  }
}

export function isWithinAllowlist(target: string, allowlist: string[]): boolean {
  const realTarget = safeRealpath(target);
  if (!realTarget) return false;
  for (const root of allowlist) {
    const realRoot = safeRealpath(root);
    if (!realRoot) continue;
    const rel = path.relative(realRoot, realTarget);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function shouldExclude(
  relativePath: string,
  basename: string,
  excludeNames: string[],
  caseInsensitive: boolean,
): boolean {
  const comparableBasename = caseInsensitive ? basename.toLocaleLowerCase('en-US') : basename;
  if (comparableBasename.startsWith('.env')) return true;
  if (comparableBasename.endsWith('.log') || comparableBasename.endsWith('.bak')) return true;
  const parts = relativePath.split(/[\\/]/);
  const excluded = caseInsensitive
    ? new Set(excludeNames.map(name => name.toLocaleLowerCase('en-US')))
    : new Set(excludeNames);
  return parts.some(part => excluded.has(caseInsensitive ? part.toLocaleLowerCase('en-US') : part));
}

function toPortableRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

type FileIdentity = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;

export function openedFileIdentityError(
  before: FileIdentity,
  opened: FileIdentity,
  noFollowAvailable: boolean,
): 'source_file_identity_unavailable' | 'source_file_identity_changed' | 'source_file_changed_during_open' | undefined {
  const stableIdentityAvailable = before.ino !== 0 && opened.ino !== 0;
  if (!stableIdentityAvailable && !noFollowAvailable) return 'source_file_identity_unavailable';
  if (stableIdentityAvailable && (before.dev !== opened.dev || before.ino !== opened.ino)) {
    return 'source_file_identity_changed';
  }
  if (before.size !== opened.size || before.mtimeMs !== opened.mtimeMs) {
    return 'source_file_changed_during_open';
  }
  return undefined;
}

export function readOpenedTextFileBoundedSync(
  descriptor: number,
  opened: fs.Stats,
  maxFileBytes: number,
): string {
  const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      null,
    );
    if (count === 0) break;
    bytesRead += count;
  }
  if (bytesRead > maxFileBytes) throw new Error('source_file_changed_or_too_large');
  const after = fs.fstatSync(descriptor);
  if (
    !after.isFile() ||
    after.dev !== opened.dev ||
    (opened.ino !== 0 && after.ino !== 0 && after.ino !== opened.ino) ||
    after.size !== opened.size ||
    after.mtimeMs !== opened.mtimeMs
  ) {
    throw new Error('source_file_changed_during_read');
  }
  return buffer.toString('utf8', 0, bytesRead);
}

/**
 * Revalidate and read one previewed file without following a swapped symlink.
 * Callers should keep the portable relative path returned by preview().
 */
export function readAcceptedTextFileSync(
  rootRealpath: string,
  relativePath: string,
  maxFileBytes = DEFAULT_SOURCE_MAX_FILE_BYTES,
): string {
  const canonicalRoot = fs.realpathSync(rootRealpath);
  const normalizedRegisteredRoot = path.resolve(rootRealpath);
  const normalizeIdentity = (value: string): string => process.platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  if (normalizeIdentity(canonicalRoot) !== normalizeIdentity(normalizedRegisteredRoot)) {
    throw new Error('codebase_root_realpath_drift');
  }
  const portablePath = relativePath.replace(/\\/g, '/');
  const segments = portablePath.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('source_path_invalid');
  }
  const candidate = path.join(canonicalRoot, ...segments);
  const before = fs.lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('source_path_not_regular_file');
  const realPath = fs.realpathSync(candidate);
  const relative = path.relative(canonicalRoot, realPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('source_path_outside_root');
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  let noFollowUsed = noFollow !== 0;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (process.platform !== 'win32' || noFollow === 0) throw error;
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
    noFollowUsed = false;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('source_file_changed_or_too_large');
    const identityError = openedFileIdentityError(before, stat, noFollowUsed);
    if (identityError) throw new Error(identityError);
    // Never read to EOF without a hard bound. A writable checkout can grow
    // after fstat; reading at most max+1 both caps allocation and detects that
    // race before any source text reaches the indexing pipeline.
    const content = readOpenedTextFileBoundedSync(descriptor, stat, maxFileBytes);
    const afterRootRealPath = fs.realpathSync(rootRealpath);
    if (normalizeIdentity(afterRootRealPath) !== normalizeIdentity(canonicalRoot)) {
      throw new Error('codebase_root_realpath_drift');
    }
    const afterRealPath = fs.realpathSync(candidate);
    if (afterRealPath !== realPath) throw new Error('source_path_changed_during_read');
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

export class PathSecurityGate {
  // null means "read from env at call time" (supports dotenv loaded after module init)
  private readonly allowlistRootsOverride: string[] | null;
  private readonly allowlistEnvironmentVariable: string;
  private readonly excludeNames: string[];
  private readonly allowedExtensions: Set<string>;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxVisitedEntries: number;
  private readonly maxDirectories: number;
  private readonly maxSkippedDiagnostics: number;
  private readonly platform: NodeJS.Platform;

  constructor(options: PathSecurityGateOptions = {}) {
    this.allowlistRootsOverride = options.allowlistRoots ?? null;
    this.allowlistEnvironmentVariable = options.allowlistEnvironmentVariable ??
      'SMARTPERFETTO_CODEBASE_ROOTS';
    this.platform = options.platform ?? process.platform;
    this.excludeNames = options.excludeNames ?? DEFAULT_EXCLUDES;
    const caseInsensitive = this.platform === 'win32';
    this.allowedExtensions = new Set(Array.from(options.allowedExtensions ?? DEFAULT_EXTENSIONS, extension => (
      caseInsensitive ? extension.toLocaleLowerCase('en-US') : extension
    )));
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_SOURCE_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? 50_000;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SOURCE_MAX_TOTAL_BYTES;
    this.maxVisitedEntries = options.maxVisitedEntries ?? Math.max(this.maxFiles * 4, 200_000);
    this.maxDirectories = options.maxDirectories ?? Math.min(this.maxVisitedEntries, 50_000);
    this.maxSkippedDiagnostics = options.maxSkippedDiagnostics ?? 1_000;
  }

  getSourceReadLimits(): Readonly<{maxFileBytes: number; maxTotalBytes: number}> {
    return {
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
    };
  }

  async preview(
    rootPath: string,
    options: PathPreviewOptions = {},
  ): Promise<PathPreviewResult> {
    // Read env lazily so SMARTPERFETTO_CODEBASE_ROOTS set via dotenv (loaded after
    // module init in ESM) is visible on the first real request.
    const configuredRoots = this.allowlistRootsOverride ??
      configuredAllowlistRoots(this.allowlistEnvironmentVariable);
    const allowlistRoots = [
      ...configuredRoots,
      ...(options.additionalAllowlistRoots ?? []),
    ];
    const rootRealpath = await safeRealpathAsync(rootPath);
    if (!rootRealpath) {
      return {
        rootPath,
        rootRealpath: '',
        acceptedFiles: [],
        skippedFiles: [],
        skippedFileCount: 0,
        blocked: true,
        blockedReason: 'root_not_found',
      };
    }
    if (allowlistRoots.length === 0 || !isWithinAllowlist(rootRealpath, allowlistRoots)) {
      return {
        rootPath,
        rootRealpath,
        acceptedFiles: [],
        skippedFiles: [],
        skippedFileCount: 0,
        blocked: true,
        blockedReason: 'root_outside_allowlist',
      };
    }

    const acceptedFiles: PathPreviewFile[] = [];
    const skippedFiles: Array<{relativePath: string; reason: string}> = [];
    const stack = [rootRealpath];
    let acceptedBytes = 0;
    let visitedEntries = 0;
    let visitedDirectories = 1;
    let skippedFileCount = 0;
    const recordSkipped = (relativePath: string, reason: string): void => {
      skippedFileCount += 1;
      if (skippedFiles.length < this.maxSkippedDiagnostics) {
        skippedFiles.push({relativePath, reason});
      }
    };
    const blockedResult = (blockedReason: string): PathPreviewResult => ({
      rootPath,
      rootRealpath,
      acceptedFiles: [...acceptedFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      skippedFiles: [...skippedFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      skippedFileCount,
      blocked: true,
      blockedReason,
    });

    while (stack.length > 0) {
      const current = stack.pop()!;
      const directory = await fsPromises.opendir(current);
      for await (const entry of directory) {
        visitedEntries += 1;
        if (visitedEntries > this.maxVisitedEntries) {
          return blockedResult('too_many_paths');
        }
        const fullPath = path.join(current, entry.name);
        const realPath = await safeRealpathAsync(fullPath);
        // Detect symlinks that escape the root without calling isWithinAllowlist
        // (realPath is already resolved, so a simple relative-path check suffices).
        if (!realPath) {
          recordSkipped(toPortableRelativePath(rootRealpath, fullPath), 'symlink_outside_root');
          continue;
        }
        const rel = path.relative(rootRealpath, realPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          recordSkipped(toPortableRelativePath(rootRealpath, fullPath), 'symlink_outside_root');
          continue;
        }
        const relativePath = rel.split(path.sep).join('/');
        if (shouldExclude(relativePath, entry.name, this.excludeNames, this.platform === 'win32')) {
          if (entry.isFile()) recordSkipped(relativePath, 'excluded');
          continue;
        }
        if (entry.isDirectory()) {
          visitedDirectories += 1;
          if (visitedDirectories > this.maxDirectories) {
            return blockedResult('too_many_paths');
          }
          stack.push(realPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const rawExtension = path.extname(entry.name);
        const ext = this.platform === 'win32'
          ? rawExtension.toLocaleLowerCase('en-US')
          : rawExtension;
        if (!this.allowedExtensions.has(ext)) {
          recordSkipped(relativePath, 'extension_not_allowed');
          continue;
        }
        const stat = await fsPromises.stat(realPath);
        if (stat.size > this.maxFileBytes) {
          recordSkipped(relativePath, 'file_too_large');
          continue;
        }
        acceptedFiles.push({relativePath, sizeBytes: stat.size});
        acceptedBytes += stat.size;
        if (acceptedFiles.length > this.maxFiles) {
          return blockedResult('too_many_files');
        }
        if (acceptedBytes > this.maxTotalBytes) {
          return blockedResult('total_bytes_exceeded');
        }
      }
    }

    acceptedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    skippedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      rootPath,
      rootRealpath,
      acceptedFiles,
      skippedFiles,
      skippedFileCount,
      blocked: false,
    };
  }
}

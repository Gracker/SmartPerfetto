// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import type {CodebaseKind, CodebaseRef} from './codebaseRegistry';
import {DEFAULT_SOURCE_MAX_FILE_BYTES} from './pathSecurityGate';

export const HARD_EXCLUDE_DIRS = ['.git', '.hg', '.svn', '.repo', 'secrets'] as const;
export const NOISE_EXCLUDE_DIRS = [
  'node_modules', 'build', 'Build', 'out', 'dist', 'target', '.gradle', '.idea',
  '.cxx', '.cache', 'coverage', '.venv', 'venv', '__pycache__', 'Pods',
  '.dart_tool', '.next', '.worktrees', 'DerivedData',
] as const;

const BASE_NATIVE = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.inc', '.S', '.s'];
const BASE_BUILD = ['.gradle', '.kts', '.mk', '.bp', '.rc', '.te', '.conf', '.properties', '.cmake'];

export const LEGACY_SOURCE_EXTENSIONS = [
  '.java', '.kt', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.rs', '.go', '.py',
  '.kts', '.gradle', '.mk', '.bp', '.rc', '.te', '.conf', '.properties', '.aidl',
  '.proto', '.xml',
] as const;

function sourceExtensions(...extensions: readonly string[]): readonly string[] {
  return [...new Set([...LEGACY_SOURCE_EXTENSIONS, ...extensions])];
}

const EXTENSIONS_BY_KIND: Record<CodebaseKind, readonly string[]> = {
  app_source: sourceExtensions(
    '.java', '.kt', '.dart', '.ts', '.tsx', '.js', '.jsx', '.cs', '.swift', '.m', '.mm',
    '.xml', '.aidl', '.proto', '.sh', ...BASE_NATIVE, ...BASE_BUILD,
  ),
  aosp: sourceExtensions('.java', '.kt', '.aidl', '.proto', '.xml', '.py', '.sh', ...BASE_NATIVE, ...BASE_BUILD),
  kernel_source: sourceExtensions('.rs', '.py', '.sh', '.dts', '.dtsi', ...BASE_NATIVE, ...BASE_BUILD),
  oem_sdk: sourceExtensions('.java', '.kt', '.aidl', '.proto', '.xml', '.py', '.sh', ...BASE_NATIVE, ...BASE_BUILD),
};

export interface SourceSelectionIR {
  includePrefixes: string[];
  excludeGlobs: string[];
  hardExcludeDirs: string[];
  noiseExcludeDirs: string[];
  extensions: ReadonlySet<string>;
  maxFileBytes: number;
  ignoreMode: 'ignore_aware' | 'include_ignored';
}

export interface BuildSourceSelectionInput {
  kind: CodebaseKind;
  includePrefixes?: readonly string[];
  excludeGlobs?: readonly string[];
  maxFileBytes?: number;
  ignoreMode?: SourceSelectionIR['ignoreMode'];
}

function normalizeRelative(value: string, errorCode: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) throw new Error(errorCode);
  let normalized = value.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(errorCode);
  }
  return normalized;
}

function normalizeExcludeGlob(value: string): string {
  const normalized = normalizeRelative(value, 'source_exclude_glob_invalid');
  if (/[!:\[\]{}]/.test(normalized)) throw new Error('source_exclude_glob_invalid');
  if (normalized.split('/').some(segment => segment.includes('**') && segment !== '**')) {
    throw new Error('source_exclude_glob_invalid');
  }
  return normalized;
}

function pathHasPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function pathSegmentMatches(pattern: string, candidate: string): boolean {
  let patternIndex = 0;
  let candidateIndex = 0;
  let starIndex = -1;
  let starCandidateIndex = -1;
  while (candidateIndex < candidate.length) {
    if (
      patternIndex < pattern.length &&
      (pattern[patternIndex] === '?' || pattern[patternIndex] === candidate[candidateIndex])
    ) {
      patternIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      starCandidateIndex = candidateIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starCandidateIndex += 1;
      candidateIndex = starCandidateIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

function globMatches(globSegments: readonly string[], candidate: string): boolean {
  const candidateSegments = candidate.split('/');
  let globIndex = 0;
  let candidateIndex = 0;
  let globstarIndex = -1;
  let globstarCandidateIndex = -1;
  while (candidateIndex < candidateSegments.length) {
    if (
      globIndex < globSegments.length &&
      globSegments[globIndex] !== '**' &&
      pathSegmentMatches(globSegments[globIndex]!, candidateSegments[candidateIndex]!)
    ) {
      globIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (globSegments[globIndex] === '**') {
      globstarIndex = globIndex;
      globstarCandidateIndex = candidateIndex;
      globIndex += 1;
      continue;
    }
    if (globstarIndex >= 0) {
      globIndex = globstarIndex + 1;
      globstarCandidateIndex += 1;
      candidateIndex = globstarCandidateIndex;
      continue;
    }
    return false;
  }
  while (globSegments[globIndex] === '**') globIndex += 1;
  return globIndex === globSegments.length;
}

interface CompiledSourceSelection {
  comparable: (value: string) => string;
  hardExcludes: ReadonlySet<string>;
  noiseExcludes: ReadonlySet<string>;
  extensions: ReadonlySet<string>;
  includePrefixes: readonly string[];
  excludeGlobs: readonly (readonly string[])[];
}

const compiledSelectionCache = new WeakMap<SourceSelectionIR, Map<NodeJS.Platform, CompiledSourceSelection>>();

function compiledSelection(
  policy: SourceSelectionIR,
  platform: NodeJS.Platform,
): CompiledSourceSelection {
  let byPlatform = compiledSelectionCache.get(policy);
  if (!byPlatform) {
    byPlatform = new Map();
    compiledSelectionCache.set(policy, byPlatform);
  }
  const cached = byPlatform.get(platform);
  if (cached) return cached;
  const caseInsensitive = platform === 'win32';
  const comparable = (value: string): string => caseInsensitive
    ? value.toLocaleLowerCase('en-US')
    : value;
  const compiled: CompiledSourceSelection = {
    comparable,
    hardExcludes: new Set(policy.hardExcludeDirs.map(comparable)),
    noiseExcludes: new Set(policy.noiseExcludeDirs.map(comparable)),
    extensions: new Set([...policy.extensions].map(comparable)),
    includePrefixes: policy.includePrefixes.map(comparable),
    excludeGlobs: policy.excludeGlobs.map(glob => comparable(glob).split('/')),
  };
  byPlatform.set(platform, compiled);
  return compiled;
}

export function sourceExtensionsForKind(kind: CodebaseKind): readonly string[] {
  return EXTENSIONS_BY_KIND[kind];
}

export function buildSourceSelectionIR(input: BuildSourceSelectionInput): SourceSelectionIR {
  const includePrefixes = [...new Set((input.includePrefixes ?? []).map(prefix =>
    normalizeRelative(prefix, 'source_include_prefix_invalid')))].sort();
  const excludeGlobs = [...new Set((input.excludeGlobs ?? []).map(normalizeExcludeGlob))].sort();
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_SOURCE_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('source_max_file_bytes_invalid');
  return {
    includePrefixes,
    excludeGlobs,
    hardExcludeDirs: [...HARD_EXCLUDE_DIRS],
    noiseExcludeDirs: [...NOISE_EXCLUDE_DIRS],
    extensions: new Set(sourceExtensionsForKind(input.kind)),
    maxFileBytes,
    ignoreMode: input.ignoreMode ?? 'ignore_aware',
  };
}

export function sourceSelectionForRef(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs'>,
  maxFileBytes = DEFAULT_SOURCE_MAX_FILE_BYTES,
): SourceSelectionIR {
  return buildSourceSelectionIR({
    kind: ref.kind,
    includePrefixes: ref.pathFilters,
    excludeGlobs: ref.excludeGlobs,
    maxFileBytes,
  });
}

export function sourceSelectionAdmits(
  policy: SourceSelectionIR,
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let relativePath: string;
  try {
    relativePath = normalizeRelative(value, 'source_path_invalid');
  } catch {
    return false;
  }
  const compiled = compiledSelection(policy, platform);
  const comparable = compiled.comparable;
  const segments = relativePath.split('/');
  if (segments.some(segment => compiled.hardExcludes.has(comparable(segment)))) return false;
  const basename = segments[segments.length - 1]!;
  if (/^\.env/i.test(basename) || /\.(?:pem|p12|keystore|jks)$/i.test(basename)) return false;
  const extension = comparable(path.posix.extname(basename));
  if (!compiled.extensions.has(extension)) return false;
  if (
    compiled.includePrefixes.length > 0 &&
    !compiled.includePrefixes.some(prefix => pathHasPrefix(prefix, comparable(relativePath)))
  ) return false;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!compiled.noiseExcludes.has(comparable(segments[index]!))) continue;
    const noisePath = comparable(segments.slice(0, index + 1).join('/'));
    const explicitlyIncluded = compiled.includePrefixes.some(prefix =>
      pathHasPrefix(noisePath, prefix));
    if (!explicitlyIncluded) return false;
  }
  const comparablePath = comparable(relativePath);
  return !compiled.excludeGlobs.some(glob => globMatches(glob, comparablePath));
}

export function sourceSelectionGitPathspecs(
  policy: SourceSelectionIR,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const magic = platform === 'win32' ? ':(icase,literal)' : ':(literal)';
  return policy.includePrefixes.length > 0
    ? policy.includePrefixes.map(prefix => `${magic}${prefix}`)
    : [`${magic}.`];
}

export function sourceSelectionRipgrepArguments(
  policy: SourceSelectionIR,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const comparable = (value: string): string => platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  const overriddenNoise = new Set<string>();
  for (const noise of policy.noiseExcludeDirs) {
    if (policy.includePrefixes.some(prefix =>
      prefix.split('/').map(comparable).includes(comparable(noise)))) {
      overriddenNoise.add(noise);
    }
  }
  const globs = [
    ...policy.hardExcludeDirs.map(directory => `!**/${directory}/`),
    ...policy.noiseExcludeDirs
      .filter(directory => !overriddenNoise.has(directory))
      .map(directory => `!**/${directory}/`),
    ...policy.excludeGlobs.map(glob => `!${glob}`),
  ];
  const globOption = platform === 'win32' ? '--iglob' : '--glob';
  return [
    ...(policy.ignoreMode === 'include_ignored' ? ['--no-ignore'] : []),
    ...globs.flatMap(glob => [globOption, glob]),
  ];
}

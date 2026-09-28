// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import yaml from 'js-yaml';

import {hardenedGitEnvironment, hardenedGitPrefixArguments} from '../codebase/subprocessHardening';

import {
  DEFAULT_SOURCE_MAX_FILE_BYTES,
  DEFAULT_SOURCE_MAX_TOTAL_BYTES,
  readAcceptedTextFileSync,
} from '../codebase/pathSecurityGate';

export interface AndroidInternalsWikiArticle {
  relativePath: string;
  title?: string;
  status?: string;
  confidence?: string;
  lastVerified?: string;
  lastVerifiedAgainst?: string;
  tags: string[];
  body: string;
  /** Full Markdown hash, including frontmatter, for generation identity. */
  fileHash: string;
  /** Normalized body hash used only for duplicate-content detection. */
  contentHash: string;
  metadataValid: boolean;
  metadataError?: string;
}

export interface AndroidInternalsWikiCorpus {
  rootPath: string;
  totalArticles: number;
  articles: AndroidInternalsWikiArticle[];
  contentFingerprint: string;
}

export interface AndroidInternalsWikiCorpusIdentity {
  revision: string;
  contentFingerprint: string;
  dirtyAcceptedArticlePaths: string[];
  dirty: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^#\\n"']+)`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function listMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const basename = entry.name.toUpperCase();
        if (basename !== 'README.MD' && basename !== 'SUMMARY.MD') files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export function scanAndroidInternalsWiki(
  rootPath: string,
  acceptedRelativePaths?: readonly string[],
  limits: Readonly<{maxFileBytes?: number; maxTotalBytes?: number}> = {},
): AndroidInternalsWikiCorpus {
  const resolvedRoot = fs.realpathSync(path.resolve(rootPath));
  const articles: AndroidInternalsWikiArticle[] = [];
  const filePaths = acceptedRelativePaths
    ? acceptedRelativePaths
        .map(relativePath => relativePath.replace(/\\/g, '/'))
        .filter(relativePath => {
          const basename = path.posix.basename(relativePath).toUpperCase();
          return relativePath.startsWith('src/') && relativePath.endsWith('.md') &&
            basename !== 'README.MD' && basename !== 'SUMMARY.MD';
        })
        .sort()
    : listMarkdownFiles(path.join(resolvedRoot, 'src'))
        .map(filePath => path.relative(resolvedRoot, filePath).split(path.sep).join('/'));
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_SOURCE_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_SOURCE_MAX_TOTAL_BYTES;
  let actualTotalBytes = 0;
  for (const relativePath of filePaths) {
    const raw = readAcceptedTextFileSync(resolvedRoot, relativePath, maxFileBytes);
    actualTotalBytes += Buffer.byteLength(raw, 'utf8');
    if (actualTotalBytes > maxTotalBytes) {
      throw new Error(`source_total_bytes_exceeded:${maxTotalBytes}`);
    }
    const frontmatterMatch = raw.match(FRONTMATTER);
    if (!frontmatterMatch) {
      articles.push({
        relativePath,
        tags: [],
        body: raw,
        fileHash: createHash('sha256').update(raw).digest('hex'),
        contentHash: createHash('sha256').update(raw.replace(/\s+/g, ' ').trim()).digest('hex'),
        metadataValid: false,
        metadataError: 'missing frontmatter',
      });
      continue;
    }
    const frontmatter = frontmatterMatch[1] ?? '';
    const body = raw.slice(frontmatterMatch[0].length);
    let parsed: Record<string, unknown> | null = null;
    let metadataError: string | undefined;
    try {
      const loaded = yaml.load(frontmatter);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new Error('frontmatter must be a mapping');
      }
      parsed = loaded as Record<string, unknown>;
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error);
    }
    const stringValue = (key: string): string | undefined => {
      const value = parsed?.[key];
      return typeof value === 'string' ? value.trim() || undefined : scalar(frontmatter, key);
    };
    const parsedTags = parsed?.tags;
    const title = stringValue('title');
    const status = stringValue('status');
    const confidence = stringValue('confidence');
    const lastVerified = stringValue('last_verified');
    const lastVerifiedAgainst = stringValue('last_verified_against');
    const tags = Array.isArray(parsedTags)
      ? parsedTags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim())
      : [];
    const validationErrors = [
      ...(title && title.length > 240 ? ['title_too_long'] : []),
      ...(confidence && !['low', 'medium', 'high'].includes(confidence.toLowerCase())
        ? ['confidence_invalid'] : []),
      ...(lastVerified && !Number.isFinite(Date.parse(lastVerified)) ? ['last_verified_invalid'] : []),
      ...(lastVerifiedAgainst && (lastVerifiedAgainst.length > 200 || /[\r\n\0]/.test(lastVerifiedAgainst))
        ? ['last_verified_against_invalid'] : []),
      ...(tags.length > 32 || tags.some(tag => !tag || tag.length > 80 || /[\r\n\0]/.test(tag))
        ? ['tags_invalid'] : []),
    ];
    articles.push({
      relativePath,
      title,
      status,
      confidence,
      lastVerified,
      lastVerifiedAgainst,
      tags,
      body,
      fileHash: createHash('sha256').update(raw).digest('hex'),
      contentHash: createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex'),
      metadataValid: parsed !== null && validationErrors.length === 0,
      ...((metadataError || validationErrors.length > 0)
        ? {metadataError: metadataError ?? validationErrors.join(',')}
        : {}),
    });
  }
  return {
    rootPath: resolvedRoot,
    totalArticles: articles.length,
    articles,
    contentFingerprint: createHash('sha256')
      .update(articles.map(article => `${article.relativePath}\0${article.fileHash}`).join('\0'))
      .digest('hex'),
  };
}

const GIT_IDENTITY_TIMEOUT_MS = 10_000;

export function inspectAndroidInternalsWikiIdentity(
  corpus: AndroidInternalsWikiCorpus,
): AndroidInternalsWikiCorpusIdentity {
  // A registered knowledge root is untrusted: repo-local config must not run
  // fsmonitor or hook commands, and a stuck git must not hold the request.
  const git = (args: string[]): string => execFileSync(
    'git',
    [...hardenedGitPrefixArguments(corpus.rootPath), ...args],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hardenedGitEnvironment(),
      timeout: GIT_IDENTITY_TIMEOUT_MS},
  );
  const isPotentialArticlePath = (relativePath: string): boolean => {
    const normalized = relativePath.split('\\').join('/');
    const basename = path.posix.basename(normalized).toUpperCase();
    return normalized.startsWith('src/') &&
      normalized.endsWith('.md') &&
      basename !== 'README.MD' &&
      basename !== 'SUMMARY.MD';
  };
  let statusRecords: string[];
  let revision: string;
  try {
    statusRecords = git([
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    'src',
    ]).split('\0');
    revision = git(['rev-parse', 'HEAD']).trim();
  } catch {
    return {
      revision: `content-${corpus.contentFingerprint.slice(0, 40)}`,
      contentFingerprint: corpus.contentFingerprint,
      dirtyAcceptedArticlePaths: corpus.articles.map(article => article.relativePath).sort(),
      dirty: true,
    };
  }
  const dirtyPaths = new Set<string>();
  for (let index = 0; index < statusRecords.length; index++) {
    const record = statusRecords[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const currentPath = record.slice(3);
    if (isPotentialArticlePath(currentPath)) dirtyPaths.add(currentPath);
    if (status.includes('R') || status.includes('C')) {
      const originalPath = statusRecords[++index] ?? '';
      if (isPotentialArticlePath(originalPath)) dirtyPaths.add(originalPath);
    }
  }
  const dirtyAcceptedArticlePaths = Array.from(dirtyPaths).sort();
  return {
    revision,
    contentFingerprint: corpus.contentFingerprint,
    dirtyAcceptedArticlePaths,
    dirty: dirtyAcceptedArticlePaths.length > 0,
  };
}

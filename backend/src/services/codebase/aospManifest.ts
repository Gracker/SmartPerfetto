// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fsPromises from 'fs/promises';
import * as path from 'path';

import {readBoundedMetadataFile} from './boundedMetadataFile';

export interface AospManifestProject {
  name: string;
  path: string;
  groups: string[];
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 10_000;
const MANIFEST_DISCOVERY_TIMEOUT_MS = 5_000;

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeRelative(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) return undefined;
  return normalized;
}

export function parseAospManifestProjects(xml: string): AospManifestProject[] {
  if (Buffer.byteLength(xml, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('aosp_manifest_too_large');
  const projects: AospManifestProject[] = [];
  const projectPattern = /<project\b([^>]*)>/g;
  let projectMatch: RegExpExecArray | null;
  while ((projectMatch = projectPattern.exec(xml)) && projects.length < MAX_PROJECTS) {
    const attributes = new Map<string, string>();
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(projectMatch[1]!))) {
      attributes.set(attributeMatch[1]!, decodeXml(attributeMatch[2] ?? attributeMatch[3] ?? ''));
    }
    const name = attributes.get('name');
    const projectPath = safeRelative(attributes.get('path') || name || '');
    if (!name || !projectPath) continue;
    const groups = [...new Set((attributes.get('groups') ?? '')
      .split(',')
      .map(group => group.trim())
      .filter(Boolean))].sort();
    projects.push({name, path: projectPath, groups});
  }
  return projects.sort((left, right) => left.path.localeCompare(right.path));
}

async function discoverAospManifestProjects(
  rootRealpath: string,
  expectedRootRealpath: string,
  deadline: number,
): Promise<AospManifestProject[]> {
  const normalizeIdentity = (value: string): string => process.platform === 'win32'
    ? path.resolve(value).toLocaleLowerCase('en-US')
    : path.resolve(value);
  let repoRoot: string;
  try {
    repoRoot = await fsPromises.realpath(rootRealpath);
  } catch {
    throw new Error('codebase_root_realpath_drift');
  }
  if (normalizeIdentity(repoRoot) !== normalizeIdentity(expectedRootRealpath)) {
    throw new Error('codebase_root_realpath_drift');
  }
  const manifestPath = path.join(repoRoot, '.repo', 'manifest.xml');
  let realManifest: string;
  try {
    realManifest = await fsPromises.realpath(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('aosp_manifest_discovery_failed');
  }
  const repoMetadataRoot = path.join(repoRoot, '.repo');
  const relative = path.relative(repoMetadataRoot, realManifest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('aosp_manifest_outside_repo_metadata');
  const contents = await readBoundedMetadataFile({
    filePath: realManifest,
    expectedRealpath: realManifest,
    maxBytes: MAX_MANIFEST_BYTES,
    deadline,
  });
  let rootAfterRead: string;
  try {
    rootAfterRead = await fsPromises.realpath(rootRealpath);
  } catch {
    throw new Error('codebase_root_realpath_drift');
  }
  if (normalizeIdentity(rootAfterRead) !== normalizeIdentity(expectedRootRealpath)) {
    throw new Error('codebase_root_realpath_drift');
  }
  let manifestAfterRead: string;
  try {
    manifestAfterRead = await fsPromises.realpath(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('aosp_manifest_identity_changed');
    }
    throw new Error('aosp_manifest_discovery_failed');
  }
  const afterRelative = path.relative(repoMetadataRoot, manifestAfterRead);
  if (
    normalizeIdentity(manifestAfterRead) !== normalizeIdentity(realManifest) ||
    afterRelative.startsWith('..') ||
    path.isAbsolute(afterRelative)
  ) throw new Error('aosp_manifest_identity_changed');
  return parseAospManifestProjects(contents);
}

export async function readAospManifestProjects(
  rootRealpath: string,
  expectedRootRealpath = rootRealpath,
  timeoutMs = MANIFEST_DISCOVERY_TIMEOUT_MS,
): Promise<AospManifestProject[]> {
  const deadline = Date.now() + timeoutMs;
  const discovery = discoverAospManifestProjects(rootRealpath, expectedRootRealpath, deadline);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      discovery,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('source_metadata_time_budget')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void discovery.catch(() => undefined);
  }
}

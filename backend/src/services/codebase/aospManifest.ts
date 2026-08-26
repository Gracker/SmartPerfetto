// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fsPromises from 'fs/promises';
import * as path from 'path';

export interface AospManifestProject {
  name: string;
  path: string;
  groups: string[];
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 10_000;

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

export async function readAospManifestProjects(rootRealpath: string): Promise<AospManifestProject[]> {
  const repoRoot = await fsPromises.realpath(rootRealpath);
  const manifestPath = path.join(repoRoot, '.repo', 'manifest.xml');
  let realManifest: string;
  try {
    realManifest = await fsPromises.realpath(manifestPath);
  } catch {
    return [];
  }
  const repoMetadataRoot = path.join(repoRoot, '.repo');
  const relative = path.relative(repoMetadataRoot, realManifest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('aosp_manifest_outside_repo_metadata');
  const stat = await fsPromises.stat(realManifest);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('aosp_manifest_too_large');
  return parseAospManifestProjects(await fsPromises.readFile(realManifest, 'utf8'));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const SOURCE_LOOKUP_TOOLS = new Set([
  'lookup_app_source',
  'lookup_aosp_source',
  'lookup_kernel_source',
  'lookup_oem_sdk',
  'search_codebase',
  'read_codebase_file',
]);

const MAX_SOURCE_CODE_REFERENCES = 8;
const CODE_FILE_PATH = /^[\w.-]+(?:\/[\w.-]+)*\.(?:kt|java|kts|xml|cpp|cc|c|h|hpp|m|mm|swift|rs|go|py|ts|tsx|js|jsx|sql|md)$/i;
const sourceCodeReferencesByOwner = new WeakMap<object, SourceLookupCodeReference[]>();

export interface SourceLookupCodeReference {
  chunkId?: string;
  referenceId?: string;
  filePath: string;
  lineRange?: {
    start: number;
    end: number;
  };
}

export function shortSourceLookupToolName(toolName: string): string {
  return toolName.replace(/^mcp__smartperfetto__/, '');
}

export function isSourceLookupToolName(toolName: string): boolean {
  return SOURCE_LOOKUP_TOOLS.has(shortSourceLookupToolName(toolName));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeRelativeCodePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.includes('://') ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  return CODE_FILE_PATH.test(normalized) ? normalized : undefined;
}

function normalizeChunkId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeLineRange(value: unknown): SourceLookupCodeReference['lineRange'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.start) ||
    !Number.isInteger(record.end) ||
    Number(record.start) < 1 ||
    Number(record.end) < Number(record.start)
  ) {
    return undefined;
  }
  return {start: Number(record.start), end: Number(record.end)};
}

function normalizeCodeReference(input: {
  chunkId?: unknown;
  referenceId?: unknown;
  filePath: unknown;
  lineRange?: unknown;
}): SourceLookupCodeReference | undefined {
  const chunkId = normalizeChunkId(input.chunkId);
  const referenceId = normalizeChunkId(input.referenceId);
  const filePath = normalizeRelativeCodePath(input.filePath);
  if ((!chunkId && !referenceId) || !filePath) return undefined;
  const lineRange = normalizeLineRange(input.lineRange);
  return {
    ...(chunkId ? {chunkId} : {}),
    ...(referenceId ? {referenceId} : {}),
    filePath,
    ...(lineRange ? {lineRange} : {}),
  };
}

function codeReferenceKey(reference: SourceLookupCodeReference): string {
  return [
    reference.filePath,
    reference.chunkId ?? reference.referenceId ?? '',
    reference.lineRange?.start ?? '',
    reference.lineRange?.end ?? '',
  ].join('\0');
}

function collectCodeReferences(
  value: unknown,
  references: SourceLookupCodeReference[],
  seen: WeakSet<object>,
  depth = 0,
): void {
  if (depth > 8 || value == null || references.length >= MAX_SOURCE_CODE_REFERENCES) return;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    if (parsed !== undefined) collectCodeReferences(parsed, references, seen, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(entry => collectCodeReferences(entry, references, seen, depth + 1));
    return;
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : undefined;
  const reference = normalizeCodeReference({
    chunkId: record.chunkId,
    referenceId: record.referenceId,
    filePath: record.filePath ?? metadata?.filePath,
    lineRange: record.lineRange ?? metadata?.lineRange,
  });
  if (reference && !references.some(existing => codeReferenceKey(existing) === codeReferenceKey(reference))) {
    references.push(reference);
  }
  Object.values(record).forEach(entry => collectCodeReferences(entry, references, seen, depth + 1));
}

export function extractSourceLookupCodeReferences(
  toolName: string,
  result: unknown,
): SourceLookupCodeReference[] {
  if (!isSourceLookupToolName(toolName)) return [];
  const references: SourceLookupCodeReference[] = [];
  collectCodeReferences(result, references, new WeakSet<object>());
  return references;
}

export function rememberSourceLookupCodeReferences(
  owner: object,
  references: readonly SourceLookupCodeReference[],
): void {
  if (references.length === 0) return;
  const existing = sourceCodeReferencesByOwner.get(owner) ?? [];
  const merged = [...existing];
  for (const reference of references) {
    if (merged.length >= MAX_SOURCE_CODE_REFERENCES) break;
    const normalizedReference = normalizeCodeReference(reference);
    if (
      normalizedReference &&
      !merged.some(candidate => codeReferenceKey(candidate) === codeReferenceKey(normalizedReference))
    ) {
      merged.push(normalizedReference);
    }
  }
  sourceCodeReferencesByOwner.set(owner, merged);
}

export function getSourceLookupCodeReferences(owner: object): SourceLookupCodeReference[] {
  return (sourceCodeReferencesByOwner.get(owner) ?? []).map(reference => ({
    ...reference,
    ...(reference.lineRange ? {lineRange: {...reference.lineRange}} : {}),
  }));
}

export function sourceLookupResultHasCodeReferences(
  toolName: string,
  result: unknown,
): boolean {
  return extractSourceLookupCodeReferences(toolName, result).length > 0;
}

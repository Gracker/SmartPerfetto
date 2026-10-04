// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `knowledge_use@1`: which selected knowledge bases a run actually delivered
 * to the model, at which pinned generation, and how the knowledge locations
 * the answer cites (`kb:path#L10-L20`) stand against what was delivered.
 *
 * It is a display and audit record, never evidence: no claim verification,
 * finite proof or delivery verdict reads it, and an unmatched citation is
 * shown, not failed. A result without the field is "not recorded" (an older
 * result, or a run that never reached finalization), never zero use.
 */

import {
  BARE_PATH_SEGMENT,
  extractWrittenLocations,
  gradeWrittenLocation,
  writtenLineSuffix,
  type WrittenLocationPatterns,
} from '../codebase/sourceCitations';
import {MAX_SOURCE_LINE, normalizeSourceReferencePath} from '../codebase/sourceUseDecision';
import {isExternalKnowledgeSourceId} from '../externalKnowledgeSourceRegistry';
import type {KnowledgeDeliveredLocation, KnowledgeReferenceLedger} from './knowledgeTools';

export const KNOWLEDGE_USE_SCHEMA_VERSION = 'knowledge_use@1' as const;

/** `android_internals_wiki` is read from records written before that connector was retired; no run writes it. */
export const KNOWLEDGE_BASE_KINDS = ['document_collection', 'android_internals_wiki'] as const;
export type KnowledgeBaseKind = typeof KNOWLEDGE_BASE_KINDS[number];

/**
 * `delivered`: every cited line lies in text this run delivered (a search
 * excerpt that was its hit's whole text, or a section read whole);
 * `located`: delivered locations cover the lines, but not all of their text was delivered;
 * `unmatched`: no single document version this run delivered covers them;
 * `ambiguous`: several knowledge bases or generations hold a covering document.
 */
export const KNOWLEDGE_CITATION_STATUS_VALUES = ['delivered', 'located', 'unmatched', 'ambiguous'] as const;
export type KnowledgeCitationStatus = typeof KNOWLEDGE_CITATION_STATUS_VALUES[number];

export interface KnowledgeUseSourceV1 {
  knowledgeBaseId: string;
  kind: KnowledgeBaseKind;
  /** The generation this run pinned and read. */
  generation: string;
  /** Distinct references (document hits, Wiki chunks) actually delivered; repeats count once. */
  deliveredReferenceCount: number;
}

export interface KnowledgeCitationV1 {
  /** The citation exactly as written. */
  citation: string;
  relativePath: string;
  /** The written lines; absent when they are not a valid range (reversed, zero, too large), which never matches. */
  lineRange?: {start: number; end: number};
  status: KnowledgeCitationStatus;
  /** The knowledge base and reference that pin it, for a positive status. */
  knowledgeBaseId?: string;
  referenceId?: string;
  /** For `ambiguous`: the knowledge bases holding a covering document. */
  candidateKnowledgeBaseIds?: string[];
}

export interface KnowledgeUseV1 {
  schemaVersion: typeof KNOWLEDGE_USE_SCHEMA_VERSION;
  sources: KnowledgeUseSourceV1[];
  citations: KnowledgeCitationV1[];
  /** Some citations were not read; nothing is known about them. */
  citationsTruncated?: true;
}

/** What one run delivered, handed to finalization; the answer's citations are graded there. */
export interface KnowledgeUseRecord {
  sources: KnowledgeUseSourceV1[];
  locations: KnowledgeDeliveredLocation[];
}

const MAX_KNOWLEDGE_USE_SOURCES = 64;
const MAX_KNOWLEDGE_CITATIONS = 200;
const MAX_CANDIDATES = 16;
const MAX_TEXT = 1024;
const GENERATION = /^[A-Za-z0-9_.:-]{1,160}$/;
const KNOWLEDGE_REFERENCE = /^kref-[0-9a-f-]{36}$/;

const KB_LINE_SUFFIX = writtenLineSuffix('#');
/**
 * `kb:relative/path#L10-L20`, `kb:path#10-20` or `kb:path#L10`. A bare path
 * holds no spaces; a backtick-quoted one may.
 */
const KNOWLEDGE_CITATION_PATTERNS: WrittenLocationPatterns = {
  quoted: new RegExp(`\`kb:([^\`\\n#]{1,512}?)${KB_LINE_SUFFIX}\``, 'gu'),
  bare: new RegExp(
    `(?<![\\p{L}\\p{N}_./@+-])kb:((?:${BARE_PATH_SEGMENT}+/){0,32}${BARE_PATH_SEGMENT}+)` +
    `${KB_LINE_SUFFIX}(?![\\p{L}\\p{N}_])`, 'gu'),
};

/**
 * Collects what one run delivered from its selected knowledge bases. Only a
 * delivery the tool actually returned is recorded: zero hits, refusals,
 * evaluation-filtered and repeated content never count.
 */
export class KnowledgeUseRecorder {
  constructor(private readonly references: KnowledgeReferenceLedger) {}

  snapshot(): KnowledgeUseRecord {
    const sources: KnowledgeUseSourceV1[] = [...this.references.deliveredReferenceCounts()]
      .map(([knowledgeBaseId, {generation, count}]) => ({
        knowledgeBaseId, kind: 'document_collection' as const, generation, deliveredReferenceCount: count}))
      .sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
    return {sources, locations: this.references.deliveredLocations()};
  }
}

/**
 * One written knowledge location against what the run delivered
 * (`gradeWrittenLocation`), a version being one document of one knowledge
 * base at one generation; `delivered` needs the covering text itself to have
 * been delivered.
 */
function gradeKnowledgeCitation(
  citation: {citation: string; filePath: string; lineRange: {start: number; end: number}; malformed?: boolean},
  locations: readonly KnowledgeDeliveredLocation[],
): KnowledgeCitationV1 {
  if (citation.malformed) return {citation: citation.citation, relativePath: citation.filePath, status: 'unmatched'};
  const base = {citation: citation.citation, relativePath: citation.filePath, lineRange: citation.lineRange};
  const grade = gradeWrittenLocation(citation, locations, {
    path: location => location.relativePath,
    versionKey: location => [location.knowledgeBaseId, location.generation, location.relativePath].join('\0'),
    range: location => location.lineRange, hasBody: location => location.bodyDelivered,
  });
  switch (grade.status) {
    case 'unmatched': return {...base, status: 'unmatched'};
    case 'ambiguous': return {...base, status: 'ambiguous', candidateKnowledgeBaseIds:
      [...new Set(grade.candidates.map(group => group[0]!.knowledgeBaseId))].sort().slice(0, MAX_CANDIDATES)};
    case 'body':
    case 'located': return {...base, status: grade.status === 'body' ? 'delivered' : 'located',
      knowledgeBaseId: grade.pin.knowledgeBaseId, referenceId: grade.pin.referenceId};
  }
}

/**
 * The run's `knowledge_use@1` result: its delivered sources and the
 * knowledge citations written in the answer, graded. Undefined when the run
 * recorded nothing (no knowledge base was selected).
 */
export function buildKnowledgeUse(record: KnowledgeUseRecord | undefined, body: string): KnowledgeUseV1 | undefined {
  if (!record) return undefined;
  const {citations, truncated} = extractWrittenLocations(body, KNOWLEDGE_CITATION_PATTERNS);
  return sanitizeKnowledgeUse({
    schemaVersion: KNOWLEDGE_USE_SCHEMA_VERSION,
    sources: record.sources,
    citations: citations.map(citation => gradeKnowledgeCitation(citation, record.locations)),
    ...(truncated ? {citationsTruncated: true} : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000 ? Number(value) : undefined;
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : undefined;
}

function lineRange(value: unknown): {start: number; end: number} | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['start', 'end'])) return undefined;
  const {start, end} = value;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 1 &&
    Number(end) >= Number(start) && Number(end) <= MAX_SOURCE_LINE ? {start: Number(start), end: Number(end)} : undefined;
}

function sanitizeSource(value: unknown): KnowledgeUseSourceV1 | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['knowledgeBaseId', 'kind', 'generation', 'deliveredReferenceCount'])) {
    return undefined;
  }
  const deliveredReferenceCount = count(value.deliveredReferenceCount);
  if (!isExternalKnowledgeSourceId(value.knowledgeBaseId) ||
    !KNOWLEDGE_BASE_KINDS.includes(value.kind as KnowledgeBaseKind) ||
    typeof value.generation !== 'string' || !GENERATION.test(value.generation) ||
    deliveredReferenceCount === undefined) return undefined;
  return {knowledgeBaseId: value.knowledgeBaseId, kind: value.kind as KnowledgeBaseKind,
    generation: value.generation, deliveredReferenceCount};
}

function sanitizeCitation(value: unknown): KnowledgeCitationV1 | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['citation', 'relativePath', 'lineRange', 'status', 'knowledgeBaseId',
    'referenceId', 'candidateKnowledgeBaseIds'])) return undefined;
  const citation = boundedText(value.citation);
  const relativePath = normalizeSourceReferencePath(value.relativePath);
  const range = value.lineRange === undefined ? undefined : lineRange(value.lineRange);
  const status = KNOWLEDGE_CITATION_STATUS_VALUES.includes(value.status as KnowledgeCitationStatus)
    ? value.status as KnowledgeCitationStatus : undefined;
  if (!citation || !relativePath || relativePath !== value.relativePath || !status) return undefined;
  // Only an unmatched citation may lack its lines: they were not a valid range.
  if (value.lineRange !== undefined ? !range : status !== 'unmatched') return undefined;
  const positive = status === 'delivered' || status === 'located';
  // A positive status names the base and reference that pin it; no other status carries them.
  if (positive !== (value.knowledgeBaseId !== undefined) || positive !== (value.referenceId !== undefined)) return undefined;
  if (positive && (!isExternalKnowledgeSourceId(value.knowledgeBaseId) ||
    typeof value.referenceId !== 'string' || !KNOWLEDGE_REFERENCE.test(value.referenceId))) return undefined;
  const candidates = value.candidateKnowledgeBaseIds;
  if ((status === 'ambiguous') !== (candidates !== undefined)) return undefined;
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length === 0 ||
    candidates.length > MAX_CANDIDATES || !candidates.every(isExternalKnowledgeSourceId))) return undefined;
  return {citation, relativePath, ...(range ? {lineRange: range} : {}), status,
    ...(positive ? {knowledgeBaseId: value.knowledgeBaseId as string, referenceId: value.referenceId as string} : {}),
    ...(candidates !== undefined ? {candidateKnowledgeBaseIds: [...candidates as string[]]} : {})};
}

/**
 * The one closed shape check for a stored or transported `knowledge_use@1`.
 * Anything it does not recognize in full (an unknown field, a bad id, an
 * inconsistent status) is not a record, so the whole value is dropped and
 * reads as "not recorded" rather than as partial use.
 */
export function sanitizeKnowledgeUse(value: unknown): KnowledgeUseV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== KNOWLEDGE_USE_SCHEMA_VERSION ||
    !hasOnlyKeys(value, ['schemaVersion', 'sources', 'citations', 'citationsTruncated']) ||
    !Array.isArray(value.sources) || value.sources.length > MAX_KNOWLEDGE_USE_SOURCES ||
    !Array.isArray(value.citations) || value.citations.length > MAX_KNOWLEDGE_CITATIONS ||
    (value.citationsTruncated !== undefined && value.citationsTruncated !== true)) return undefined;
  const sources = value.sources.map(sanitizeSource);
  const citations = value.citations.map(sanitizeCitation);
  if (sources.some(source => !source) || citations.some(citation => !citation)) return undefined;
  const byId = new Map(sources.map(source => [source!.knowledgeBaseId, source!]));
  if (byId.size !== sources.length) return undefined;
  // A citation can only stand on lines this record says were delivered: every
  // base it names is a document collection (the one kind with line locations)
  // that delivered at least one reference.
  const delivered = (knowledgeBaseId: string): boolean => {
    const source = byId.get(knowledgeBaseId);
    return source?.kind === 'document_collection' && source.deliveredReferenceCount > 0;
  };
  if (!citations.every(citation => (citation!.knowledgeBaseId === undefined || delivered(citation!.knowledgeBaseId)) &&
    (citation!.candidateKnowledgeBaseIds ?? []).every(delivered))) return undefined;
  return {schemaVersion: KNOWLEDGE_USE_SCHEMA_VERSION, sources: sources as KnowledgeUseSourceV1[],
    citations: citations as KnowledgeCitationV1[], ...(value.citationsTruncated ? {citationsTruncated: true} : {})};
}

/**
 * A record (as `sanitizeKnowledgeUse` returned it) for one audience. The owner
 * keeps the citations (fragments of their answer) with their text projected;
 * every other audience keeps only the sources, since a citation's text and
 * path are document content.
 */
export function projectKnowledgeUseForAudience(
  record: KnowledgeUseV1,
  audience: {owner: boolean; projectText: (text: string) => string},
): KnowledgeUseV1 {
  if (!audience.owner) {
    return {schemaVersion: record.schemaVersion, sources: record.sources, citations: []};
  }
  const citations = record.citations.flatMap(citation => {
    const text = audience.projectText(citation.citation);
    const relativePath = audience.projectText(citation.relativePath);
    // A projection that altered the path no longer names the cited document.
    return relativePath === citation.relativePath ? [{...citation, citation: text}] : [];
  });
  return {...record, citations};
}

/** Delivered references across sources, for the analysis receipt; undefined when not recorded. */
export function knowledgeReferenceCount(value: unknown): number | undefined {
  const record = sanitizeKnowledgeUse(value);
  return record ? record.sources.reduce((total, source) => total + source.deliveredReferenceCount, 0) : undefined;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {escapeRegExp} from '../../utils/escapeRegExp';
import {allSourceExtensions} from './sourceSelectionPolicy';
import {
  isBodyLookupKind, lineRangesCover, lineRangesIntersect, MAX_SOURCE_LINE, normalizeSourceReferencePath,
  sourceReferenceIdentity, type SourceReferenceV1,
} from './sourceUseDecision';

/**
 * A source location written in the answer (`path/File.kt:L10-L20`), checked
 * against what this run actually returned. It locates and is displayed; it
 * never proves behavior, and an unmatched one is a warning, not a failure.
 */
export interface SourceCitationV1 {
  /** The citation exactly as written. */
  citation: string;
  filePath: string;
  lineRange: {start: number; end: number};
  /**
   * `verified_body`: body windows this run read cover every written line;
   * `located`: returned locations cover them, but not all were read;
   * `unmatched`: no single file version this run returned covers them;
   * `ambiguous`: several file versions do.
   */
  status: SourceCitationStatus;
  /** The issued reference that pins it, for a positive status. */
  sourceReferenceId?: string;
  /**
   * For `ambiguous`: the issued references that fit. A claim bound to one of
   * them names the version it relies on, which pins the citation for that claim.
   */
  candidateReferenceIds?: string[];
}

export const SOURCE_CITATION_STATUS_VALUES = ['verified_body', 'located', 'unmatched', 'ambiguous'] as const;
export type SourceCitationStatus = typeof SOURCE_CITATION_STATUS_VALUES[number];

const MAX_CITATIONS = 200;

/** Every extension any codebase kind admits, longest first so `.hpp` wins over `.h`. */
const SOURCE_EXTENSION_ALTERNATION = allSourceExtensions()
  .map(extension => extension.slice(1))
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');

/**
 * A range is read whole or not at all: a single line is never matched where a
 * range separator follows, so a range whose end does not parse cannot shrink
 * into its first line.
 */
const RANGE_SEPARATOR = '\\s?[-–—~～]\\s?';
const LINE_SUFFIX = `:L?(\\d+)(?:${RANGE_SEPARATOR}L?(\\d+))?(?!${RANGE_SEPARATOR}L?\\d)`;
/**
 * `path.ext:L10-L20`, `path.ext:10-20` or `path.ext:L10`. A bare path may hold
 * any letters but no spaces; a backtick-quoted one may also hold spaces.
 */
const QUOTED_CITATION = new RegExp(
  `\`([^\`\\n]{1,512}?\\.(?:${SOURCE_EXTENSION_ALTERNATION}))${LINE_SUFFIX}\``, 'gu');
const BARE_CITATION = new RegExp(
  `(?<![\\p{L}\\p{N}_./@+-])((?:[\\p{L}\\p{N}_.@+-]+/){0,32}[\\p{L}\\p{N}_.@+-]+\\.(?:${SOURCE_EXTENSION_ALTERNATION}))` +
  `${LINE_SUFFIX}(?![\\p{L}\\p{N}_])`, 'gu');

export interface ExtractedSourceCitation {
  citation: string;
  filePath: string;
  lineRange: {start: number; end: number};
  /** Character offset in the text. */
  index: number;
  /** Lines that are not a valid range (reversed, zero, or past the largest line); it never matches. */
  malformed?: boolean;
}

function* scanCitations(text: string): Generator<ExtractedSourceCitation> {
  const quoted: Array<{start: number; end: number}> = [];
  const read = (match: RegExpMatchArray, citation: string, index: number): ExtractedSourceCitation | undefined => {
    const filePath = normalizeSourceReferencePath(match[1]);
    if (!filePath) return undefined;
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    const valid = start >= 1 && end >= start && end <= MAX_SOURCE_LINE;
    return {citation, filePath, lineRange: {start, end}, index, ...(valid ? {} : {malformed: true})};
  };
  for (const match of text.matchAll(QUOTED_CITATION)) {
    const index = match.index ?? 0;
    quoted.push({start: index, end: index + match[0].length});
    const found = read(match, match[0].slice(1, -1), index + 1);
    if (found) yield found;
  }
  for (const match of text.matchAll(BARE_CITATION)) {
    const index = match.index ?? 0;
    // A location inside a quoted citation was already read, spaces included.
    if (quoted.some(range => index >= range.start && index < range.end)) continue;
    const found = read(match, match[0], index);
    if (found) yield found;
  }
}

/**
 * Source locations written in a text, in order, up to a fixed number;
 * `truncated` says some were not read, so nothing is known about them.
 */
export function extractSourceCitations(text: string): {citations: ExtractedSourceCitation[]; truncated: boolean} {
  const found = [...scanCitations(text)].sort((a, b) => a.index - b.index);
  return {citations: found.slice(0, MAX_CITATIONS), truncated: found.length > MAX_CITATIONS};
}

/** Whether a text writes any source location. */
export function hasSourceCitation(text: string): boolean {
  return !scanCitations(text).next().done;
}

/**
 * The answer's blocks (paragraphs, list items, headings) as character ranges:
 * a claim's visible text is the blocks that cite its references.
 */
export function splitAnswerBlocks(text: string): Array<{start: number; end: number}> {
  const blocks: Array<{start: number; end: number}> = [];
  let blockStart = -1;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim()) {
      if (blockStart >= 0) blocks.push({start: blockStart, end: lineStart});
      blockStart = -1;
      continue;
    }
    if (blockStart >= 0 && /^\s*(?:[-*+]|\d+[.)]|#{1,6})\s/.test(line)) {
      blocks.push({start: blockStart, end: lineStart});
      blockStart = -1;
    }
    if (blockStart < 0) blockStart = lineStart;
  }
  if (blockStart >= 0) blocks.push({start: blockStart, end: text.length});
  return blocks;
}

type RangedReference = SourceReferenceV1 & {lineRange: {start: number; end: number}};

/**
 * One citation against the run's issued references. The written path must
 * equal a returned path, or be its trailing segments. A positive status needs
 * one file version (codebase, path, source generation) whose returned ranges
 * together cover every written line; a range that only overlaps, a reference
 * without lines, or ranges of two versions never do. Several covering versions
 * are `ambiguous`, never merged.
 */
export function matchSourceCitation(
  citation: Pick<ExtractedSourceCitation, 'citation' | 'filePath' | 'lineRange' | 'malformed'>,
  references: readonly SourceReferenceV1[],
): SourceCitationV1 {
  if (citation.malformed) {
    return {citation: citation.citation, filePath: citation.filePath, lineRange: citation.lineRange, status: 'unmatched'};
  }
  const exact = references.filter(reference => reference.filePath === citation.filePath);
  const candidates = exact.length > 0 ? exact
    : references.filter(reference => reference.filePath.endsWith(`/${citation.filePath}`));
  const byIdentity = new Map<string, RangedReference[]>();
  for (const reference of candidates) {
    if (!reference.lineRange) continue;
    const key = sourceReferenceIdentity(reference);
    const group = byIdentity.get(key);
    if (group) group.push(reference as RangedReference);
    else byIdentity.set(key, [reference as RangedReference]);
  }
  const covering = [...byIdentity.values()].filter(group =>
    lineRangesCover(group.map(reference => reference.lineRange), citation.lineRange));
  const base = {citation: citation.citation, filePath: citation.filePath, lineRange: citation.lineRange};
  if (covering.length === 0) return {...base, status: 'unmatched'};
  // Only references that touch the written lines stand for it.
  const touching = (group: RangedReference[]) =>
    group.filter(reference => lineRangesIntersect(reference.lineRange, citation.lineRange));
  if (covering.length > 1) {
    // Every candidate: a claim's binding pins one only when it is the sole version bound.
    return {...base, status: 'ambiguous', candidateReferenceIds: covering.flatMap(touching).map(reference => reference.id)};
  }
  const group = touching(covering[0]!);
  const bodies = group.filter(reference => isBodyLookupKind(reference.lookupKind));
  return lineRangesCover(bodies.map(reference => reference.lineRange), citation.lineRange)
    ? {...base, status: 'verified_body', sourceReferenceId: bodies[0]!.id}
    : {...base, status: 'located', sourceReferenceId: group[0]!.id};
}

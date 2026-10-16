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

/** How many written locations one text is read for; the rest are reported as truncated. */
const MAX_WRITTEN_CITATIONS = 200;

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
/**
 * The line part of a written location after its `marker` (`:` for source,
 * `#` for knowledge): `L10-L20`, `10-20` or `L10`. Groups 2 and 3 hold the lines.
 */
export function writtenLineSuffix(marker: ':' | '#'): string {
  return `${marker}L?(\\d+)(?:${RANGE_SEPARATOR}L?(\\d+))?(?!${RANGE_SEPARATOR}L?\\d)`;
}
/** A bare path segment: any letters, digits and `_ . @ + -`, no spaces. */
export const BARE_PATH_SEGMENT = '[\\p{L}\\p{N}_.@+-]';
const LINE_SUFFIX = writtenLineSuffix(':');
/**
 * `path.ext:L10-L20`, `path.ext:10-20` or `path.ext:L10`. A bare path may hold
 * any letters but no spaces; a backtick-quoted one may also hold spaces.
 */
const SOURCE_CITATION_PATTERNS: WrittenLocationPatterns = {
  quoted: new RegExp(`\`([^\`\\n]{1,512}?\\.(?:${SOURCE_EXTENSION_ALTERNATION}))${LINE_SUFFIX}\``, 'gu'),
  bare: new RegExp(
    `(?<![\\p{L}\\p{N}_./@+-])((?:${BARE_PATH_SEGMENT}+/){0,32}${BARE_PATH_SEGMENT}+\\.(?:${SOURCE_EXTENSION_ALTERNATION}))` +
    `${LINE_SUFFIX}(?![\\p{L}\\p{N}_])`, 'gu'),
};

export interface ExtractedSourceCitation {
  citation: string;
  filePath: string;
  lineRange: {start: number; end: number};
  /** Character offset in the text. */
  index: number;
  /** Lines that are not a valid range (reversed, zero, or past the largest line); it never matches. */
  malformed?: boolean;
}

/**
 * How one kind of written location is found: a backtick-quoted form (whose
 * path may hold spaces) and a bare form. Group 1 is the path, groups 2 and 3
 * the lines (`writtenLineSuffix`).
 */
export interface WrittenLocationPatterns {
  quoted: RegExp;
  bare: RegExp;
}

function* scanWrittenLocations(text: string, patterns: WrittenLocationPatterns): Generator<ExtractedSourceCitation> {
  const quoted: Array<{start: number; end: number}> = [];
  const read = (match: RegExpMatchArray, citation: string, index: number): ExtractedSourceCitation | undefined => {
    const filePath = normalizeSourceReferencePath(match[1]);
    if (!filePath) return undefined;
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    const valid = start >= 1 && end >= start && end <= MAX_SOURCE_LINE;
    return {citation, filePath, lineRange: {start, end}, index, ...(valid ? {} : {malformed: true})};
  };
  for (const match of text.matchAll(patterns.quoted)) {
    const index = match.index ?? 0;
    quoted.push({start: index, end: index + match[0].length});
    const found = read(match, match[0].slice(1, -1), index + 1);
    if (found) yield found;
  }
  for (const match of text.matchAll(patterns.bare)) {
    const index = match.index ?? 0;
    // A location inside a quoted citation was already read, spaces included.
    if (quoted.some(range => index >= range.start && index < range.end)) continue;
    const found = read(match, match[0], index);
    if (found) yield found;
  }
}

/**
 * The locations of one kind written in a text, in order, up to a fixed
 * number; `truncated` says some were not read, so nothing is known about them.
 * Source and knowledge citations share this reading, so a range, a quoted
 * path with spaces and a malformed line read the same way in both.
 */
export function extractWrittenLocations(
  text: string,
  patterns: WrittenLocationPatterns,
): {citations: ExtractedSourceCitation[]; truncated: boolean} {
  const found = [...scanWrittenLocations(text, patterns)].sort((a, b) => a.index - b.index);
  return {citations: found.slice(0, MAX_WRITTEN_CITATIONS), truncated: found.length > MAX_WRITTEN_CITATIONS};
}

/**
 * Source locations written in a text, in order, up to a fixed number;
 * `truncated` says some were not read, so nothing is known about them.
 */
export function extractSourceCitations(text: string): {citations: ExtractedSourceCitation[]; truncated: boolean} {
  return extractWrittenLocations(text, SOURCE_CITATION_PATTERNS);
}

/** Whether a text writes any source location. */
export function hasSourceCitation(text: string): boolean {
  return !scanWrittenLocations(text, SOURCE_CITATION_PATTERNS).next().done;
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

interface LineRange {start: number; end: number}

/** How one written location stands against the delivered items it could name. */
export type WrittenLocationGrade<T> =
  | {status: 'unmatched'}
  /** Every covering version's items that touch the written lines. */
  | {status: 'ambiguous'; candidates: T[][]}
  /** `body`: the covering items' delivered text covers every line; `located`: only their places do. */
  | {status: 'body' | 'located'; pin: T};

/**
 * One written location against what a run delivered. The written path must
 * equal a delivered path, or be its trailing segments. A positive grade needs
 * one version (`versionKey`) whose ranges together cover every written line; a
 * range that only overlaps, an item without lines, or ranges of two versions
 * never do. Several covering versions are `ambiguous`, never merged. `body`
 * further needs the covering items that carry their text to cover the lines.
 * Source and knowledge citations share this reading.
 */
export function gradeWrittenLocation<T>(
  written: {filePath: string; lineRange: LineRange},
  items: readonly T[],
  read: {path(item: T): string; versionKey(item: T): string; range(item: T): LineRange | undefined; hasBody(item: T): boolean},
): WrittenLocationGrade<T> {
  const exact = items.filter(item => read.path(item) === written.filePath);
  const candidates = exact.length > 0 ? exact
    : items.filter(item => read.path(item).endsWith(`/${written.filePath}`));
  const byVersion = new Map<string, Array<{item: T; range: LineRange}>>();
  for (const item of candidates) {
    const range = read.range(item);
    if (!range) continue;
    const key = read.versionKey(item);
    const group = byVersion.get(key);
    if (group) group.push({item, range});
    else byVersion.set(key, [{item, range}]);
  }
  const covering = [...byVersion.values()].filter(group =>
    lineRangesCover(group.map(entry => entry.range), written.lineRange));
  if (covering.length === 0) return {status: 'unmatched'};
  // Only items that touch the written lines stand for it.
  const touching = (group: Array<{item: T; range: LineRange}>) =>
    group.filter(entry => lineRangesIntersect(entry.range, written.lineRange));
  if (covering.length > 1) {
    return {status: 'ambiguous', candidates: covering.map(group => touching(group).map(entry => entry.item))};
  }
  const group = touching(covering[0]!);
  const bodies = group.filter(entry => read.hasBody(entry.item));
  return lineRangesCover(bodies.map(entry => entry.range), written.lineRange)
    ? {status: 'body', pin: bodies[0]!.item}
    : {status: 'located', pin: group[0]!.item};
}

/**
 * One citation against the run's issued references (`gradeWrittenLocation`),
 * a version being one file of one codebase at one source generation.
 */
export function matchSourceCitation(
  citation: Pick<ExtractedSourceCitation, 'citation' | 'filePath' | 'lineRange' | 'malformed'>,
  references: readonly SourceReferenceV1[],
): SourceCitationV1 {
  const base = {citation: citation.citation, filePath: citation.filePath, lineRange: citation.lineRange};
  if (citation.malformed) return {...base, status: 'unmatched'};
  const grade = gradeWrittenLocation<SourceReferenceV1>(citation, references, {
    path: reference => reference.filePath, versionKey: sourceReferenceIdentity,
    range: reference => reference.lineRange, hasBody: reference => isBodyLookupKind(reference.lookupKind),
  });
  switch (grade.status) {
    case 'unmatched': return {...base, status: 'unmatched'};
    // Every candidate: a claim's binding pins one only when it is the sole version bound.
    case 'ambiguous': return {...base, status: 'ambiguous', candidateReferenceIds: grade.candidates.flat().map(reference => reference.id)};
    case 'body': return {...base, status: 'verified_body', sourceReferenceId: grade.pin.id};
    case 'located': return {...base, status: 'located', sourceReferenceId: grade.pin.id};
  }
}

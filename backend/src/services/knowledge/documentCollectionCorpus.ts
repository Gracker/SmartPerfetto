// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Reads a registered document collection into sections and retrieval chunks.
 *
 * Order matters for credentials: the raw file is redacted whole in its own
 * syntax first, then converted (frontmatter removed, HTML tags stripped and
 * entities decoded, which can join a key and its value), then the converted
 * text is redacted whole again, and only then cut into sections and chunks.
 * Titles and heading paths come from redacted text.
 *
 * Converted text keeps where it came from as source-line change points
 * (`MappedText`), so a section or chunk, even one slice of a long converted
 * line, reports the first and last source line its own characters span.
 * Redaction keeps every line break, which is what lets the second pass keep
 * that mapping line by line.
 */

import {createHash} from 'crypto';
import * as path from 'path';

import {
  type PathPreviewResult,
  PathSecurityGate,
  readAcceptedTextFileSync,
} from '../codebase/pathSecurityGate';
import {CodebaseStateError} from '../codebase/codebaseRequestError';
import {redactSecrets, redactSourceFile} from '../security/secretPatterns';
import {parseStoredYaml} from '../../utils/storedData';

const DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.html', '.htm'];
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const BATCH_MAX_FILES = 32;
const BATCH_MAX_BYTES = 2 * 1024 * 1024;
const TARGET_CHUNK_CHARS = 1_200;
const OVERLAP_CHARS = 150;
/** A fenced code block or table up to this size stays in one chunk. */
const MAX_WHOLE_BLOCK_CHARS = 2 * TARGET_CHUNK_CHARS;
const MAX_TITLE_CHARS = 240;

/** The gate every document-collection read goes through: the knowledge root allowlist and document extensions. */
export function createDocumentCollectionGate(options: {
  /**
   * Roots the caller itself trusts, in place of `SMARTPERFETTO_KNOWLEDGE_ROOTS`:
   * the local CLI user's own folder, as `smp codebase` trusts it.
   */
  allowlistRoots?: string[];
} = {}): PathSecurityGate {
  return new PathSecurityGate({
    ...(options.allowlistRoots ? {allowlistRoots: options.allowlistRoots} : {}),
    allowlistEnvironmentVariable: 'SMARTPERFETTO_KNOWLEDGE_ROOTS',
    allowedExtensions: DOCUMENT_EXTENSIONS,
    maxFileBytes: MAX_FILE_BYTES,
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    // Skip reasons are counted from this sample; keep it whole for any root the budgets admit.
    maxSkippedDiagnostics: 200_000,
  });
}

export type DocumentCollectionSkipReason =
  | 'extension_not_allowed'
  | 'file_too_large'
  | 'excluded'
  | 'outside_root'
  | 'empty_text'
  | 'read_failed'
  | 'unclassified';

export interface DocumentCollectionChunk {
  ordinal: number;
  body: string;
  startLine: number;
  endLine: number;
}

export interface DocumentCollectionSection {
  ordinal: number;
  heading: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  /** The whole redacted section text; chunks overlap, sections do not. */
  body: string;
  chunks: DocumentCollectionChunk[];
}

export interface DocumentCollectionDocument {
  relativePath: string;
  title: string;
  fileHash: string;
  sections: DocumentCollectionSection[];
}

export interface DocumentCollectionReadSummary {
  documentCount: number;
  sectionCount: number;
  chunkCount: number;
  skipped: Partial<Record<DocumentCollectionSkipReason, number>>;
  /** sha256 over each indexed document's relative path and file hash; no git. */
  contentFingerprint: string;
}

// ---------------------------------------------------------------------------
// Text with source-line change points

/**
 * Converted text and its source lines: from `offsets[k]` on the text comes
 * from source line `lines[k]`. Every conversion emits text in source order,
 * so lines never decrease along the text, and a span's first and last
 * source lines are those of its first and last character.
 */
interface MappedText {
  text: string;
  offsets: number[];
  lines: number[];
}

function lineAt(mapped: MappedText, offset: number): number {
  let low = 0;
  let high = mapped.offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (mapped.offsets[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return mapped.lines[low] ?? 1;
}

/** Text whose lines are source lines, the first being `firstLine` (after removed frontmatter). */
function lineAlignedText(text: string, firstLine: number): MappedText {
  const offsets = [0];
  const lines = [firstLine];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    offsets.push(index + 1);
    lines.push(lines[lines.length - 1]! + 1);
  }
  return {text, offsets, lines};
}

class MappedTextBuilder {
  private readonly parts: string[] = [];
  private readonly offsets: number[] = [];
  private readonly lines: number[] = [];
  length = 0;

  push(text: string, line: number): void {
    if (!text) return;
    if (this.lines[this.lines.length - 1] !== line) {
      this.offsets.push(this.length);
      this.lines.push(line);
    }
    this.parts.push(text);
    this.length += text.length;
  }

  build(): MappedText {
    return {text: this.parts.join(''), offsets: this.offsets, lines: this.lines};
  }
}

function countLineBreaks(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', start); index >= 0 && index < end; index = text.indexOf('\n', index + 1)) {
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Format conversion

type DocumentFormat = 'markdown' | 'asciidoc' | 'rst' | 'html' | 'text';

function documentFormat(relativePath: string): DocumentFormat {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case '.md':
    case '.markdown':
    case '.mdx':
      return 'markdown';
    case '.adoc':
      return 'asciidoc';
    case '.rst':
      return 'rst';
    case '.html':
    case '.htm':
      return 'html';
    default:
      return 'text';
  }
}

const FRONTMATTER = /^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/** Frontmatter is optional; its `title` is used when present. Returns the body and its first source line. */
function stripFrontmatter(text: string): {body: string; firstLine: number; title?: string} {
  const match = FRONTMATTER.exec(text);
  if (!match) return {body: text, firstLine: 1};
  let title: string | undefined;
  try {
    const parsed = parseStoredYaml(match[1] ?? '', 'frontmatter', {authored: true, startLine: 2});
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).title
      : undefined;
    if (typeof value === 'string') title = value;
  } catch {
    // Frontmatter is optional; an unreadable block only loses its title.
  }
  return {body: text.slice(match[0].length), firstLine: 1 + countLineBreaks(match[0], 0, match[0].length), title};
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', deg: '°', plusmn: '±',
};

function decodeEntity(entity: string): string | undefined {
  if (entity.startsWith('#')) {
    const codePoint = entity[1] === 'x' || entity[1] === 'X'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return undefined;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return undefined;
    return String.fromCodePoint(codePoint);
  }
  return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
}

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (whole, entity: string) => decodeEntity(entity) ?? whole);
}

const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const HTML_DROPPED_ELEMENTS = new Set(['head', 'noscript', 'script', 'style', 'template', 'title']);
const HTML_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/y;
const HTML_ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const HTML_TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

interface HtmlConversion {
  mapped: MappedText;
  /** Output offsets where an `<hN>` heading's own line starts. */
  headings: Array<{level: number; offset: number}>;
  title?: string;
}

function convertHtml(text: string): HtmlConversion {
  const builder = new MappedTextBuilder();
  const headings: HtmlConversion['headings'] = [];
  let openHeading: {level: number; offset: number} | undefined;
  let title: string | undefined;
  const lowerText = text.toLowerCase();
  let index = 0;
  let line = 1;
  /** Skip source text up to `end`, keeping the line count. */
  const skipTo = (end: number): void => {
    line += countLineBreaks(text, index, end);
    index = end;
  };
  const separate = (separatorLine: number): void => builder.push(openHeading ? ' ' : '\n', separatorLine);
  const TEXT_STOP = /[<&\n]/g;
  while (index < text.length) {
    const character = text[index]!;
    const tagLine = line;
    if (character === '<') {
      if (text.startsWith('<!--', index)) {
        const end = text.indexOf('-->', index + 4);
        skipTo(end < 0 ? text.length : end + 3);
        continue;
      }
      if (text.startsWith('<!', index) || text.startsWith('<?', index)) {
        const end = text.indexOf('>', index);
        skipTo(end < 0 ? text.length : end + 1);
        continue;
      }
      HTML_TAG.lastIndex = index;
      const tag = HTML_TAG.exec(text);
      if (tag) {
        const closing = tag[1] === '/';
        const name = tag[2]!.toLowerCase();
        skipTo(index + tag[0].length);
        if (!closing && HTML_DROPPED_ELEMENTS.has(name)) {
          const end = lowerText.indexOf(`</${name}`, index);
          const element = text.slice(index, end < 0 ? text.length : end);
          const titleMatch = name === 'title' ? [element, element] : HTML_TITLE.exec(element);
          if (titleMatch && title === undefined) title = decodeEntities(titleMatch[1] ?? '');
          const close = end < 0 ? -1 : text.indexOf('>', end);
          skipTo(close < 0 ? text.length : close + 1);
          separate(tagLine);
          continue;
        }
        const heading = /^h([1-6])$/.exec(name);
        if (heading) {
          if (!closing && !openHeading) {
            builder.push('\n', tagLine);
            openHeading = {level: Number(heading[1]), offset: builder.length};
          } else if (closing && openHeading) {
            headings.push(openHeading);
            openHeading = undefined;
            builder.push('\n', tagLine);
          }
          continue;
        }
        if (name === 'td' || name === 'th') {
          builder.push(' ', tagLine);
        } else if (HTML_BLOCK_TAGS.has(name)) {
          separate(tagLine);
        }
        continue;
      }
    } else if (character === '&') {
      HTML_ENTITY.lastIndex = index;
      const entity = HTML_ENTITY.exec(text);
      const decoded = entity ? decodeEntity(entity[1]!) : undefined;
      if (entity && decoded !== undefined) {
        builder.push(decoded, line);
        index += entity[0].length;
        continue;
      }
    } else if (character === '\n') {
      // A heading is one output line, whatever source lines it spans.
      builder.push(openHeading ? ' ' : '\n', line);
      line += 1;
      index += 1;
      continue;
    }
    TEXT_STOP.lastIndex = index + 1;
    const stop = TEXT_STOP.exec(text);
    const end = stop ? stop.index : text.length;
    builder.push(text.slice(index, end), line);
    index = end;
  }
  if (openHeading) headings.push(openHeading);
  return {mapped: builder.build(), headings, title};
}

// ---------------------------------------------------------------------------
// Lines, headings and sections

interface SourceRange {
  /** 0 when the text spans no source text (blank). */
  firstLine: number;
  lastLine: number;
}

interface DocumentLine extends SourceRange {
  /** Redacted text of one converted line. */
  text: string;
  blank: boolean;
  /** Source lines of the non-blank characters in `text.slice(start, end)`. */
  range(start: number, end: number): SourceRange;
}

function isBlank(text: string): boolean {
  return !/\S/.test(text);
}

const BLANK_RANGE: SourceRange = {firstLine: 0, lastLine: 0};

/**
 * Split converted text into lines and pair each with its redacted line.
 * Where redaction changed a line, offsets in the unchanged prefix and suffix
 * map exactly; one inside the changed middle maps to that middle's source
 * span, so a slice touching a redaction may widen to the redacted value's
 * lines, never narrow.
 */
function documentLines(mapped: MappedText, redactedText: string): DocumentLine[] {
  const redactedLines = redactedText.split('\n');
  const originalLines = mapped.text.split('\n');
  if (redactedLines.length !== originalLines.length) throw new Error('document_redaction_line_mismatch');
  let offset = 0;
  return redactedLines.map((text, index) => {
    const original = originalLines[index]!;
    const lineOffset = offset;
    offset += original.length + 1;
    let prefix = 0;
    let suffix = 0;
    if (original !== text) {
      const shorter = Math.min(original.length, text.length);
      while (prefix < shorter && original[prefix] === text[prefix]) prefix += 1;
      while (suffix < shorter - prefix &&
        original[original.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix += 1;
    }
    const middleFirst = lineOffset + Math.min(prefix, original.length - 1);
    const middleLast = lineOffset + Math.max(prefix, original.length - suffix - 1);
    const originalOffset = (at: number, edge: 'first' | 'last'): number => {
      if (original === text || at < prefix) return lineOffset + at;
      if (at >= text.length - suffix) return lineOffset + original.length - (text.length - at);
      return edge === 'first' ? middleFirst : middleLast;
    };
    const range = (start: number, requestedEnd: number): SourceRange => {
      const end = Math.min(requestedEnd, text.length);
      let first = start;
      while (first < end && /\s/.test(text[first]!)) first += 1;
      if (first >= end) return BLANK_RANGE;
      let last = end - 1;
      while (/\s/.test(text[last]!)) last -= 1;
      return {
        firstLine: lineAt(mapped, originalOffset(first, 'first')),
        lastLine: lineAt(mapped, originalOffset(last, 'last')),
      };
    };
    const whole = range(0, text.length);
    return {text, blank: whole.firstLine === 0, ...whole, range};
  });
}

interface DocumentHeading {
  level: number;
  text: string;
  /** Index of the heading's first line; an rst overline or setext text line included. */
  lineIndex: number;
}

function headingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})/;

function markdownHeadings(lines: readonly DocumentLine[]): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.text;
    const fenceMatch = MARKDOWN_FENCE.exec(text);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length &&
        text.trim() === fenceMatch[1]) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(text);
    if (atx) {
      const title = headingText(atx[2]!.replace(/[ \t]+#+[ \t]*$/, ''));
      if (title) headings.push({level: atx[1]!.length, text: title, lineIndex: index});
      continue;
    }
    const next = lines[index + 1]?.text;
    const setext = next === undefined ? undefined : /^ {0,3}(=+|-+)[ \t]*$/.exec(next);
    if (
      setext && !lines[index]!.blank && !/^ {4}/.test(text) &&
      (index === 0 || lines[index - 1]!.blank)
    ) {
      headings.push({level: setext[1]![0] === '=' ? 1 : 2, text: headingText(text), lineIndex: index});
      index += 1;
    }
  }
  return headings;
}

const ASCIIDOC_DELIMITER = /^(-{4,}|\.{4,}|`{3,}|\+{4,}|_{4,}|\*{4,}|={4,}|\/{4,})[ \t]*$/;

function asciidocHeadings(lines: readonly DocumentLine[]): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  let delimiter: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.text;
    const block = ASCIIDOC_DELIMITER.exec(text);
    if (delimiter) {
      if (block && block[1] === delimiter) delimiter = undefined;
      continue;
    }
    if (block) {
      delimiter = block[1];
      continue;
    }
    const heading = /^(={1,6})[ \t]+(\S.*)$/.exec(text);
    if (heading) headings.push({level: heading[1]!.length, text: headingText(heading[2]!), lineIndex: index});
  }
  return headings;
}

const RST_ADORNMENT = /^([!-/:-@[-`{-~])\1+[ \t]*$/;

function rstHeadings(lines: readonly DocumentLine[]): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  // reST levels follow the order in which adornment styles first appear.
  const styles: string[] = [];
  const levelOf = (style: string): number => {
    if (!styles.includes(style)) styles.push(style);
    return styles.indexOf(style) + 1;
  };
  const adornment = (index: number): string | undefined =>
    RST_ADORNMENT.exec(lines[index]?.text ?? '')?.[1];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.text;
    const over = adornment(index);
    const title = lines[index + 1]?.text;
    if (over && title !== undefined && !isBlank(title) && adornment(index + 2) === over) {
      headings.push({level: levelOf(`${over}/over`), text: headingText(title), lineIndex: index});
      index += 2;
      continue;
    }
    const under = adornment(index + 1);
    if (
      under && !lines[index]!.blank && !/^\s/.test(text) && !over &&
      lines[index + 1]!.text.trim().length >= Math.min(3, text.trim().length) &&
      (index === 0 || lines[index - 1]!.blank)
    ) {
      headings.push({level: levelOf(under), text: headingText(text), lineIndex: index});
      index += 1;
    }
  }
  return headings;
}

function htmlHeadings(
  mapped: MappedText,
  lines: readonly DocumentLine[],
  markers: HtmlConversion['headings'],
): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  let lineIndex = 0;
  let scanned = 0;
  for (const marker of markers) {
    for (; scanned < marker.offset && scanned < mapped.text.length; scanned += 1) {
      if (mapped.text[scanned] === '\n') lineIndex += 1;
    }
    const text = headingText(lines[lineIndex]?.text ?? '');
    if (text) headings.push({level: marker.level, text, lineIndex});
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Chunks

interface ChunkUnit extends SourceRange {
  text: string;
  /** Present for a whole converted line: the source lines of one slice of it. */
  range?: DocumentLine['range'];
}

function unitRange(units: readonly ChunkUnit[]): {startLine: number; endLine: number} {
  let startLine = 0;
  let endLine = 0;
  for (const unit of units) {
    if (unit.firstLine === 0) continue;
    if (startLine === 0 || unit.firstLine < startLine) startLine = unit.firstLine;
    if (unit.lastLine > endLine) endLine = unit.lastLine;
  }
  return {startLine, endLine};
}

function unitsLength(units: readonly ChunkUnit[]): number {
  return units.reduce((total, unit) => total + unit.text.length + 1, 0);
}

/** Paragraphs separated by blank lines; a fenced block stays one block across its blank lines. */
function sectionBlocks(lines: readonly DocumentLine[], format: DocumentFormat): ChunkUnit[][] {
  const blocks: ChunkUnit[][] = [];
  let current: ChunkUnit[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const fenceToken = format === 'markdown'
      ? MARKDOWN_FENCE.exec(line.text)?.[1]
      : format === 'asciidoc'
        ? ASCIIDOC_DELIMITER.exec(line.text)?.[1]
        : undefined;
    if (fence) {
      current.push(line);
      if (fenceToken && fenceToken[0] === fence[0] && fenceToken.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceToken) {
      if (current.length > 0) blocks.push(current);
      current = [line];
      fence = fenceToken;
      continue;
    }
    if (line.blank) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** A block too large to keep whole, cut at line boundaries; a single overlong line is cut by length. */
function splitBlock(block: readonly ChunkUnit[]): ChunkUnit[][] {
  const pieces: ChunkUnit[][] = [];
  let current: ChunkUnit[] = [];
  const flush = (): void => {
    if (current.length > 0) pieces.push(current);
    current = [];
  };
  for (const unit of block) {
    if (unit.text.length > TARGET_CHUNK_CHARS) {
      flush();
      for (let offset = 0; offset < unit.text.length; offset += TARGET_CHUNK_CHARS) {
        const end = offset + TARGET_CHUNK_CHARS;
        // Each slice reports the source lines of its own characters.
        const range = unit.range ? unit.range(offset, end) : unit;
        pieces.push([{text: unit.text.slice(offset, end), firstLine: range.firstLine, lastLine: range.lastLine}]);
      }
      continue;
    }
    if (current.length > 0 && unitsLength(current) + unit.text.length > TARGET_CHUNK_CHARS) flush();
    current.push(unit);
  }
  flush();
  return pieces;
}

const BLOCK_SEPARATOR: ChunkUnit = {text: '', ...BLANK_RANGE};

function chunkSection(lines: readonly DocumentLine[], format: DocumentFormat): DocumentCollectionChunk[] {
  const contents: ChunkUnit[][] = [];
  let current: ChunkUnit[] = [];
  const flush = (): void => {
    if (current.length > 0) contents.push(current);
    current = [];
  };
  for (const block of sectionBlocks(lines, format)) {
    const length = unitsLength(block);
    if (length > MAX_WHOLE_BLOCK_CHARS) {
      flush();
      contents.push(...splitBlock(block));
    } else if (length > TARGET_CHUNK_CHARS) {
      flush();
      contents.push([...block]);
    } else {
      if (current.length > 0 && unitsLength(current) + length + 1 > TARGET_CHUNK_CHARS) flush();
      if (current.length > 0) current.push(BLOCK_SEPARATOR);
      current.push(...block);
    }
  }
  flush();
  // Each chunk after the first repeats the previous chunk's last whole lines
  // (up to OVERLAP_CHARS) so a passage cut at a boundary is still found whole.
  return contents.map((units, ordinal) => {
    const overlap: ChunkUnit[] = [];
    const previous = ordinal > 0 ? contents[ordinal - 1]! : [];
    let overlapLength = 0;
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      const unit = previous[index]!;
      if (unit.firstLine === 0) break;
      if (overlapLength + unit.text.length + 1 > OVERLAP_CHARS) break;
      overlap.unshift(unit);
      overlapLength += unit.text.length + 1;
    }
    const all = [...overlap, ...units];
    return {body: all.map(unit => unit.text).join('\n'), ...unitRange(all)};
  }).filter(chunk => chunk.startLine > 0).map((chunk, ordinal) => ({ordinal, ...chunk}));
}

// ---------------------------------------------------------------------------
// Documents

function trimBlankEdges(lines: readonly DocumentLine[]): DocumentLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.blank) start += 1;
  while (end > start && lines[end - 1]!.blank) end -= 1;
  return lines.slice(start, end);
}

function redactedTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = headingText(redactSecrets(value).text);
  return title || undefined;
}

/**
 * Convert one document read from the gate. Undefined when it holds no
 * indexable text. Exported for the corpus tests; the reader below is its caller.
 */
export function convertDocumentCollectionFile(
  relativePath: string,
  raw: string,
): DocumentCollectionDocument | undefined {
  const format = documentFormat(relativePath);
  const fileHash = createHash('sha256').update(raw).digest('hex');
  // `\r\n` and a lone `\r` each end one source line.
  const normalized = redactSourceFile(raw, relativePath).text.replace(/\r\n?/g, '\n');
  let mapped: MappedText;
  let metadataTitle: string | undefined;
  let htmlMarkers: HtmlConversion['headings'] = [];
  if (format === 'html') {
    const converted = convertHtml(normalized);
    mapped = converted.mapped;
    htmlMarkers = converted.headings;
    metadataTitle = converted.title;
  } else if (format === 'markdown' || format === 'asciidoc') {
    // reST is left alone: a `---` overline and underline around a title is a heading there.
    const stripped = stripFrontmatter(normalized);
    mapped = lineAlignedText(stripped.body, stripped.firstLine);
    metadataTitle = stripped.title;
  } else {
    mapped = lineAlignedText(normalized, 1);
  }
  const lines = documentLines(mapped, redactSecrets(mapped.text).text);
  if (lines.every(line => line.blank)) return undefined;

  const headings = format === 'markdown'
    ? markdownHeadings(lines)
    : format === 'asciidoc'
      ? asciidocHeadings(lines)
      : format === 'rst'
        ? rstHeadings(lines)
        : format === 'html'
          ? htmlHeadings(mapped, lines, htmlMarkers)
          : [];

  const sections: DocumentCollectionSection[] = [];
  const stack: DocumentHeading[] = [];
  const boundaries = [
    {heading: undefined as DocumentHeading | undefined, lineIndex: 0},
    ...headings.map(heading => ({heading, lineIndex: heading.lineIndex})),
  ];
  for (let index = 0; index < boundaries.length; index += 1) {
    const {heading, lineIndex} = boundaries[index]!;
    const end = boundaries[index + 1]?.lineIndex ?? lines.length;
    if (heading) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
      stack.push(heading);
    }
    const sectionLines = trimBlankEdges(lines.slice(lineIndex, end));
    if (sectionLines.length === 0) continue;
    const range = unitRange(sectionLines);
    if (range.startLine === 0) continue;
    sections.push({
      ordinal: sections.length,
      heading: heading?.text ?? '',
      headingPath: heading ? stack.map(entry => entry.text) : [],
      ...range,
      body: sectionLines.map(line => line.text).join('\n'),
      chunks: chunkSection(sectionLines, format),
    });
  }
  if (sections.length === 0) return undefined;
  const title = redactedTitle(metadataTitle) ??
    headings[0]?.text ??
    headingText(path.posix.basename(relativePath, path.posix.extname(relativePath)));
  return {relativePath, title: title || relativePath, fileHash, sections};
}

// ---------------------------------------------------------------------------
// Reading a previewed collection

const GATE_SKIP_REASONS: Readonly<Record<string, DocumentCollectionSkipReason>> = {
  extension_not_allowed: 'extension_not_allowed',
  file_too_large: 'file_too_large',
  excluded: 'excluded',
  symlink_outside_root: 'outside_root',
};

/** Failures that mean the root itself changed: the whole read stops instead of skipping one file. */
function isRootFailure(error: unknown): boolean {
  return error instanceof CodebaseStateError;
}

export interface DocumentCollectionReadHooks {
  /** Before every batch, after yielding the event loop: renew a lease, honour cancellation. */
  beforeBatch?: () => void;
  /** Each batch of converted documents, in path order. */
  onBatch?: (documents: DocumentCollectionDocument[]) => void;
}

/**
 * Read every file a gate preview accepted, in bounded batches that yield the
 * event loop between them. A file that cannot be read or holds no text is
 * counted as skipped; a changed root fails the whole read.
 */
export async function readDocumentCollection(
  preview: PathPreviewResult,
  limits: Readonly<{maxFileBytes: number; maxTotalBytes: number}>,
  hooks: DocumentCollectionReadHooks = {},
): Promise<DocumentCollectionReadSummary> {
  const skipped: DocumentCollectionReadSummary['skipped'] = {};
  const skip = (reason: DocumentCollectionSkipReason, count = 1): void => {
    if (count > 0) skipped[reason] = (skipped[reason] ?? 0) + count;
  };
  for (const file of preview.skippedFiles) skip(GATE_SKIP_REASONS[file.reason] ?? 'unclassified');
  skip('unclassified', preview.skippedFileCount - preview.skippedFiles.length);

  const fingerprint = createHash('sha256');
  let documentCount = 0;
  let sectionCount = 0;
  let chunkCount = 0;
  let totalBytes = 0;
  const files = preview.acceptedFiles;
  for (let start = 0; start < files.length;) {
    await new Promise<void>(resolve => setImmediate(resolve));
    hooks.beforeBatch?.();
    const documents: DocumentCollectionDocument[] = [];
    let batchBytes = 0;
    let end = start;
    for (; end < files.length && end - start < BATCH_MAX_FILES && batchBytes < BATCH_MAX_BYTES; end += 1) {
      const relativePath = files[end]!.relativePath;
      let raw: string;
      try {
        raw = readAcceptedTextFileSync(preview.rootRealpath, relativePath, limits.maxFileBytes);
      } catch (error) {
        if (isRootFailure(error)) throw error;
        skip(error instanceof Error && error.message === 'source_file_too_large' ? 'file_too_large' : 'read_failed');
        continue;
      }
      const bytes = Buffer.byteLength(raw, 'utf8');
      batchBytes += bytes;
      totalBytes += bytes;
      if (totalBytes > limits.maxTotalBytes) throw new Error(`source_total_bytes_exceeded:${limits.maxTotalBytes}`);
      let document: DocumentCollectionDocument | undefined;
      try {
        document = convertDocumentCollectionFile(relativePath, raw);
      } catch {
        skip('read_failed');
        continue;
      }
      if (!document) {
        skip('empty_text');
        continue;
      }
      documents.push(document);
      fingerprint.update(`${relativePath}\0${document.fileHash}\0`);
      documentCount += 1;
      sectionCount += document.sections.length;
      chunkCount += document.sections.reduce((total, section) => total + section.chunks.length, 0);
    }
    if (documents.length > 0) hooks.onBatch?.(documents);
    start = end;
  }
  return {
    documentCount,
    sectionCount,
    chunkCount,
    skipped,
    contentFingerprint: fingerprint.digest('hex'),
  };
}

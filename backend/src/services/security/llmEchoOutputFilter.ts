// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {StringDecoder} from 'string_decoder';

export interface CodeRef {
  chunkId: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
}

interface Pattern {
  text: string;
  hash: string;
  kind: 'exact' | 'line' | 'sliding' | 'canary';
  codeRef?: CodeRef;
  replacement?: string;
}

interface TextUnit {
  start: number;
  end: number;
  kind: 'identifier' | 'quote' | 'ticks' | 'reference';
  close?: string;
  open: boolean;
}
interface EchoRange {start: number; end: number; patterns: Pattern[]; forced?: boolean}
interface DiscardedUnit {kind: 'identifier' | 'quote' | 'ticks' | 'line'; close: string; escaped: boolean; ticks: number; ignoredTicks: boolean}
const SUPPRESSED = '[PRIVATE_OUTPUT_SUPPRESSED]';
const REDACTED = '[REDACTED_CODE_ECHO]';
const MULTIPLE_SOURCES = '[Code: multiple source references]';
const identifierChar = (value: string | undefined): boolean => Boolean(value && /[A-Za-z0-9_$.:/#\\-]/.test(value));
const escapedAt = (text: string, index: number): boolean => {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
};
const highSurrogate = (value: string | undefined): boolean => Boolean(value && /[\uD800-\uDBFF]/.test(value));
const lowSurrogate = (value: string | undefined): boolean => Boolean(value && /[\uDC00-\uDFFF]/.test(value));

/** At most one trailing high surrogate is deferred; no input text is retained. */
function utf8ChunkBytes(text: string, pendingHigh: boolean): {bytes: number; pendingHigh: boolean} {
  if (!text) return {bytes: 0, pendingHigh};
  let bytes = Buffer.byteLength(text);
  if (pendingHigh) bytes += lowSurrogate(text[0]) ? 1 : 3;
  const pending = highSurrogate(text[text.length - 1]);
  if (pending) bytes -= 3;
  return {bytes, pendingHigh: pending};
}

/** Only the delimiters needed to redact an entire text unit, not a Markdown parser. */
function textUnits(text: string, references: readonly string[]): TextUnit[] {
  const units: TextUnit[] = [];
  for (let index = 0; index < text.length;) {
    const reference = text[index] === '[' ? references.find(value => text.startsWith(value, index)) : undefined;
    if (reference) {
      units.push({start: index, end: index + reference.length, kind: 'reference', open: false});
      index += reference.length; continue;
    }
    const char = text[index];
    const quote = ({'"': '"', "'": "'", '“': '”', '‘': '’'} as Record<string, string>)[char];
    if ((char === '`' || quote) && !escapedAt(text, index) && !(char === "'" && identifierChar(text[index - 1]))) {
      const start = index;
      let close = quote;
      if (char === '`') {while (text[index] === '`') index++; close = text.slice(start, index);}
      else index++;
      let closed = false;
      while (index < text.length) {
        if (char === '`' && text[index] === '`') {
          const runStart = index;
          while (text[index] === '`') index++;
          if (index - runStart >= close.length && !escapedAt(text, runStart)) {closed = true; break;}
        } else if (char !== '`' && text[index] === close && !escapedAt(text, index)) {index++; closed = true; break;}
        else index++;
      }
      units.push({start, end: index, kind: char === '`' ? 'ticks' : 'quote', close, open: !closed});
      continue;
    }
    if (identifierChar(char)) {
      const start = index++;
      while (identifierChar(text[index]) || text[index] === "'" || text[index] === '’') index++;
      units.push({start, end: index, kind: 'identifier', open: index === text.length});
      continue;
    }
    index++;
  }
  return units;
}

export interface LlmEchoStats {
  bytesProcessed: number;
  hits: Array<{
    patternHash: string;
    patternKind: Pattern['kind'];
    codeRef?: CodeRef;
    replacement: string;
    atOffset: number;
  }>;
  redactedBytes: number;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function replacementFor(pattern: Pattern): string {
  if (pattern.replacement) return pattern.replacement;
  if (pattern.kind === 'canary' || !pattern.codeRef) return '[REDACTED_CODE_ECHO]';
  const loc = pattern.codeRef.lineRange
    ? `${pattern.codeRef.filePath}:${pattern.codeRef.lineRange.start}-${pattern.codeRef.lineRange.end}`
    : pattern.codeRef.filePath;
  return `[Code: ${pattern.codeRef.symbol ?? pattern.codeRef.chunkId} @ ${loc}]`;
}

export class LLMEchoOutputStream {
  private static readonly MAX_DERIVED_PATTERNS = 4096;
  private static readonly MAX_DERIVED_PATTERN_BYTES = 512 * 1024;
  private static readonly MAX_TEXT_UNIT_CHARS = 2048;
  private patterns: Pattern[] = [];
  private patternBytes = 0;
  private referenceCache?: string[];
  private longestPattern = 0;
  private overflowed = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private rawOffset = 0;
  private discarded?: DiscardedUnit;
  private destroyed = false;
  private bytesProcessed = 0;
  private inputPendingHigh = false;
  private redactedBytes = 0;
  private redactedPendingHigh = false;
  private hits: LlmEchoStats['hits'] = [];

  constructor(private readonly maxPatternLength = 2048) {}

  get outputSuppressed(): boolean {
    return this.overflowed;
  }

  /** Output so far differs from its input: a replacement, a dropped unit, or overflow. */
  get altered(): boolean {
    return this.overflowed || this.redactedBytes > 0;
  }

  registerSnippet(snippet: string, ref: CodeRef): void {
    this.assertActive();
    this.registerDerivedPatterns(snippet, ref);
    this.sortPatterns();
  }

  registerCanary(canary: string): void {
    this.assertActive();
    this.addPattern(canary, 'canary');
    this.sortPatterns();
  }

  registerPrivateSnippet(snippet: string, replacement: string): void {
    this.assertActive();
    this.registerDerivedPatterns(snippet, undefined, replacement);
    this.sortPatterns();
  }

  private registerDerivedPatterns(
    snippet: string,
    codeRef?: CodeRef,
    replacement?: string,
  ): void {
    this.addPattern(snippet, 'exact', codeRef, replacement);
    for (const line of snippet.split(/\r?\n/)) {
      if (this.overflowed) break;
      const trimmed = line.trim();
      if (trimmed.length >= 8) this.addPattern(trimmed, 'line', codeRef, replacement);
    }
    for (let i = 0; i < snippet.length && !this.overflowed; i += 80) {
      const window = snippet.slice(i, i + 80).trim();
      if (window.length >= 16) this.addPattern(window, 'sliding', codeRef, replacement);
    }
    for (const token of snippet.match(/[A-Za-z0-9_.$:/-]{16,}/g) ?? []) {
      if (this.overflowed) break;
      this.addPattern(token, 'sliding', codeRef, replacement);
    }
    for (let i = 0; i + 24 <= snippet.length && !this.overflowed; i += 12) {
      this.addPattern(snippet.slice(i, i + 24), 'sliding', codeRef, replacement);
    }
  }

  write(tokenChunk: string | Buffer): string {
    this.assertActive();
    if (Buffer.isBuffer(tokenChunk)) {
      this.bytesProcessed += tokenChunk.length + (this.inputPendingHigh ? 3 : 0);
      this.inputPendingHigh = false;
    } else {
      const count = utf8ChunkBytes(tokenChunk, this.inputPendingHigh);
      this.bytesProcessed += count.bytes; this.inputPendingHigh = count.pendingHigh;
    }
    let text: string;
    if (Buffer.isBuffer(tokenChunk)) text = this.decoder.write(tokenChunk);
    else {text = this.decoder.end() + tokenChunk; this.decoder = new StringDecoder('utf8');}
    if (this.overflowed) return '';
    let output = '';
    // Input chunk size must not decide whether an oversized unit gets suppressed.
    const step = Math.max(32, this.maxPatternLength);
    for (let index = 0; index < text.length; index += step) {
      let part = text.slice(index, index + step);
      if (this.discarded) part = this.consumeDiscarded(part);
      this.buffer += part;
      output += this.redact(false);
    }
    return output;
  }

  flush(): string {
    this.assertActive();
    const tail = this.decoder.end();
    this.buffer += this.discarded ? this.consumeDiscarded(tail) : tail;
    const out = this.overflowed ? SUPPRESSED : this.redact(true);
    if (this.inputPendingHigh) this.bytesProcessed += 3;
    this.inputPendingHigh = false;
    this.finishRedactedBytes();
    this.discarded = undefined;
    return out;
  }

  stats(): LlmEchoStats {
    return {
      bytesProcessed: this.bytesProcessed,
      hits: [...this.hits],
      redactedBytes: this.redactedBytes,
    };
  }

  destroy(): void {
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.discarded = undefined;
    this.inputPendingHigh = false;
    this.redactedPendingHigh = false;
    this.patterns = [];
    this.patternBytes = 0;
    this.referenceCache = undefined;
    this.longestPattern = 0;
    this.overflowed = false;
    this.destroyed = true;
  }

  private addPattern(
    text: string,
    kind: Pattern['kind'],
    codeRef?: CodeRef,
    replacement?: string,
  ): void {
    if (this.overflowed) return;
    const normalized = text.trim();
    if (!normalized) return;
    const patternBytes = Buffer.byteLength(normalized, 'utf8');
    if (
      this.patterns.length >= LLMEchoOutputStream.MAX_DERIVED_PATTERNS ||
      this.patternBytes + patternBytes > LLMEchoOutputStream.MAX_DERIVED_PATTERN_BYTES
    ) {
      this.patterns = [];
      this.patternBytes = 0;
      this.overflowed = true;
      return;
    }
    this.patterns.push({
      text: normalized,
      hash: hash(normalized),
      kind,
      ...(codeRef ? {codeRef} : {}),
      ...(replacement ? {replacement} : {}),
    });
    this.patternBytes += patternBytes;
  }

  private sortPatterns(): void {
    if (this.overflowed) return;
    const seen = new Set<string>();
    this.patterns = this.patterns
      .filter(pattern => {
        const key = JSON.stringify([pattern.kind, pattern.text, pattern.replacement ?? null, pattern.codeRef ?? null]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.text.length - a.text.length);
    this.referenceCache = undefined;
    this.longestPattern = this.patterns[0]?.text.length ?? 0;
  }

  private sourceReferences(): string[] {
    if (this.referenceCache) return this.referenceCache;
    const references = [...new Set(this.patterns.filter(pattern => pattern.codeRef && !pattern.replacement)
      .map(replacementFor))];
    if (references.length > 1) references.push(MULTIPLE_SOURCES);
    this.referenceCache = references.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return this.referenceCache;
  }

  private matchingRanges(input: string, units: TextUnit[], barriers: EchoRange[], references: readonly string[]): EchoRange[] {
    const protectedReferences: Array<{start: number; end: number}> = [];
    for (const reference of references) {
      for (let index = input.indexOf(reference); index >= 0; index = input.indexOf(reference, index + reference.length)) {
        protectedReferences.push({start: index, end: index + reference.length});
      }
    }
    const matches: EchoRange[] = [];
    for (const pattern of this.patterns) {
      for (let index = input.indexOf(pattern.text); index >= 0; index = input.indexOf(pattern.text, index + 1)) {
        let start = index; let end = index + pattern.text.length;
        if (lowSurrogate(input[start]) && highSurrogate(input[start - 1])) start--;
        if (highSurrogate(input[end - 1]) && lowSurrogate(input[end])) end++;
        if (barriers.some(barrier => start < barrier.end && end > barrier.start)) continue;
        // Only exact registered references exempt source patterns. Hard privacy policies still scan them.
        if (pattern.codeRef && !pattern.replacement && pattern.kind !== 'canary' &&
            protectedReferences.some(reference => start >= reference.start && end <= reference.end)) continue;
        for (const unit of units) {
          if (unit.start >= end) break;
          if (unit.end > start) {start = Math.min(start, unit.start); end = Math.max(end, unit.end);}
        }
        matches.push({start, end, patterns: [pattern]});
      }
    }
    const merged: EchoRange[] = [];
    for (const match of matches.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const previous = merged[merged.length - 1];
      if (previous && match.start < previous.end) {
        previous.end = Math.max(previous.end, match.end); previous.patterns.push(...match.patterns);
      } else merged.push(match);
    }
    return merged;
  }

  private rangeReplacement(range: EchoRange): string {
    let replacement: string;
    if (range.forced) replacement = SUPPRESSED;
    else if (range.patterns.some(pattern => pattern.kind === 'canary')) replacement = REDACTED;
    else {
      const privateLabels = [...new Set(range.patterns.flatMap(pattern => pattern.replacement ? [pattern.replacement] : []))];
      const sourceLabels = [...new Set(range.patterns.map(replacementFor))];
      replacement = privateLabels.length ? privateLabels.length === 1 ? privateLabels[0] : REDACTED
        : sourceLabels.length === 1 ? sourceLabels[0] : MULTIPLE_SOURCES;
    }
    // A reference label itself can contain a registered secret or canary.
    const hard = this.patterns.filter(pattern => pattern.kind === 'canary' || pattern.replacement);
    return [replacement, REDACTED, SUPPRESSED, ''].find(value => !hard.some(pattern => value.includes(pattern.text))) ?? '';
  }

  private render(input: string, ranges: EchoRange[], end: number): string {
    let output = ''; let cursor = 0;
    for (const range of ranges) {
      if (range.end > end) break;
      this.finishRedactedBytes();
      const replacement = this.rangeReplacement(range);
      output += input.slice(cursor, range.start) + replacement;
      this.countRedactedBytes(input.slice(range.start, range.end));
      if (range.end < input.length) this.finishRedactedBytes();
      for (const pattern of [...new Set(range.patterns)].sort((a, b) => b.text.length - a.text.length ||
        ['canary', 'exact', 'line', 'sliding'].indexOf(a.kind) - ['canary', 'exact', 'line', 'sliding'].indexOf(b.kind))) {
        if (this.hits.length >= LLMEchoOutputStream.MAX_DERIVED_PATTERNS) break;
        const codeRef = pattern.codeRef && !Object.values(pattern.codeRef).some(value => typeof value === 'string' &&
          this.patterns.some(guard => (guard.kind === 'canary' || guard.replacement) && value.includes(guard.text))) ? pattern.codeRef : undefined;
        this.hits.push({patternHash: pattern.hash, patternKind: pattern.kind,
          ...(codeRef ? {codeRef} : {}), replacement, atOffset: this.rawOffset + range.start});
      }
      cursor = range.end;
    }
    return output + input.slice(cursor, end);
  }

  private countRedactedBytes(text: string): void {
    const count = utf8ChunkBytes(text, this.redactedPendingHigh);
    this.redactedBytes += count.bytes; this.redactedPendingHigh = count.pendingHigh;
  }

  private finishRedactedBytes(): void {
    if (this.redactedPendingHigh) this.redactedBytes += 3;
    this.redactedPendingHigh = false;
  }

  private consumeDiscarded(input: string): string {
    const unit = this.discarded!;
    let index = 0;
    for (; index < input.length; index++) {
      const char = input[index];
      if (unit.kind === 'line' && char === '\n' || unit.kind === 'identifier' &&
          !identifierChar(char) && char !== "'" && char !== '’') {this.discarded = undefined; break;}
      if (unit.kind === 'ticks') {
        if (char === '`') {
          if (unit.ticks === 0) unit.ignoredTicks = unit.escaped;
          unit.ticks++; unit.escaped = false; continue;
        }
        if (unit.ticks >= unit.close.length && !unit.ignoredTicks) {this.discarded = undefined; break;}
        unit.ticks = 0; unit.ignoredTicks = false;
      }
      if (unit.kind === 'quote' && char === unit.close && !unit.escaped) {
        index++; this.discarded = undefined; break;
      }
      unit.escaped = char === '\\' && !unit.escaped;
    }
    this.rawOffset += index;
    this.countRedactedBytes(input.slice(0, index));
    if (!this.discarded) this.finishRedactedBytes();
    return input.slice(index);
  }

  private redact(final: boolean): string {
    if (!this.patterns.length) {const result = this.buffer; this.rawOffset += result.length; this.buffer = ''; return result;}
    const references = this.sourceReferences();
    const unitBudget = LLMEchoOutputStream.MAX_TEXT_UNIT_CHARS;
    const lookbehind = Math.max(unitBudget, this.maxPatternLength, this.longestPattern, references[0]?.length ?? 0) + unitBudget;
    let output = '';
    while (this.buffer && (final || this.buffer.length >= lookbehind + unitBudget)) {
      const input = this.buffer;
      const units = textUnits(input, references);
      const barriers: EchoRange[] = units.filter(unit => unit.kind !== 'reference' &&
        (unit.end - unit.start > unitBudget || final && unit.open && unit.kind !== 'identifier'))
        .map(unit => ({start: unit.start, end: unit.end, patterns: [], forced: true}));
      let ranges = this.matchingRanges(input, units, barriers, references);
      // A connected echo larger than one bounded unit is suppressed through the next line boundary.
      for (const range of ranges) {
        if (range.end - range.start <= unitBudget) continue;
        const newline = input.indexOf('\n', range.start + unitBudget);
        barriers.push({start: range.start, end: newline < 0 ? input.length : newline, patterns: [], forced: true});
        break;
      }
      const barrier = barriers.sort((a, b) => a.start - b.start)[0];
      const safeEnd = final ? input.length : input.length - lookbehind;
      if (barrier && (final || barrier.start <= safeEnd)) {
        ranges = this.matchingRanges(input.slice(0, barrier.start), units.filter(unit => unit.end <= barrier.start), [], references);
        output += this.render(input, [...ranges, barrier], barrier.end);
        if (!final && barrier.end === input.length) {
          const unit = units.find(value => value.start === barrier.start && value.end === barrier.end);
          let ticks = 0;
          if (unit?.kind === 'ticks') {while (input[input.length - ticks - 1] === '`') ticks++;}
          if (!unit || unit.open) this.discarded = {kind: unit?.kind === 'quote' || unit?.kind === 'ticks' || unit?.kind === 'identifier' ? unit.kind : 'line',
            close: unit?.close ?? '', escaped: escapedAt(input, input.length), ticks,
            ignoredTicks: ticks > 0 && escapedAt(input, input.length - ticks)};
        }
        this.rawOffset += barrier.end; this.buffer = input.slice(barrier.end);
        continue;
      }
      let end = safeEnd;
      for (const range of [...units, ...ranges]) {
        if (range.start < end && range.end > end || !final && range.start < end && 'open' in range && range.open) end = range.start;
      }
      while (!final && end > 0 && (input[end - 1] === '\\' || /[\uD800-\uDBFF]/.test(input[end - 1]))) end--;
      if (end <= 0) break;
      output += this.render(input, ranges, end);
      this.rawOffset += end; this.buffer = input.slice(end);
    }
    return output;
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error('LLMEchoOutputStream has been destroyed');
    }
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadStrategyYaml} from '../../agentv3/strategyLoader';
import type {OnDemandSourceSearchMatch, OnDemandSourceSearchResult} from './onDemandSourceAccess';
import {escapeRegExp} from '../../utils/escapeRegExp';
import {compilePattern, exactKeys, isRecord, positiveInteger} from './policyYaml';

const POLICY_ASSET_NAME = 'source-anchor-normalization';
const POLICY_SCHEMA_VERSION = 'source_anchor_normalization@1' as const;

export const TRACE_ANCHOR_KINDS = ['slice', 'marker', 'thread', 'native_frame'] as const;
export type TraceAnchorKind = typeof TRACE_ANCHOR_KINDS[number];

/** Why a returned line is a candidate source for the anchor. */
export type AnchorMatchKind =
  | 'trace_call'
  | 'constant_definition'
  | 'thread_creation'
  | 'method_declaration'
  | 'framework_override'
  | 'template'
  | 'literal';

/**
 * A trace call site outranks a definition, which outranks any other line. A
 * thread anchor is named where the thread is created; a trace section that
 * merely contains the name is a different entity.
 */
const MATCH_RANK: Readonly<Record<AnchorMatchKind, number>> = {
  trace_call: 3,
  constant_definition: 2,
  thread_creation: 2,
  method_declaration: 2,
  framework_override: 2,
  template: 1,
  literal: 1,
};
const THREAD_MATCH_RANK: Readonly<Record<AnchorMatchKind, number>> = {...MATCH_RANK, thread_creation: 3, trace_call: 1};

interface FrameworkSlice {
  readonly match?: string;
  readonly prefix?: string;
  readonly symbols: readonly string[];
  readonly framework: boolean;
}

export interface SourceAnchorNormalization {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly maxInternalSearches: number;
  readonly minLiteralChars: number;
  readonly threadNameMaxChars: number;
  readonly traceCall: readonly RegExp[];
  readonly constantDefinition: readonly RegExp[];
  readonly threadCreation: readonly RegExp[];
  readonly templatePlaceholder: string;
  readonly frameworkSlices: readonly FrameworkSlice[];
}

const ROOT_KEYS = ['schema_version', 'max_internal_searches', 'min_literal_chars', 'thread_name_max_chars',
  'trace_call_patterns', 'constant_definition_patterns', 'thread_creation_patterns', 'template_placeholder',
  'framework_slices'] as const;

function patternList(value: unknown, errorCode: string, requireNameGroup = false): RegExp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(errorCode);
  return value.map(source => {
    const pattern = compilePattern(source, errorCode);
    if (requireNameGroup && !pattern.source.includes('(?<name>')) throw new Error(errorCode);
    return pattern;
  });
}

function frameworkSlice(value: unknown): FrameworkSlice {
  const error = 'source_anchor_normalization_invalid_framework_slice';
  if (!isRecord(value)) throw new Error(error);
  const keys = Object.keys(value);
  if (keys.some(key => !['match', 'prefix', 'symbols', 'framework'].includes(key))) throw new Error(error);
  const text = (field: unknown) => typeof field === 'string' && field.length > 0 ? field : undefined;
  const match = text(value.match);
  const prefix = text(value.prefix);
  // Exactly one of match or prefix.
  if (Boolean(match) === Boolean(prefix)) throw new Error(error);
  const symbols = value.symbols === undefined ? [] : value.symbols;
  if (!Array.isArray(symbols) || symbols.some(symbol => typeof symbol !== 'string' || !/^[A-Za-z_]\w*$/.test(symbol))) {
    throw new Error(error);
  }
  if (value.framework !== undefined && typeof value.framework !== 'boolean') throw new Error(error);
  if (symbols.length === 0 && value.framework !== true) throw new Error(error);
  return Object.freeze({...(match ? {match} : {prefix}), symbols: Object.freeze([...symbols]),
    framework: value.framework === true});
}

export function parseSourceAnchorNormalization(value: unknown): SourceAnchorNormalization {
  if (!isRecord(value) || !exactKeys(value, ROOT_KEYS) || value.schema_version !== POLICY_SCHEMA_VERSION) {
    throw new Error('source_anchor_normalization_invalid_root');
  }
  const templatePlaceholder = compilePattern(value.template_placeholder,
    'source_anchor_normalization_invalid_template').source;
  if (!Array.isArray(value.framework_slices)) throw new Error('source_anchor_normalization_invalid_framework_slice');
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    maxInternalSearches: positiveInteger(value.max_internal_searches, 'source_anchor_normalization_invalid_limit'),
    minLiteralChars: positiveInteger(value.min_literal_chars, 'source_anchor_normalization_invalid_limit'),
    threadNameMaxChars: positiveInteger(value.thread_name_max_chars, 'source_anchor_normalization_invalid_limit'),
    traceCall: patternList(value.trace_call_patterns, 'source_anchor_normalization_invalid_pattern'),
    constantDefinition: patternList(value.constant_definition_patterns,
      'source_anchor_normalization_invalid_pattern', true),
    threadCreation: patternList(value.thread_creation_patterns, 'source_anchor_normalization_invalid_pattern'),
    templatePlaceholder,
    frameworkSlices: Object.freeze(value.framework_slices.map(frameworkSlice)),
  });
}

export function loadSourceAnchorNormalization(): SourceAnchorNormalization {
  const policy = loadStrategyYaml(POLICY_ASSET_NAME, parseSourceAnchorNormalization);
  if (!policy) throw new Error('source_anchor_normalization_missing');
  return policy;
}

const wholeWord = (word: string): RegExp => new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
// Bounded quantifiers: a matched line may be a long minified one.
const methodDeclaration = (name: string): RegExp => new RegExp(
  `(?:\\b(?:fun|void|override|def|func|fn|static|public|private|protected|virtual|inline)\\b[^=;(]{0,200}` +
  `|(?:\\w{1,80}::){1,8})(?<![\\w$])${escapeRegExp(name)}\\s*\\(`);

interface PlannedQuery {
  readonly query: string;
  readonly matchedBy: AnchorMatchKind;
  /** A matching line must also match this. */
  readonly lineFilter?: RegExp;
  /** A matching line that also matches this is a declaration of the method. */
  readonly declaration?: RegExp;
  /** A looser reading, run only while nothing has been found. */
  readonly fallback?: true;
}

export interface TraceAnchorPlan {
  readonly queries: readonly PlannedQuery[];
  /** How the anchor was read, in the order applied. */
  readonly normalizations: readonly string[];
  /** The anchor is a framework slice: its implementation is in AOSP, not the app. */
  readonly framework?: {readonly implementation: 'aosp'; readonly overrides: readonly string[]};
  /** For a native frame, the owning class or namespace, used to rank its files first. */
  readonly owner?: string;
  /** Other `#` segments of the anchor, used to rank lines near them first. */
  readonly companions?: readonly string[];
}

/**
 * The searches for one trace anchor, before any is run. A framework slice
 * searches only the app methods that override its hook; a framework slice with
 * none searches nothing.
 */
export function planTraceAnchorSearch(
  input: {anchor: string; kind: TraceAnchorKind},
  policy: SourceAnchorNormalization,
): TraceAnchorPlan {
  const anchor = input.anchor.trim();
  const normalizations: string[] = [];
  const queries: PlannedQuery[] = [];
  const add = (query: PlannedQuery) => {
    if (query.query.length > 0 && !queries.some(existing => existing.query === query.query)) queries.push(query);
  };

  if (input.kind === 'native_frame') {
    const symbol = anchor
      .replace(/^.*!/, '')
      .replace(/\s*\+\s*0x[0-9a-f]+$/i, '')
      .replace(/\(.*$/, '')
      .trim();
    const parts = symbol.split(symbol.includes('::') ? '::' : '.').map(part => part.trim()).filter(Boolean);
    const method = parts[parts.length - 1] ?? symbol;
    const owner = parts.length > 1 ? parts[parts.length - 2] : undefined;
    if (method.length >= policy.minLiteralChars && method !== anchor) normalizations.push('native_frame_method');
    add({query: method.length >= policy.minLiteralChars ? method : anchor, matchedBy: 'literal',
      lineFilter: wholeWord(method), declaration: methodDeclaration(method)});
    return {queries: queries.slice(0, policy.maxInternalSearches), normalizations, ...(owner ? {owner} : {})};
  }

  if (input.kind === 'thread') {
    if (anchor.length === policy.threadNameMaxChars) normalizations.push('thread_name_prefix');
    add({query: anchor, matchedBy: 'literal'});
    return {queries, normalizations};
  }

  const framework = policy.frameworkSlices.find(slice =>
    slice.match !== undefined ? slice.match === anchor : anchor.startsWith(slice.prefix!));
  if (framework) {
    normalizations.push('framework_slice');
    for (const symbol of framework.symbols) {
      add({query: symbol, matchedBy: 'framework_override', lineFilter: methodDeclaration(symbol)});
    }
    return {queries: queries.slice(0, policy.maxInternalSearches), normalizations,
      ...(framework.framework ? {framework: {implementation: 'aosp' as const, overrides: framework.symbols}} : {})};
  }

  add({query: anchor, matchedBy: 'literal'});
  const literalPieces = anchor.split(/\d+/);
  if (literalPieces.length > 1) {
    // A number in the name may have been built at run time: search the longest
    // literal piece, keep lines whose literal reads the same with placeholders.
    const longest = literalPieces.map(piece => piece.trim()).sort((a, b) => b.length - a.length)[0] ?? '';
    if (longest.length >= policy.minLiteralChars) {
      normalizations.push('templated_number');
      const shape = anchor.split(/(\d+)/)
        .map((piece, index) => index % 2 === 1 ? policy.templatePlaceholder : escapeRegExp(piece))
        .join('');
      add({query: longest, matchedBy: 'template', lineFilter: new RegExp(shape), fallback: true});
    }
  }
  const segments = anchor.split('#').map(segment => segment.trim());
  if (segments.length > 1) {
    normalizations.push('hash_segments');
    for (const segment of [...segments].reverse()) {
      if (segment.length >= policy.minLiteralChars) add({query: segment, matchedBy: 'literal', fallback: true});
    }
  }
  return {
    queries: queries.slice(0, policy.maxInternalSearches),
    normalizations,
    ...(segments.length > 1 ? {companions: segments.filter(segment => segment.length >= policy.minLiteralChars)} : {}),
  };
}

export interface LocatedAnchorMatch extends OnDemandSourceSearchMatch {
  matchedBy: AnchorMatchKind;
  /** The anchor reaches this call site through a named constant. */
  viaConstant?: true;
}

export interface TraceAnchorLocateResult {
  success: boolean;
  codebaseId: string;
  matches: LocatedAnchorMatch[];
  /** More candidates exist than are shown. */
  moreResults?: boolean;
  /** The best candidates tie across different modules: the anchor is not pinned to one. */
  ambiguous?: boolean;
  searchesRun: number;
  normalizations: string[];
  framework?: TraceAnchorPlan['framework'];
  truncated: boolean;
  /**
   * False when an internal search did not cover every admitted file. A locate
   * never claims complete absence, so it is otherwise unset.
   */
  coverageComplete?: false;
  searchIncompleteReason?: string;
  backend?: OnDemandSourceSearchResult['backend'];
  unsupportedReason?: string;
}

/** The on-demand search options every locate uses: exact case, one line of context, internal line texts. */
export const TRACE_ANCHOR_SEARCH_OPTIONS = Object.freeze({
  caseSensitive: true,
  contextLines: 1,
  maxResults: 30,
  includeMatchLineText: true,
} as const);

/** One search with `TRACE_ANCHOR_SEARCH_OPTIONS`; the locator ranks lines by their `matchLineTexts`. */
type AnchorSearch = (query: string) => Promise<OnDemandSourceSearchResult>;

/** Classification reads at most this much of a line; a trace call or definition starts well before it. */
const CLASSIFY_LINE_CHARS = 4096;

/**
 * The fields a candidate carries out of the locator, named one by one: the
 * internal line texts (and anything else a search adds later) never leave it.
 */
function deliveredFields(match: OnDemandSourceSearchMatch): OnDemandSourceSearchMatch {
  return {
    referenceId: match.referenceId,
    codebaseId: match.codebaseId,
    filePath: match.filePath,
    lineRange: match.lineRange,
    matchLines: match.matchLines,
    ...(match.sourceGeneration !== undefined ? {sourceGeneration: match.sourceGeneration} : {}),
    ...(match.text !== undefined ? {text: match.text} : {}),
    ...(match.redactedCount !== undefined ? {redactedCount: match.redactedCount} : {}),
    ...(match.bodyUnavailable !== undefined ? {bodyUnavailable: match.bodyUnavailable} : {}),
  };
}

interface MatchedLine {
  readonly line: number;
  readonly text: string;
}

/** The matching lines of a hit window (adjacent hits share one), from the search's internal line texts. */
function matchedLines(match: OnDemandSourceSearchMatch): MatchedLine[] {
  const texts = match.matchLineTexts ?? [];
  return match.matchLines.flatMap((line, index) => texts[index] === undefined
    ? []
    : [{line, text: texts[index]!.slice(0, CLASSIFY_LINE_CHARS)}]);
}

/** The module a file belongs to: the path before its `src/`, else its first directory. */
function moduleRoot(filePath: string): string {
  const parts = filePath.split('/');
  const src = parts.indexOf('src');
  return src > 0 ? parts.slice(0, src).join('/') : parts[0] ?? '';
}

/** How many leading package segments of the traced process appear as consecutive path directories. */
function packageAffinity(filePath: string, processName: string | undefined): number {
  if (!processName) return 0;
  const segments = processName.split(':')[0]!.split('.').filter(Boolean);
  const directories = filePath.split('/');
  for (let length = segments.length; length > 0; length--) {
    const wanted = segments.slice(0, length);
    for (let start = 0; start + length <= directories.length; start++) {
      if (wanted.every((segment, offset) => directories[start + offset] === segment)) return length;
    }
  }
  return 0;
}

/**
 * Runs a planned locate: at most `maxInternalSearches` searches, stopping early
 * once enough trace call sites are found or the deadline passes, plus one hop
 * from a constant definition to the lines that use the constant. Matches keep
 * the search's own redaction and admission; nothing is read beyond them.
 */
export async function locateTraceAnchor(input: {
  anchor: string;
  kind: TraceAnchorKind;
  codebaseId: string;
  processName?: string;
  maxResults: number;
  search: AnchorSearch;
  policy: SourceAnchorNormalization;
  /** The plan the caller already made; otherwise planned here. */
  plan?: TraceAnchorPlan;
  deadlineMs?: number;
}): Promise<TraceAnchorLocateResult> {
  const {policy} = input;
  const plan = input.plan ?? planTraceAnchorSearch(input, policy);
  const matchRank = input.kind === 'thread' ? THREAD_MATCH_RANK : MATCH_RANK;
  const candidates = new Map<string, {match: LocatedAnchorMatch; rank: number; order: number}>();
  const constants: string[] = [];
  let searchesRun = 0;
  let anySuccess = false;
  let incompleteReason: string | undefined;
  let backend: OnDemandSourceSearchResult['backend'];
  const remaining = () => policy.maxInternalSearches - searchesRun;
  const beforeDeadline = () => input.deadlineMs === undefined || Date.now() < input.deadlineMs;

  /**
   * Why a hit window is a candidate, and the lines that show it: a window can
   * hold several hits, and only the decisive ones are pointed at.
   */
  const classify = (
    window: readonly MatchedLine[],
    planned: PlannedQuery,
  ): {kind: AnchorMatchKind; lines: number[]} | undefined => {
    const eligible = planned.lineFilter ? window.filter(({text}) => planned.lineFilter!.test(text)) : window;
    if (eligible.length === 0) return undefined;
    const where = (predicate: (text: string) => boolean) =>
      eligible.filter(({text}) => predicate(text)).map(({line}) => line);
    if (input.kind === 'thread') {
      const created = where(text => policy.threadCreation.some(pattern => pattern.test(text)));
      if (created.length > 0) return {kind: 'thread_creation', lines: created};
    }
    const traceCalls = where(text => policy.traceCall.some(pattern => pattern.test(text)));
    if (traceCalls.length > 0) return {kind: 'trace_call', lines: traceCalls};
    const all = eligible.map(({line}) => line);
    if (planned.matchedBy === 'framework_override') return {kind: 'framework_override', lines: all};
    for (const {line, text} of eligible) {
      for (const pattern of policy.constantDefinition) {
        const name = pattern.exec(text)?.groups?.name;
        if (name) {
          if (!constants.includes(name)) constants.push(name);
          return {kind: 'constant_definition', lines: [line]};
        }
      }
    }
    if (planned.declaration) {
      const declared = where(text => planned.declaration!.test(text));
      if (declared.length > 0) return {kind: 'method_declaration', lines: declared};
    }
    return {kind: planned.matchedBy, lines: all};
  };

  const run = async (planned: PlannedQuery, viaConstant?: string): Promise<OnDemandSourceSearchResult | undefined> => {
    if (remaining() <= 0 || !beforeDeadline()) return undefined;
    searchesRun += 1;
    const result = await input.search(planned.query);
    if (!result.success) return result;
    anySuccess = true;
    backend ??= result.backend;
    if (result.coverageComplete === false) incompleteReason ??= result.searchIncompleteReason ?? 'coverage_incomplete';
    for (const match of result.matches) {
      const window = matchedLines(match);
      // A hit with no line text (a file above the read limit) cannot be told
      // apart: it stays a plain hit unless the reading needs a line check.
      const classified = window.length > 0 ? classify(window, planned)
        : planned.lineFilter ? undefined : {kind: planned.matchedBy, lines: match.matchLines};
      if (!classified) continue;
      const matchedBy = classified.kind;
      // The constant's own definition is not a use of it.
      if (viaConstant && matchedBy === 'constant_definition') continue;
      // The same line found by two searches (in different windows) is one candidate.
      const key = `${match.filePath}\0${classified.lines[0]}`;
      const ownerFile = plan.owner !== undefined && match.filePath.split('/').pop()!.startsWith(plan.owner);
      const nearCompanion = plan.companions?.some(companion => match.filePath.includes(companion) ||
        (match.matchLineTexts ?? []).some(text => text.includes(companion))) === true;
      const rank = matchRank[matchedBy] * 100 + packageAffinity(match.filePath, input.processName) * 10 +
        (ownerFile ? 5 : 0) + (nearCompanion ? 2 : 0);
      const existing = candidates.get(key);
      if (!existing || existing.rank < rank) {
        candidates.set(key, {match: {...deliveredFields(match), matchLines: classified.lines, matchedBy,
          ...(viaConstant ? {viaConstant: true as const} : {})}, rank,
          order: existing?.order ?? candidates.size});
      }
    }
    return result;
  };

  for (const planned of plan.queries) {
    if (planned.fallback && candidates.size > 0) continue;
    // Keep one search for the constant hop once a constant has been found.
    if (constants.length > 0 && remaining() <= 1) break;
    const result = await run(planned);
    if (result && !result.success && searchesRun === 1) {
      // A refusal on the first search (consent, scope) is the locate's answer.
      return {success: false, codebaseId: input.codebaseId, matches: [], searchesRun,
        normalizations: [...plan.normalizations], truncated: false,
        ...(result.unsupportedReason ? {unsupportedReason: result.unsupportedReason} : {})};
    }
  }
  const constant = constants[0];
  if (constant && ![...candidates.values()].some(candidate => candidate.match.matchedBy === 'trace_call')) {
    await run({query: constant, matchedBy: 'literal', lineFilter: wholeWord(constant)}, constant);
  }

  const ranked = [...candidates.values()].sort((a, b) => b.rank - a.rank || a.order - b.order);
  const top = ranked[0];
  const tied = top ? ranked.filter(candidate => candidate.rank === top.rank) : [];
  const ambiguous = new Set(tied.map(candidate => moduleRoot(candidate.match.filePath))).size > 1;
  const shown = ranked.slice(0, input.maxResults).map(candidate => candidate.match);
  const normalizations = [...plan.normalizations, ...(constant ? ['constant_hop'] : [])];
  return {
    success: anySuccess || plan.queries.length === 0,
    codebaseId: input.codebaseId,
    matches: shown,
    ...(ranked.length > shown.length ? {moreResults: true} : {}),
    ...(ambiguous ? {ambiguous: true} : {}),
    searchesRun,
    normalizations,
    ...(plan.framework ? {framework: plan.framework} : {}),
    // Paging is not incomplete coverage.
    truncated: false,
    ...(incompleteReason ? {coverageComplete: false as const, searchIncompleteReason: incompleteReason} : {}),
    ...(backend ? {backend} : {}),
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, createHmac, randomBytes} from 'crypto';
import {spawn} from 'child_process';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import {StringDecoder} from 'string_decoder';

import type {CodeAwareMode} from './codeAwareFeature';
import {
  channelAuthorizedRoots,
  codebaseRootAvailable,
  type CodebaseRef,
  type CodebaseRegistry,
  type CodebaseScope,
} from './codebaseRegistry';
import {
  PathSecurityGate,
  readAcceptedTextFileSync,
} from './pathSecurityGate';
import {
  hardenedRipgrepEnvironment,
  hardenedRipgrepPrefixArguments,
} from './subprocessHardening';
import {
  createSourceProviderPathPredicate,
  sourceProviderGrantCanDescend,
} from './sourceDisclosure';
import {
  compileSourcePathGlob,
  sourceSelectionCanDescend,
  sourceSelectionForRef,
  sourceSelectionRipgrepArguments,
  type SourceSelectionIR,
} from './sourceSelectionPolicy';
import {REDACTED_SECRET, redactSourceFile} from '../security/secretPatterns';
import {isClosedCode} from '../../utils/closedCode';
import {detectSourceSymbol} from '../rag/baseIngester';
import {
  assertCodebaseRootIdentity,
  codebaseSourcePathMatches,
} from '../rag/sourceFileSelection';

const DEFAULT_MAX_RESULTS = 12;
const MAX_RESULTS = 30;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 5;
const MAX_READ_LINES = 200;
const DEFAULT_FIND_RESULTS = 20;
const MAX_FIND_RESULTS = 50;
const MISSING_FILE_CANDIDATES = 5;
const MISSING_FILE_LOOKUP_TIMEOUT_MS = 500;
/** A search reads at most this many ranked candidates per result it shows. */
const VERIFY_CANDIDATE_FACTOR = 3;
/** Ranking looks at no more of a candidate line than this. */
const RANK_LINE_CHARS = 512;
const ENCLOSING_SYMBOL_LOOKBACK_LINES = 400;
const MAX_DECLARATION_LINE_CHARS = 1_000;
const RIPGREP_TIMEOUT_MS = 3_000;
const RIPGREP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SUBPROCESS_TERMINATION_GRACE_MS = 250;
const NODE_WALK_MAX_VISITED_ENTRIES = 20_000;
const NODE_WALK_MAX_DIRECTORIES = 5_000;
/**
 * On-demand limits, separate from the 200 KiB indexing limit: framework files
 * such as View.java or ActivityThread.java are far larger and must stay
 * searchable and readable. A search scans files up to the search limit; a hit
 * in a file above the read limit returns its location without a body.
 */
export const ON_DEMAND_SEARCH_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const ON_DEMAND_READ_MAX_FILE_BYTES = 4 * 1024 * 1024;

export type SourceSearchIncompleteReason =
  | 'enumeration_budget'
  | 'time_budget'
  | 'output_budget'
  | 'traversal_error'
  // A match lay in a registered file outside the provider-send grant and was withheld.
  | 'provider_grant_scope';

type TraversalStopReason = Exclude<SourceSearchIncompleteReason, 'provider_grant_scope'>;

/**
 * How far a traversal got. Only `complete` saw every selected file; showing
 * fewer results than exist is paging (`moreResults`), not incompleteness.
 */
export type SourceSearchTraversal = 'complete' | 'stopped_at_cap' | 'timed_out' | 'error';

const TRAVERSAL_FOR_STOP: Readonly<Record<TraversalStopReason, SourceSearchTraversal>> = {
  enumeration_budget: 'stopped_at_cap',
  output_budget: 'stopped_at_cap',
  time_budget: 'timed_out',
  traversal_error: 'error',
};

/** What a traversal saw, before ranking: every admitted item it reached. */
interface SourceTraversal<T> {
  items: T[];
  stopReason?: TraversalStopReason;
  /** An item outside the provider-send grant was withheld. */
  grantWithheld: boolean;
}

/**
 * A line a backend reported as containing the query, scored from its text when
 * collected; the text itself is not kept (what is returned is read back
 * through the gate).
 */
interface SourceSearchCandidate {
  filePath: string;
  line: number;
  score: number;
}

/** What a search or find covers once admitted: its root, policy and scope. */
interface ScopedLookup {
  root: string;
  policy: SourceSelectionIR;
  requestedPrefix?: string;
  effectivePrefixes: string[];
  coverageScope: 'codebase' | 'path_prefix';
  providerPathAllowed?: (relativePath: string) => boolean;
}

export interface OnDemandSourceReference {
  referenceId: string;
  codebaseId: string;
  filePath: string;
  lineRange: {start: number; end: number};
  /** The live file content this range was read from (`liveContentVersion`). */
  sourceGeneration?: string;
  text?: string;
  redactedCount?: number;
}

export interface OnDemandSourceSearchMatch extends OnDemandSourceReference {
  /** The matching lines inside `lineRange`; the other lines are context. */
  matchLines: number[];
  /** The file is above the read limit: its location is returned, not its body. */
  bodyUnavailable?: 'file_too_large';
}

interface SourceCoverageFields {
  truncated: boolean;
  backend?: 'ripgrep' | 'node';
  traversal?: SourceSearchTraversal;
  coverageComplete?: boolean;
  /**
   * What `coverageComplete` covers: the whole registered selection, or only the
   * requested `path_prefix` inside it. A prefix-scoped empty search is not
   * evidence of codebase-wide absence.
   */
  coverageScope?: 'codebase' | 'path_prefix';
  searchIncompleteReason?: SourceSearchIncompleteReason;
  /** More results exist than are shown: paging, not incomplete coverage. */
  moreResults?: boolean;
  /** Files above this size were not searched. */
  scope?: {maxFileBytes: number};
  unsupportedReason?: string;
}

/**
 * A refusal (`success: false` with `unsupportedReason`) searched nothing, so it
 * carries no backend or coverage fields.
 */
export interface OnDemandSourceSearchResult extends SourceCoverageFields {
  success: boolean;
  codebaseId: string;
  matches: OnDemandSourceSearchMatch[];
  /** Matching lines the traversal saw; a lower bound unless it was complete. */
  totalMatches?: number;
  /** Distinct files among the shown matches. */
  fileCount?: number;
  caseSensitive?: boolean;
  enumerationBackend?: 'ripgrep' | 'git' | 'node-walk';
  backendFidelity?: 'exact' | 'degraded';
}

export interface OnDemandSourceFindResult extends SourceCoverageFields {
  success: boolean;
  codebaseId: string;
  files: Array<{filePath: string}>;
  /** Matching files the traversal saw; a lower bound unless it was complete. */
  totalFiles?: number;
}

export interface OnDemandSourceReadResult {
  success: boolean;
  codebaseId: string;
  reference?: OnDemandSourceReference;
  window?: {
    totalLines: number;
    omittedBefore: number;
    omittedAfter: number;
    nextStartLine: number | null;
    symbolCoverage: 'not_assessed';
    /** The nearest declaration at or above the window start; a heuristic. */
    enclosingSymbol?: {name: string; line: number; heuristic: true};
  };
  /** Admitted files with the requested file's name, when it does not exist. */
  candidates?: string[];
  truncated: boolean;
  unsupportedReason?: string;
}

export interface OnDemandSourceAccessServiceOptions {
  registry: CodebaseRegistry;
  gate?: PathSecurityGate;
  platform?: NodeJS.Platform;
  ripgrepPath?: string;
  searchTimeoutMs?: number;
  maxSearchOutputBytes?: number;
  maxConcurrentSearches?: number;
  concurrencyWaitTimeoutMs?: number;
  searchMaxFileBytes?: number;
  readMaxFileBytes?: number;
}

type RegisteredCodebase = CodebaseRef & {lifecycleState?: 'active' | 'deleting'};
type SearchWaiter = {grant: () => void; timeout?: NodeJS.Timeout};

export function codebaseOnDemandAvailability(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'rootRealpath'>,
): {available: true} | {available: false; reason: 'codebase_deleting' | 'codebase_root_unavailable'} {
  if (ref.lifecycleState === 'deleting') {
    return {available: false, reason: 'codebase_deleting'};
  }
  return codebaseRootAvailable(ref)
    ? {available: true}
    : {available: false, reason: 'codebase_root_unavailable'};
}

/** provider_send reaches a codebase's source only with that codebase's own consent. */
export function onDemandConsentFailure(
  ref: Pick<CodebaseRef, 'consent'>,
  mode: CodeAwareMode,
): 'no_send_to_provider_consent' | undefined {
  return mode === 'provider_send' && !ref.consent.sendToProvider ? 'no_send_to_provider_consent' : undefined;
}

/** One id per returned range: a window and a hit that start on the same line differ. */
function referenceId(codebaseId: string, filePath: string, range: {start: number; end: number}): string {
  return `source_${createHash('sha256')
    .update(`${codebaseId}\0${filePath}\0${range.start}\0${range.end}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field}_invalid`);
  }
  return resolved;
}

function placeholderCount(text: string): number {
  return text.split(REDACTED_SECRET).length - 1;
}

/**
 * One file as a search or read sees it, read once through the gate. Its
 * provider text is the whole file redacted in its own syntax, so a window or a
 * hit line never starts inside a literal or comment whose start it cannot see;
 * redaction keeps every line break, so its lines stay aligned with the file's.
 */
/** Per-process key: a content version matches within a run but fingerprints nothing outside it. */
const LIVE_CONTENT_VERSION_KEY = randomBytes(32);

/**
 * Identifies the live file content a returned range came from, so a read of a
 * file that changed after a search never stands in for the hit it searched.
 */
function liveContentVersion(content: string): string {
  return `live-${createHmac('sha256', LIVE_CONTENT_VERSION_KEY).update(content).digest('hex').slice(0, 16)}`;
}

class SourceFileView {
  readonly lines: string[];
  private redactedLines?: string[];
  private version?: string;

  constructor(private readonly content: string, readonly filePath: string) {
    this.lines = content.split(/\r?\n/);
  }

  /** Computed only for files whose ranges are returned. */
  get contentVersion(): string {
    this.version ??= liveContentVersion(this.content);
    return this.version;
  }

  /**
   * What a provider sees of lines [start, end): under `provider_send` their
   * redacted text and how many values in them were withheld (placeholders the
   * file did not already hold; the whole-file count would cover other lines),
   * otherwise nothing.
   */
  providerProjection(start: number, end: number, mode: CodeAwareMode): {text?: string; redactedCount?: number} {
    if (mode !== 'provider_send') return {};
    this.redactedLines ??= redactSourceFile(this.content, this.filePath).text.split(/\r?\n/);
    const text = this.redactedLines.slice(start, end).join('\n');
    return {text, redactedCount: placeholderCount(text) - placeholderCount(this.lines.slice(start, end).join('\n'))};
  }
}

function escapeLiteralGlob(value: string): string {
  return value.replace(/[\\*?\[\]{}!]/g, character => `\\${character}`);
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

function pathHasPrefix(
  parent: string,
  child: string,
  platform: NodeJS.Platform,
): boolean {
  const comparableParent = comparablePath(parent, platform);
  const comparableChild = comparablePath(child, platform);
  return comparableChild === comparableParent || comparableChild.startsWith(`${comparableParent}/`);
}

/** Smart case: a query with an upper-case letter matches case-sensitively. */
function smartCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

function lineMatcher(query: string, caseSensitive: boolean): (line: string) => boolean {
  if (caseSensitive) return line => line.includes(query);
  const folded = query.toLowerCase();
  return line => line.toLowerCase().includes(folded);
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;
const TRACE_CALL = /\b(?:Trace\.(?:beginSection|traceBegin|beginAsyncSection|asyncTraceBegin|traceCounter|setCounter)|TraceCompat\.beginSection|ATRACE_[A-Z_]+|TRACE_EVENT[A-Z0-9_]*|ScopedTrace|PERFETTO_TE_SLICE_BEGIN|trace\s*\(|traceSection\s*\()/;
const LOW_SIGNAL_PATH_SEGMENT = /^(?:test|tests|__tests__|androidTest|testFixtures|testing|generated|build|out|intermediates)$/i;
const TEST_FILE_NAME = /(?:Test|Tests|_test|_unittest|Spec)\.[^./]+$/;

function lowSignalPath(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.slice(0, -1).some(segment => LOW_SIGNAL_PATH_SEGMENT.test(segment)) ||
    TEST_FILE_NAME.test(segments[segments.length - 1]!);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scores a candidate line for deterministic ranking from its text alone:
 * declarations of the query, trace-section call sites, whole-word and
 * exact-case occurrences up, test/generated/build paths down.
 */
function searchLineScorer(query: string, caseSensitive: boolean): (filePath: string, text: string) => number {
  const flags = caseSensitive ? '' : 'i';
  const shortQuery = query.split(/[.#:]+/).filter(Boolean).pop() ?? query;
  const identifier = /^[A-Za-z_$][\w$]*$/.test(shortQuery);
  const declaration = identifier
    ? new RegExp(`(?:\\b(?:val|var|let|const|def|fn|func|function|typealias)\\s+|(?:^|\\s)#\\s*define\\s+)${escapeRegExp(shortQuery)}\\b`, flags)
    : undefined;
  const sameName = (name: string | undefined): boolean => name !== undefined &&
    (caseSensitive ? name === shortQuery : name.toLowerCase() === shortQuery.toLowerCase());
  const occurrence = new RegExp(escapeRegExp(query), `g${flags}`);
  const wholeWord = (text: string): boolean => {
    for (const match of text.matchAll(occurrence)) {
      const before = text[match.index! - 1];
      const after = text[match.index! + match[0].length];
      if ((!before || !IDENTIFIER_CHARACTER.test(before)) && (!after || !IDENTIFIER_CHARACTER.test(after))) return true;
    }
    return false;
  };
  return (filePath, line) => {
    const text = line.slice(0, RANK_LINE_CHARS);
    return (identifier && (sameName(detectSourceSymbol(text)) || declaration!.test(text)) ? 8 : 0) +
      (TRACE_CALL.test(text) ? 6 : 0) +
      (wholeWord(text) ? 2 : 0) +
      (text.includes(query) ? 1 : 0) -
      // Outweighs every positive feature: test or generated code ranks below
      // any production hit, even its own declaration of the name.
      (lowSignalPath(filePath) ? 20 : 0);
  };
}

function compareSearchCandidates(left: SourceSearchCandidate, right: SourceSearchCandidate): number {
  return right.score - left.score ||
    (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0) ||
    left.line - right.line;
}

/** Found files in order: exact name, name prefix, shallower, ordinary paths, then path. */
function rankFiles(filePaths: readonly string[], name: string | undefined, caseSensitive: boolean): string[] {
  const fold = (value: string): string => caseSensitive ? value : value.toLowerCase();
  const wanted = name === undefined ? undefined : fold(name);
  return filePaths.map(filePath => {
    const base = fold(path.posix.basename(filePath));
    return {
      filePath,
      score: (wanted !== undefined && base === wanted ? 4 : 0) +
        (wanted !== undefined && base.startsWith(wanted) ? 2 : 0) -
        (lowSignalPath(filePath) ? 4 : 0),
      depth: filePath.split('/').length,
    };
  }).sort((left, right) => right.score - left.score || left.depth - right.depth ||
    (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0))
    .map(entry => entry.filePath);
}

/** The nearest declaration at or above a line (1-based), within a bounded look-back. */
function enclosingSymbol(lines: readonly string[], line: number):
{name: string; line: number; heuristic: true} | undefined {
  const floor = Math.max(1, line - ENCLOSING_SYMBOL_LOOKBACK_LINES);
  for (let current = Math.min(line, lines.length); current >= floor; current -= 1) {
    // A declaration is never this long; a minified line would only make the
    // declaration patterns backtrack.
    if (lines[current - 1]!.length > MAX_DECLARATION_LINE_CHARS) continue;
    const name = detectSourceSymbol(lines[current - 1]!);
    if (name) return {name, line: current, heuristic: true};
  }
  return undefined;
}

function coverageFields(
  traversal: SourceTraversal<unknown>,
  coverageScope: 'codebase' | 'path_prefix',
): Pick<SourceCoverageFields, 'truncated' | 'traversal' | 'coverageComplete' | 'coverageScope' | 'searchIncompleteReason'> {
  const stopReason = traversal.stopReason;
  const incompleteReason: SourceSearchIncompleteReason | undefined =
    stopReason ?? (traversal.grantWithheld ? 'provider_grant_scope' : undefined);
  return {
    truncated: stopReason !== undefined,
    traversal: stopReason ? TRAVERSAL_FOR_STOP[stopReason] : 'complete',
    coverageComplete: incompleteReason === undefined,
    coverageScope,
    ...(incompleteReason ? {searchIncompleteReason: incompleteReason} : {}),
  };
}

/** A path the provider-send grant does not cover: its matches are withheld. */
function outsideProviderGrant(prepared: Pick<ScopedLookup, 'providerPathAllowed'>, filePath: string): boolean {
  return prepared.providerPathAllowed !== undefined && !prepared.providerPathAllowed(filePath);
}

export class OnDemandSourceAccessService {
  private readonly registry: CodebaseRegistry;
  private readonly gate: PathSecurityGate;
  private readonly platform: NodeJS.Platform;
  private readonly ripgrepPath: string;
  private readonly searchTimeoutMs: number;
  private readonly maxSearchOutputBytes: number;
  private readonly maxConcurrentSearches: number;
  private readonly concurrencyWaitTimeoutMs: number;
  private readonly searchMaxFileBytes: number;
  private readonly readMaxFileBytes: number;
  private activeSearches = 0;
  private readonly searchWaiters: SearchWaiter[] = [];

  constructor(options: OnDemandSourceAccessServiceOptions) {
    this.registry = options.registry;
    this.gate = options.gate ?? new PathSecurityGate();
    this.platform = options.platform ?? process.platform;
    this.ripgrepPath = options.ripgrepPath ?? 'rg';
    this.searchTimeoutMs = boundedPositiveInteger(
      options.searchTimeoutMs,
      RIPGREP_TIMEOUT_MS,
      60_000,
      'search_timeout_ms',
    );
    this.maxSearchOutputBytes = boundedPositiveInteger(
      options.maxSearchOutputBytes,
      RIPGREP_MAX_OUTPUT_BYTES,
      64 * 1024 * 1024,
      'max_search_output_bytes',
    );
    this.maxConcurrentSearches = boundedPositiveInteger(
      options.maxConcurrentSearches,
      4,
      32,
      'max_concurrent_searches',
    );
    this.concurrencyWaitTimeoutMs = boundedPositiveInteger(
      options.concurrencyWaitTimeoutMs,
      this.searchTimeoutMs,
      60_000,
      'concurrency_wait_timeout_ms',
    );
    this.searchMaxFileBytes = boundedPositiveInteger(
      options.searchMaxFileBytes,
      ON_DEMAND_SEARCH_MAX_FILE_BYTES,
      64 * 1024 * 1024,
      'search_max_file_bytes',
    );
    this.readMaxFileBytes = boundedPositiveInteger(
      options.readMaxFileBytes,
      Math.min(ON_DEMAND_READ_MAX_FILE_BYTES, this.searchMaxFileBytes),
      this.searchMaxFileBytes,
      'read_max_file_bytes',
    );
  }

  private acquireSearchSlot(): Promise<boolean> {
    if (this.tryAcquireSearchSlot()) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiter: SearchWaiter = {grant: () => resolve(true)};
      waiter.timeout = setTimeout(() => {
        const index = this.searchWaiters.indexOf(waiter);
        if (index >= 0) this.searchWaiters.splice(index, 1);
        resolve(false);
      }, this.concurrencyWaitTimeoutMs);
      waiter.timeout.unref();
      this.searchWaiters.push(waiter);
    });
  }

  private releaseSearchSlot(): void {
    this.activeSearches = Math.max(0, this.activeSearches - 1);
    const waiter = this.searchWaiters.shift();
    if (!waiter) return;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    this.activeSearches += 1;
    waiter.grant();
  }

  private resolveRef(codebaseId: string, scope: CodebaseScope): RegisteredCodebase {
    const ref = this.registry.get(codebaseId, scope);
    if (!ref) throw new Error('codebase_not_found');
    const availability = codebaseOnDemandAvailability(ref);
    if (!availability.available) throw new Error(availability.reason);
    return ref;
  }

  private async validateRoot(ref: RegisteredCodebase): Promise<string> {
    const root = await this.gate.validateRoot(
      ref.rootRealpath,
      channelAuthorizedRoots(ref),
    );
    assertCodebaseRootIdentity(ref.rootRealpath, root, this.platform);
    return root;
  }

  /**
   * The prefixes a search actually covers. `disjoint` means no admitted file
   * can lie under the requested prefix: it is outside the registered filters
   * or inside a directory the source policy never descends into. `narrowed`
   * means the prefix covers less than the whole registered selection.
   */
  private sourceSearchPrefixes(
    ref: RegisteredCodebase,
    requestedPrefix: string | undefined,
    policy: SourceSelectionIR,
  ): {requestedPrefix?: string; effectivePrefixes: string[]; disjoint: boolean; narrowed: boolean} {
    const registered = [...new Set((ref.pathFilters ?? []).map(prefix =>
      this.gate.validateRelativeSourcePrefix(prefix, {enforceConfiguredExcludes: false})))];
    const requested = requestedPrefix
      ? this.gate.validateRelativeSourcePrefix(requestedPrefix, {enforceConfiguredExcludes: false})
      : undefined;
    if (!requested) return {effectivePrefixes: registered, disjoint: false, narrowed: false};
    const effectivePrefixes = registered.length === 0
      ? [requested]
      : [...new Set(registered.flatMap(prefix => {
          if (pathHasPrefix(prefix, requested, this.platform)) return [requested];
          if (pathHasPrefix(requested, prefix, this.platform)) return [prefix];
          return [];
        }))];
    return {
      requestedPrefix: requested,
      effectivePrefixes,
      disjoint: effectivePrefixes.length === 0 ||
        !sourceSelectionCanDescend(policy, requested, this.platform),
      // Same comparison as pathHasPrefix: case-insensitive only on win32, the
      // gate's one case-insensitive platform.
      narrowed: effectivePrefixes.length !== registered.length ||
        effectivePrefixes.some(prefix => !registered.some(registeredPrefix =>
          samePath(prefix, registeredPrefix, this.platform))),
    };
  }

  private ripgrepGlobArguments(
    effectivePrefixes: readonly string[],
    policy: SourceSelectionIR,
  ): string[] {
    const caseInsensitive = this.platform === 'win32';
    const option = caseInsensitive ? '--iglob' : '--glob';
    const includeGlobs = [...policy.extensions].flatMap(extension => {
      if (effectivePrefixes.length === 0) return [`*${escapeLiteralGlob(extension)}`];
      return effectivePrefixes.map(prefix =>
        `${escapeLiteralGlob(prefix)}/**/*${escapeLiteralGlob(extension)}`);
    });
    const allowedExtensions = new Set(policy.extensions);
    const exactPrefixGlobs = effectivePrefixes
      .filter(prefix => {
        const rawExtension = path.posix.extname(prefix);
        const extension = caseInsensitive
          ? rawExtension.toLocaleLowerCase('en-US')
          : rawExtension;
        return allowedExtensions.has(extension);
      })
      .map(escapeLiteralGlob);
    return [
      ...[...exactPrefixGlobs, ...includeGlobs].flatMap(glob => [option, glob]),
      ...sourceSelectionRipgrepArguments(policy, this.platform),
    ];
  }

  private tryAcquireSearchSlot(): boolean {
    if (this.activeSearches >= this.maxConcurrentSearches) return false;
    this.activeSearches += 1;
    return true;
  }

  /**
   * Shared admission for searches and file finds: consent, root, the prefixes
   * the call covers, and the provider grant. A refusal searched nothing.
   */
  private async prepareScopedLookup(
    ref: RegisteredCodebase,
    mode: CodeAwareMode,
    pathPrefix: string | undefined,
  ): Promise<{refusal: string} | ScopedLookup> {
    const consentFailure = onDemandConsentFailure(ref, mode);
    if (consentFailure) return {refusal: consentFailure};
    const root = await this.validateRoot(ref);
    const policy = sourceSelectionForRef(ref, this.searchMaxFileBytes);
    const prefixes = this.sourceSearchPrefixes(ref, pathPrefix, policy);
    // An empty complete result under such a prefix would read as source absence.
    if (prefixes.disjoint) return {refusal: 'source_path_prefix_outside_registered_filters'};
    if (
      mode === 'provider_send' && prefixes.requestedPrefix &&
      !sourceProviderGrantCanDescend(ref, prefixes.requestedPrefix, this.platform)
    ) {
      return {refusal: 'source_path_prefix_outside_provider_grant'};
    }
    return {
      root,
      policy,
      ...(prefixes.requestedPrefix ? {requestedPrefix: prefixes.requestedPrefix} : {}),
      effectivePrefixes: prefixes.effectivePrefixes,
      coverageScope: prefixes.narrowed ? 'path_prefix' : 'codebase',
      ...(mode === 'provider_send'
        ? {providerPathAllowed: createSourceProviderPathPredicate(ref, this.platform, policy)}
        : {}),
    };
  }

  async search(input: {
    codebaseId: string;
    scope: CodebaseScope;
    query: string;
    mode: CodeAwareMode;
    pathPrefix?: string;
    fileGlob?: string;
    caseSensitive?: boolean;
    contextLines?: number;
    maxResults?: number;
  }): Promise<OnDemandSourceSearchResult> {
    // Matching is per line in every backend (ripgrep rejects a multi-line
    // literal), so a line break is as malformed as a NUL.
    if (!input.query || input.query.length > 512 || /[\0\r\n]/.test(input.query)) {
      throw new Error('source_query_invalid');
    }
    const maxResults = boundedPositiveInteger(input.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS, 'max_results');
    const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > MAX_CONTEXT_LINES) {
      throw new Error('context_lines_invalid');
    }
    const fileGlob = input.fileGlob === undefined ? undefined : compileSourcePathGlob(input.fileGlob, this.platform);
    const caseSensitive = input.caseSensitive ?? smartCaseSensitive(input.query);
    const ref = this.resolveRef(input.codebaseId, input.scope);
    const prepared = await this.prepareScopedLookup(ref, input.mode, input.pathPrefix);
    if ('refusal' in prepared) {
      return {success: false, codebaseId: input.codebaseId, matches: [], truncated: false,
        unsupportedReason: prepared.refusal};
    }
    if (!await this.acquireSearchSlot()) {
      return {
        success: true, codebaseId: input.codebaseId, matches: [], ...this.busyCoverage(prepared),
        totalMatches: 0, fileCount: 0, caseSensitive, enumerationBackend: 'ripgrep', backendFidelity: 'exact',
      };
    }
    try {
      const admits = (relativePath: string): boolean => !fileGlob || fileGlob(relativePath);
      const matches = lineMatcher(input.query, caseSensitive);
      const score = searchLineScorer(input.query, caseSensitive);
      const {backend, value: traversal} = await this.withNodeFallback(
        () => this.searchCandidatesWithRipgrep(ref, prepared, input.query, caseSensitive, admits, score),
        () => this.searchCandidatesWithNode(ref, prepared, input.query, caseSensitive, admits, score),
      );
      const shown = this.rankAndVerify({
        ref,
        root: prepared.root,
        mode: input.mode,
        candidates: traversal.items,
        matches,
        maxResults,
        contextLines: input.mode === 'provider_send' ? contextLines : 0,
      });
      return {
        success: true,
        codebaseId: input.codebaseId,
        matches: shown.matches,
        backend,
        // A file the traversal reported but the gate no longer reads was not
        // verifiably searched.
        ...coverageFields(shown.readError && !traversal.stopReason
          ? {...traversal, stopReason: 'traversal_error'}
          : traversal, prepared.coverageScope),
        moreResults: shown.moreResults,
        totalMatches: traversal.items.length,
        fileCount: new Set(shown.matches.map(match => match.filePath)).size,
        caseSensitive,
        scope: {maxFileBytes: this.searchMaxFileBytes},
        enumerationBackend: backend === 'ripgrep' ? 'ripgrep' : 'node-walk',
        // A finished Node walk visits every selected file, but applies no
        // ignore files and is slower; that is reported here, not as coverage.
        backendFidelity: backend === 'ripgrep' ? 'exact' : 'degraded',
      };
    } finally {
      this.releaseSearchSlot();
    }
  }

  /** The answer of a search or find that waited too long for a slot: nothing searched. */
  private busyCoverage(prepared: ScopedLookup) {
    return {
      backend: 'ripgrep' as const,
      ...coverageFields({items: [], stopReason: 'time_budget', grantWithheld: false}, prepared.coverageScope),
      moreResults: false,
      scope: {maxFileBytes: this.searchMaxFileBytes},
    };
  }

  /** Runs the ripgrep backend, or the Node walk when ripgrep cannot run. */
  private async withNodeFallback<T>(
    ripgrep: () => Promise<T>,
    node: () => Promise<T>,
  ): Promise<{backend: 'ripgrep' | 'node'; value: T}> {
    try {
      return {backend: 'ripgrep', value: await ripgrep()};
    } catch (error) {
      if (!this.shouldUseNodeFallback(error)) throw error;
      return {backend: 'node', value: await node()};
    }
  }

  /**
   * Ranks every candidate, then reads the best through the gate until enough
   * verify (at most VERIFY_CANDIDATE_FACTOR per shown result). Each file is
   * read once and released as soon as no later examined candidate needs it;
   * verified hits in one file share merged context windows.
   */
  private rankAndVerify(input: {
    ref: RegisteredCodebase;
    root: string;
    mode: CodeAwareMode;
    candidates: SourceSearchCandidate[];
    matches: (line: string) => boolean;
    maxResults: number;
    contextLines: number;
  }): {matches: OnDemandSourceSearchMatch[]; moreResults: boolean; readError: boolean} {
    const ranked = input.candidates.sort(compareSearchCandidates);
    const examinable = ranked.slice(0, input.maxResults * VERIFY_CANDIDATE_FACTOR);
    const pending = new Map<string, number>();
    for (const candidate of examinable) pending.set(candidate.filePath, (pending.get(candidate.filePath) ?? 0) + 1);
    const files = new Map<string, {view: SourceFileView; bodyAvailable: boolean} | null>();
    const accepted = new Map<string, Set<number>>();
    let acceptedCount = 0;
    let examined = 0;
    let readError = false;
    for (const candidate of examinable) {
      if (acceptedCount >= input.maxResults) break;
      examined += 1;
      let file = files.get(candidate.filePath);
      if (file === undefined) {
        try {
          const content = readAcceptedTextFileSync(input.root, candidate.filePath, this.searchMaxFileBytes);
          file = {
            view: new SourceFileView(content, candidate.filePath),
            bodyAvailable: Buffer.byteLength(content, 'utf8') <= this.readMaxFileBytes,
          };
        } catch {
          readError = true;
          file = null;
        }
        files.set(candidate.filePath, file);
      }
      const text = file?.view.lines[candidate.line - 1];
      if (text !== undefined && input.matches(text)) {
        const lines = accepted.get(candidate.filePath) ?? new Set<number>();
        if (!lines.has(candidate.line)) acceptedCount += 1;
        accepted.set(candidate.filePath, lines.add(candidate.line));
      }
      const remaining = pending.get(candidate.filePath)! - 1;
      pending.set(candidate.filePath, remaining);
      // A file nothing was accepted from is not needed once its last examined
      // candidate is checked; up to 16 MiB each, they must not pile up.
      if (remaining === 0 && !accepted.has(candidate.filePath)) files.set(candidate.filePath, null);
    }
    const shown: OnDemandSourceSearchMatch[] = [];
    // Files keep the order of their best hit; windows within a file go by line.
    for (const [filePath, lines] of accepted) {
      const {view, bodyAvailable} = files.get(filePath)!;
      const context = bodyAvailable ? input.contextLines : 0;
      const windows: Array<{start: number; end: number; matchLines: number[]}> = [];
      for (const line of [...lines].sort((left, right) => left - right)) {
        const start = Math.max(1, line - context);
        const end = Math.min(view.lines.length, line + context);
        const last = windows[windows.length - 1];
        if (last && start <= last.end + 1) {
          last.end = Math.max(last.end, end);
          last.matchLines.push(line);
        } else {
          windows.push({start, end, matchLines: [line]});
        }
      }
      for (const window of windows) {
        shown.push({
          referenceId: referenceId(input.ref.codebaseId, filePath, window),
          codebaseId: input.ref.codebaseId,
          filePath,
          lineRange: {start: window.start, end: window.end},
          matchLines: window.matchLines,
          // A location-only hit has no version: no read can ever cover it.
          ...(bodyAvailable
            ? {sourceGeneration: view.contentVersion,
              ...view.providerProjection(window.start - 1, window.end, input.mode)}
            : {bodyUnavailable: 'file_too_large' as const}),
        });
      }
    }
    return {matches: shown, moreResults: examined < ranked.length, readError};
  }

  /**
   * Finds admitted files by a name substring (a path substring when it holds
   * `/`) or a glob. Only relative paths are returned; no file is read.
   */
  async find(input: {
    codebaseId: string;
    scope: CodebaseScope;
    pattern: string;
    mode: CodeAwareMode;
    pathPrefix?: string;
    maxResults?: number;
  }): Promise<OnDemandSourceFindResult> {
    if (!input.pattern || input.pattern.length > 256 || /[\0\r\n]/.test(input.pattern)) {
      throw new Error('source_file_pattern_invalid');
    }
    const maxResults = boundedPositiveInteger(input.maxResults, DEFAULT_FIND_RESULTS, MAX_FIND_RESULTS, 'max_results');
    const caseSensitive = smartCaseSensitive(input.pattern);
    const glob = /[*?]/.test(input.pattern);
    const wholePath = input.pattern.includes('/');
    let matchesPath: (relativePath: string) => boolean;
    if (glob) {
      matchesPath = compileSourcePathGlob(input.pattern, this.platform);
    } else {
      const matches = lineMatcher(input.pattern, caseSensitive);
      matchesPath = relativePath => matches(wholePath ? relativePath : path.posix.basename(relativePath));
    }
    const ref = this.resolveRef(input.codebaseId, input.scope);
    const prepared = await this.prepareScopedLookup(ref, input.mode, input.pathPrefix);
    if ('refusal' in prepared) {
      return {success: false, codebaseId: input.codebaseId, files: [], truncated: false,
        unsupportedReason: prepared.refusal};
    }
    if (!await this.acquireSearchSlot()) {
      return {success: true, codebaseId: input.codebaseId, files: [], ...this.busyCoverage(prepared), totalFiles: 0};
    }
    try {
      const {backend, value: traversal} = await this.listFiles(ref, prepared, matchesPath, this.searchTimeoutMs);
      const ranked = rankFiles(traversal.items, glob || wholePath ? undefined : input.pattern, caseSensitive);
      return {
        success: true,
        codebaseId: input.codebaseId,
        files: ranked.slice(0, maxResults).map(filePath => ({filePath})),
        backend,
        ...coverageFields(traversal, prepared.coverageScope),
        moreResults: ranked.length > maxResults,
        totalFiles: ranked.length,
        scope: {maxFileBytes: this.searchMaxFileBytes},
      };
    } finally {
      this.releaseSearchSlot();
    }
  }

  /** Every admitted file the predicate accepts, by ripgrep or the Node walk. */
  private listFiles(
    ref: RegisteredCodebase,
    prepared: ScopedLookup,
    matchesPath: (relativePath: string) => boolean,
    timeoutMs: number,
  ): Promise<{backend: 'ripgrep' | 'node'; value: SourceTraversal<string>}> {
    // Each backend collects afresh, so a failed ripgrep start leaves nothing behind.
    const collect = async (
      traverse: (accept: (filePath: string) => void) => Promise<TraversalStopReason | undefined>,
    ): Promise<SourceTraversal<string>> => {
      const files: string[] = [];
      let grantWithheld = false;
      const stopReason = await traverse(filePath => {
        if (!matchesPath(filePath)) return;
        if (outsideProviderGrant(prepared, filePath)) {
          grantWithheld = true;
          return;
        }
        files.push(filePath);
      });
      return {items: files, stopReason, grantWithheld};
    };
    return this.withNodeFallback(
      () => collect(accept => this.runRipgrep(
        prepared.root,
        ['--files', ...this.ripgrepScopeArguments(prepared), '.'],
        timeoutMs,
        line => {
          const filePath = this.admittedPath(ref, prepared, line);
          if (filePath) accept(filePath);
        },
      )),
      () => collect(accept => this.walkAdmittedFiles(ref, prepared, timeoutMs, accept)),
    );
  }

  /** A traversal-reported path, validated and inside the call's scope, or undefined. */
  private admittedPath(
    ref: RegisteredCodebase,
    prepared: Pick<ScopedLookup, 'policy' | 'requestedPrefix'>,
    rawPath: string,
  ): string | undefined {
    const filePath = this.gate.validateRelativeSourcePath(rawPath, {enforceConfiguredExcludes: false});
    return codebaseSourcePathMatches(ref, filePath, prepared.requestedPrefix, this.platform, prepared.policy)
      ? filePath
      : undefined;
  }

  async read(input: {
    codebaseId: string;
    scope: CodebaseScope;
    filePath: string;
    startLine?: number;
    aroundLine?: number;
    maxLines?: number;
    /** The run's per-window cap; a larger request is paged with nextStartLine. */
    lineCap?: number;
    mode: CodeAwareMode;
  }): Promise<OnDemandSourceReadResult> {
    // A refusal or file-level failure is data the caller can act on, like
    // missing consent; every code is path-free and the path is not echoed.
    const failed = (
      unsupportedReason: string,
      extra: Pick<OnDemandSourceReadResult, 'window' | 'candidates'> = {},
    ): OnDemandSourceReadResult => ({
      success: false,
      codebaseId: input.codebaseId,
      ...extra,
      truncated: false,
      unsupportedReason,
    });
    const ref = this.resolveRef(input.codebaseId, input.scope);
    if (input.mode === 'off') return failed('code_aware_disabled_for_session');
    const consentFailure = onDemandConsentFailure(ref, input.mode);
    if (consentFailure) return failed(consentFailure);
    const root = await this.validateRoot(ref);
    const admission = this.gate.admitRelativeSourcePath(
      input.filePath,
      {enforceConfiguredExcludes: false},
    );
    if (!admission.admitted) return failed(admission.reason);
    const filePath = admission.path;
    const selectionPolicy = sourceSelectionForRef(ref, this.searchMaxFileBytes);
    if (!codebaseSourcePathMatches(
      ref,
      filePath,
      undefined,
      this.platform,
      selectionPolicy,
    )) {
      return failed('source_path_outside_registered_filters');
    }
    const providerPathAllowed = input.mode === 'provider_send'
      ? createSourceProviderPathPredicate(ref, this.platform, selectionPolicy)
      : undefined;
    if (providerPathAllowed && !providerPathAllowed(filePath)) {
      return failed('source_path_outside_provider_grant');
    }
    if (input.startLine !== undefined && input.aroundLine !== undefined) {
      return failed('source_read_window_conflict');
    }
    let maxLines: number;
    let startLine: number;
    let content: string;
    try {
      maxLines = Math.min(boundedPositiveInteger(input.maxLines, 80, MAX_READ_LINES, 'max_lines'),
        input.lineCap ?? MAX_READ_LINES);
      startLine = input.aroundLine !== undefined
        ? Math.max(1, boundedPositiveInteger(input.aroundLine, 1, Number.MAX_SAFE_INTEGER, 'around_line') -
          Math.floor((maxLines - 1) / 2))
        : boundedPositiveInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER, 'start_line');
      content = readAcceptedTextFileSync(root, filePath, this.readMaxFileBytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'source_file_not_found') {
        const candidates = await this.missingFileCandidates(ref, input.mode, filePath);
        return failed(code, candidates.length > 0 ? {candidates} : {});
      }
      return failed(isClosedCode(code) ? code : 'source_read_failed');
    }
    const file = new SourceFileView(content, filePath);
    const lines = file.lines;
    if (startLine > lines.length) {
      return failed('source_line_out_of_range', {window: {
        totalLines: lines.length,
        omittedBefore: lines.length,
        omittedAfter: 0,
        nextStartLine: null,
        symbolCoverage: 'not_assessed',
      }});
    }
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = startLine + selected.length - 1;
    const projected = file.providerProjection(startLine - 1, endLine, input.mode);
    const symbol = enclosingSymbol(lines, startLine);
    return {
      success: true,
      codebaseId: input.codebaseId,
      reference: {
        referenceId: referenceId(input.codebaseId, filePath, {start: startLine, end: endLine}),
        codebaseId: input.codebaseId,
        filePath,
        lineRange: {start: startLine, end: endLine},
        sourceGeneration: file.contentVersion,
        ...projected,
      },
      window: {
        totalLines: lines.length,
        omittedBefore: startLine - 1,
        omittedAfter: lines.length - endLine,
        nextStartLine: endLine < lines.length ? endLine + 1 : null,
        symbolCoverage: 'not_assessed',
        ...(symbol ? {enclosingSymbol: symbol} : {}),
      },
      truncated: endLine < lines.length,
    };
  }

  /**
   * Admitted files with a missing file's name, best effort: only when a search
   * slot is free, within a short deadline, and never outside the provider grant.
   */
  private async missingFileCandidates(
    ref: RegisteredCodebase,
    mode: CodeAwareMode,
    filePath: string,
  ): Promise<string[]> {
    if (!this.tryAcquireSearchSlot()) return [];
    try {
      const prepared = await this.prepareScopedLookup(ref, mode, undefined);
      if ('refusal' in prepared) return [];
      const name = path.posix.basename(filePath);
      const wanted = name.toLowerCase();
      const {value: traversal} = await this.listFiles(ref, prepared,
        candidate => path.posix.basename(candidate).toLowerCase() === wanted,
        MISSING_FILE_LOOKUP_TIMEOUT_MS);
      return rankFiles(traversal.items.filter(candidate => candidate !== filePath), name, true)
        .slice(0, MISSING_FILE_CANDIDATES);
    } catch {
      return [];
    } finally {
      this.releaseSearchSlot();
    }
  }

  private ripgrepScopeArguments(
    prepared: {policy: SourceSelectionIR; effectivePrefixes: readonly string[]},
  ): string[] {
    return [
      '--color',
      'never',
      ...hardenedRipgrepPrefixArguments(this.searchMaxFileBytes),
      ...this.ripgrepGlobArguments(prepared.effectivePrefixes, prepared.policy),
    ];
  }

  private async searchCandidatesWithRipgrep(
    ref: RegisteredCodebase,
    prepared: ScopedLookup,
    query: string,
    caseSensitive: boolean,
    admits: (relativePath: string) => boolean,
    score: (filePath: string, text: string) => number,
  ): Promise<SourceTraversal<SourceSearchCandidate>> {
    const candidates: SourceSearchCandidate[] = [];
    let grantWithheld = false;
    // Ripgrep reports a file's matches together: judge each path once.
    let lastPath: {rawPath: string; verdict: () => string | 'skip' | 'withheld'} | undefined;
    const judge = (rawPath: string): string | 'skip' | 'withheld' => {
      if (lastPath?.rawPath !== rawPath) {
        let verdict: () => string | 'skip' | 'withheld';
        try {
          const filePath = this.admittedPath(ref, prepared, rawPath);
          const outcome = !filePath || !admits(filePath) ? 'skip'
            : outsideProviderGrant(prepared, filePath) ? 'withheld' : filePath;
          verdict = () => outcome;
        } catch (error) {
          verdict = () => { throw error; };
        }
        lastPath = {rawPath, verdict};
      }
      return lastPath.verdict();
    };
    const stopReason = await this.runRipgrep(
      prepared.root,
      [
        '--json',
        '--fixed-strings',
        caseSensitive ? '--case-sensitive' : '--ignore-case',
        '--line-number',
        '--no-heading',
        ...this.ripgrepScopeArguments(prepared),
        '--',
        query,
        '.',
      ],
      this.searchTimeoutMs,
      line => {
        let event: {type?: string; data?: {path?: {text?: string}; line_number?: number; lines?: {text?: string}}};
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type !== 'match') return;
        const rawPath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (!rawPath || !Number.isInteger(lineNumber)) return;
        const verdict = judge(rawPath);
        if (verdict === 'skip') return;
        if (verdict === 'withheld') {
          // Withheld without its path, but the search no longer covers every
          // registered file, so it cannot report complete coverage.
          grantWithheld = true;
          return;
        }
        // Ripgrep's line text is an untrusted ranking hint; what is returned
        // is read back through the gate.
        const text = typeof event.data?.lines?.text === 'string' ? event.data.lines.text.replace(/\r?\n$/, '') : '';
        candidates.push({filePath: verdict, line: lineNumber!, score: score(verdict, text)});
      },
    );
    return {items: candidates, stopReason, grantWithheld};
  }

  /**
   * Runs ripgrep over one root and hands each output line to `onRecord`.
   * Resolves with why the traversal stopped early, if it did; rejects only
   * when ripgrep cannot run (the caller may fall back to the Node walk).
   * Output is an untrusted locator: a record `onRecord` cannot accept (it
   * throws) leaves the traversal incomplete rather than projecting it.
   */
  private runRipgrep(
    root: string,
    args: string[],
    timeoutMs: number,
    onRecord: (line: string) => void,
  ): Promise<TraversalStopReason | undefined> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ripgrepPath, args, {
        cwd: root,
        env: hardenedRipgrepEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const decoder = new StringDecoder('utf8');
      let stdoutBuffer = '';
      let stdoutBytes = 0;
      let stderrObserved = false;
      let recordError = false;
      let settled = false;
      let stopReason: TraversalStopReason | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (reason: TraversalStopReason): void => {
        if (stopReason) return;
        stopReason = reason;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, SUBPROCESS_TERMINATION_GRACE_MS);
        killTimer.unref();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (stopReason) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxSearchOutputBytes) {
          terminate('output_budget');
          return;
        }
        stdoutBuffer += decoder.write(chunk);
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0 && !stopReason) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line) {
            try {
              onRecord(line);
            } catch {
              recordError = true;
            }
          }
          newline = stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.on('data', () => {
        stderrObserved = true;
      });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (!stopReason && code !== 0 && code !== 1 && code !== 2) {
          const error = new Error(`ripgrep_search_failed:${code ?? 'signal'}`) as NodeJS.ErrnoException;
          error.code = String(code ?? 'signal');
          reject(error);
          return;
        }
        resolve(stopReason ?? (code === 2 || stderrObserved || recordError ? 'traversal_error' : undefined));
      });
      const timeout = setTimeout(() => terminate('time_budget'), timeoutMs);
      timeout.unref();
    });
  }

  private shouldUseNodeFallback(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'EACCES';
  }

  private async searchCandidatesWithNode(
    ref: RegisteredCodebase,
    prepared: ScopedLookup,
    query: string,
    caseSensitive: boolean,
    admits: (relativePath: string) => boolean,
    score: (filePath: string, text: string) => number,
  ): Promise<SourceTraversal<SourceSearchCandidate>> {
    const candidates: SourceSearchCandidate[] = [];
    const folded = caseSensitive ? query : query.toLowerCase();
    let grantWithheld = false;
    let readError = false;
    const stopReason = await this.walkAdmittedFiles(ref, prepared, this.searchTimeoutMs, async filePath => {
      if (!admits(filePath)) return;
      const withheld = outsideProviderGrant(prepared, filePath);
      // Withheld like a ripgrep hit outside the grant: never returned, but a
      // match there keeps the search from reading as complete.
      if (withheld && grantWithheld) return;
      let content: string;
      try {
        content = readAcceptedTextFileSync(prepared.root, filePath, this.searchMaxFileBytes);
      } catch {
        readError = true;
        return;
      } finally {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Most files hold no match and are never split; a whole-file hit is
      // still confirmed per line, since matching is per line.
      const comparable = caseSensitive ? content : content.toLowerCase();
      if (!comparable.includes(folded)) return;
      const comparableLines = comparable.split(/\r?\n/);
      if (withheld) {
        grantWithheld = comparableLines.some(text => text.includes(folded));
        return;
      }
      const lines = caseSensitive ? comparableLines : content.split(/\r?\n/);
      comparableLines.forEach((text, index) => {
        if (text.includes(folded)) candidates.push({filePath, line: index + 1, score: score(filePath, lines[index]!)});
      });
    });
    return {items: candidates, stopReason: stopReason ?? (readError ? 'traversal_error' : undefined), grantWithheld};
  }

  /**
   * Walks the root in the selection policy's scope and hands each admitted
   * file (validated, inside the call's prefix) to `visit`. Resolves with why
   * the walk stopped early, if it did.
   */
  private async walkAdmittedFiles(
    ref: RegisteredCodebase,
    prepared: {root: string; policy: SourceSelectionIR; requestedPrefix?: string; effectivePrefixes: readonly string[]},
    timeoutMs: number,
    visit: (filePath: string) => void | Promise<void>,
  ): Promise<TraversalStopReason | undefined> {
    assertCodebaseRootIdentity(ref.rootRealpath, prepared.root, this.platform);
    const stack = [''];
    const deadline = Date.now() + timeoutMs;
    let visitedEntries = 0;
    let visitedDirectories = 0;
    let traversalError = false;
    while (stack.length > 0) {
      if (Date.now() >= deadline) return 'time_budget';
      const directory = stack.pop()!;
      visitedDirectories += 1;
      if (visitedDirectories > NODE_WALK_MAX_DIRECTORIES) return 'enumeration_budget';
      const absoluteDirectory = directory
        ? path.join(prepared.root, ...directory.split('/'))
        : prepared.root;
      try {
        const handle = await fsPromises.opendir(absoluteDirectory);
        for await (const entry of handle) {
          if (Date.now() >= deadline) return 'time_budget';
          visitedEntries += 1;
          if (visitedEntries > NODE_WALK_MAX_VISITED_ENTRIES) return 'enumeration_budget';
          const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (sourceSelectionCanDescend(prepared.policy, relativePath, this.platform, prepared.effectivePrefixes)) {
              stack.push(relativePath);
            }
            continue;
          }
          if (!entry.isFile()) continue;
          let filePath: string | undefined;
          try {
            filePath = this.admittedPath(ref, prepared, relativePath);
          } catch {
            continue;
          }
          if (filePath) await visit(filePath);
        }
      } catch {
        traversalError = true;
      }
    }
    // A finished walk visits every selected file (it applies no ignore files),
    // so only a traversal error leaves it incomplete; speed and ignore
    // semantics are reported separately as backendFidelity.
    return traversalError ? 'traversal_error' : undefined;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as path from 'path';

import {DEFAULT_OUTPUT_LANGUAGE, type OutputLanguage} from '../../agentv3/outputLanguage';
import {loadPromptSegment} from '../../agentv3/strategyLoader';
import type {CodeAwareMode} from './codeAwareFeature';
import {allSourceExtensions} from './sourceSelectionPolicy';

export const SOURCE_USE_DECISION_SCHEMA_VERSION = 'source_use_decision@1' as const;

/**
 * A new run derives its status from actual lookups (`pending`, `attempted`,
 * `located`, `corroborated`, `not_found_complete`, `search_incomplete`) or
 * starts at `not_needed` when it may acquire no evidence. `disallowed`,
 * `no_queryable_anchor`, `ambiguous_candidates` and `unverified` came only from
 * a retired model-declared decision and stay so stored results remain readable.
 */
export type SourceUseStatus =
  | 'pending'
  | 'not_needed'
  | 'disallowed'
  | 'no_queryable_anchor'
  | 'attempted'
  | 'located'
  | 'corroborated'
  | 'ambiguous_candidates'
  | 'not_found_complete'
  | 'search_incomplete'
  | 'unverified';

export type SourceMechanismStatus =
  | 'corroborated'
  | 'compatible'
  | 'ambiguous'
  | 'unverified';

export interface SourceReferenceV1 {
  id: string;
  chunkId?: string;
  referenceId?: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  buildId?: string;
  commitHash?: string;
  /**
   * The content the range came from: an index generation (`codebase_…`), or
   * for on-demand reads the live content version (`live-…`, keyed per process,
   * so comparable only within one run, never across a restart).
   */
  sourceGeneration?: string;
  /**
   * How the reference was returned. `search_hit` and `metadata`/`graph` locate
   * code; only `body` (a read window) and `indexed` deliver it as evidence.
   */
  lookupKind: SourceLookupKind;
}

export const SOURCE_LOOKUP_KIND_VALUES = ['metadata', 'search_hit', 'body', 'indexed', 'graph'] as const;
export type SourceLookupKind = typeof SOURCE_LOOKUP_KIND_VALUES[number];

export interface SourceUseDecisionV1 {
  schemaVersion: typeof SOURCE_USE_DECISION_SCHEMA_VERSION;
  codeAwareMode: 'metadata_only' | 'provider_send';
  selectedCodebaseIds: string[];
  status: SourceUseStatus;
  reasonCode?: Exclude<SourceUseStatus, 'pending' | 'attempted' | 'located' | 'corroborated'>;
  attemptedTools: string[];
  queriedCodebaseIds: string[];
  usedCodebaseIds: string[];
  coverageComplete?: boolean;
  incompleteReasons?: string[];
  references: SourceReferenceV1[];
}

/** Actual MCP access scope, captured privately for this analysis run. */
export interface SourceExecutionScopeV1 {
  codeAwareMode: CodeAwareMode;
  selectedCodebaseIds: string[];
  hasCodebaseAccess: boolean;
  analysisContextFingerprint: string;
}

/**
 * A claim bound to the source references (and same-claim Trace evidence) it
 * relies on. The product computes the claim's source status; the model no
 * longer declares one. `mechanismStatus` is read only from stored results.
 */
export interface SourceClaimBindingV1 {
  claimId: string;
  sourceReferenceIds: string[];
  traceEvidenceRefIds: string[];
  /** Retired model-declared status; present only in stored historical results. */
  mechanismStatus?: SourceMechanismStatus;
}

/** A decision to skip source cannot erase actual access or incomplete coverage. */
export function isUnusedSourceDecision(value: SourceUseDecisionV1 | undefined): boolean {
  return value === undefined || value.schemaVersion === SOURCE_USE_DECISION_SCHEMA_VERSION &&
    value.status === 'not_needed' && value.coverageComplete !== false &&
    (value.incompleteReasons === undefined || Array.isArray(value.incompleteReasons) && value.incompleteReasons.length === 0) &&
    [value.attemptedTools, value.queriedCodebaseIds, value.usedCodebaseIds, value.references]
      .every(items => Array.isArray(items) && items.length === 0);
}

export const MAX_SOURCE_REFERENCE_COUNT = 100;
export const MAX_SOURCE_REFERENCE_PATH_LENGTH = 512;

/**
 * The shared source-use guidance, for a run with selected codebases. The
 * selection itself, capabilities and budget are run data the caller supplies
 * separately (`source_authorization`), so this text is the same for every run.
 */
export function loadSourceUsePrompt(input: {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  outputLanguage?: OutputLanguage;
}): string | undefined {
  if (!input.codeAwareMode || input.codeAwareMode === 'off' || !input.codebaseIds?.length) {
    return undefined;
  }
  const templateName = (input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE) === 'en'
    ? 'prompt-source-use-en'
    : 'prompt-source-use-zh';
  const prompt = loadPromptSegment(templateName);
  if (!prompt) throw new Error(`Missing required source-use prompt template: ${templateName}`);
  return prompt;
}

const MAX_SOURCE_IDENTIFIER_LENGTH = 160;
export const MAX_SOURCE_REFERENCE_ID_LENGTH = 256;
const MAX_SOURCE_SYMBOL_LENGTH = 256;
const MAX_SOURCE_TOOL_COUNT = 64;
const MAX_SOURCE_INCOMPLETE_REASON_COUNT = 20;
const MAX_SOURCE_CLAIM_BINDING_COUNT = 100;
const MAX_SOURCE_BINDING_REFERENCE_COUNT = 100;
export const MAX_SOURCE_LINE = 2_147_483_647;
const LEGACY_REFERENCE_ONLY_EXTENSIONS = ['.sql', '.md'] as const;
const SOURCE_LOOKUP_KINDS: ReadonlySet<SourceLookupKind> = new Set(SOURCE_LOOKUP_KIND_VALUES);
const SOURCE_USE_STATUSES: ReadonlySet<SourceUseStatus> = new Set([
  'pending',
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'attempted',
  'located',
  'corroborated',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SOURCE_USE_REASON_CODES = new Set<NonNullable<SourceUseDecisionV1['reasonCode']>>([
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SUPPORTED_SOURCE_EXTENSIONS = new Set(
  [...allSourceExtensions(), ...LEGACY_REFERENCE_ONLY_EXTENSIONS]
    .map(extension => extension.toLocaleLowerCase('en-US')),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictIdentifier(value: unknown, maxLength = MAX_SOURCE_IDENTIFIER_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function boundedSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_SOURCE_SYMBOL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function boundedLineRange(value: unknown): SourceReferenceV1['lineRange'] {
  if (!isRecord(value)) return undefined;
  const start = Number(value.start);
  const end = Number(value.end);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_SOURCE_LINE
  ) {
    return undefined;
  }
  return {start, end};
}

function uniqueBoundedIdentifiers(
  value: unknown,
  maxCount: number,
  maxLength = MAX_SOURCE_IDENTIFIER_LENGTH,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const identifier = strictIdentifier(candidate, maxLength);
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    result.push(identifier);
    if (result.length >= maxCount) break;
  }
  return result;
}

export function normalizeSourceReferencePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (
    !normalized ||
    normalized.length > MAX_SOURCE_REFERENCE_PATH_LENGTH ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.includes('://') ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    return undefined;
  }
  const segments = normalized.split('/');
  if (
    segments.some(segment =>
      !segment ||
      segment === '.' ||
      segment === '..')
  ) {
    return undefined;
  }
  const extension = path.posix.extname(normalized).toLocaleLowerCase('en-US');
  return SUPPORTED_SOURCE_EXTENSIONS.has(extension) ? normalized : undefined;
}

/** A reference that locates code without delivering its body as evidence. */
export function isLocateOnlyLookupKind(kind: SourceLookupKind): boolean {
  return kind === 'metadata' || kind === 'graph' || kind === 'search_hit';
}

/** A reference whose body the run delivered: a read window or an indexed chunk. */
export function isBodyLookupKind(kind: SourceLookupKind): boolean {
  return kind === 'body' || kind === 'indexed';
}

/**
 * Whether the run delivered this reference's whole range as a body: it is a
 * body reference itself, or an issued body reference of the same file and
 * the same known source generation (an index generation, or the live content
 * version on-demand reads carry) together contain its range. An unknown generation
 * never matches, so a changed file cannot stand in for the one searched. It
 * never widens a reference beyond its own range.
 */
export function referenceHasReadBody(
  reference: SourceReferenceV1,
  issued: Iterable<SourceReferenceV1>,
): boolean {
  if (isBodyLookupKind(reference.lookupKind)) return true;
  const range = reference.lineRange;
  if (!range || reference.sourceGeneration === undefined) return false;
  const identity = sourceReferenceIdentity(reference);
  // Bodies of the one known version together, as a written citation is judged.
  const bodies: Array<{start: number; end: number}> = [];
  for (const other of issued) {
    if (isBodyLookupKind(other.lookupKind) && other.lineRange && sourceReferenceIdentity(other) === identity) {
      bodies.push(other.lineRange);
    }
  }
  return lineRangesCover(bodies, range);
}

type LineRange = {start: number; end: number};

/** Inclusive line ranges that share a line. */
export const lineRangesIntersect = (a: LineRange, b: LineRange): boolean => a.start <= b.end && b.start <= a.end;
/** The union of `ranges` holds every line of `target`. */
export function lineRangesCover(ranges: readonly LineRange[], target: LineRange): boolean {
  let next = target.start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > next) break;
    if (range.end >= next) next = range.end + 1;
    if (next > target.end) return true;
  }
  return false;
}

/**
 * One file version: codebase, path and source generation. References of two
 * identities never prove anything about each other's lines. A reference with
 * no known generation is its own version: an absent version is not an equal one.
 */
export function sourceReferenceIdentity(
  reference: Pick<SourceReferenceV1, 'id' | 'codebaseId' | 'filePath' | 'sourceGeneration'>,
): string {
  return reference.sourceGeneration === undefined
    ? `${reference.codebaseId}\0${reference.filePath}\0\0${reference.id}`
    : `${reference.codebaseId}\0${reference.filePath}\0${reference.sourceGeneration}`;
}

const DERIVABLE_SOURCE_USE_STATUSES: ReadonlySet<SourceUseStatus> = new Set([
  'pending', 'attempted', 'not_found_complete', 'search_incomplete', 'located', 'corroborated',
]);

/**
 * The run's source-use status after one lookup. Positive findings outrank an
 * incomplete search, which outranks absence: one unfinished search no longer
 * pins the run, while run coverage (kept separately, monotone) still blocks
 * negative source claims. A status the product set (not_needed and the like)
 * yields only to incompleteness.
 */
export function mergeSourceUseStatus(input: {
  current: SourceUseStatus;
  observedPositive?: 'located' | 'corroborated';
  observedIncomplete: boolean;
  runIncomplete: boolean;
  observedCompleteAbsence: boolean;
}): SourceUseStatus {
  if (!DERIVABLE_SOURCE_USE_STATUSES.has(input.current)) {
    return input.observedIncomplete ? 'search_incomplete' : input.current;
  }
  const currentPositive = input.current === 'corroborated' || input.current === 'located' ? input.current : undefined;
  if (currentPositive === 'corroborated' || input.observedPositive === 'corroborated') return 'corroborated';
  if (currentPositive ?? input.observedPositive) return 'located';
  if (input.runIncomplete) return 'search_incomplete';
  return input.current === 'not_found_complete' || input.observedCompleteAbsence ? 'not_found_complete' : 'attempted';
}

function sourceReferenceId(reference: Omit<SourceReferenceV1, 'id'>): string {
  const identity = [
    reference.lookupKind,
    reference.codebaseId,
    reference.filePath,
    reference.chunkId ?? '',
    // Not the internal referenceId: the model cites references without it,
    // and the range, symbol and generation already make an identity.
    reference.lineRange?.start ?? '',
    reference.lineRange?.end ?? '',
    reference.symbol ?? '',
    reference.buildId ?? '',
    reference.commitHash ?? '',
    reference.sourceGeneration ?? '',
  ];
  return `source-ref-v1-${createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 24)}`;
}

export function sanitizeSourceReference(value: unknown): SourceReferenceV1 | undefined {
  if (!isRecord(value)) return undefined;
  const chunkId = strictIdentifier(value.chunkId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const referenceId = strictIdentifier(value.referenceId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const codebaseId = strictIdentifier(value.codebaseId);
  const filePath = normalizeSourceReferencePath(value.filePath);
  const lookupKind = typeof value.lookupKind === 'string' &&
    SOURCE_LOOKUP_KINDS.has(value.lookupKind as SourceLookupKind)
    ? value.lookupKind as SourceLookupKind
    : undefined;
  if (!codebaseId || !filePath || !lookupKind) return undefined;

  const lineRange = boundedLineRange(value.lineRange);
  const symbol = boundedSymbol(value.symbol);
  const buildId = strictIdentifier(value.buildId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const commitHash = typeof value.commitHash === 'string' &&
    /^[a-f0-9]{7,128}$/i.test(value.commitHash.trim())
    ? value.commitHash.trim()
    : undefined;
  const sourceGeneration = strictIdentifier(value.sourceGeneration, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const referenceWithoutId: Omit<SourceReferenceV1, 'id'> = {
    ...(chunkId ? {chunkId} : {}),
    ...(referenceId ? {referenceId} : {}),
    codebaseId,
    filePath,
    ...(lineRange ? {lineRange} : {}),
    ...(symbol ? {symbol} : {}),
    ...(buildId ? {buildId} : {}),
    ...(commitHash ? {commitHash} : {}),
    ...(sourceGeneration ? {sourceGeneration} : {}),
    lookupKind,
  };
  return {
    id: sourceReferenceId(referenceWithoutId),
    ...referenceWithoutId,
  };
}

export function sanitizeSourceReferences(value: unknown): SourceReferenceV1[] {
  if (!Array.isArray(value)) return [];
  const references: SourceReferenceV1[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const reference = sanitizeSourceReference(candidate);
    if (!reference || seen.has(reference.id)) continue;
    seen.add(reference.id);
    references.push(reference);
    if (references.length >= MAX_SOURCE_REFERENCE_COUNT) break;
  }
  return references;
}

export function sanitizeSourceIncompleteReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 128 &&
    /^[a-z][a-z0-9_.:-]*$/.test(normalized)
    ? normalized
    : undefined;
}

export function sanitizeSourceUseDecision(
  value: unknown,
  currentSelectedCodebaseIds?: readonly string[],
): SourceUseDecisionV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== SOURCE_USE_DECISION_SCHEMA_VERSION) {
    return undefined;
  }
  const codeAwareMode = value.codeAwareMode === 'metadata_only' || value.codeAwareMode === 'provider_send'
    ? value.codeAwareMode
    : undefined;
  const declaredStatus = typeof value.status === 'string' && SOURCE_USE_STATUSES.has(value.status as SourceUseStatus)
    ? value.status as SourceUseStatus
    : undefined;
  if (!codeAwareMode || !declaredStatus) return undefined;
  const status = codeAwareMode === 'metadata_only' && declaredStatus === 'corroborated'
    ? 'located'
    : declaredStatus;

  const declaredCodebaseIds = uniqueBoundedIdentifiers(
    value.selectedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).sort();
  const currentSelection = currentSelectedCodebaseIds === undefined
    ? undefined
    : new Set(uniqueBoundedIdentifiers(
      currentSelectedCodebaseIds,
      MAX_SOURCE_REFERENCE_COUNT,
    ));
  const selectedCodebaseIds = currentSelection
    ? declaredCodebaseIds.filter(codebaseId => currentSelection.has(codebaseId))
    : declaredCodebaseIds;
  const selected = new Set(selectedCodebaseIds);
  const queriedCodebaseIds = uniqueBoundedIdentifiers(
    value.queriedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).filter(codebaseId => selected.has(codebaseId));
  const usedCodebaseIds = uniqueBoundedIdentifiers(
    value.usedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).filter(codebaseId => selected.has(codebaseId));
  const references = sanitizeSourceReferences(value.references)
    .filter(reference => selected.has(reference.codebaseId));
  const reasonCode = SOURCE_USE_REASON_CODES.has(status as NonNullable<SourceUseDecisionV1['reasonCode']>) &&
    typeof value.reasonCode === 'string' &&
    SOURCE_USE_REASON_CODES.has(value.reasonCode as NonNullable<SourceUseDecisionV1['reasonCode']>)
    ? value.reasonCode as NonNullable<SourceUseDecisionV1['reasonCode']>
    : undefined;
  const incompleteReasons = Array.isArray(value.incompleteReasons)
    ? [...new Set(value.incompleteReasons
      .map(sanitizeSourceIncompleteReason)
      .filter((reason): reason is string => Boolean(reason)))]
      .slice(0, MAX_SOURCE_INCOMPLETE_REASON_COUNT)
    : [];
  return {
    schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
    codeAwareMode,
    selectedCodebaseIds,
    status,
    ...(reasonCode ? {reasonCode} : {}),
    attemptedTools: uniqueBoundedIdentifiers(
      value.attemptedTools,
      MAX_SOURCE_TOOL_COUNT,
      128,
    ),
    queriedCodebaseIds,
    usedCodebaseIds,
    ...(typeof value.coverageComplete === 'boolean'
      ? {coverageComplete: value.coverageComplete}
      : {}),
    ...(incompleteReasons.length > 0 ? {incompleteReasons} : {}),
    references,
  };
}

function sourceMechanismStatus(value: unknown): SourceMechanismStatus | undefined {
  return value === 'corroborated' || value === 'compatible' || value === 'ambiguous' || value === 'unverified'
    ? value : undefined;
}

/** Retired binding keys a model may still write: accepted and dropped, never judged. */
const LEGACY_SOURCE_BINDING_KEYS = ['mechanismStatus', 'reason'];
const SOURCE_BINDING_KEYS = ['claimId', 'sourceReferenceIds', 'traceEvidenceRefIds', ...LEGACY_SOURCE_BINDING_KEYS];

/** Validate original declaration shape without trimming, dropping, or deduplicating values. */
export function isSourceClaimBindingDeclaration(value: unknown): value is SourceClaimBindingV1 {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'claimId') ||
    !Object.prototype.hasOwnProperty.call(value, 'sourceReferenceIds') ||
    Object.keys(value).some(key => !SOURCE_BINDING_KEYS.includes(key)) ||
    typeof value.claimId !== 'string' || strictIdentifier(value.claimId, MAX_SOURCE_REFERENCE_ID_LENGTH) !== value.claimId) {
    return false;
  }
  // An omitted Trace list is empty; a present one must be an array.
  const traceIds = Object.prototype.hasOwnProperty.call(value, 'traceEvidenceRefIds') ? value.traceEvidenceRefIds : [];
  for (const references of [value.sourceReferenceIds, traceIds]) {
    if (!Array.isArray(references) || references.length > MAX_SOURCE_BINDING_REFERENCE_COUNT) return false;
    for (const reference of references) {
      if (typeof reference !== 'string' || strictIdentifier(reference, MAX_SOURCE_REFERENCE_ID_LENGTH) !== reference) return false;
    }
  }
  return true;
}

/** Check the whole original array, including holes and entries for other claims. */
export function isSourceClaimBindingsDeclaration(value: unknown): value is SourceClaimBindingV1[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_CLAIM_BINDING_COUNT) return false;
  for (const binding of value) if (!isSourceClaimBindingDeclaration(binding)) return false;
  return true;
}

/** A valid declared array in its current form: retired keys dropped, a missing Trace list empty. */
export function canonicalSourceClaimBindingDeclarations(value: readonly SourceClaimBindingV1[]): SourceClaimBindingV1[] {
  return value.map(binding => ({claimId: binding.claimId, sourceReferenceIds: [...binding.sourceReferenceIds],
    traceEvidenceRefIds: [...(binding.traceEvidenceRefIds ?? [])]}));
}

/** Whether a value is a status a stored historical binding may carry. */
export function isSourceMechanismStatus(value: unknown): value is SourceMechanismStatus {
  return sourceMechanismStatus(value) !== undefined;
}

export function sanitizeSourceClaimBindings(
  value: unknown,
  options: {
    referenceIdAliases?: ReadonlyMap<string, string>;
  } = {},
): SourceClaimBindingV1[] {
  if (!Array.isArray(value)) return [];
  const bindings: SourceClaimBindingV1[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const claimId = strictIdentifier(candidate.claimId, MAX_SOURCE_REFERENCE_ID_LENGTH);
    // Kept only to render stored historical results; never produced or judged now.
    const mechanismStatus = sourceMechanismStatus(candidate.mechanismStatus);
    if (!claimId) continue;
    const sourceReferenceIds = uniqueBoundedIdentifiers(
      candidate.sourceReferenceIds,
      MAX_SOURCE_BINDING_REFERENCE_COUNT,
      MAX_SOURCE_REFERENCE_ID_LENGTH,
    ).map(referenceId => options.referenceIdAliases?.get(referenceId) ?? referenceId);
    const traceEvidenceRefIds = uniqueBoundedIdentifiers(
      candidate.traceEvidenceRefIds,
      MAX_SOURCE_BINDING_REFERENCE_COUNT,
      MAX_SOURCE_REFERENCE_ID_LENGTH,
    );
    const key = JSON.stringify([claimId, mechanismStatus, sourceReferenceIds, traceEvidenceRefIds]);
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({
      claimId,
      sourceReferenceIds,
      traceEvidenceRefIds,
      ...(mechanismStatus ? {mechanismStatus} : {}),
    });
    if (bindings.length >= MAX_SOURCE_CLAIM_BINDING_COUNT) break;
  }
  return bindings;
}

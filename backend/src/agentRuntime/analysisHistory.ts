// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import {AnalysisHistoryStore, parseAnalysisHistoryEvidenceLocator, type AnalysisHistoryScope} from '../services/analysisHistoryStore';
import {analysisHasPrivateContext} from '../services/security/analysisPrivateContext';
import {registerPrivateAnalysisQueryForEcho} from '../services/security/codeAwareOutputRegistry';
import {stableStringify} from '../utils/stableJson';

/** Historical declarations and locators, never execution witnesses or verification authority. */
export interface AnalysisHistoryEvidenceLocator {
  artifactId?: string;
  evidenceRefId?: string;
  sourceToolCallId?: string;
  traceId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  sourceRef?: string;
}

export interface AnalysisHistoryTurn {
  id: string;
  turnIndex: number;
  query: string;
  answer: string;
  timestamp: number;
  traceId: string;
  partial: boolean;
  completionStatus: 'completed' | 'incomplete' | 'unknown';
  terminationReason?: string;
  terminationMessage?: string;
  uncertainties: string[];
  nextSteps: string[];
  evidence: AnalysisHistoryEvidenceLocator[];
  sourceDerived?: boolean;
  /** Original run's source authorization partition; never filled from a later run. */
  analysisContextFingerprint?: string;
}

interface HistoryResult {
  conclusion?: string;
  message?: string;
  partial?: boolean;
  completion?: {status: string; reason?: string};
  terminationReason?: string;
  terminationMessage?: string;
  conclusionContract?: unknown;
  uncertainties?: string[];
  nextSteps?: string[];
  analysisContextFingerprint?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function toAnalysisHistoryTurn(input: {
  id: string; turnIndex: number; query: string; traceId: string; timestamp: number;
  result?: HistoryResult; sourceDerived?: boolean; analysisContextFingerprint?: string;
}): AnalysisHistoryTurn {
  const result = input.result;
  const contract = record(result?.conclusionContract);
  const status = result?.completion?.status;
  const analysisContextFingerprint = input.analysisContextFingerprint ?? result?.analysisContextFingerprint;
  const completionStatus = result?.partial === true ? 'incomplete'
    : status === 'completed' ? 'completed'
      : status && status !== 'unknown' ? 'incomplete' : 'unknown';
  const evidence: AnalysisHistoryEvidenceLocator[] = [];
  for (const claim of Array.isArray(contract?.claims) ? contract.claims : []) {
    const declared = record(claim);
    for (const value of [...(Array.isArray(declared?.references) ? declared.references : []),
      ...(Array.isArray(declared?.artifactRefs) ? declared.artifactRefs : [])]) {
      const locator = parseAnalysisHistoryEvidenceLocator(value);
      if (locator) evidence.push(locator);
    }
  }
  return {
    id: input.id, turnIndex: input.turnIndex, query: input.query,
    answer: result?.conclusion ?? result?.message ?? '', timestamp: input.timestamp, traceId: input.traceId,
    partial: completionStatus !== 'completed', completionStatus,
    ...(result?.terminationReason || result?.completion?.reason
      ? {terminationReason: result?.terminationReason ?? result?.completion?.reason} : {}),
    ...(result?.terminationMessage ? {terminationMessage: result.terminationMessage} : {}),
    uncertainties: [...new Set([...strings(result?.uncertainties), ...strings(contract?.uncertainties)])],
    nextSteps: [...new Set([...strings(result?.nextSteps), ...strings(contract?.nextSteps)])],
    evidence: [...new Map(evidence.map(ref => [JSON.stringify(ref), ref])).values()],
    ...(input.sourceDerived ? {sourceDerived: true} : {}),
    ...(analysisContextFingerprint?.trim() ? {analysisContextFingerprint} : {}),
  };
}

export interface AnalysisHistoryReadRequest {
  turnId?: string;
  offset?: number;
  limit?: number;
  textOffset?: number;
  maxChars?: number;
}

export interface AnalysisHistoryReader {
  getTurns(): AnalysisHistoryTurn[];
  read(request: AnalysisHistoryReadRequest): Record<string, unknown>;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('analysis_history_invalid_page');
  return value;
}

function preview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return '';
  // Keep UTF-16 offsets in the reader, but never split a surrogate in a displayed excerpt.
  return `${text.slice(0, Math.max(0, maxChars - 1)).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}

const MAX_HISTORY_LOCATOR_BYTES = 2048;
const MAX_HISTORY_LOCATORS_SCANNED = 32;
const MAX_RELATED_HISTORY_TURNS_SCANNED = 64;

function boundedHistoryLocator(value: AnalysisHistoryEvidenceLocator): AnalysisHistoryEvidenceLocator | undefined {
  // IDs are either retained exactly or spilled. Never shorten one into a different locator.
  if (Object.values(value).some(item => typeof item === 'string' && item.length > MAX_HISTORY_LOCATOR_BYTES)) return undefined;
  if (value.rowSelector && (Object.keys(value.rowSelector).length > 32 ||
    Object.entries(value.rowSelector).some(([key, item]) => key.length > MAX_HISTORY_LOCATOR_BYTES ||
      (typeof item === 'string' && item.length > MAX_HISTORY_LOCATOR_BYTES)))) return undefined;
  const locator = parseAnalysisHistoryEvidenceLocator(value);
  return locator && Buffer.byteLength(JSON.stringify(locator), 'utf8') <= MAX_HISTORY_LOCATOR_BYTES ? locator : undefined;
}

function newestFirst(turns: readonly AnalysisHistoryTurn[]): AnalysisHistoryTurn[] {
  return [...turns].sort((a, b) => b.timestamp - a.timestamp || b.turnIndex - a.turnIndex ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Exact shared historical locators provide navigation, never current evidence or capture identity. */
function relatedHistoryTurnIds(turn: AnalysisHistoryTurn, newestTurns: readonly AnalysisHistoryTurn[]): string[] {
  if (!turn.traceId.trim() || (turn.sourceDerived && !turn.analysisContextFingerprint?.trim())) return [];
  const keys = (entry: AnalysisHistoryTurn) => entry.evidence.slice(0, MAX_HISTORY_LOCATORS_SCANNED).flatMap(value => {
    const locator = boundedHistoryLocator(value);
    return locator?.evidenceRefId?.trim() && locator.sourceToolCallId?.trim() &&
      (locator.traceId === undefined || locator.traceId === entry.traceId)
      ? [stableStringify(locator)] : [];
  });
  const own = new Set(keys(turn));
  if (own.size === 0) return [];
  return newestTurns.slice(0, MAX_RELATED_HISTORY_TURNS_SCANNED).filter(candidate =>
    candidate.id !== turn.id && candidate.traceId === turn.traceId &&
    Boolean(candidate.sourceDerived) === Boolean(turn.sourceDerived) &&
    (!turn.sourceDerived || candidate.analysisContextFingerprint === turn.analysisContextFingerprint) &&
    keys(candidate).some(key => own.has(key))).slice(0, 2).map(candidate => candidate.id);
}

function indexEntry(turn: AnalysisHistoryTurn) {
  return {id: turn.id, turnIndex: turn.turnIndex, timestamp: turn.timestamp, traceId: turn.traceId,
    partial: turn.partial, completionStatus: turn.completionStatus, terminationReason: turn.terminationReason ? preview(turn.terminationReason, 120) : undefined,
    query: preview(turn.query, 180), answerChars: turn.answer.length,
    uncertaintyCount: turn.uncertainties.length, nextStepCount: turn.nextSteps.length};
}

export function createAnalysisHistoryReader(input: {
  getTurns: () => readonly AnalysisHistoryTurn[];
  assertActive: () => void;
}): AnalysisHistoryReader {
  const getTurns = () => {
    input.assertActive();
    const turns = structuredClone([...input.getTurns()]);
    input.assertActive();
    return turns.sort((a, b) => a.timestamp - b.timestamp || a.turnIndex - b.turnIndex);
  };
  return Object.freeze({getTurns, read(request: AnalysisHistoryReadRequest) {
    const turns = getTurns();
    if (request.turnId !== undefined) {
      const turn = turns.find(candidate => candidate.id === request.turnId);
      if (!turn) return {success: false, provenance: 'historical_context', error: 'analysis_history_turn_unavailable'};
      const {analysisContextFingerprint: _authorizationPartition, ...historicalContent} = turn;
      const serialized = JSON.stringify(historicalContent);
      const offset = boundedInteger(request.textOffset, 0, Number.MAX_SAFE_INTEGER);
      const maxChars = boundedInteger(request.maxChars, 4000, 12000);
      if (maxChars === 0) throw new Error('analysis_history_invalid_page');
      const text = serialized.slice(offset, offset + maxChars);
      const nextTextOffset = offset + text.length;
      return {success: true, provenance: 'historical_context', kind: 'turn',
        id: turn.id, partial: turn.partial, completionStatus: turn.completionStatus,
        relatedTurnIds: relatedHistoryTurnIds(turn, newestFirst(turns)),
        text, textOffset: offset, totalChars: serialized.length,
        nextTextOffset: nextTextOffset < serialized.length ? nextTextOffset : null,
        truncated: offset > 0 || nextTextOffset < serialized.length};
    }
    const offset = boundedInteger(request.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(request.limit, 20, 50);
    if (limit === 0) throw new Error('analysis_history_invalid_page');
    const entries = turns.slice().reverse().slice(offset, offset + limit).map(indexEntry);
    return {success: true, provenance: 'historical_context', kind: 'index', entries, totalTurns: turns.length,
      nextOffset: offset + entries.length < turns.length ? offset + entries.length : null};
  }});
}

const historyBinding = Symbol('analysisHistoryReader');
interface IssuedHistoryBinding {
  reader: AnalysisHistoryReader;
  /** Product-resolved activation for this run, separate from source authorization. */
  includeSourceDerived?: boolean;
}
const readers = new WeakMap<object, IssuedHistoryBinding>();

/** Internal options spreads preserve this capability; JSON and guessed handles do not. */
export function withAnalysisHistoryReader<T extends object>(options: T, reader: AnalysisHistoryReader,
  activation: {includeSourceDerived?: boolean} = {}): T {
  if (activation.includeSourceDerived !== undefined && typeof activation.includeSourceDerived !== 'boolean') {
    throw new Error('analysis_history_activation_invalid');
  }
  const token = Object.freeze({});
  readers.set(token, Object.freeze({reader, includeSourceDerived: activation.includeSourceDerived}));
  return {...options, [historyBinding]: token};
}

function resolveHistoryBinding(options: object): IssuedHistoryBinding | undefined {
  const token = (options as {[historyBinding]?: object})[historyBinding];
  if (!Object.prototype.hasOwnProperty.call(options, historyBinding)) return undefined;
  const binding = token && readers.get(token);
  if (!binding) throw new Error('analysis_history_binding_invalid');
  return binding;
}

export function resolveAnalysisHistoryReader(options: object, fallbackReader: AnalysisHistoryReader): AnalysisHistoryReader {
  return resolveHistoryBinding(options)?.reader ?? fallbackReader;
}

/** No caller-supplied owner/session selector ever enters the model-facing reader. */
export function createRuntimeAnalysisHistoryReader(input: {
  options: AnalysisOptions; sessionId: string; traceId: string;
  getTurns: () => readonly AnalysisHistoryTurn[]; assertActive: () => void;
  includeSourceDerived?: boolean;
}): AnalysisHistoryReader {
  const {tenantId, workspaceId, userId} = input.options;
  const scope: AnalysisHistoryScope | undefined = tenantId && workspaceId && userId
    ? {tenantId, workspaceId, userId, sessionId: input.sessionId, traceId: input.traceId} : undefined;
  const fingerprint = input.options.analysisContextFingerprint;
  const binding = resolveHistoryBinding(input.options);
  // A run with authorized source or private knowledge reads its own derived
  // history; the exact fingerprint below is what partitions it.
  const defaultActivation = input.includeSourceDerived ?? analysisHasPrivateContext(input.options);
  // A product's explicit activation survives physical runtime wrappers. A later
  // wrapper can restrict it, but cannot turn a dormant product run into source use.
  const includeSourceDerived = binding?.includeSourceDerived !== undefined
    ? binding.includeSourceDerived && input.includeSourceDerived !== false : defaultActivation;
  const sourceAllowed = (turn: AnalysisHistoryTurn) => !turn.sourceDerived || Boolean(includeSourceDerived &&
    fingerprint?.trim() && turn.analysisContextFingerprint === fingerprint);
  const fallback = createAnalysisHistoryReader({assertActive: input.assertActive, getTurns: () => {
    const allowed = (turn: AnalysisHistoryTurn) => turn.traceId === input.traceId && sourceAllowed(turn);
    const historical = (scope ? new AnalysisHistoryStore().list(scope) : []).filter(allowed);
    const merged = new Map(historical.map(turn => [turn.id, turn]));
    for (const turn of input.getTurns()) {
      if (!allowed(turn)) continue;
      // Durable finalized results take precedence over a runtime draft of that turn.
      if (!merged.has(turn.id)) merged.set(turn.id, turn);
    }
    return [...merged.values()];
  }});
  const resolved = binding?.reader ?? fallback;
  return createAnalysisHistoryReader({getTurns: () => {
    const turns = resolved.getTurns().filter(sourceAllowed);
    // Every model-visible history read passes here, so strict output learns to
    // replace an echo of a private question before the model can repeat it.
    for (const turn of turns) {
      if (turn.sourceDerived) registerPrivateAnalysisQueryForEcho(input.sessionId, turn.query);
    }
    return turns;
  }, assertActive: input.assertActive});
}

/** No history text or identifiers are carried by a budget error. @internal */
export class AnalysisHistoryContextBudgetError extends Error {
  constructor() {
    super('analysis_history_context_budget_exceeded');
    this.name = 'AnalysisHistoryContextBudgetError';
  }
}

interface HistoryPreviewLimits {
  query: number;
  answer: number;
  uncertainties: number;
  nextSteps: number;
  itemChars: number;
  evidence: number;
  metadata: boolean;
}

const FULL_HISTORY_PREVIEW: HistoryPreviewLimits = {
  query: 180, answer: 700, uncertainties: 4, nextSteps: 3, itemChars: 220, evidence: 5, metadata: true,
};
const COMPACT_HISTORY_PREVIEW: HistoryPreviewLimits = {
  query: 100, answer: 160, uncertainties: 1, nextSteps: 1, itemChars: 80, evidence: 1, metadata: false,
};
const MINIMAL_HISTORY_PREVIEW: HistoryPreviewLimits = {
  query: 40, answer: 60, uncertainties: 1, nextSteps: 1, itemChars: 40, evidence: 0, metadata: false,
};

function historyPreview(turn: AnalysisHistoryTurn, limits: HistoryPreviewLimits, answer = limits.answer) {
  const query = preview(turn.query, limits.query);
  const body = preview(turn.answer, answer);
  const terminationMessage = preview(turn.terminationMessage ?? '', limits.metadata ? 240 : 80);
  const uncertainties = turn.uncertainties.slice(0, limits.uncertainties).map(item => preview(item, limits.itemChars));
  const nextSteps = turn.nextSteps.slice(0, limits.nextSteps).map(item => preview(item, Math.min(limits.itemChars, 180)));
  const evidence = turn.evidence.slice(0, MAX_HISTORY_LOCATORS_SCANNED).flatMap(value => {
    const locator = boundedHistoryLocator(value);
    return locator ? [locator] : [];
  }).slice(0, limits.evidence);
  return {
    ...(limits.metadata ? indexEntry(turn) : {id: turn.id, partial: turn.partial, completionStatus: turn.completionStatus}),
    query, answer: body,
    ...(turn.terminationReason ? {terminationReason: preview(turn.terminationReason, 120)} : {}),
    ...(terminationMessage ? {terminationMessage} : {}),
    uncertainties, nextSteps, evidence,
    evidenceCount: turn.evidence.length, omittedEvidence: turn.evidence.length - evidence.length,
    omittedUncertainties: turn.uncertainties.length - uncertainties.length,
    omittedNextSteps: turn.nextSteps.length - nextSteps.length,
    truncated: !limits.metadata || query !== turn.query || body !== turn.answer ||
      preview(turn.terminationReason ?? '', 120) !== (turn.terminationReason ?? '') ||
      terminationMessage !== (turn.terminationMessage ?? '') || evidence.length !== turn.evidence.length ||
      uncertainties.length !== turn.uncertainties.length || nextSteps.length !== turn.nextSteps.length ||
      uncertainties.some((item, index) => item !== turn.uncertainties[index]) ||
      nextSteps.some((item, index) => item !== turn.nextSteps[index]),
  };
}

/** Bounded prompts protect the latest exchange and unfinished work; full text remains pageable. */
export function renderAnalysisHistoryContext(turns: readonly AnalysisHistoryTurn[], options: {
  outputLanguage?: OutputLanguage; maxBytes?: number;
} = {}): string | undefined {
  if (turns.length === 0) return undefined;
  const maxBytes = options.maxBytes ?? 12_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new AnalysisHistoryContextBudgetError();
  const sorted = newestFirst(turns);
  const latest = sorted[0];
  const latestIncomplete = sorted.find(turn => turn.completionStatus !== 'completed');
  const candidates = sorted.filter((turn, index) => index < 3 || turn === latestIncomplete);
  let selected = candidates;
  type Preview = ReturnType<typeof historyPreview> & {relatedTurnIds?: string[]};
  let recent: Preview[] = selected.map(turn => ({...historyPreview(turn, FULL_HISTORY_PREVIEW),
    relatedTurnIds: relatedHistoryTurnIds(turn, sorted)}));
  let earlier = sorted.filter(turn => !selected.includes(turn)).slice(0, 12).map(indexEntry);
  const render = () => renderRequiredLocalizedStrategyTemplate('prompt-runtime-history', options.outputLanguage ?? 'zh-CN', {
    history: JSON.stringify({provenance: 'historical_context', totalTurns: turns.length,
      omittedTurns: turns.length - recent.length,
      unlistedTurns: turns.length - new Set([...recent, ...earlier].map(turn => turn.id)).size,
      recent, earlier}),
  });
  const fitted = () => {
    const text = render();
    return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : undefined;
  };
  // Coarse degradation must not leave most of a larger budget unused. Restore
  // the latest exchange first, then unfinished obligations, other recent detail
  // and finally navigation. Every addition is measured before it is kept.
  const enrich = (): string => {
    const offer = (entry: Preview) => {
      const previous = recent;
      recent = [...recent.filter(item => item.id !== entry.id), entry]
        .sort((a, b) => candidates.findIndex(turn => turn.id === a.id) - candidates.findIndex(turn => turn.id === b.id));
      if (!fitted()) recent = previous;
    };
    offer(historyPreview(latest, FULL_HISTORY_PREVIEW));
    if (latestIncomplete && latestIncomplete !== latest) {
      const retainedBody = recent.find(entry => entry.id === latestIncomplete.id)?.answer;
      offer(historyPreview(latestIncomplete, FULL_HISTORY_PREVIEW, retainedBody ? FULL_HISTORY_PREVIEW.answer : 0));
    }
    for (const turn of candidates) {
      if (!recent.some(entry => entry.id === turn.id)) offer(historyPreview(turn, COMPACT_HISTORY_PREVIEW));
    }
    for (const turn of candidates.filter(turn => turn !== latest && turn !== latestIncomplete)) {
      if (recent.some(entry => entry.id === turn.id)) offer(historyPreview(turn, FULL_HISTORY_PREVIEW));
    }
    for (const turn of sorted.filter(turn => !recent.some(entry => entry.id === turn.id)).slice(0, 12)) {
      if (earlier.some(entry => entry.id === turn.id)) continue;
      earlier.push(indexEntry(turn));
      if (!fitted()) earlier.pop();
    }
    for (const entry of recent) {
      const turn = candidates.find(turn => turn.id === entry.id)!;
      const related = relatedHistoryTurnIds(turn, sorted);
      if (related.length === 0) continue;
      entry.relatedTurnIds = related;
      if (!fitted()) delete entry.relatedTurnIds;
    }
    return fitted()!;
  };
  let text = fitted();
  if (text) return text;
  for (const entry of recent) delete entry.relatedTurnIds;
  while (!(text = fitted()) && earlier.length > 0) earlier.pop();
  if (text) return enrich();
  // Evict optional older detail before touching either protected exchange.
  for (const turn of [...selected].reverse()) {
    if (turn === latest || turn === latestIncomplete) continue;
    recent = recent.filter(entry => entry.id !== turn.id);
    text = fitted();
    if (text) return enrich();
  }
  selected = selected.filter(turn => turn === latest || turn === latestIncomplete);
  for (const limits of [COMPACT_HISTORY_PREVIEW, MINIMAL_HISTORY_PREVIEW]) {
    recent = selected.map(turn => historyPreview(turn, limits, turn === latest ? limits.answer : 0));
    text = fitted();
    if (text) return enrich();
  }
  // If two details cannot fit, keep the older unfinished turn as an exact read locator.
  earlier = latestIncomplete && latestIncomplete !== latest ? [{...indexEntry(latestIncomplete), query: ''}] : [];
  recent = [historyPreview(latest, MINIMAL_HISTORY_PREVIEW)];
  text = fitted();
  if (text) return text;
  // Minimal continuation envelope: no locator is truncated and no historical text is invented.
  const minimal = renderRequiredLocalizedStrategyTemplate('prompt-runtime-history-minimal', options.outputLanguage ?? 'zh-CN', {
    history: JSON.stringify({provenance: 'historical_context', totalTurns: turns.length,
      omittedTurns: turns.length, unlistedTurns: turns.length - (latestIncomplete && latestIncomplete !== latest ? 2 : 1),
      previewUnavailable: 'byte_budget', recent: [], earlier: [latest, ...(latestIncomplete && latestIncomplete !== latest ? [latestIncomplete] : [])]
        .map(turn => ({id: turn.id, partial: turn.partial, completionStatus: turn.completionStatus}))}),
  });
  if (Buffer.byteLength(minimal, 'utf8') <= maxBytes) return minimal;
  throw new AnalysisHistoryContextBudgetError();
}

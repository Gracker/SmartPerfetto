// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import {AnalysisHistoryStore, parseAnalysisHistoryEvidenceLocator, type AnalysisHistoryScope} from '../services/analysisHistoryStore';
import {analysisHasPrivateContext} from '../services/security/analysisPrivateContext';
import {registerPrivateAnalysisQueryForEcho} from '../services/security/codeAwareOutputRegistry';

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
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
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

/** Bounded prompts preserve native completion before prose; full text remains pageable. */
export function renderAnalysisHistoryContext(turns: readonly AnalysisHistoryTurn[], options: {
  outputLanguage?: OutputLanguage; maxBytes?: number;
} = {}): string | undefined {
  if (turns.length === 0) return undefined;
  const sorted = [...turns].sort((a, b) => b.timestamp - a.timestamp || b.turnIndex - a.turnIndex);
  const recent = sorted.slice(0, 3);
  const latestIncomplete = sorted.find(turn => turn.completionStatus !== 'completed');
  const selected = latestIncomplete ? [latestIncomplete, ...recent.filter(turn => turn !== latestIncomplete)] : recent;
  const payload = {
    provenance: 'historical_context', totalTurns: turns.length, omittedTurns: Math.max(0, turns.length - selected.length),
    recent: selected.map(turn => ({...indexEntry(turn), terminationMessage: preview(turn.terminationMessage ?? '', 240),
      uncertainties: turn.uncertainties.slice(0, 4).map(item => preview(item, 220)),
      nextSteps: turn.nextSteps.slice(0, 3).map(item => preview(item, 180)),
      answer: preview(turn.answer, 700), evidence: turn.evidence.slice(0, 5),
      omittedUncertainties: Math.max(0, turn.uncertainties.length - 4), omittedNextSteps: Math.max(0, turn.nextSteps.length - 3),
      truncated: turn.answer.length > 700 || turn.query.length > 180 || turn.uncertainties.length > 4 || turn.nextSteps.length > 3})),
    earlier: sorted.filter(turn => !selected.includes(turn)).slice(0, 12).map(indexEntry),
  };
  const render = () => renderRequiredLocalizedStrategyTemplate('prompt-runtime-history', options.outputLanguage ?? 'zh-CN',
    {history: JSON.stringify(payload)});
  const maxBytes = options.maxBytes ?? 12_000;
  let text = render();
  while (Buffer.byteLength(text, 'utf8') > maxBytes && payload.earlier.length > 0) {
    payload.earlier.pop(); text = render();
  }
  // Drop detail from oldest previews first, retaining status and missing-work metadata.
  for (const entry of [...payload.recent].reverse()) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) break;
    entry.answer = ''; entry.evidence = []; entry.truncated = true; text = render();
  }
  while (Buffer.byteLength(text, 'utf8') > maxBytes && payload.recent.length > 1) {
    payload.recent.pop(); payload.omittedTurns++; text = render();
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const entry = payload.recent[0];
    entry.uncertainties = entry.uncertainties.slice(0, 1).map(item => preview(item, 100));
    entry.nextSteps = entry.nextSteps.slice(0, 1).map(item => preview(item, 100));
    entry.query = preview(entry.query, 80); entry.terminationMessage = preview(entry.terminationMessage, 100);
    text = render();
  }
  return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : undefined;
}

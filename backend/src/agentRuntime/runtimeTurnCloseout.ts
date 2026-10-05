// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate} from '../agentv3/strategyLoader';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {projectToolResultForExternalSurface} from '../services/rag/toolResultProjectionFilter';
import {decodeRuntimeToolResult, readRuntimeToolResultFacts} from './runtimeToolResult';
import type {RuntimeToolObserver} from './runtimeToolObserver';

/** The last model call belongs to delivery; one-turn configurations cannot add a call. */
export function resolveRuntimeTurnBudget(maxTurns: number) {
  const totalTurns = Number.isSafeInteger(maxTurns) && maxTurns > 0 ? maxTurns : 1;
  const deliveryTurns: 0 | 1 = totalTurns > 1 ? 1 : 0;
  return {totalTurns, acquisitionTurns: totalTurns - deliveryTurns, deliveryTurns};
}

function boundedText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text);
  // Remove a partial UTF-8 codepoint as well as explicitly label the omission.
  return `${bytes.subarray(0, Math.max(0, maxBytes - 40)).toString('utf8').replace(/\uFFFD$/u, '')}\n[omitted: byte budget]`;
}

/** Keep JSON values intact; a truncated string is visibly an excerpt, never a full value. */
function boundedValue(value: unknown, state: {nodes: number; omitted: number}, depth = 0): unknown {
  if (++state.nodes > 300 || depth > 8) { state.omitted++; return '[omitted: structure budget]'; }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 1600) state.omitted++;
    return boundedText(value, 1600);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const result = value.slice(0, 16).map(item => boundedValue(item, state, depth + 1));
    if (value.length > 16) { state.omitted += value.length - 16; result.push(`[omitted: ${value.length - 16} items]`); }
    return result;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 32)) result[boundedText(key, 200)] = boundedValue(item, state, depth + 1);
    if (entries.length > 32) { state.omitted += entries.length - 32; result.__omittedFields = entries.length - 32; }
    return result;
  }
  return undefined;
}

interface DeliveryPromptInput {
  query: string;
  priorConclusion: string;
  outputLanguage?: OutputLanguage;
}

interface ToolExcerpt {
  toolCallId: string;
  toolName: string;
  state: 'pending' | 'returned' | 'failed';
  resultFacts?: ReturnType<typeof readRuntimeToolResultFacts>;
  returnedData?: unknown;
  omittedValues?: number;
}

/**
 * Ephemeral, returned-data excerpts from this run. This is deliberately neither
 * SDK history nor a verification store, and must not be logged or persisted.
 */
export function createRuntimeTurnCloseoutTape(options: {maxBytes?: number} = {}) {
  const maxBytes = Math.max(4096, Math.min(options.maxBytes ?? 24 * 1024, 64 * 1024));
  const entries = new Map<string, ToolExcerpt>();
  let omittedCalls = 0;
  let unavailableResults = 0;
  const trim = () => {
    while (entries.size > 32 || Buffer.byteLength(JSON.stringify([...entries.values()])) > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
      omittedCalls++;
    }
  };
  const observe: RuntimeToolObserver = event => {
    const toolCallId = boundedText(event.toolCallId, 200);
    const toolName = boundedText(event.toolName, 200);
    if (event.phase === 'started') {
      entries.set(toolCallId, {toolCallId, toolName, state: 'pending'});
    } else if (event.phase === 'failed') {
      // Exceptions can contain credentials or private source. Only the outcome is retained.
      entries.set(toolCallId, {toolCallId, toolName, state: 'failed'});
    } else {
      try {
        const resultFacts = readRuntimeToolResultFacts(event.result);
        const projected = projectToolResultForExternalSurface(toolName, event.result);
        const decoded = decodeRuntimeToolResult(projected);
        const bounds = {nodes: 0, omitted: 0};
        const returnedData = boundedValue(decoded.body ?? projected, bounds);
        entries.set(toolCallId, {toolCallId, toolName, state: 'returned', resultFacts,
          returnedData, ...(bounds.omitted ? {omittedValues: bounds.omitted} : {})});
      } catch {
        unavailableResults++;
        entries.set(toolCallId, {toolCallId, toolName, state: 'returned', omittedValues: 1});
      }
    }
    trim();
  };
  /** At least one call returned data that survived projection; an unreadable result gives a delivery call nothing. */
  const hasReturnedData = () => [...entries.values()].some(entry => entry.state === 'returned' && entry.returnedData !== undefined);
  const render = (templateName: string, input: DeliveryPromptInput,
    extra: Record<string, string> = {}): string | undefined => {
    let template: string | undefined;
    try { template = loadPromptTemplate(`${templateName}-${input.outputLanguage === 'en' ? 'en' : 'zh'}`); }
    catch { return undefined; }
    if (!template?.trim()) return undefined;
    return renderTemplate(template.replace(/<!--[\s\S]*?-->/g, '').trim(), {
      ...extra,
      original_query: boundedText(input.query, 6000),
      prior_conclusion: boundedText(input.priorConclusion, 8000),
      returned_data: JSON.stringify({kind: 'current_run_returned_data_excerpts',
        completeTranscript: false, verified: false, modelConsumptionKnown: false,
        omittedCalls, unavailableResults, entries: [...entries.values()]}),
    });
  };
  const buildPrompt = (input: DeliveryPromptInput & {
    /** Which acquisition budget ran out; the delivery call is the same for both. */
    budgetExhausted?: 'turn_limit' | 'timeout';
  }): string | undefined => render('prompt-runtime-turn-closeout', input,
    {budget_exhausted: input.budgetExhausted ?? 'turn_limit'});
  /**
   * A completed run whose final reply had no answer body (only a declaration,
   * or nothing): the one delivery call writes the body from the same returned
   * data. Without returned data there is nothing to answer from, so no prompt.
   */
  const buildEmptyBodyPrompt = (input: DeliveryPromptInput): string | undefined =>
    hasReturnedData() ? render('prompt-runtime-empty-body-continuation', input) : undefined;
  return {observe, buildPrompt, buildEmptyBodyPrompt, hasReturnedData};
}

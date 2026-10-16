// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The simulated runtime the source authorization gate tests share: what a
 * runtime would hand the model from session history, and the turn it records
 * afterwards, both through the production readers and session context.
 */

import {expect} from '@jest/globals';

import {sessionContextManager} from '../../src/agent/context/enhancedSessionContext';
import type {AnalysisOptions} from '../../src/agent/core/orchestratorTypes';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext} from '../../src/agentRuntime/analysisHistory';
import {analysisHasPrivateContext} from '../../src/services/security/analysisPrivateContext';

export interface ObservedModelInput {
  sessionId: string;
  query: string;
  options: AnalysisOptions;
  /** The bounded history preview the runtime prefixes to the question. */
  preview: string;
  /** read_session_history: the index, then every listed turn. */
  historyIndex: Record<string, unknown>;
  historyTurns: Array<Record<string, unknown>>;
}

/** The history a runtime's model sees at the start of a run, read as every runtime reads it. */
export function observeModelInput(query: string, sessionId: string, traceId: string,
  options: AnalysisOptions): ObservedModelInput {
  const context = sessionContextManager.getOrCreate(sessionId, traceId);
  // The runtime's own reader: it honours a product-bound reader (the CLI transcript) too.
  const reader = createRuntimeAnalysisHistoryReader({options, sessionId, traceId,
    getTurns: () => context.getAnalysisHistory(), assertActive: () => undefined});
  const turns = reader.getTurns();
  return {sessionId, query, options,
    preview: renderAnalysisHistoryContext(turns, {outputLanguage: 'en'}) ?? '',
    historyIndex: reader.read({}), historyTurns: turns.map(turn => reader.read({turnId: turn.id}))};
}

/** As a runtime records its turn: source-derived under a private selection, bound to its fingerprint. */
export function recordRuntimeTurn(query: string, sessionId: string, traceId: string, options: AnalysisOptions,
  conclusion: string): void {
  sessionContextManager.getOrCreate(sessionId, traceId).addTurn(query,
    {primaryGoal: query, aspects: [], expectedOutputType: 'summary', complexity: 'simple'}, {
      agentId: 'gate-runtime', success: true, findings: [], confidence: 0.8, message: conclusion,
      ...(options.runId ? {completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk', status: 'completed',
        runId: options.runId}} : {}),
      sourceDerived: analysisHasPrivateContext(options) || undefined,
      analysisContextFingerprint: options.analysisContextFingerprint,
    } as any, []);
}

/** Nothing an earlier session read reaches this turn's model input. */
export function expectCleanTurn(turn: ObservedModelInput, query: string, canary: string): void {
  expect(turn.query).toBe(query);
  expect(turn.preview).toBe('');
  expect(turn.historyIndex).toMatchObject({success: true, totalTurns: 0});
  expect(turn.historyTurns).toEqual([]);
  expect(JSON.stringify(turn)).not.toContain(canary);
}

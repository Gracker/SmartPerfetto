// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {IOrchestrator} from '../../agent/core/orchestratorTypes';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {
  loadAnalysisSourceActivationPolicy,
  type AnalysisSourceActivation,
} from './analysisSourceActivationPolicy';

interface SourceHistoryEntryBase {
  turn: number;
  sourceDerived?: boolean;
}

interface SourceQueryHistoryEntry extends SourceHistoryEntryBase {
  query: string;
}

interface SourceConclusionHistoryEntry extends SourceHistoryEntryBase {
  conclusion: string;
}

function buildSafeResetQuery(input: {
  query: string;
  queryHistory?: readonly SourceQueryHistoryEntry[];
  conclusionHistory?: readonly SourceConclusionHistoryEntry[];
}): string {
  const template = loadPromptTemplate('prompt-source-activation-reset');
  if (!template) return input.query;
  const replay = loadAnalysisSourceActivationPolicy().safeReplay;
  const queriesByTurn = new Map(
    (input.queryHistory ?? [])
      .filter(entry => entry.sourceDerived !== true)
      .map(entry => [entry.turn, entry.query.slice(0, replay.maxCharsPerEntry)]),
  );
  const safeHistory = (input.conclusionHistory ?? [])
    .filter(entry => entry.sourceDerived !== true && queriesByTurn.has(entry.turn))
    .slice(-replay.maxTurns)
    .map(entry => [
      `User: ${queriesByTurn.get(entry.turn)}`,
      `Assistant: ${entry.conclusion.slice(0, replay.maxCharsPerEntry)}`,
    ].join('\n'))
    .join('\n\n');
  return renderTemplate(template, {
    safeHistory: safeHistory || '(No safe prior turns are available.)',
    query: input.query,
  });
}

export async function resetRuntimeForSourceActivation(input: {
  orchestrator: IOrchestrator;
  sessionId: string;
  query: string;
  previousActivation?: AnalysisSourceActivation;
  nextActivation: AnalysisSourceActivation;
  queryHistory?: readonly SourceQueryHistoryEntry[];
  conclusionHistory?: readonly SourceConclusionHistoryEntry[];
}): Promise<string | undefined> {
  if (!input.previousActivation || input.previousActivation === input.nextActivation) {
    return undefined;
  }
  if (typeof input.orchestrator.cleanupSession === 'function') {
    await Promise.resolve(input.orchestrator.cleanupSession(input.sessionId));
  }
  return buildSafeResetQuery(input);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { loadPromptTemplate, renderTemplate } from './strategyLoader';
import type { ComplexityClassifierInput } from './types';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';

type ComplexityPromptInput = string | ComplexityClassifierInput;
const MAX_PREVIOUS_QUERY_CHARS = 240;
const MAX_PREVIOUS_FINDING_CHARS = 200;
/** Per scene; the classifier prompt carries every registered scene. */
const CATALOG_KEYWORDS = 8;

function formatPreviousQueries(input: ComplexityPromptInput): string {
  if (typeof input === 'string') return 'none';
  const previousQueries = (input.previousQueries ?? [])
    .map(q => q.trim())
    .filter(Boolean)
    .map(q => q.length > MAX_PREVIOUS_QUERY_CHARS
      ? `${q.slice(0, MAX_PREVIOUS_QUERY_CHARS)}...`
      : q)
    .slice(-3);
  if (previousQueries.length === 0) return 'none';
  return previousQueries.map((q, index) => `${index + 1}. ${q}`).join('\n');
}

function formatPreviousFindings(input: ComplexityPromptInput): string {
  if (typeof input === 'string') return 'none';
  const previousFindings = (input.previousFindings ?? [])
    .map(f => f.trim())
    .filter(Boolean)
    .map(f => f.length > MAX_PREVIOUS_FINDING_CHARS
      ? `${f.slice(0, MAX_PREVIOUS_FINDING_CHARS)}...`
      : f)
    .slice(-5);
  if (previousFindings.length === 0) return 'none';
  return previousFindings.map((f, index) => `${index + 1}. ${f}`).join('\n');
}

function promptVar(input: ComplexityPromptInput, key: keyof ComplexityClassifierInput): string {
  if (typeof input === 'string') return 'unknown';
  const value = input[key];
  if (value === undefined || value === null) return 'unknown';
  return String(value);
}

export function buildComplexityClassifierPrompt(input: ComplexityPromptInput): string {
  const query = typeof input === 'string' ? input : input.query;
  const template = loadPromptTemplate('prompt-complexity-classifier');
  const vars = {
    query,
    sceneType: promptVar(input, 'sceneType'),
    hasSelectionContext: promptVar(input, 'hasSelectionContext'),
    hasReferenceTrace: promptVar(input, 'hasReferenceTrace'),
    hasExistingFindings: promptVar(input, 'hasExistingFindings'),
    hasPriorFullAnalysis: promptVar(input, 'hasPriorFullAnalysis'),
    previousQueries: typeof input !== 'string' && input.historyContext !== undefined ? 'none' : formatPreviousQueries(input),
    previousFindings: typeof input !== 'string' && input.historyContext !== undefined ? 'none' : formatPreviousFindings(input),
  };
  const prompt = template
    ? renderTemplate(template, vars)
    : [
        'Classify this Android trace analysis query as "quick" (factual) or "full" (analysis).',
        `Scene type: ${vars.sceneType}`,
        `Previous queries:\n${vars.previousQueries}`,
        `Previous findings:\n${vars.previousFindings}`,
        `Query: ${query}`,
        'Output JSON: {"complexity": "quick" or "full", "reason": "..."}',
      ].join('\n');
  return typeof input !== 'string' && input.historyContext ? `${prompt}\n\n${input.historyContext}` : prompt;
}

/** Rendering only: semantic policy lives in the external template. */
export function buildAnalysisTurnIntentPrompt(input: {
  context: ComplexityClassifierInput;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  template: string;
  decisionSchema: Readonly<Record<string, unknown>>;
  /** The source-need dimension's guidance, or empty when the run selects no source. */
  sourceNeedGuidance?: string;
}): string {
  const context = input.context;
  const sceneCatalog = input.strategyRegistry.getAllStrategies()
    .filter(strategy => strategy.strategyKind !== 'contract_only')
    .map(strategy => ({
      id: strategy.scene,
      ...(strategy.classificationDescription ? {description: strategy.classificationDescription} : {}),
      // Lexical anchors for the scene dimension only. A description says what a
      // scene means; these say what it is called, which is what a first-turn
      // question actually contains. The template governs how they may be used.
      ...(strategy.keywords.length ? {keywords: strategy.keywords.slice(0, CATALOG_KEYWORDS)} : {}),
      capabilities: strategy.requiredCapabilities,
    }));
  const requestContext = {
    query: context.query,
    requestedMode: context.requestedMode ?? 'auto',
    selection: context.selectionContext ?? null,
    hasReferenceTrace: context.hasReferenceTrace,
    ...(context.historyContext !== undefined ? {historyContext: context.historyContext} : {
      previousQueries: context.previousQueries?.slice(-3).map(query => query.slice(0, 800)) ?? [],
      previousFindings: context.previousFindingDetails ?? context.previousFindings?.slice(-5) ?? [],
      previousEntities: context.previousEntities ?? [],
    }),
  };
  return renderTemplate(input.template, {
    decisionSchema: JSON.stringify(input.decisionSchema),
    sourceNeedGuidance: input.sourceNeedGuidance ?? '',
    sceneCatalog: JSON.stringify(sceneCatalog),
    requestContext: JSON.stringify(requestContext),
  });
}

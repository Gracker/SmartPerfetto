// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions, IOrchestrator} from '../../agent/core/orchestratorTypes';
import {containsInternalToolProtocol} from '../../assistant/contracts/conversationContract';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {CodeLookupLedger} from './codeLookupLedger';
import {
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
} from '../security/codeAwareOutputRegistry';
import {projectPrivateStructuredValue} from '../security/privateAnalysisProjection';

export interface AnalysisSourceSupplementMetrics {
  searchCalls: number;
  readCalls: number;
  durationMs: number;
}

export interface AnalysisSourceSupplementOutcome {
  message: string;
  metrics: AnalysisSourceSupplementMetrics;
}

export function analysisSourceSupplementRuntimeSessionId(
  sessionId: string,
  runId: string,
): string {
  return `${sessionId}:${runId}:analysis-source-enrichment`;
}

export async function runAnalysisSourceSupplement(input: {
  orchestrator: IOrchestrator;
  sessionId: string;
  runId: string;
  traceId: string;
  question: string;
  primaryConclusion: string;
  analysisOptions: AnalysisOptions;
}): Promise<AnalysisSourceSupplementOutcome> {
  const runtimeSessionId = analysisSourceSupplementRuntimeSessionId(input.sessionId, input.runId);
  const template = loadPromptTemplate('analysis-source-deep-supplement');
  if (!template) throw new Error('analysis_source_supplement_prompt_missing');
  const prompt = renderTemplate(template, {
    question: input.question,
    primaryConclusion: input.primaryConclusion,
  });
  const startedAt = Date.now();
  registerPrivateAnalysisQueryForEcho(runtimeSessionId, input.question);
  try {
    const result = await input.orchestrator.analyze(
      prompt,
      runtimeSessionId,
      input.traceId,
      {
        ...input.analysisOptions,
        analysisMode: 'fast',
        runId: `${input.runId}:analysis-source-enrichment`,
        sourceUsePolicy: {phase: 'deep_enrichment'},
        knowledgeSourceIds: undefined,
      },
    );
    if (!result.success) {
      throw new Error(result.terminationMessage || 'analysis_source_supplement_failed');
    }
    if (containsInternalToolProtocol(result.conclusion)) {
      throw new Error('analysis_source_supplement_internal_tool_protocol');
    }
    const entries = CodeLookupLedger.restore(runtimeSessionId, 12_000, 2).getEntries();
    const executed = entries.filter(entry => entry.outcome !== 'budget_exceeded');
    return projectPrivateStructuredValue(runtimeSessionId, {
      message: result.conclusion.trim(),
      metrics: {
        searchCalls: executed.filter(entry => entry.toolName === 'search_codebase').length,
        readCalls: executed.filter(entry => entry.toolName === 'read_codebase_file').length,
        durationMs: Date.now() - startedAt,
      },
    });
  } finally {
    revokeCodeAwareOutputGuards(runtimeSessionId);
    await Promise.resolve(input.orchestrator.cleanupSession?.(runtimeSessionId)).catch(() => undefined);
  }
}

export async function cancelAnalysisSourceSupplement(
  orchestrator: IOrchestrator,
  sessionId: string,
  runId: string,
): Promise<void> {
  const runtimeSessionId = analysisSourceSupplementRuntimeSessionId(sessionId, runId);
  await Promise.resolve(orchestrator.abortSession?.(runtimeSessionId)).catch(() => undefined);
  await Promise.resolve(orchestrator.cleanupSession?.(runtimeSessionId)).catch(() => undefined);
  revokeCodeAwareOutputGuards(runtimeSessionId);
}

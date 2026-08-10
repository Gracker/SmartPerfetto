// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions, IOrchestrator} from '../../agent/core/orchestratorTypes';
import type {StreamingUpdate} from '../../agent';
import {
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {
  privateAnalysisFailureMessage,
  projectPrivateStructuredValue,
} from '../../services/security/privateAnalysisProjection';
import {analysisContextUsesPrivateKnowledge} from '../../services/resolvedAnalysisContext';
import {
  buildConversationPrompt,
  parseConversationResponse,
  type ConversationEvidenceRef,
  type ConversationRuntimeOutcome,
} from '../contracts/conversationContract';
import type {
  ConversationRuntimeAdapter,
  ConversationRuntimeInput,
} from '../application/conversationSessionService';

export interface OrchestratorConversationRuntimeOptions {
  analysisOptions?: Omit<AnalysisOptions, 'analysisMode' | 'runId'>;
}

function projectEvidence(result: Awaited<ReturnType<IOrchestrator['analyze']>>): ConversationEvidenceRef[] {
  return result.findings.flatMap((finding): ConversationEvidenceRef[] => {
    const id = String(finding.id || '').trim();
    const label = String(finding.title || '').trim();
    if (!id || !label) return [];
    const source = String(finding.source || '').trim();
    return [{id, label, ...(source ? {source} : {})}];
  });
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|cancel/i.test(message);
}

/**
 * Conversation is an independent product contract while the five production
 * SDK runtimes remain the model/tool execution boundary. The existing fast
 * executor supplies its wide safety cap and lightweight tool surface; this
 * adapter suppresses analysis-only reports, plans and snapshots at the route.
 */
export class OrchestratorConversationRuntimeAdapter implements ConversationRuntimeAdapter {
  private readonly runtimeSessionIds = new Map<string, string>();

  constructor(
    private readonly orchestrator: IOrchestrator,
    private readonly options: OrchestratorConversationRuntimeOptions = {},
  ) {}

  async run(input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> {
    const runtimeSessionId = `${input.sessionId}:${input.runId}`;
    this.runtimeSessionIds.set(input.runId, runtimeSessionId);
    const analysisOptions = this.options.analysisOptions ?? {};
    const privateKnowledge = analysisContextUsesPrivateKnowledge(analysisOptions);
    const outputLanguage = analysisOptions.outputLanguage ?? 'zh-CN';
    if (privateKnowledge) {
      const privateUserQueries = new Set([
        ...input.history
          .filter(message => message.role === 'user')
          .map(message => message.content),
        input.query,
      ]);
      for (const query of privateUserQueries) {
        registerPrivateAnalysisQueryForEcho(runtimeSessionId, query);
      }
    }
    const traceId = input.traceContext.kind === 'attached'
      ? input.traceContext.traceId
      : `conversation-no-trace:${input.sessionId}`;
    const onUpdate = (update: StreamingUpdate) => input.onUpdate?.(
      projectCodeAwareStreamingUpdate(
        runtimeSessionId,
        update,
        privateKnowledge,
        outputLanguage,
      ),
    );
    this.orchestrator.on('update', onUpdate);
    try {
      const result = await this.orchestrator.analyze(
        buildConversationPrompt({
          question: input.query,
          history: input.history,
          traceContext: input.traceContext,
        }),
        runtimeSessionId,
        traceId,
        {
          ...this.options.analysisOptions,
          selectionContext: input.selectionContext,
          analysisMode: 'fast',
          assistantSurface: 'conversation',
          conversationTraceAttached: input.traceContext.kind === 'attached',
          runId: input.runId,
        },
      );
      if (!result.success) {
        throw new Error(result.terminationMessage || 'Conversation runtime failed');
      }
      const outcome = parseConversationResponse(
        result.conclusion,
        input.query,
        projectEvidence(result),
      );
      return privateKnowledge
        ? projectPrivateStructuredValue(runtimeSessionId, outcome)
        : outcome;
    } catch (error) {
      if (isCancellationError(error)) {
        return {kind: 'cancelled', message: ''};
      }
      if (privateKnowledge) {
        throw new Error(privateAnalysisFailureMessage(outputLanguage));
      }
      throw error;
    } finally {
      this.orchestrator.off('update', onUpdate);
      revokeCodeAwareOutputGuards(runtimeSessionId);
      this.runtimeSessionIds.delete(input.runId);
    }
  }

  async cancel(_sessionId: string, runId: string): Promise<void> {
    const runtimeSessionId = this.runtimeSessionIds.get(runId);
    if (runtimeSessionId) await this.orchestrator.abortSession?.(runtimeSessionId);
  }

  async dispose(): Promise<void> {
    this.orchestrator.reset();
    this.orchestrator.removeAllListeners();
  }
}

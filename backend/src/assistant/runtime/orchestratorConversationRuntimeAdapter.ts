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
import {CodeLookupLedger} from '../../services/codebase/codeLookupLedger';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {
  buildConversationPrompt,
  containsInternalToolProtocol,
  parseConversationResponse,
  type ConversationEvidenceRef,
  type ConversationRuntimeOutcome,
} from '../contracts/conversationContract';
import {
  CONVERSATION_SOURCE_ENRICHMENT_BUDGET,
  resolvePrimaryConversationSourceUse,
  shouldStartAutomaticSourceEnrichment,
} from './conversationSourcePolicy';
import type {
  ConversationRuntimeAdapter,
  ConversationRuntimeInput,
  ConversationSourceEnrichmentRuntimeInput,
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
  private readonly sourceRuntimeSessionIds = new Map<string, string>();

  constructor(
    private readonly orchestrator: IOrchestrator,
    private readonly options: OrchestratorConversationRuntimeOptions = {},
  ) {}

  resolvePrimarySourceUse(query: string) {
    return resolvePrimaryConversationSourceUse({
      query,
      hasAuthorizedCodebase: Boolean(this.options.analysisOptions?.codebaseIds?.length),
    });
  }

  shouldStartSourceEnrichment(
    input: ConversationRuntimeInput,
    outcome: ConversationRuntimeOutcome,
  ): boolean {
    return shouldStartAutomaticSourceEnrichment({
      hasAuthorizedCodebase: Boolean(this.options.analysisOptions?.codebaseIds?.length),
      traceAttached: input.traceContext.kind === 'attached',
      primarySourceUse: this.resolvePrimarySourceUse(input.query),
      outcomeKind: outcome.kind,
      evidence: outcome.evidence,
    });
  }

  async run(input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> {
    const runtimeSessionId = `${input.sessionId}:${input.runId}`;
    this.runtimeSessionIds.set(input.runId, runtimeSessionId);
    const analysisOptions = this.options.analysisOptions ?? {};
    const primarySourceUse = resolvePrimaryConversationSourceUse({
      query: input.query,
      hasAuthorizedCodebase: Boolean(analysisOptions.codebaseIds?.length),
    });
    const effectiveAnalysisOptions: typeof analysisOptions = primarySourceUse === 'explicit'
      ? {
          ...analysisOptions,
          sourceUsePolicy: {
            phase: 'explicit',
            ...CONVERSATION_SOURCE_ENRICHMENT_BUDGET,
          },
        }
      : {
          ...analysisOptions,
          codeAwareMode: 'off',
          codebaseIds: undefined,
          sourceUsePolicy: undefined,
          analysisContextFingerprint: undefined,
        };
    const privateKnowledge = analysisContextUsesPrivateKnowledge(effectiveAnalysisOptions);
    const outputLanguage = effectiveAnalysisOptions.outputLanguage ?? 'zh-CN';
    const history = primarySourceUse === 'dormant'
      ? input.history.filter(message => !message.sourceDerived)
      : input.history;
    if (privateKnowledge) {
      const privateUserQueries = new Set([
        ...history
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
          history,
          traceContext: input.traceContext,
        }),
        runtimeSessionId,
        traceId,
        {
          ...effectiveAnalysisOptions,
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
      if (containsInternalToolProtocol(result.conclusion)) {
        const message = outputLanguage === 'en'
          ? 'The model returned an internal tool protocol instead of a user answer. The protocol was blocked.'
          : '模型返回了内部工具协议而不是用户答案，协议内容已被安全拦截。';
        const question = outputLanguage === 'en'
          ? 'Please retry the question. If it requires source, attach or authorize the relevant codebase first.'
          : '请重试这个问题；如果问题需要源码，请先挂载并授权相关代码库。';
        return {kind: 'needs_user_input', message, question};
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

  async runSourceEnrichment(input: ConversationSourceEnrichmentRuntimeInput) {
    const analysisOptions = this.options.analysisOptions ?? {};
    if (!analysisOptions.codebaseIds?.length || !analysisOptions.codeAwareMode || analysisOptions.codeAwareMode === 'off') {
      throw new Error('source_enrichment_not_authorized');
    }
    const runtimeSessionId = `${input.sessionId}:${input.runId}:source-enrichment`;
    this.sourceRuntimeSessionIds.set(input.runId, runtimeSessionId);
    registerPrivateAnalysisQueryForEcho(runtimeSessionId, input.query);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const template = loadPromptTemplate('conversation-source-enrichment');
      if (!template) throw new Error('conversation_source_enrichment_prompt_missing');
      const anchors = (input.primaryOutcome.evidence ?? [])
        .map(item => item.label.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
      const prompt = renderTemplate(template, {
        question: input.query,
        anchors,
        primaryAnswer: input.primaryOutcome.message,
      });
      const traceId = input.traceContext.kind === 'attached'
        ? input.traceContext.traceId
        : `conversation-no-trace:${input.sessionId}`;
      const startedAt = Date.now();
      const analysis = this.orchestrator.analyze(
        prompt,
        runtimeSessionId,
        traceId,
        {
          ...analysisOptions,
          selectionContext: input.selectionContext,
          analysisMode: 'fast',
          assistantSurface: 'conversation',
          conversationTraceAttached: input.traceContext.kind === 'attached',
          runId: `${input.runId}:source-enrichment`,
          sourceUsePolicy: {
            phase: 'automatic_enrichment',
            ...CONVERSATION_SOURCE_ENRICHMENT_BUDGET,
          },
        },
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void this.orchestrator.abortSession?.(runtimeSessionId);
          reject(new Error('source_enrichment_timeout'));
        }, CONVERSATION_SOURCE_ENRICHMENT_BUDGET.maxDurationMs);
        timer.unref?.();
      });
      const result = await Promise.race([analysis, timeout]);
      if (!result.success) throw new Error(result.terminationMessage || 'source_enrichment_failed');
      if (containsInternalToolProtocol(result.conclusion)) {
        throw new Error('source_enrichment_internal_tool_protocol');
      }
      const parsed = parseConversationResponse(
        result.conclusion,
        input.query,
        projectEvidence(result),
      );
      const entries = CodeLookupLedger.restore(runtimeSessionId, 12_000, 2).getEntries();
      const sourceEntries = entries.filter(entry => (
        entry.toolName === 'search_codebase' || entry.toolName === 'read_codebase_file'
      ));
      const executedSourceEntries = sourceEntries.filter(
        entry => entry.outcome !== 'budget_exceeded',
      );
      return projectPrivateStructuredValue(runtimeSessionId, {
        message: parsed.message,
        evidence: parsed.evidence ?? [],
        metrics: {
          searchCalls: executedSourceEntries.filter(entry => entry.toolName === 'search_codebase').length,
          readCalls: executedSourceEntries.filter(entry => entry.toolName === 'read_codebase_file').length,
          durationMs: Date.now() - startedAt,
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      revokeCodeAwareOutputGuards(runtimeSessionId);
      this.sourceRuntimeSessionIds.delete(input.runId);
    }
  }

  async cancelSourceEnrichment(_sessionId: string, runId: string): Promise<void> {
    const runtimeSessionId = this.sourceRuntimeSessionIds.get(runId);
    if (runtimeSessionId) await this.orchestrator.abortSession?.(runtimeSessionId);
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

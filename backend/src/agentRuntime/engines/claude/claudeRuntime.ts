// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  commitEvaluationExposureSince,
  currentEvaluationInjectionContract,
} from '../../../services/selfEvolution/evaluationInjectionContext';
import {
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';
import type { TraceProcessorService } from '../../../services/traceProcessorService';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import { getSkillAnalysisAdapter } from '../../../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../../../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../../../agent/types/agentProtocol';
import type { AnalysisResult, AnalysisOptions, IOrchestrator } from '../../../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../../../agent/detectors/types';

import { createClaudeMcpServer, loadLearnedSqlFixPairs, MCP_NAME_PREFIX } from '../../../agentv3/claudeMcpServer';
import {
  buildSystemPromptParts,
  buildQuickSystemPrompt,
  buildSelectionContextSection,
} from '../../../agentv3/claudeSystemPrompt';
import {
  createSseBridge,
  extractSdkToolResultBlocks,
  isSdkToolResultFailure,
  stringifySdkToolResult,
} from './claudeSseBridge';
import {
  buildMaxTurnsFallbackConclusion,
  buildMaxTurnsTerminationMessage,
  capPartialConfidence,
  isSdkMaxTurnsSubtype,
  MAX_TURNS_TERMINATION_REASON,
  prependPartialNotice,
  SDK_MAX_TURNS_SUBTYPE,
  estimateAnalysisConfidence,
} from '../../../agentv3/analysisTermination';
import { extractFindingsFromText, extractFindingsFromSkillResult, mergeFindings } from '../../../agentv3/claudeFindingExtractor';
import {
  createQuickConfig,
  createSdkEnv,
  explainClaudeRuntimeError,
  getCredentialSourceHint,
  getSdkBinaryOption,
  hasConfiguredClaudeEffortOverride,
  isClaudeQuotaError,
  loadClaudeConfig,
  resolveClaudeSdkPermissionOptions,
  resolveEffort,
  resolveRuntimeConfig,
  type ClaudeAgentConfig,
} from './claudeConfig';
import { detectFocusApps, focusAppTimeRangeFromSelection } from '../../../agentv3/focusAppDetector';
import { classifyScene, type SceneType } from '../../../agentv3/sceneClassifier';
import {
  classifyQueryComplexity,
  classifyQueryComplexityLocal,
  isAcknowledgementFollowupReason,
  PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON,
} from '../../../agentv3/queryComplexityClassifier';
import { buildComplexityClassifierInput } from '../../../agentv3/queryComplexityContext';
import { buildAgentDefinitions } from './claudeAgentDefinitions';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import {resolveEffectiveAnalysisMode} from '../../../services/effectiveAnalysisMode';
import {
  analysisContextMemoryPartitionKey,
  analysisContextUsesPrivateKnowledge,
} from '../../../services/resolvedAnalysisContext';
import type { AnalysisNote, AnalysisPlanV3, ClaudeAnalysisContext, ComplexityClassifierInput, FailedApproach, Hypothesis, QueryComplexity, UncertaintyFlag, VerificationIssue } from '../../../agentv3/types';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
  readToolResultFacts,
} from '../../../agentv3/planToolCallRecorder';
import { buildRecoveryNote } from '../../../agentv3/recoveryNoteBuilder';
import { evaluateThreshold as evaluateContextThreshold } from '../../../agentv3/contextTokenMeter';
import {
  createClaudeSnapshotEngineState,
  getClaudeSnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type SessionStateSnapshot,
  type SessionFieldsForSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import { AgentMetricsCollector, persistSessionMetrics } from '../../../agentv3/agentMetrics';
import {
  extractTraceFeatures,
  extractKeyInsights,
  saveAnalysisPattern,
  saveNegativePattern,
  saveQuickPathPattern,
  promoteQuickPatternIfMatching,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../../../agentv3/analysisPatternMemory';
import {
  createCodeAwareStreamingTextProjection,
  sanitizeCodeAwareText,
} from '../../../services/security/codeAwareOutputRegistry';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {completeFinalReportCodeReferences} from '../../../services/codebase/codeReferenceContract';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {finalizeSourceAwareAnalysisResult} from '../../../services/codebase/sourceClaimVerifier';
import {diagnosticLogIdentity} from '../../../utils/logger';
import { runSnapshots } from '../../../agentv3/selfImprove/strategyFingerprint';
import { verifyConclusion, generateCorrectionPrompt, isConclusionIncomplete } from './claudeVerifier';
import {recoverInterruptedFinalReport} from '../../runtimeFinalReportRecovery';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import { backendLogPath } from '../../../runtimePaths';
import {
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
  looksLikeProcessNarrationConclusion,
  looksLikePhaseSummaryFallback,
  looksLikeProviderErrorConclusion,
} from '../../../services/finalResultQualityGate';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { getProductionEngineCapabilities } from '../../runtimeDescriptors';
import type { EngineCapabilities } from '../../runtimeDescriptorTypes';
import {
  createResettableRuntimeTimeout,
  resolveFullRequestTimeoutMs,
  summarizeExternalToolResult,
  type RuntimeTimeoutKind,
} from '../../runtimeLimits';
import { buildFocusAppEvidencePayload } from '../../focusAppEvidence';
import {
  buildRuntimeQuickEvidenceAttempt,
  selectReusableRuntimeQuickEvidenceAttempt,
  combineRuntimeQuickEvidenceDirectAnswers,
  countRuntimeQuickEvidenceCitedRefs,
  sanitizeRuntimeQuickEvidenceRoutingContext,
  type RuntimeQuickEvidenceAttempt,
} from '../../quickEvidenceDirectAnswer';
import {
  buildQuickDirectAcknowledgementAnalysisResult,
  buildQuickDirectEvidenceAnalysisResult,
  emitQuickDirectAnswerEvents,
  emitQuickDirectQualityGateIssue,
} from '../../quickDirectResult';
import {
  buildQuickFocusAppDirectAnswer,
} from '../../quickFocusAppDirectAnswer';
import { buildQuickProcessIdentityDirectAnswer } from '../../quickProcessIdentityDirectAnswer';
import {
  buildQuickProcessIdentityEvidence,
  createQuickProcessIdentitySkillExecutor,
  shouldUseEvidenceOnlyQuickAnalysis,
} from '../../quickProcessIdentityEvidence';
import { buildQuickTraceFactDirectAnswer } from '../../quickTraceFactDirectAnswer';
import {
  buildQuickTraceFactEvidence,
  joinRuntimeEvidenceContexts,
  shouldSkipFocusDetectionForQuickTraceFactEvidence,
  shouldUseTraceFactEvidenceOnlyQuickAnalysis,
} from '../../quickTraceFactEvidence';
import { deriveRuntimeQuickPreEvidenceFlags } from '../../quickModeResolution';
import {
  buildRuntimeTracePairComparisonContext,
  buildQuickKnowledgeBaseContext,
} from '../../runtimePromptContext';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import { CLAUDE_AGENT_RUNTIME_KIND } from '../../runtimeKinds';

function looksLikeProcessNarration(text: string): boolean {
  return /(?:我来|我需要|我将|接下来|先重新|重新读取|继续调用|首先.*提交|计划已提交|工具|tool|let me|i need to|i will|next i)/i
    .test(text.slice(0, 500));
}

function correctionResultLooksUsable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 100) return false;
  if (looksLikePhaseSummaryFallback(trimmed)) return false;
  const hasFinalReportMarker =
    /(^|\n)\s*#{1,3}\s*(?:综合结论|Final Conclusion|关键证据链|Evidence|优化建议|Recommendations)(?:\s|[：:]|$)/i.test(trimmed);
  if (looksLikeProcessNarration(trimmed) && !hasFinalReportMarker) return false;
  return hasFinalReportMarker || !isConclusionIncomplete(trimmed);
}

function hasClaudeRecoveryEvidence(text: string): boolean {
  return /(?:\bart-\d+\b|\bdata:[a-z0-9_:-]+\b|\bevidence[_-]?ref(?:_id)?\b|\bsource_tool_call_id\b|\bsource_ref\b|证据\s*(?:ID|引用))/i
    .test(text);
}

function recoverClaudeInterruptedFinalReport(input: {
  accumulatedAnswer: string;
  plan: AnalysisPlanV3 | null;
  hypotheses?: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
}): string | undefined {
  const candidate = sanitizeClaudeConclusionText(input.accumulatedAnswer);
  const candidateIsUsable = candidate.length > 0 &&
    hasDeliverableFinalReportHeading(candidate) &&
    !looksLikeProcessNarration(candidate) &&
    !looksLikeProcessNarrationConclusion(candidate) &&
    !looksLikePhaseSummaryFallback(candidate) &&
    hasClaudeRecoveryEvidence(candidate);

  return recoverInterruptedFinalReport({
    partialConclusion: candidateIsUsable ? candidate : undefined,
    plan: input.plan,
    hypotheses: input.hypotheses,
    outputLanguage: input.outputLanguage,
  });
}

function isRecoverableClaudeStreamInterruption(input: {
  errorMessage: string;
  streamStarted: boolean;
  hasPartialEvidence: boolean;
  quotaExceeded: boolean;
}): boolean {
  const message = input.errorMessage.trim().toLowerCase();
  if (!message || input.quotaExceeded) return false;
  if (
    /(?:no conversation found|\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|api[_ -]?key|credential|quota|credit|billing|spending|permission denied|access denied|invalid configuration|configuration error|model (?:is )?not found|unknown model|\benoent\b|invalid cwd)/i.test(message) ||
    /\babort(?:ed|error)?\b/i.test(message)
  ) {
    return false;
  }

  const explicitStreamInterruption =
    /(?:error_max_turns|stream (?:terminated|ended|closed|interrupted)|response (?:terminated|ended|closed)|connection (?:terminated|closed|reset|lost)|socket hang up|econnreset|epipe|etimedout|unexpected eof|prematurely ended)/i
      .test(message);
  return explicitStreamInterruption && input.streamStarted && input.hasPartialEvidence;
}

function findDeliverableReportHeadingIndex(text: string): number {
  const match = text.match(
    /(?:^|\n)\s{0,3}(?:#{1,3}\s*)?(?:(?:[^\n#]{0,40})?分析报告|综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause)(?=\s|[：:。.!！?\n]|$)/i,
  );
  return match?.index ?? -1;
}

function stripLeadingProcessNarrationBeforeSection(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const reportHeadingMatch = trimmed.match(
    /^\s{0,3}#{1,3}\s*[^\n]*(?:分析报告|最终报告|Final Report|Analysis Report)[^\n]*\n+/i,
  );
  const heading = reportHeadingMatch ? reportHeadingMatch[0].trimEnd() : '';
  const body = reportHeadingMatch
    ? trimmed.slice(reportHeadingMatch[0].length).trimStart()
    : trimmed;
  const sectionMatch = /(?:^|\n)\s{0,3}#{1,4}\s+\S/.exec(body);
  if (!sectionMatch || sectionMatch.index === undefined || sectionMatch.index <= 0) {
    return trimmed;
  }

  const prefix = body.slice(0, sectionMatch.index).trim();
  const prefixIsProcessNarration =
    looksLikeProcessNarration(prefix) ||
    looksLikeProcessNarrationConclusion(prefix) ||
    /(?:我来分析|计划已提交|开始\s*Phase|进入\s*Phase|Phase\s*\d+|所有假设已解决|所有(?:深钻)?数据(?:已)?收集完毕|开始撰写综合结论报告|完整结构化报告|修正重试|验证发现|update_plan_phase|resolve_hypothesis)/i.test(prefix);
  if (!prefixIsProcessNarration) return trimmed;

  const reportBody = body.slice(sectionMatch.index).trimStart();
  return heading ? `${heading}\n\n${reportBody}` : reportBody;
}

function stripCorrectionScaffold(text: string): string {
  const cleanedHeadingLabels = text.replace(
    /(^|\n)(\s{0,3}#{1,3}\s+[^\n#]*(?:分析报告|Analysis Report|Final Report|Root Cause)[^\n]*?)[（(]\s*(?:修正版|修正后|corrected(?:\s+version)?|revised)\s*[）)]/gi,
    '$1$2',
  );

  const withoutPlanDeviationBlock = (() => {
    const lines = cleanedHeadingLabels.split(/\r?\n/);
    const start = lines.findIndex((line, idx) =>
      idx < 40 && /(?:计划执行偏差|plan execution deviation|verification feedback|验证反馈)/i.test(line)
    );
    if (start < 0) return cleanedHeadingLabels;

    let blockStart = start;
    while (blockStart > 0 && !lines[blockStart - 1].trim()) blockStart--;

    let blockEnd = start + 1;
    while (blockEnd < lines.length) {
      const line = lines[blockEnd].trim();
      if (/^-{3,}$/.test(line)) {
        blockEnd++;
        break;
      }
      if (/^#{1,6}\s+/.test(line) && !/(?:计划执行偏差|plan execution deviation|verification feedback|验证反馈)/i.test(line)) {
        break;
      }
      blockEnd++;
    }

    return [
      ...lines.slice(0, blockStart),
      ...lines.slice(blockEnd),
    ].join('\n');
  })();

  const withoutToolExecutionScaffold = withoutPlanDeviationBlock
    .replace(/[`'"“”]?detect_architecture[`'"“”]?\s*(?:Skill|tool|工具)?\s*本次未执行[，,、；;]?\s*/gi, '')
    .replace(/(?:`?detect_architecture`?\s+)?(?:Skill|tool)\s+(?:was\s+)?not\s+executed[,.；;]?\s*/gi, '');

  const lines = withoutToolExecutionScaffold.split(/\r?\n/);
  const output: string[] = [];
  let firstReportHeading: { canonical: string; nonEmptyAfter: number } | undefined;

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
    if (heading && /(?:分析报告|Analysis Report|Final Report|Root Cause)/i.test(heading[1])) {
      const canonical = heading[1]
        .replace(/[（(]\s*(?:修正版|修正后|corrected(?:\s+version)?|revised)\s*[）)]/ig, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (
        firstReportHeading &&
        firstReportHeading.canonical === canonical &&
        firstReportHeading.nonEmptyAfter <= 4
      ) {
        continue;
      }
      firstReportHeading = { canonical, nonEmptyAfter: 0 };
    } else if (firstReportHeading && line.trim()) {
      firstReportHeading.nonEmptyAfter++;
    }
    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeClaudeConclusionText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const singleLineCleaned = trimmed
    .replace(/^(?:完成综合结论输出|完整结构化报告已(?:输出|生成))[。:：\s]*/i, '')
    .replace(/^所有假设已解决[。；;,\s]*(?:现在)?输出完整结构化报告[。:：\s-]*/i, '')
    .replace(/^所有(?:深钻)?数据(?:已)?收集完毕[。；;,\s]*(?:现在)?(?:开始撰写|输出)(?:综合结论报告|综合结论|最终报告|完整结构化报告)[。:：\s-]*/i, '')
    .trim();
  const processIntroCleaned = stripLeadingProcessNarrationBeforeSection(singleLineCleaned);
  if (processIntroCleaned !== trimmed) return stripCorrectionScaffold(processIntroCleaned);

  const headingIndex = findDeliverableReportHeadingIndex(trimmed);
  if (headingIndex <= 0 || !hasDeliverableFinalReportHeading(trimmed.slice(headingIndex))) {
    return stripCorrectionScaffold(trimmed);
  }

  const prefix = trimmed.slice(0, headingIndex).trim();
  const prefixIsProcessNarration =
    looksLikeProcessNarration(prefix) ||
    looksLikeProcessNarrationConclusion(prefix) ||
    /(?:我来分析|计划已提交|开始\s*Phase|进入\s*Phase|Phase\s*\d+|所有假设已解决|所有(?:深钻)?数据(?:已)?收集完毕|开始撰写综合结论报告|完整结构化报告|修正重试|验证发现|update_plan_phase|resolve_hypothesis)/i.test(prefix);
  if (!prefixIsProcessNarration) return stripCorrectionScaffold(trimmed);

  return stripCorrectionScaffold(trimmed.slice(headingIndex).trim());
}

function reportHeadingForScene(sceneType: SceneType | undefined, outputLanguage: string): string {
  const zh = outputLanguage !== 'en';
  switch (sceneType) {
    case 'startup':
      return zh ? '# 启动性能分析报告' : '# Startup Performance Analysis Report';
    case 'scrolling':
      return zh ? '# 滑动性能分析报告' : '# Scrolling Performance Analysis Report';
    case 'anr':
      return zh ? '# ANR 分析报告' : '# ANR Analysis Report';
    default:
      return zh ? '# 性能分析报告' : '# Performance Analysis Report';
  }
}

function looksLikeStructuredDeliverableReport(text: string): boolean {
  const trimmed = text.trim();
  const headingCount = (trimmed.match(/(^|\n)\s{0,3}#{1,3}\s+\S/g) || []).length;
  if (headingCount < 2) return false;
  return /(?:evidence_ref_id|source_ref|art-\d+|data:art-\d+|data:skill:|##?\s*(?:概览|关键发现|根因|优化建议|Recommendations|Evidence))/i.test(trimmed);
}

function ensureClaudeFinalReportHeading(
  text: string,
  sceneType: SceneType | undefined,
  outputLanguage: string,
): string {
  const trimmed = sanitizeClaudeConclusionText(text);
  if (!trimmed || hasDeliverableFinalReportHeading(trimmed)) return trimmed;
  if (!looksLikeStructuredDeliverableReport(trimmed)) return trimmed;
  return `${reportHeadingForScene(sceneType, outputLanguage)}\n\n${trimmed}`;
}

function normalizeClaudeBridgeConclusionUpdate(
  update: StreamingUpdate,
  sceneType: SceneType | undefined,
  outputLanguage: string,
): StreamingUpdate {
  if (update.type !== 'conclusion') return update;
  const content = update.content as Record<string, unknown> | undefined;
  if (!content || typeof content.conclusion !== 'string') return update;

  const conclusion = ensureClaudeFinalReportHeading(
    content.conclusion,
    sceneType,
    outputLanguage,
  );
  if (conclusion === content.conclusion) return update;

  return {
    ...update,
    content: {
      ...content,
      conclusion,
    },
  } as StreamingUpdate;
}

function shouldMarkCorrectionTimeoutPartial(input: {
  correctedResult: string;
  existingConclusion: string;
}): boolean {
  if (correctionResultLooksUsable(sanitizeClaudeConclusionText(input.correctedResult))) {
    return false;
  }
  return !correctionResultLooksUsable(sanitizeClaudeConclusionText(input.existingConclusion));
}

function shouldSkipSdkCorrectionForDeliverableConclusion(
  errorIssues: VerificationIssue[],
  conclusion: string,
): boolean {
  const sanitizedConclusion = sanitizeClaudeConclusionText(conclusion);
  if (!correctionResultLooksUsable(sanitizedConclusion)) return false;
  return errorIssues.every(issue => {
    if (issue.type === 'plan_deviation') {
      return true;
    }
    if (issue.type === 'truncation') {
      return looksLikeSoftTruncationFalsePositive(sanitizedConclusion);
    }
    return false;
  });
}

function looksLikeSoftTruncationFalsePositive(conclusion: string): boolean {
  const trimmed = conclusion.trim();
  if (trimmed.length < 1500 || !hasDeliverableFinalReportHeading(trimmed)) return false;
  if (!looksLikeStructuredDeliverableReport(trimmed)) return false;

  const lastLine = trimmed.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop() || '';
  if (!lastLine || lastLine.length < 8) return false;

  return /^(?:[-*]\s*)?(?:evidence_ref_id|source_ref|identity:|data:|art-\d+\b)/i.test(lastLine) ||
    /(?:evidence_ref_id|source_ref|identity:|data:|art-\d+\b)/i.test(lastLine) ||
    /^(?:Powered by|由 SmartPerfetto|SmartPerfetto\b)/i.test(lastLine) ||
    /(?:置信度|confidence)\s*[:：]?\s*\d+(?:\.\d+)?%?$/i.test(lastLine) ||
    /(?:\d+(?:\.\d+)?\s*(?:ms|s|%|fps|MB|GHz|MHz)|[`）)\]】])$/.test(lastLine);
}

function chooseClaudeConclusionText(input: {
  finalResult: string;
  accumulatedAnswer: string;
}): string {
  const finalResult = sanitizeClaudeConclusionText(input.finalResult);
  const accumulatedAnswer = sanitizeClaudeConclusionText(input.accumulatedAnswer);
  if (!finalResult) return accumulatedAnswer;
  if (!accumulatedAnswer) return finalResult;
  if (
    isConclusionIncomplete(finalResult) &&
    accumulatedAnswer.length > finalResult.length &&
    hasDeliverableFinalReportHeading(accumulatedAnswer)
  ) {
    return accumulatedAnswer;
  }
  if (
    !hasDeliverableFinalReportHeading(finalResult) &&
    hasDeliverableFinalReportHeading(accumulatedAnswer)
  ) {
    return accumulatedAnswer;
  }
  return finalResult;
}
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import { localize, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { planPhaseUpdatedContent } from '../../../agentv3/planPhaseEvents';
import { isPolicyRefusalResult } from '../../../agentv3/toolNarration';
import {
  deleteClaudeSessionMapRuntimeSnapshot,
  deleteClaudeSessionMapRuntimeSnapshots,
  loadClaudeSessionMapFromRuntimeSnapshots,
  saveClaudeSessionMapToRuntimeSnapshots,
  type ClaudeSessionMapRuntimeEntry,
} from '../../../services/runtimeSnapshotStore';
import {
  enterpriseDbWritesEnabled,
  legacyFilesystemReadAuthorityEnabled,
  legacyFilesystemWritesEnabled,
} from '../../../services/enterpriseMigration';
import {
  SDK_SESSION_FRESHNESS_MS,
  buildQuickRunReceipt,
  buildEntityContext,
  buildQuickConversationContext,
  buildQuickMemoryContextPayload,
  buildRuntimeSessionMapKey,
  captureSkillDisplayEntities,
  collectRecentFindings,
  createRuntimeSkillNotesBudget,
  getLruCacheEntry,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  setLruCacheEntry,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createAnalysisRunSpec,
  type AnalysisRunSpec,
} from '../../analysisRunSpec';
import {buildAdaptiveRoutingForModeDecision} from '../../adaptiveRoutingProjection';
import type { RuntimeSelection } from '../../runtimeSelection';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';

const SESSION_MAP_FILE = backendLogPath('claude_session_map.json');
/** Max age for session map entries before pruning (24 hours). */
const SESSION_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SessionMapEntry {
  sdkSessionId: string;
  updatedAt: number;
  mode?: 'full';
}

function enterpriseSessionMapDbWritesEnabled(): boolean {
  return enterpriseDbWritesEnabled();
}

function legacySessionMapWritesEnabled(): boolean {
  return legacyFilesystemWritesEnabled();
}

function loadPersistedSessionMap(): Map<string, SessionMapEntry> {
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const map = new Map<string, SessionMapEntry>();
      for (const [key, value] of Object.entries(data)) {
        // Migration: old format stored plain string, new format stores {sdkSessionId, updatedAt}
        if (typeof value === 'string') {
          map.set(key, { sdkSessionId: value, updatedAt: Date.now() });
        } else if (value && typeof value === 'object') {
          const entry = value as Partial<SessionMapEntry>;
          if (typeof entry.sdkSessionId !== 'string') continue;
          const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : Date.now();
          const mode = entry.mode === 'full' ? entry.mode : undefined;
          map.set(key, { sdkSessionId: entry.sdkSessionId, updatedAt, ...(mode ? { mode } : {}) });
        }
      }
      return map;
    }
  } catch {
    // Ignore — start with empty map
  }
  return new Map();
}

function loadSessionMapForCurrentMode(): Map<string, SessionMapEntry> {
  if (legacyFilesystemReadAuthorityEnabled()) {
    return loadPersistedSessionMap();
  }

  try {
    return loadClaudeSessionMapFromRuntimeSnapshots(SESSION_MAP_MAX_AGE_MS);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to load runtime_snapshots session map:', diagnosticLogIdentity((err as Error).message));
  }
  return new Map();
}

/**
 * Debounce timer for session map persistence — avoids blocking event loop on every SDK message.
 * P2-1: Use a Map keyed by the Map reference to support multiple ClaudeRuntime instances.
 */
const saveTimers = new WeakMap<Map<string, SessionMapEntry>, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 2000;
const CORRECTION_RETRY_TIMEOUT_MS_PER_TURN = 45_000;
const FULL_REPORT_CORRECTION_TIMEOUT_MS_PER_TURN = 30_000;
const TEXT_ONLY_CORRECTION_TIMEOUT_MS = 120_000;

function savePersistedSessionMap(map: Map<string, SessionMapEntry>): void {
  const existing = saveTimers.get(map);
  if (existing) clearTimeout(existing);
  saveTimers.set(map, setTimeout(() => {
    saveTimers.delete(map);
    savePersistedSessionMapSync(map);
  }, SAVE_DEBOUNCE_MS));
}

/** Immediate save — used by debounce timer and for critical operations (session removal). */
function savePersistedSessionMapSync(map: Map<string, SessionMapEntry>): void {
  try {
    const dir = path.dirname(SESSION_MAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Prune stale entries before saving
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.updatedAt > SESSION_MAP_MAX_AGE_MS) {
        map.delete(key);
      }
    }

    const tmpFile = SESSION_MAP_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmpFile, SESSION_MAP_FILE);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to persist session map:', diagnosticLogIdentity((err as Error).message));
  }
}

// Notes persistence now handled by unified SessionStateSnapshot — no separate disk I/O.
// The old logs/session_notes/ directory is no longer written to.

// P2-G1: ALLOWED_TOOLS is now auto-derived from createClaudeMcpServer() return value.
// No longer hardcoded — adding a new MCP tool automatically includes it.

/** Check if an error is retryable (API overload/server errors). */
function isRetryableError(err: Error): boolean {
  const msg = err.message || '';
  // Anthropic API errors: 529 (overload), 500 (server), 503 (service unavailable)
  return /529|overload|500|server error|503|service unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);
}

function getSdkResultErrorMessage(msg: any): string | undefined {
  if (!msg || msg.type !== 'result') return undefined;
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown';
  if (subtype === 'success' || isSdkMaxTurnsSubtype(subtype)) return undefined;

  const errors = Array.isArray(msg.errors)
    ? msg.errors.map(formatSdkError).filter(Boolean)
    : [];
  return `Claude analysis error (${subtype}): ${errors.join('; ') || 'Unknown error'}`;
}

function formatSdkError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function isMissingSdkConversationError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

function isFreshFullSdkSessionEntry(entry: SessionMapEntry | undefined, now = Date.now()): entry is SessionMapEntry & { mode: 'full' } {
  return !!entry
    && entry.mode === 'full'
    && isFreshRuntimeEntry(entry, SDK_SESSION_FRESHNESS_MS, now);
}

type ClaudeSdkSystemPrompt = string | string[];

function supportsSystemPromptDynamicBoundary(capabilities: EngineCapabilities): boolean {
  return capabilities.promptCache.systemPromptDynamicBoundary;
}

function buildClaudeSdkSystemPrompt(
  parts: Pick<ReturnType<typeof buildSystemPromptParts>, 'fullPrompt' | 'stablePrefix' | 'volatileSuffix'>,
  capabilities: EngineCapabilities,
): ClaudeSdkSystemPrompt {
  if (!supportsSystemPromptDynamicBoundary(capabilities)) {
    return parts.fullPrompt;
  }

  const stablePrefix = parts.stablePrefix.trim();
  if (!stablePrefix) {
    return parts.fullPrompt;
  }

  const blocks = [
    stablePrefix,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  ];
  const volatileSuffix = parts.volatileSuffix.trim();
  if (volatileSuffix) {
    blocks.push(volatileSuffix);
  }
  return blocks;
}

function projectClaudeToolResultForPlan(toolName: string, result: unknown): string {
  return summarizeExternalToolResult(projectToolResultForExternalSurface(toolName, result));
}

function buildClaudeSdkToolOptions(
  allowedTools: readonly string[],
  agents?: Record<string, unknown>,
): {tools: string[]; allowedTools: string[]} {
  const hasSubAgents = agents !== undefined && Object.keys(agents).length > 0;
  if (!hasSubAgents) {
    return {tools: [], allowedTools: [...allowedTools]};
  }
  return {
    tools: ['Agent'],
    allowedTools: allowedTools.includes('Agent')
      ? [...allowedTools]
      : [...allowedTools, 'Agent'],
  };
}

export const __testing = {
  getSdkResultErrorMessage,
  isMissingSdkConversationError,
  isFreshFullSdkSessionEntry,
  buildClaudeSdkSystemPrompt,
  getCorrectionRetryTimeoutMs,
  buildQuickConversationContext,
  correctionResultLooksUsable,
  shouldSkipSdkCorrectionForDeliverableConclusion,
  looksLikeSoftTruncationFalsePositive,
  chooseClaudeConclusionText,
  ensureClaudeFinalReportHeading,
  normalizeClaudeBridgeConclusionUpdate,
  sanitizeClaudeConclusionText,
  shouldMarkCorrectionTimeoutPartial,
  projectClaudeToolResultForPlan,
  recoverClaudeInterruptedFinalReport,
  isRecoverableClaudeStreamInterruption,
  buildClaudeSdkToolOptions,
};

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCorrectionRetryTimeoutMs(
  correctionTurns: number,
  conclusionNeedsFullGeneration: boolean,
): number {
  return correctionTurns * (
    conclusionNeedsFullGeneration
      ? FULL_REPORT_CORRECTION_TIMEOUT_MS_PER_TURN
      : CORRECTION_RETRY_TIMEOUT_MS_PER_TURN
  );
}

/**
 * Handle returned by sdkQueryWithRetry. `stream` is the (retry-wrapped)
 * async iterable of SDK messages; `close()` aborts the underlying SDK
 * subprocess and any in-flight MCP tool calls.
 *
 * Callers MUST invoke `close()` (typically from a timeout handler and as a
 * `finally` safety net) to prevent zombie MCP tool executions from running
 * after the session has been torn down.
 */
interface SdkQueryHandle {
  stream: ReturnType<typeof sdkQuery>;
  close: () => void;
}

interface RuntimeAbortHandle {
  abort(): void;
}

interface SdkQueryRuntimeReceiptState {
  sdkStartRecorded: boolean;
}

/**
 * Wrap sdkQuery with exponential backoff retry for transient API errors
 * and expose a `close()` handle so timeout/abort paths can terminate the
 * SDK subprocess instead of just breaking out of the `for await` loop.
 *
 * Without `close()`, a consumer that `break`s out of the iterator leaves
 * the SDK free to continue executing queued MCP tool calls (e.g.
 * `execute_sql`). Those "ghost" calls hit trace_processor after the
 * session logger has closed, producing orphan errors no one handles.
 */
function sdkQueryWithRetry(
  params: Parameters<typeof sdkQuery>[0],
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    emitUpdate?: (update: StreamingUpdate) => void;
    outputLanguage?: import('../../../agentv3/outputLanguage').OutputLanguage;
    runtimePerformance?: RuntimePerformanceRun;
    signal?: AbortSignal;
    recordSdkStartPhase?: boolean;
    runtimeReceiptState?: SdkQueryRuntimeReceiptState;
  } = {},
): SdkQueryHandle {
  const {
    maxRetries = 2,
    baseDelayMs = 2000,
    emitUpdate,
    outputLanguage = loadClaudeConfig().outputLanguage,
    runtimePerformance,
    signal,
    recordSdkStartPhase = false,
    runtimeReceiptState,
  } = options;
  const queryOptions = params.options ?? {};
  const binaryOpt = getSdkBinaryOption(queryOptions.env);
  const mergedParams = binaryOpt.pathToClaudeCodeExecutable
    ? { ...params, options: { ...queryOptions, ...binaryOpt } }
    : params;

  // Tracks the Query instance currently being iterated so `close()` can
  // forward termination to the underlying SDK subprocess across retries.
  let currentQuery: ReturnType<typeof sdkQuery> | undefined;
  let closed = false;
  const localRuntimeReceiptState = runtimeReceiptState ?? {sdkStartRecorded: false};
  let activeAttemptEnd: ((outcome: RuntimePerformanceOutcome) => void) | undefined;

  // We can't directly retry an async iterable, so we use a generator wrapper.
  // On the first call to next(), we attempt sdkQuery. If it throws, we retry.
  async function* retryableStream() {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (closed) return;
      let terminalResultObserved = false;
      let attemptOutcome: RuntimePerformanceOutcome = 'ok';
      const sdkStartPhase = recordSdkStartPhase && !localRuntimeReceiptState.sdkStartRecorded
        ? runtimePerformance?.startPhase('sdk_start')
        : undefined;
      if (sdkStartPhase) {
        localRuntimeReceiptState.sdkStartRecorded = true;
      }
      const providerPhase = runtimePerformance?.startPhase('provider');
      let providerEnded = false;
      const endProviderPhase = (outcome: RuntimePerformanceOutcome) => {
        if (providerEnded) return;
        providerEnded = true;
        providerPhase?.end(outcome);
        if (activeAttemptEnd === endProviderPhase) {
          activeAttemptEnd = undefined;
        }
      };
      activeAttemptEnd = endProviderPhase;
      try {
        if (currentEvaluationInjectionContract()) {
          commitEvaluationExposureSince(0, 'sdk_handoff_observed');
        }
        currentQuery = sdkQuery(mergedParams);
        sdkStartPhase?.end(closed || signal?.aborted ? 'cancelled' : 'ok');
        // Yield all messages from the stream
        for await (const msg of currentQuery) {
          if (closed) {
            endProviderPhase('cancelled');
            return;
          }
          if ((msg as any)?.type === 'result') {
            const subtype = (msg as any).subtype;
            terminalResultObserved = subtype === 'success' || isSdkMaxTurnsSubtype(subtype);
            if (!terminalResultObserved && getSdkResultErrorMessage(msg)) {
              attemptOutcome = 'error';
            }
          }
          yield msg;
        }
        endProviderPhase(closed || signal?.aborted ? 'cancelled' : attemptOutcome);
        return; // Success — exit generator
      } catch (err) {
        lastErr = err as Error;
        if (terminalResultObserved) {
          sdkStartPhase?.end(closed || signal?.aborted ? 'cancelled' : 'ok');
          endProviderPhase('ok');
          console.warn(
            '[ClaudeRuntime] Ignoring SDK iterator cleanup error after terminal result:',
            diagnosticLogIdentity(lastErr.message),
          );
          return;
        }
        const outcome = runtimeOutcomeFromError(lastErr, signal);
        sdkStartPhase?.end(outcome);
        endProviderPhase(outcome);
        // If the caller invoked close(), treat the resulting error as
        // intentional termination rather than a retryable failure.
        if (closed) return;
        if (isRetryableError(lastErr) && attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(
            `[ClaudeRuntime] API error (attempt ${attempt + 1}/${maxRetries + 1}): ` +
            `${diagnosticLogIdentity(lastErr.message)}. Retrying in ${delay}ms...`,
          );
          emitUpdate?.({
            type: 'progress',
            content: {
              phase: 'starting',
              message: localize(
                outputLanguage,
                `API 暂时不可用，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${maxRetries})...`,
                `API is temporarily unavailable. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${maxRetries})...`,
              ),
            },
            timestamp: Date.now(),
          });
          await sleep(delay);
          continue;
        }
        throw lastErr; // Non-retryable or max retries exceeded
      }
    }
    if (lastErr) throw lastErr;
  }

  return {
    stream: retryableStream() as ReturnType<typeof sdkQuery>,
    close: () => {
      if (closed) return; // Idempotent — safe to call from timeout handler AND finally.
      closed = true;
      activeAttemptEnd?.('cancelled');
      try {
        currentQuery?.close();
      } catch (err) {
        console.warn('[ClaudeRuntime] sdkQueryWithRetry close() failed (non-fatal):', diagnosticLogIdentity((err as Error).message));
      }
    },
  };
}

/**
 * Claude Agent SDK runtime for SmartPerfetto.
 * Claude SDK orchestrator implementation behind the shared IOrchestrator contract.
 * Implements the same EventEmitter + analyze() interface as AgentRuntime.
 */
export class ClaudeRuntime extends EventEmitter implements IOrchestrator {
  private traceProcessorService: TraceProcessorService;
  private config: ClaudeAgentConfig;
  private sessionMap: Map<string, SessionMapEntry>;
  /** Cache architecture detection results per traceId (deterministic per trace). */
  private architectureCache: Map<string, ArchitectureInfo> = new Map();
  /** Cache vendor detection results per traceId (deterministic per trace). */
  private vendorCache: Map<string, string> = new Map();
  /** Per-session artifact stores — persist across turns within a session. */
  private artifactStores: Map<string, ArtifactStore> = new Map();
  /** Per-session analysis notes — persist across turns within a session. */
  private sessionNotes: Map<string, AnalysisNote[]> = new Map();
  /** Per-session SQL error tracking for error-fix pair learning. */
  private sessionSqlErrors: Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number }>> = new Map();
  private sessionSqlErrorPartitions: Map<string, string> = new Map();
  /** Per-session analysis plans for plan adherence tracking. */
  private sessionPlans: Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }> = new Map();
  /** Per-session hypotheses for hypothesis-verify cycle (P0-G4). */
  private sessionHypotheses: Map<string, Hypothesis[]> = new Map();
  /** Per-session uncertainty flags for non-blocking human interaction (P1-G1). */
  private sessionUncertaintyFlags: Map<string, UncertaintyFlag[]> = new Map();
  /** Guard against concurrent analyze() calls for the same session. */
  private activeAnalyses: Set<string> = new Set();
  /** In-flight SDK subprocess handles keyed by SmartPerfetto session. */
  private readonly activeAbortHandles: Map<string, Set<RuntimeAbortHandle>> = new Map();
  private readonly executionGuard = new RuntimeExecutionGuard();
  private readonly runtimeSelection: RuntimeSelection;
  private readonly runtimeCapabilities: EngineCapabilities;

  constructor(
    traceProcessorService: TraceProcessorService,
    config?: Partial<ClaudeAgentConfig>,
    runtimeSelection: RuntimeSelection = { kind: 'claude-agent-sdk', source: 'default' },
  ) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.config = loadClaudeConfig(config);
    this.runtimeSelection = runtimeSelection;
    this.runtimeCapabilities = getProductionEngineCapabilities(runtimeSelection.kind);
    this.sessionMap = loadSessionMapForCurrentMode();
  }

  /** Restore a previously persisted SDK session mapping (e.g., after server restart). */
  restoreSessionMapping(smartPerfettoSessionId: string, sdkSessionId: string, referenceTraceId?: string): void {
    this.sessionMap.set(
      this.buildSessionMapKey(smartPerfettoSessionId, referenceTraceId),
      { sdkSessionId, updatedAt: Date.now(), mode: 'full' },
    );
  }

  /** Restore a cached architecture detection result (e.g., from session persistence). */
  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  /** Get cached architecture for a traceId (used for persistence). */
  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
  }

  /** Get SDK session ID for persistence. */
  getSdkSessionId(smartPerfettoSessionId: string, referenceTraceId?: string): string | undefined {
    const entry = this.sessionMap.get(this.buildSessionMapKey(smartPerfettoSessionId, referenceTraceId));
    return isFreshFullSdkSessionEntry(entry) ? entry.sdkSessionId : undefined;
  }

  private buildSessionMapKey(sessionId: string, referenceTraceId?: string): string {
    return buildRuntimeSessionMapKey(sessionId, referenceTraceId);
  }

  private persistSessionMapEntry(
    sessionId: string,
    traceId: string,
    sessionMapKey: string,
    entry: ClaudeSessionMapRuntimeEntry,
    options: AnalysisOptions,
  ): void {
    if (legacySessionMapWritesEnabled()) {
      savePersistedSessionMap(this.sessionMap);
    }

    if (!enterpriseSessionMapDbWritesEnabled()) return;

    if (!options.tenantId || !options.workspaceId) {
      console.warn('[ClaudeRuntime] Enterprise session map persistence skipped: missing tenant/workspace scope');
      return;
    }

    try {
      saveClaudeSessionMapToRuntimeSnapshots({
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        userId: options.userId,
        sessionId,
        runId: options.runId,
        traceId,
      }, sessionMapKey, entry);
    } catch (err) {
      console.warn('[ClaudeRuntime] Failed to persist session map to runtime_snapshots:', diagnosticLogIdentity((err as Error).message));
    }
  }

  private rememberFullSdkSessionMapping(
    sessionId: string,
    traceId: string,
    sessionMapKey: string,
    sdkSessionId: string,
    options: AnalysisOptions,
  ): void {
    const entry = { sdkSessionId, updatedAt: Date.now(), mode: 'full' as const };
    this.sessionMap.set(sessionMapKey, entry);
    this.persistSessionMapEntry(sessionId, traceId, sessionMapKey, entry, options);
  }

  private forgetSdkSessionMapping(
    sessionId: string,
    sessionMapKey: string,
    reason: string,
    options: AnalysisOptions = {},
  ): void {
    const removed = this.sessionMap.delete(sessionMapKey);
    if (legacySessionMapWritesEnabled()) {
      savePersistedSessionMapSync(this.sessionMap);
    }

    if (enterpriseSessionMapDbWritesEnabled()) {
      try {
        deleteClaudeSessionMapRuntimeSnapshot(sessionId, sessionMapKey, providerScopeFromAnalysisOptions(options));
      } catch (err) {
        console.warn('[ClaudeRuntime] Failed to delete stale SDK session map from runtime_snapshots:', diagnosticLogIdentity((err as Error).message));
      }
    }

    console.warn(
      `[ClaudeRuntime] Discarded stale SDK session mapping for ${sessionMapKey}` +
      `${removed ? '' : ' (not present in memory)'}: ${reason}`,
    );
  }

  private async retryWithoutSdkResume(params: {
    query: string;
    sessionId: string;
    traceId: string;
    options: AnalysisOptions;
    sessionMapKey: string;
    errorMessage: string;
    mode: 'full' | 'fast';
    outputLanguage: import('../../../agentv3/outputLanguage').OutputLanguage;
  }): Promise<void> {
    this.forgetSdkSessionMapping(params.sessionId, params.sessionMapKey, params.errorMessage, params.options);
    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'claudeRuntime',
        fallback: 'fresh_sdk_session_after_missing_conversation',
        error: 'missing_sdk_conversation',
        mode: params.mode,
        message: localize(
          params.outputLanguage,
          'Claude 远端对话已不可用，已清理旧会话并使用本地持久化上下文重新发起分析...',
          'Claude remote conversation is no longer available. Retrying with persisted local context in a fresh SDK session...',
        ),
      },
      timestamp: Date.now(),
    });
  }

  private removeSessionMapEntries(sessionId: string): void {
    const referencePrefix = `${sessionId}:ref:`;
    for (const key of [...this.sessionMap.keys()]) {
      if (key === sessionId || key.startsWith(referencePrefix)) {
        this.sessionMap.delete(key);
      }
    }
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    options = {
      ...options,
      analysisMode: resolveEffectiveAnalysisMode(options.analysisMode, options),
    };
    const executionLease = this.executionGuard.begin({
      runtime: CLAUDE_AGENT_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(
      options.runManifestAttributionSink,
    );
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';

    const startTime = Date.now();
    const allFindings: Finding[][] = [];
    let conclusionText = '';
    let sdkSessionId: string | undefined;
    let rounds = 0;
    let delegatedRetry = false;
    let outputLanguage = options.outputLanguage ?? this.config.outputLanguage;
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;
    const metricsCollector = new AgentMetricsCollector(sessionId);
    let interruptionRecoveryState: {
      streamStarted: boolean;
      getAccumulatedAnswer: () => string;
      flushPendingAnswer: () => void;
      dispose: () => void;
      getPlan: () => AnalysisPlanV3 | null;
    } | undefined;

    try {
      executionLease.throwIfAborted();
      // Phase 0: Complexity classification — runs in parallel with early context prep
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() || [];
      const sceneType = classifyScene(query);
      // Freeze the strategy version for the duration of this analyze() call so
      // a hot-reload mid-flight can't split-brain the agent's reasoning.
      runSnapshots.capture(sessionId, sceneType);

      const classifierInput: ComplexityClassifierInput = buildComplexityClassifierInput({
        query,
        sceneType,
        selectionContext: options.selectionContext,
        hasReferenceTrace: !!options.referenceTraceId,
        previousTurns,
      });

      const cachedArch = getLruCacheEntry(this.architectureCache, traceId);

      const explicitMode = options.analysisMode;
      const providerScope = providerScopeFromAnalysisOptions(options);
      const resolvedRuntimeConfig = resolveRuntimeConfig(this.config, options.providerId, providerScope);
      const runtimeConfig = options.outputLanguage
        ? {...resolvedRuntimeConfig, outputLanguage: options.outputLanguage}
        : resolvedRuntimeConfig;
      outputLanguage = runtimeConfig.outputLanguage;
      const selectionTimeRange = focusAppTimeRangeFromSelection(options.selectionContext);
      const emptyFocusResult = {
        apps: [],
        primaryApp: undefined,
        method: 'none' as const,
        timeRange: selectionTimeRange,
      };
      const conversationSurface = options.assistantSurface === 'conversation';
      let focusPromise: Promise<Awaited<ReturnType<typeof detectFocusApps>>> | undefined;
      const startFocusDetection = () => {
        if (!focusPromise) {
          const focusPhase = runtimePerformance.startPhase('focus');
          focusPromise = detectFocusApps(this.traceProcessorService, traceId, {
            timeRange: selectionTimeRange,
          }).then((result) => {
            focusPhase.end(executionLease.signal.aborted ? 'cancelled' : 'ok');
            return result;
          }).catch((err) => {
            focusPhase.end(runtimeOutcomeFromError(err, executionLease.signal));
            console.warn('[ClaudeRuntime] Focus app detection failed (graceful):', diagnosticLogIdentity((err as Error).message));
            return emptyFocusResult;
          });
        }
        return focusPromise;
      };

      const localClassifierResult = explicitMode === 'full'
        ? null
        : classifyQueryComplexityLocal(classifierInput);
      const localQuickAcknowledgementDirectAnswer = localClassifierResult?.complexity === 'quick'
        && isAcknowledgementFollowupReason(localClassifierResult.reason);
      const localDirectEvidenceEligibleQuickMode = !options.referenceTraceId && (
        explicitMode === 'fast' || localClassifierResult?.complexity === 'quick'
      );
      const localQuickPreEvidenceFlags = deriveRuntimeQuickPreEvidenceFlags({
        query,
        selectionContext: options.selectionContext,
        packageName: options.packageName,
        hasReferenceTrace: !!options.referenceTraceId,
        directEvidenceEligibleQuickMode: localDirectEvidenceEligibleQuickMode,
        complexity: localClassifierResult?.complexity,
        reason: localClassifierResult?.reason,
      });
      const localQuickProcessIdentityPreEvidence = localQuickPreEvidenceFlags.quickProcessIdentityPreEvidence;
      const localQuickTraceFactPreEvidence = localQuickPreEvidenceFlags.quickTraceFactPreEvidence;
      const localCanSkipFocusDetection =
        conversationSurface || localQuickPreEvidenceFlags.skipFocusDetection;
      if (!localCanSkipFocusDetection) {
        if (!localQuickAcknowledgementDirectAnswer) {
          startFocusDetection();
        }
      }

      let queryComplexity: QueryComplexity;
      let classifierSource: 'user_explicit' | 'hard_rule' | 'ai';
      let classifierReason: string;
      let skipQuickTracePreflightDetection = false;
      let quickAcknowledgementDirectAnswer = false;
      let quickFocusAppPreEvidence = false;
      let quickProcessIdentityPreEvidence = false;
      let quickTraceFactPreEvidence = false;
      let quickScrollingTriagePreEvidence = false;
      let quickSkipFocusDetection = false;

      if (explicitMode === 'fast' || explicitMode === 'full') {
        queryComplexity = explicitMode === 'fast' ? 'quick' : 'full';
        classifierSource = 'user_explicit';
        classifierReason = `user requested ${explicitMode}`;
        if (explicitMode === 'fast') {
          quickAcknowledgementDirectAnswer = localQuickAcknowledgementDirectAnswer;
          quickFocusAppPreEvidence = localQuickPreEvidenceFlags.quickFocusAppPreEvidence;
          quickProcessIdentityPreEvidence = localQuickPreEvidenceFlags.quickProcessIdentityPreEvidence;
          quickTraceFactPreEvidence = localQuickPreEvidenceFlags.quickTraceFactPreEvidence;
          quickScrollingTriagePreEvidence = localQuickPreEvidenceFlags.quickScrollingTriagePreEvidence;
          quickSkipFocusDetection = localQuickPreEvidenceFlags.skipFocusDetection;
          skipQuickTracePreflightDetection = localQuickPreEvidenceFlags.skipTracePreflightDetection ||
            quickProcessIdentityPreEvidence || quickTraceFactPreEvidence;
        }
      } else {
        const classifierResult = localClassifierResult
          ?? await classifyQueryComplexity(classifierInput, {
            ...runtimeConfig,
            providerId: options.providerId,
            providerScope,
          });
        queryComplexity = classifierResult.complexity;
        classifierSource = classifierResult.source;
        classifierReason = classifierResult.reason;
        quickAcknowledgementDirectAnswer = queryComplexity === 'quick' &&
          isAcknowledgementFollowupReason(classifierReason);
        const directEvidenceEligibleQuickMode = !options.referenceTraceId && queryComplexity === 'quick';
        const quickPreEvidenceFlags = deriveRuntimeQuickPreEvidenceFlags({
          query,
          selectionContext: options.selectionContext,
          packageName: options.packageName,
          hasReferenceTrace: !!options.referenceTraceId,
          directEvidenceEligibleQuickMode,
          complexity: queryComplexity,
          reason: classifierReason,
        });
        quickFocusAppPreEvidence = quickPreEvidenceFlags.quickFocusAppPreEvidence;
        quickProcessIdentityPreEvidence = quickPreEvidenceFlags.quickProcessIdentityPreEvidence;
        quickTraceFactPreEvidence = quickPreEvidenceFlags.quickTraceFactPreEvidence;
        quickScrollingTriagePreEvidence = quickPreEvidenceFlags.quickScrollingTriagePreEvidence;
        quickSkipFocusDetection = quickPreEvidenceFlags.skipFocusDetection;
        skipQuickTracePreflightDetection = quickPreEvidenceFlags.skipTracePreflightDetection ||
          quickProcessIdentityPreEvidence || quickTraceFactPreEvidence;
      }
      executionLease.throwIfAborted();

      if (conversationSurface) {
        quickAcknowledgementDirectAnswer = false;
        quickFocusAppPreEvidence = false;
        quickProcessIdentityPreEvidence = false;
        quickTraceFactPreEvidence = false;
        quickScrollingTriagePreEvidence = false;
        quickSkipFocusDetection = true;
        skipQuickTracePreflightDetection = true;
      }

      const analysisRunSpec = createAnalysisRunSpec({
        query,
        sessionId,
        traceId,
        options,
        runtimeSelection: this.runtimeSelection,
        sceneType,
        outputLanguage: runtimeConfig.outputLanguage,
        previousTurns,
        resolvedMode: queryComplexity,
        budget: {
          model: runtimeConfig.model,
          lightModel: runtimeConfig.lightModel,
          maxTurns: runtimeConfig.maxTurns,
          maxBudgetUsd: runtimeConfig.maxBudgetUsd,
          fullPathPerTurnMs: runtimeConfig.fullPathPerTurnMs,
          quickPathPerTurnMs: runtimeConfig.quickPathPerTurnMs,
          classifierTimeoutMs: runtimeConfig.classifierTimeoutMs,
          verifierTimeoutMs: runtimeConfig.verifierTimeoutMs,
        },
        adaptiveRouting: buildAdaptiveRoutingForModeDecision({
          options,
          resolvedMode: queryComplexity,
          classifierSource,
          quickAcknowledgementDirectAnswer,
          directEvidenceAvailable: Boolean(
            quickFocusAppPreEvidence
            || quickProcessIdentityPreEvidence
            || quickTraceFactPreEvidence
            || quickScrollingTriagePreEvidence
          ),
        }),
      });

      const displayMode: 'fast' | 'full' | 'auto' = explicitMode ?? 'auto';
      console.log(
        `[ClaudeRuntime] Query complexity: ${queryComplexity} ` +
        `(mode: ${displayMode}, source: ${classifierSource}, reason: ${classifierReason})`,
      );
      metricsCollector.recordAnalysisMode(displayMode, classifierSource);
      runtimePerformance.finishClassification('ok');

      if (queryComplexity === 'quick' && quickAcknowledgementDirectAnswer) {
        executionLease.throwIfAborted();
        const sdkEnv = createSdkEnv(options.providerId, providerScope);
        const quickConfig = createQuickConfig(runtimeConfig, sdkEnv);
        const quickBudget = resolveQuickTurnBudget({
          env: sdkEnv,
          hardCapTurns: quickConfig.maxTurns,
          targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS', 'CLAUDE_QUICK_TARGET_TURNS'],
          hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS', 'CLAUDE_QUICK_MAX_TURNS'],
          enforcement: 'turn_cap',
        });
        const quickResult = buildQuickDirectAcknowledgementAnalysisResult({
          sessionId,
          options,
          outputLanguage: runtimeConfig.outputLanguage,
          startedAt: startTime,
          analysisRunSpec,
          budget: quickBudget,
          previousTurns,
        });
        emitQuickDirectQualityGateIssue({
          emitUpdate: update => this.emitUpdate(update),
          module: 'claudeRuntime',
          result: quickResult,
          query,
          sceneType,
        });
        sessionContext.addTurn(
          query,
          {
            primaryGoal: query,
            aspects: [],
            expectedOutputType: 'summary',
            complexity: 'simple',
            followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
          },
          {
            agentId: 'claude-agent',
            success: quickResult.success,
            findings: quickResult.findings,
            confidence: quickResult.confidence,
            message: quickResult.conclusion,
          },
          quickResult.findings,
        );
        runtimePerformance.recordFirstOutput();
        emitQuickDirectAnswerEvents({
          emitUpdate: update => this.emitUpdate(update),
          result: quickResult,
          startedAt: startTime,
          outputLanguage: runtimeConfig.outputLanguage,
          runtime: 'claude-agent-sdk',
          model: 'runtime-acknowledgement',
        });
        console.log(`[ClaudeRuntime] Quick acknowledgement direct answer completed: 0 rounds, ${Date.now() - startTime}ms, ${quickResult.conclusion.length} chars`);
        return quickResult;
      }

      const skipFocusDetection = quickSkipFocusDetection;
      const focusResult = skipFocusDetection
        ? emptyFocusResult
        : await startFocusDetection();
      executionLease.throwIfAborted();

      // Quick path: lightweight analysis for simple factual queries
      if (queryComplexity === 'quick') {
        return await this.analyzeQuick(query, sessionId, traceId, options, {
          sceneType,
          focusResult,
          cachedArch,
          sessionContext,
          previousTurns,
          metricsCollector,
          startTime,
          analysisRunSpec,
          skipQuickTracePreflightDetection,
          priorEvidenceOnlyFollowup:
            classifierReason === PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON,
          quickFocusAppPreEvidence,
          quickProcessIdentityPreEvidence,
          quickTraceFactPreEvidence,
          quickScrollingTriagePreEvidence,
          outputLanguage,
          executionLease,
          runtimePerformance,
        });
      }

      // Full path: original comprehensive analysis pipeline
      const ctx = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        focusResult,
        sessionContext,
        previousTurns,
        sceneType,
        runtimeConfig,
        analysisRunSpec,
        executionLease,
        runtimePerformance,
      });
      sourceUse = ctx.sourceUse;
      executionLease.throwIfAborted();

      const {
        handleMessage: bridge,
        getAccumulatedAnswer,
        flushPendingAnswer,
        dispose: disposeBridge,
      } = createSseBridge((update: StreamingUpdate) => {
        const normalizedUpdate = normalizeClaudeBridgeConclusionUpdate(
          update,
          ctx.sceneType,
          runtimeConfig.outputLanguage,
        );
        if (normalizedUpdate.type === 'answer_token' || normalizedUpdate.type === 'thought') {
          runtimePerformance.recordFirstOutput();
        }
        this.emitUpdate(normalizedUpdate);
        if (normalizedUpdate.type === 'agent_response' && normalizedUpdate.content?.result) {
          try {
            const parsed = typeof normalizedUpdate.content.result === 'string'
              ? JSON.parse(normalizedUpdate.content.result)
              : normalizedUpdate.content.result;
            if (parsed?.success && parsed?.skillId) {
              allFindings.push(extractFindingsFromSkillResult(parsed));
            }
            if (parsed?.success && parsed?.displayResults) {
              this.captureEntitiesFromSkillDisplayResults(parsed.displayResults, ctx.entityStore);
            }
          } catch {
            // Not a skill result — ignore
          }
        }
      }, outputLanguage, {
        tracePairContext: ctx.analysisContextForRebuild.comparison?.tracePairContext,
      }, ((options.codeAwareMode && options.codeAwareMode !== 'off') || options.knowledgeSourceIds?.length)
        ? createCodeAwareStreamingTextProjection(sessionId, 'claude-full-answer')
        : undefined);
      interruptionRecoveryState = {
        streamStarted: false,
        getAccumulatedAnswer,
        flushPendingAnswer,
        dispose: disposeBridge,
        getPlan: () => ctx.analysisPlan.current,
      };

      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            outputLanguage,
            `使用 ${runtimeConfig.model} 开始分析 (effort: ${ctx.effectiveEffort})...`,
            `Starting analysis with ${runtimeConfig.model} (effort: ${ctx.effectiveEffort})...`,
          ),
        },
        timestamp: Date.now(),
      });

      // Reuse composite key from prepareAnalysisContext for comparison mode session identity isolation
      const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
      let existingSessionMapEntry = privateAnalysisContext
        ? undefined
        : this.sessionMap.get(ctx.sessionMapKey);
      let existingSdkSessionId = isFreshFullSdkSessionEntry(existingSessionMapEntry)
        ? existingSessionMapEntry.sdkSessionId
        : undefined;
      let missingSdkConversationError: string | undefined;
      let finalResult: string | undefined;
      let terminationReason: AnalysisResult['terminationReason'];
      let terminationMessage: string | undefined;
      let sdkStreamErrorMessage: string | undefined;
      let timedOut = false;
      const timeoutState: {kind: RuntimeTimeoutKind} = {kind: 'request'};
      const isStreamIdleTimeout = () => (timeoutState.kind as RuntimeTimeoutKind) === 'stream_idle';
      const sdkEnv = createSdkEnv(options.providerId, analysisRunSpec.scopes.provider);
      const failedApproaches: FailedApproach[] = [];
      let sdkCompactDetected = false;
      const sdkRuntimeReceiptState: SdkQueryRuntimeReceiptState = {sdkStartRecorded: false};
      for (;;) {
        executionLease.throwIfAborted();
        missingSdkConversationError = undefined;
        sdkStreamErrorMessage = undefined;
        finalResult = undefined;
        terminationReason = undefined;
        terminationMessage = undefined;
        timedOut = false;
        timeoutState.kind = 'request';
        if (existingSessionMapEntry && existingSdkSessionId && enterpriseSessionMapDbWritesEnabled()) {
          this.persistSessionMapEntry(sessionId, traceId, ctx.sessionMapKey, existingSessionMapEntry, options);
        }

        // When resuming an SDK session, systemPrompt is ignored by the SDK (mutually exclusive).
        // Prepend selectionContext directly into the prompt so the AI sees it in the conversation.
        let effectivePrompt = query;
        if (privateAnalysisContext) {
          const localConversationContext = buildQuickConversationContext(
            ctx.previousTurns,
            outputLanguage,
          );
          if (localConversationContext) {
            effectivePrompt = `${localConversationContext}\n\n${effectivePrompt}`;
          }
        }
        if (existingSdkSessionId && options.selectionContext) {
          const selSection = buildSelectionContextSection(options.selectionContext);
          if (selSection) {
            effectivePrompt = `${selSection}\n\n${query}`;
          }
        }
        // Prepend pre-queried trace data so the AI has all context without spending turns on SQL
        if (ctx.analysisRunSpec?.traceContext.promptSection) {
          const traceSection = ctx.analysisRunSpec.traceContext.promptSection;
          effectivePrompt = `${traceSection}\n\n${effectivePrompt}`;
        }

        executionLease.throwIfAborted();
        const { stream, close: closeSdk } = sdkQueryWithRetry({
            prompt: effectivePrompt,
            options: {
              model: runtimeConfig.model,
              maxTurns: runtimeConfig.maxTurns,
              systemPrompt: ctx.sdkSystemPrompt,
              mcpServers: { smartperfetto: ctx.mcpServer },
              includePartialMessages: true,
              settingSources: [],
              ...buildClaudeSdkToolOptions(ctx.allowedTools, ctx.agents),
              ...resolveClaudeSdkPermissionOptions(),
              cwd: runtimeConfig.cwd,
              effort: ctx.effectiveEffort,
              env: sdkEnv,
              persistSession: !privateAnalysisContext,
              stderr: (data: string) => {
                console.warn(
                  `[ClaudeRuntime] SDK stderr [${sessionId}]: ${diagnosticLogIdentity(data.trimEnd())}`,
                );
              },
              ...(runtimeConfig.maxBudgetUsd ? { maxBudgetUsd: runtimeConfig.maxBudgetUsd } : {}),
              ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
              ...(ctx.agents ? { agents: ctx.agents } : {}),
            },
        }, {
            emitUpdate: (update) => this.emitUpdate(update),
            outputLanguage: outputLanguage,
          runtimePerformance,
          signal: executionLease.signal,
          recordSdkStartPhase: true,
          runtimeReceiptState: sdkRuntimeReceiptState,
        });
      const unregisterSdkAbortHandle = this.registerAbortHandle(sessionId, { abort: closeSdk });

      // Safety timeout with stream cancellation via Promise.race.
      // Per-turn budget is env-configurable (CLAUDE_FULL_PER_TURN_MS, default 60s) so slower
      // LLMs (DeepSeek / Ollama / GLM) have room per turn without false timeouts.
      // Scrolling deep-drill (hypothesis + SQL + knowledge + conclusion) still needs ~6-8 min.
      const timeoutMs = resolveFullRequestTimeoutMs(
        runtimeConfig.fullPathPerTurnMs,
        runtimeConfig.maxTurns || 15,
        runtimeConfig.fullRequestTimeoutMs,
      );
      // Sub-agent timeout tracking — stop tasks that exceed subAgentTimeoutMs
      const activeSubAgentTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
      const subAgentTimeoutMs = runtimeConfig.subAgentTimeoutMs;

      // P2-1: Turn-level autonomy watchdog — detect repetitive tool failures
      // P1-G2: Per-tool tracking — each tool gets its own failure tracking
      const toolCallHistory: Array<{
        id?: string;
        name: string;
        success: boolean;
        /**
         * The call was refused by policy rather than broken. Still a failure
         * for the model to react to, but not evidence that anything is
         * malfunctioning.
         */
        policyRefusal?: boolean;
        completed?: boolean;
        startTime?: number;
        input?: unknown;
      }> = [];
      const MAX_TOOL_CALL_HISTORY = 100;
      const WATCHDOG_WINDOW = 3; // consecutive same-tool failures to trigger warning
      const watchdogFiredTools = new Set<string>(); // tracks which tools have triggered warnings

      // P0-G16: Circuit breaker — overall tool call failure rate monitoring
      let circuitBreakerFires = 0;
      const MAX_CIRCUIT_BREAKER_FIRES = 2;
      const CIRCUIT_BREAKER_WINDOW = 5;
      const CIRCUIT_BREAKER_THRESHOLD = 0.6; // 60% failure rate
      let lastCircuitBreakerFireIdx = -Infinity;

      // P1: Negative memory — collect failed approaches for cross-session learning
      /** Track whether SDK auto-compact has fired during this turn.
       *  When true, the SDK has summarized prior conversation history,
       *  potentially losing early-turn details. We log this for diagnostics. */
      sdkCompactDetected = false;

      // ── Per-turn metrics collection ──
      // Turn boundary: assistant message = start, next assistant message = end of previous turn.
      // Usage is attributed to the turn that triggered the API call.
      interface TurnMetrics {
        turnIndex: number;
        startMs: number;
        durationMs?: number;
        firstTokenLatencyMs?: number;
        toolCalls: string[];
        toolResultPayloadBytes: number;
        hasExtendedThinking: boolean;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
      const turnMetricsList: TurnMetrics[] = [];
      let currentTurnMetrics: TurnMetrics | null = null;
      let turnCounter = 0;
      let firstTokenReceived = false;

      function recordAuthoritativeEvaluationUsage(
        usage: Record<string, unknown> | undefined,
      ): void {
        if (usage) recordEvaluationTokenDeltaIfPresent(usage);
      }

      // Phase 3-3 of v2.1 (monitor-only): track when the running conversation
      // crosses the pre-rot threshold so prod can quantify how often we *would*
      // have benefited from an interrupt+resume cycle. The actual interrupt+
      // resume orchestration is intentionally not wired yet. Disable by setting
      // `CLAUDE_PRECOMPACT_WARN_ENABLED=false`.
      let preCompactWarned = false;
      const preCompactWarnEnabled = process.env.CLAUDE_PRECOMPACT_WARN_ENABLED !== 'false';

      function checkContextPressure(): void {
        if (!preCompactWarnEnabled || preCompactWarned) return;
        const cumulativeUncached = turnMetricsList.reduce((acc, t) => acc + (t.inputTokens ?? 0), 0);
        const cumulativeCacheCreation = turnMetricsList.reduce((acc, t) => acc + (t.cacheCreationTokens ?? 0), 0);
        const cumulativePayloadBytes = turnMetricsList.reduce((acc, t) => acc + t.toolResultPayloadBytes, 0);
        const decision = evaluateContextThreshold({
          uncachedInputTokens: cumulativeUncached,
          cacheCreationInputTokens: cumulativeCacheCreation,
          recentToolPayloadBytes: cumulativePayloadBytes,
        });
        if (decision.shouldPrecompact) {
          preCompactWarned = true;
          console.warn(
            `[ClaudeRuntime] Session ${sessionId}: pre-rot threshold crossed ` +
            `(pressure=${decision.pressureTokens} / ${decision.thresholdTokens} tokens, ratio=${decision.pressureRatio.toFixed(2)}). ` +
            `Phase 3-3 will eventually interrupt+resume here; for now we only log.`,
          );
        }
      }

      function findToolCallForResult(toolUseId?: string): typeof toolCallHistory[number] | undefined {
        if (toolUseId) {
          for (let i = toolCallHistory.length - 1; i >= 0; i--) {
            if (toolCallHistory[i].id === toolUseId) return toolCallHistory[i];
          }
        }
        for (let i = toolCallHistory.length - 1; i >= 0; i--) {
          if (!toolCallHistory[i].completed) return toolCallHistory[i];
        }
        return toolCallHistory[toolCallHistory.length - 1];
      }

      function finalizeTurnMetrics(): void {
        if (currentTurnMetrics) {
          currentTurnMetrics.durationMs = Date.now() - currentTurnMetrics.startMs;
          turnMetricsList.push(currentTurnMetrics);
          checkContextPressure();
        }
      }

      const processStream = async () => {
        for await (const msg of stream) {
          if (timedOut) break; // P0-1: Actually cancel stream on timeout
          providerIdleTimeout.reset();
          if (interruptionRecoveryState) interruptionRecoveryState.streamStarted = true;

          // Detect SDK auto-compact boundary — conversation history was summarized
          if ((msg as any).type === 'system' && (msg as any).subtype === 'compact_boundary') {
            sdkCompactDetected = true;
            console.warn(`[ClaudeRuntime] SDK auto-compact detected for session ${sessionId} — prior turns summarized`);
          }

          if (!privateAnalysisContext && msg.session_id && !sdkSessionId) {
            sdkSessionId = msg.session_id;
            this.rememberFullSdkSessionMapping(sessionId, traceId, ctx.sessionMapKey, sdkSessionId, options);
          }

          const sdkResultError = getSdkResultErrorMessage(msg);
          if (sdkResultError && existingSdkSessionId && isMissingSdkConversationError(sdkResultError)) {
            if (msg.type === 'result') {
              finalizeTurnMetrics();
              currentTurnMetrics = null;
              metricsCollector.recordSdkUsage({
                usage: (msg as any).usage,
                modelUsage: (msg as any).modelUsage,
                total_cost_usd: (msg as any).total_cost_usd,
              });
              recordAuthoritativeEvaluationUsage((msg as any).usage);
            }
            missingSdkConversationError = sdkResultError;
            continue;
          }
          if (sdkResultError && !isSdkMaxTurnsSubtype((msg as any).subtype)) {
            sdkStreamErrorMessage = sdkResultError;
          }

          // Track sub-agent lifecycle for per-agent timeouts
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_started') {
            const taskId = (msg as any).task_id;
            if (taskId && subAgentTimeoutMs > 0) {
              const timer = setTimeout(() => {
                console.warn(`[ClaudeRuntime] Sub-agent timeout: stopping task ${taskId} after ${subAgentTimeoutMs / 1000}s`);
                activeSubAgentTimers.delete(taskId);
                if (typeof (stream as any).stopTask === 'function') {
                  (stream as any).stopTask(taskId).catch((err: Error) => {
                    console.warn(`[ClaudeRuntime] Failed to stop sub-agent task ${taskId}:`, diagnosticLogIdentity(err.message));
                  });
                }
                // P1-6: Record timeout as a finding so it's reflected in confidence
                allFindings.push([{
                  id: `sub-agent-timeout-${taskId}`,
                  title: localize(outputLanguage, '子代理超时', 'Sub-agent timeout'),
                  severity: 'medium' as const,
                  category: 'sub-agent',
                  description: localize(
                    outputLanguage,
                    `子代理 ${taskId} 超时 (${subAgentTimeoutMs / 1000}s)，分析可能不完整`,
                    `Sub-agent ${taskId} timed out (${subAgentTimeoutMs / 1000}s); the analysis may be incomplete`,
                  ),
                  confidence: 0.3,
                }]);
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: localize(
                      outputLanguage,
                      `子代理超时 (${subAgentTimeoutMs / 1000}s)，已停止`,
                      `Sub-agent timed out (${subAgentTimeoutMs / 1000}s) and was stopped`,
                    ),
                  },
                  timestamp: Date.now(),
                });
              }, subAgentTimeoutMs);
              activeSubAgentTimers.set(taskId, timer);
            }
          }
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_notification') {
            const taskId = (msg as any).task_id;
            if (taskId) {
              const timer = activeSubAgentTimers.get(taskId);
              if (timer) {
                clearTimeout(timer);
                activeSubAgentTimers.delete(taskId);
              }
            }
            // P1-5: Extract findings from sub-agent completion summaries.
            // Without this, sub-agent evidence is only in the conclusion text
            // and not merged into allFindings for confidence estimation.
            const summary = (msg as any).summary || '';
            const status = (msg as any).status || 'completed';
            if (status === 'completed' && summary) {
              allFindings.push(extractFindingsFromText(summary));
            }
          }

          // Bridge SDK messages to SSE events
          try {
            bridge(msg);
          } catch (bridgeErr) {
            console.warn('[ClaudeRuntime] SSE bridge error (non-fatal):', diagnosticLogIdentity((bridgeErr as Error).message));
          }

          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            const assistantText = (msg as any).message.content
              .map((block: any) => typeof block?.text === 'string' ? block.text : '')
              .filter(Boolean)
              .join('\n')
              .trim();
            if (assistantText) {
              runtimePerformance.recordFirstOutput();
            }
          }

          // ── Per-turn metrics: track stream_event signals ──
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            // First token latency
            if (!firstTokenReceived &&
                event?.type === 'content_block_delta' &&
                (event.delta?.type === 'text_delta' || event.delta?.type === 'tool_use')) {
              firstTokenReceived = true;
              currentTurnMetrics.firstTokenLatencyMs = Date.now() - currentTurnMetrics.startMs;
            }
            // Extended thinking detection
            if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
              currentTurnMetrics.hasExtendedThinking = true;
            }
          }

          // assistant message = new turn starts; finalize previous turn + watchdog tracking
          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            finalizeTurnMetrics();
            turnCounter++;
            firstTokenReceived = false;
            const toolNames: string[] = [];
            for (const block of (msg as any).message.content) {
              if (block.type === 'tool_use') {
                toolNames.push(block.name.replace(MCP_NAME_PREFIX, ''));
                // P2-1: Watchdog — track tool calls for repetitive failure detection
                toolCallHistory.push({
                  id: block.id,
                  name: block.name,
                  success: true,
                  startTime: Date.now(),
                  input: block.input,
                });
                if (toolCallHistory.length > MAX_TOOL_CALL_HISTORY) {
                  toolCallHistory.shift();
                  if (Number.isFinite(lastCircuitBreakerFireIdx)) {
                    lastCircuitBreakerFireIdx--;
                  }
                }
              }
            }
            currentTurnMetrics = {
              turnIndex: turnCounter,
              startMs: Date.now(),
              toolCalls: toolNames,
              toolResultPayloadBytes: 0,
              hasExtendedThinking: false,
            };
          }

          if (msg.type === 'user' && (msg as any).tool_use_result !== undefined) {
            const resultBlocks = extractSdkToolResultBlocks(msg);
            const observedResults = resultBlocks.length > 0
              ? resultBlocks
              : [{ result: (msg as any).tool_use_result, isError: undefined, toolUseId: undefined }];

            for (const observed of observedResults) {
              const resultStr = stringifySdkToolResult(observed.result);
              // Per-turn metrics: track tool result payload size
              if (currentTurnMetrics) {
                currentTurnMetrics.toolResultPayloadBytes += Buffer.byteLength(resultStr, 'utf-8');
              }
              const isFailed = isSdkToolResultFailure(observed.result, observed.isError);
              const refusedByPolicy = isFailed && isPolicyRefusalResult(observed.result);
              const matchedTool = findToolCallForResult(observed.toolUseId);
              if (matchedTool) {
                matchedTool.success = !isFailed;
                matchedTool.policyRefusal = refusedByPolicy;
                matchedTool.completed = true;
                // Record tool execution in metrics collector (stream-observed timing)
                const toolName = matchedTool.name.replace(MCP_NAME_PREFIX, '');
                const durationMs = matchedTool.startTime ? Date.now() - matchedTool.startTime : 0;
                metricsCollector.recordToolFromStream(toolName, durationMs, !isFailed);
              }
              // Check for consecutive same-tool failures (P1-G2: per-tool tracking)
              if (toolCallHistory.length >= WATCHDOG_WINDOW) {
                const recent = toolCallHistory.slice(-WATCHDOG_WINDOW);
                const allSameTool = recent.every(t => t.name === recent[0].name);
                const allFailed = recent.every(t => !t.success);
                const toolName = recent[0].name.replace(MCP_NAME_PREFIX, '');
                if (allSameTool && allFailed && !watchdogFiredTools.has(toolName)) {
                  watchdogFiredTools.add(toolName);
                  console.warn(`[ClaudeRuntime] Watchdog: ${WATCHDOG_WINDOW} consecutive failures for ${toolName}`);
                  // P1-2: Inject warning into next MCP tool result (Claude reads this)
                  ctx.watchdogWarning.current = localize(
                    outputLanguage,
                    `${toolName} 已连续失败 ${WATCHDOG_WINDOW} 次。请切换分析策略：尝试不同的 SQL 查询、使用其他 skill、或调整参数。不要重复相同的失败操作。`,
                    `${toolName} has failed ${WATCHDOG_WINDOW} times in a row. Switch analysis strategy: try a different SQL query, use another skill, or adjust parameters. Do not repeat the same failed action.`,
                  );
                  // P1: Record for negative memory
                  failedApproaches.push({
                    type: 'tool_failure',
                    approach: `连续调用 ${toolName} ${WATCHDOG_WINDOW} 次均失败`,
                    reason: '同一工具重复失败，需要切换策略',
                  });
                  this.emitUpdate({
                    type: 'progress',
                    content: {
                      phase: 'analyzing',
                      message: localize(
                        outputLanguage,
                        `⚠ 检测到 ${toolName} 连续 ${WATCHDOG_WINDOW} 次失败，已注入策略切换指令`,
                        `⚠ Detected ${WATCHDOG_WINDOW} consecutive failures for ${toolName}; injected a strategy-switch instruction`,
                      ),
                    },
                    timestamp: Date.now(),
                  });
                }
              }
              // Track tool call for plan adherence with phase matching (P0-1 + P1-1)
              // P1-G5: Best-fit phase-tool matching — search all eligible phases, not just first
              if (matchedTool) {
                const codeReferences = extractSourceLookupCodeReferences(
                  matchedTool.name,
                  observed.result,
                );
                recordPlanOrPrePlanToolCall(ctx.analysisPlan, {
                  toolName: matchedTool.name,
                  input: matchedTool.input,
                  returnedCodeReferences: codeReferences.length > 0,
                  returnedCodeReferenceHints: codeReferences,
                  // Read before truncation: planPhaseId and success sit after
                  // the body, so the projected/truncated text loses both.
                  resultFacts: readToolResultFacts(observed.result),
                  resultText: projectClaudeToolResultForPlan(matchedTool.name, observed.result),
                });
              }

              // P0-G16: Circuit breaker — overall failure rate monitoring
              // Unlike watchdog (same-tool consecutive failures), this monitors aggregate health.
              // Fires when >60% of recent tool calls fail, regardless of which tools.
              // P1-G9: Circuit breaker can fire even with pending watchdog warning
              // (CB is higher priority — its "simplify scope" message overwrites per-tool warnings)
              if (circuitBreakerFires < MAX_CIRCUIT_BREAKER_FIRES
                  && toolCallHistory.length >= CIRCUIT_BREAKER_WINDOW
                  && toolCallHistory.length - lastCircuitBreakerFireIdx >= 3) {
                const recentWindow = toolCallHistory.slice(-CIRCUIT_BREAKER_WINDOW);
                // Policy refusals are excluded: this breaker asks "is anything
                // broken", and its remedy is to tell the model to simplify its
                // scope. Counting the system's own refusals here shrank the
                // model's room on the strength of decisions the system made.
                // The watchdog still sees them, because repeatedly retrying a
                // refused call is a loop worth interrupting.
                const recentWindow2 = recentWindow.filter(t => t.policyRefusal !== true);
                const failCount = recentWindow2.filter(t => !t.success).length;
                const failRate = recentWindow2.length > 0
                  ? failCount / recentWindow2.length
                  : 0;
                if (failRate >= CIRCUIT_BREAKER_THRESHOLD) {
                  circuitBreakerFires++;
                  lastCircuitBreakerFireIdx = toolCallHistory.length;
                  ctx.watchdogWarning.current = localize(
                    outputLanguage,
                    `⚠️ 分析断路器触发：最近 ${CIRCUIT_BREAKER_WINDOW} 次工具调用中 ${failCount} 次失败 (${(failRate * 100).toFixed(0)}%)。` +
                      '请：1) 简化分析范围，2) 使用更基础的查询，3) 如果数据不可用则基于已有证据出结论。不要继续尝试失败的操作。',
                    `⚠️ Analysis circuit breaker triggered: ${failCount} of the last ${CIRCUIT_BREAKER_WINDOW} tool calls failed (${(failRate * 100).toFixed(0)}%). ` +
                      'Simplify the scope, use more basic queries, and conclude from existing evidence if data is unavailable. Do not keep retrying failed actions.',
                  );
                  failedApproaches.push({
                    type: 'strategy_failure',
                    approach: `整体工具调用失败率过高 (${(failRate * 100).toFixed(0)}%)`,
                    reason: `最近 ${CIRCUIT_BREAKER_WINDOW} 次调用中 ${failCount} 次失败`,
                  });
                  this.emitUpdate({
                    type: 'progress',
                    content: {
                      phase: 'analyzing',
                      message: localize(
                        outputLanguage,
                        `⚠ 分析断路器触发：工具调用失败率 ${(failRate * 100).toFixed(0)}%，建议简化分析范围`,
                        `⚠ Analysis circuit breaker triggered: tool failure rate ${(failRate * 100).toFixed(0)}%; simplify the analysis scope`,
                      ),
                    },
                    timestamp: Date.now(),
                  });
                }
              }
            }
          }

          // Per-turn metrics: capture usage from stream_event message_delta (per API turn)
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            if (event?.type === 'message_delta' && event.usage) {
              currentTurnMetrics.outputTokens = event.usage.output_tokens;
            }
            if (event?.type === 'message_start' && event.message?.usage) {
              currentTurnMetrics.inputTokens = event.message.usage.input_tokens;
              currentTurnMetrics.cacheReadTokens = event.message.usage.cache_read_input_tokens;
              currentTurnMetrics.cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
            }
          }

          if (msg.type === 'result') {
            // Finalize last turn metrics before stream ends
            finalizeTurnMetrics();
            currentTurnMetrics = null;

            rounds = (msg as any).num_turns || rounds;
            const resultSubtype = (msg as any).subtype;
            if (resultSubtype === 'success') {
              finalResult = (msg as any).result;
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              terminationReason = MAX_TURNS_TERMINATION_REASON;
              terminationMessage = buildMaxTurnsTerminationMessage({
                mode: 'full',
                turns: rounds,
                maxTurns: runtimeConfig.maxTurns,
                outputLanguage: runtimeConfig.outputLanguage,
              });
            }
            // Record SDK token usage and prompt cache metrics
            metricsCollector.recordSdkUsage({
              usage: (msg as any).usage,
              modelUsage: (msg as any).modelUsage,
              total_cost_usd: (msg as any).total_cost_usd,
            });
            recordAuthoritativeEvaluationUsage((msg as any).usage);
          }
        }
        // Clean up any remaining sub-agent timers
        for (const timer of activeSubAgentTimers.values()) clearTimeout(timer);
        activeSubAgentTimers.clear();

        // Log per-turn metrics for performance analysis
        if (turnMetricsList.length > 0) {
          const summary = {
            totalTurns: turnMetricsList.length,
            totalDurationMs: turnMetricsList.reduce((s, t) => s + (t.durationMs || 0), 0),
            totalToolCalls: turnMetricsList.reduce((s, t) => s + t.toolCalls.length, 0),
            totalPayloadBytes: turnMetricsList.reduce((s, t) => s + t.toolResultPayloadBytes, 0),
            turns: turnMetricsList.map(t => ({
              turn: t.turnIndex,
              durationMs: t.durationMs,
              firstTokenMs: t.firstTokenLatencyMs,
              tools: t.toolCalls,
              payloadBytes: t.toolResultPayloadBytes,
              thinking: t.hasExtendedThinking,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              cacheReadTokens: t.cacheReadTokens,
              cacheCreationTokens: t.cacheCreationTokens,
            })),
          };
          console.log(`[ClaudeRuntime] Turn metrics [${sessionId}]:`, JSON.stringify(summary));
          metricsCollector.recordTurnMetrics(summary);
        }
      };

      let safetyTimer: ReturnType<typeof setTimeout> | undefined;
      const providerIdleTimeout = createResettableRuntimeTimeout({
        timeoutMs: runtimeConfig.streamIdleTimeoutMs,
        message: `Claude provider stream idle timeout after ${runtimeConfig.streamIdleTimeoutMs}ms`,
        onTimeout: () => {
          timedOut = true;
          timeoutState.kind = 'stream_idle';
          closeSdk();
        },
      });
      const timeoutPromise = new Promise<void>((_, reject) => {
        safetyTimer = setTimeout(() => {
          timedOut = true;
          timeoutState.kind = 'request';
          // Forcefully terminate the SDK subprocess — without this, queued
          // MCP tool calls (e.g. execute_sql) keep executing in the background
          // after the session logger has closed, producing orphan SQL errors.
          closeSdk();
          reject(new Error(`Analysis safety timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      try {
        await Promise.race([processStream(), timeoutPromise, providerIdleTimeout.promise]);
      } catch (err) {
        if (timedOut) {
          console.error('[ClaudeRuntime] Analysis safety timeout reached — SDK subprocess has been closed');
          this.emitUpdate({
            type: 'progress',
            content: {
              phase: 'concluding',
              message: localize(
                outputLanguage,
                '分析超时，正在生成已有结果的结论...',
                'Analysis timed out. Generating a conclusion from the evidence collected so far...',
              ),
            },
            timestamp: Date.now(),
          });
        } else if (existingSdkSessionId && isMissingSdkConversationError((err as Error).message || '')) {
          missingSdkConversationError = (err as Error).message || 'No conversation found with SDK session';
        } else {
          throw err;
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
        providerIdleTimeout.clear();
        closeSdk();
        unregisterSdkAbortHandle();
      }

      if (timedOut) {
        terminationReason = 'timeout';
        terminationMessage = isStreamIdleTimeout()
          ? localize(
            outputLanguage,
            `AI provider 连续 ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} 秒没有流事件，已取消并保留部分结果。`,
            `The AI provider emitted no stream events for ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} seconds; the run was cancelled and partial results were preserved.`,
          )
          : localize(
            outputLanguage,
            `完整分析超过 ${Math.round(timeoutMs / 1000)} 秒硬上限，已取消并保留部分结果。`,
            `Full analysis exceeded the ${Math.round(timeoutMs / 1000)} second hard limit; the run was cancelled and partial results were preserved.`,
          );
        flushPendingAnswer();
      }

      if (!timedOut && missingSdkConversationError && existingSdkSessionId) {
        await this.retryWithoutSdkResume({
          query,
          sessionId,
          traceId,
          options,
          sessionMapKey: ctx.sessionMapKey,
          errorMessage: missingSdkConversationError,
          mode: 'full',
          outputLanguage,
        });
        existingSessionMapEntry = privateAnalysisContext
          ? undefined
          : this.sessionMap.get(ctx.sessionMapKey);
        existingSdkSessionId = undefined;
        sdkSessionId = undefined;
        continue;
      }
      if (sdkStreamErrorMessage && !timedOut) {
        throw new Error(sdkStreamErrorMessage);
      }
      break;
      }

      executionLease.throwIfAborted();
      // Prefer a deliverable streamed report over a short SDK terminal summary.
      // Some compatible providers put the full report in answer_token chunks but
      // return only a terse summary in the terminal result.
      const accumulatedAnswerBeforeVerification = getAccumulatedAnswer();
      const terminalResult = finalResult as string | undefined;
      conclusionText = chooseClaudeConclusionText({
        finalResult: terminalResult || '',
        accumulatedAnswer: accumulatedAnswerBeforeVerification,
      });
      // Detect before a report heading is added: the heading would make this
      // text look like a deliverable conclusion to the detector, and to every
      // gate downstream of it.
      const providerErrorConclusion = looksLikeProviderErrorConclusion(conclusionText);
      if (providerErrorConclusion) {
        console.warn(
          `[ClaudeRuntime] Session ${sessionId}: the provider returned an error instead of an ` +
          'analysis; skipping conclusion-phase completion, verification and correction.',
        );
      }
      conclusionText = ensureClaudeFinalReportHeading(
        conclusionText,
        ctx.sceneType,
        runtimeConfig.outputLanguage,
      );
      if (!finalResult && conclusionText) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: SDK result was empty, recovered ${conclusionText.length} chars from streamed answer tokens`);
      } else if (
        terminalResult &&
        conclusionText === sanitizeClaudeConclusionText(accumulatedAnswerBeforeVerification) &&
        conclusionText !== sanitizeClaudeConclusionText(terminalResult)
      ) {
        console.warn(
          `[ClaudeRuntime] Session ${sessionId}: SDK result was a short terminal summary ` +
          `(${terminalResult.length} chars), using streamed report (${conclusionText.length} chars) before verification`,
        );
      }
      allFindings.push(extractFindingsFromText(conclusionText));
      let mergedFindings = mergeFindings(allFindings);

      if (conclusionText.trim() && !providerErrorConclusion && ctx.analysisPlan.current) {
        const plan = ctx.analysisPlan.current;
        const conclusionPhase = plan.phases.find(p =>
          p.status === 'pending' &&
          p.expectedTools.length === 0 &&
          /结论|conclusion|报告|report|总结/.test(`${p.name} ${p.goal}`),
        );
        if (conclusionPhase) {
          const summary = localize(
            outputLanguage,
            `自动完成阶段：模型已生成最终结论（${conclusionText.length} 字符）。`,
            `Auto-completed phase: the model produced the final conclusion (${conclusionText.length} chars).`,
          );
          conclusionPhase.status = 'completed';
          conclusionPhase.completedAt = Date.now();
          conclusionPhase.summary = summary;
          this.emitUpdate({
            type: 'plan_phase_updated',
            content: planPhaseUpdatedContent({ phaseId: conclusionPhase.id, status: 'completed', summary, phaseName: conclusionPhase.name, origin: 'auto' }),
            timestamp: Date.now(),
          });
        }
      }

      // Log compaction for diagnostics — helps debug cases where Claude seems to lose context
      if (sdkCompactDetected) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: analysis completed after SDK auto-compact. Findings count: ${mergedFindings.length}`);
        // P1-C1: Write a structured compact recovery note so the next turn's system prompt
        // carries plan progress + findings + entity context that may have been lost.
        // Phase 3-2: also preserves the last N raw tool calls as structured digests
        // so the post-compact agent knows what it was just doing.
        const sessionNotes = this.sessionNotes.get(sessionId);
        if (sessionNotes) {
          const note = buildRecoveryNote({
            plan: ctx.analysisPlan.current ?? undefined,
            findings: mergedFindings,
            recentToolCalls: ctx.analysisPlan.current?.toolCallLog ?? [],
            entitySnapshot: this.buildEntityContext(ctx.entityStore),
          });

          sessionNotes.push({
            section: 'next_step',
            content: note.text,
            priority: 'high',
            timestamp: Date.now(),
          });
          if (sessionNotes.length > 20) sessionNotes.shift();

          console.log(`[ClaudeRuntime] Compact recovery note: ${note.sectionsIncluded.length} sections, ${note.usedChars} chars (${note.sectionsIncluded.join('/')})`);
        }
      }

      // Verification + reflection-driven retry (P0-2 + P2-2)
      // Default ON. Up to 2 correction retries, but second only if new/different errors.
      // Run unconditionally when enabled — plan adherence, hypothesis resolution,
      // and conclusion-length checks must fire even when zero findings are extracted.
      console.log(`[ClaudeRuntime] Pre-verification: conclusionText=${conclusionText.length} chars, sdkSessionId=${sdkSessionId ? 'set' : 'MISSING'}, enableVerification=${runtimeConfig.enableVerification}`);
      let verificationDegradedMessage: string | undefined;
      if (!timedOut && !providerErrorConclusion && (runtimeConfig.enableVerification || privateAnalysisContext)) {
        const MAX_CORRECTION_ATTEMPTS = 2;
        let previousErrorSignatures = new Set<string>();

        try {
          for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt++) {
            conclusionText = completeFinalReportCodeReferences({
              plan: ctx.analysisPlan.current,
              conclusion: conclusionText,
              outputLanguage,
            });
            mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
            const reportIsAlreadyDeliverable = correctionResultLooksUsable(conclusionText);
            executionLease.throwIfAborted();
            const verificationPhase = runtimePerformance.startPhase('verification');
            let verification: Awaited<ReturnType<typeof verifyConclusion>>;
            try {
              verification = await verifyConclusion(mergedFindings, conclusionText, {
              emitUpdate: (update) => this.emitUpdate(update),
              enableLLM: !reportIsAlreadyDeliverable,
              plan: ctx.analysisPlan.current,
              hypotheses: ctx.hypotheses,
              sceneType: ctx.sceneType,
              lightModel: runtimeConfig.lightModel,
              verifierTimeoutMs: runtimeConfig.verifierTimeoutMs,
              providerId: options.providerId,
              providerScope,
              outputLanguage: outputLanguage,
              query,
              emitIssueProgress: !reportIsAlreadyDeliverable,
              allowPersistentLearning: !analysisContextUsesPrivateKnowledge(options),
            });
              verificationPhase.end('ok');
            } catch (error) {
              verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
              throw error;
            }
            executionLease.throwIfAborted();

            const allIssues = [...verification.heuristicIssues, ...(verification.llmIssues || [])];
            const errorIssues = allIssues.filter(i => i.severity === 'error');
            const shouldDeferToFinalGates = errorIssues.length > 0 &&
              shouldSkipSdkCorrectionForDeliverableConclusion(errorIssues, conclusionText);
            const verificationStatus = verification.passed
              ? 'PASSED'
              : shouldDeferToFinalGates
                ? 'NON-BLOCKING ISSUES'
                : 'ISSUES FOUND';
            console.log(`[ClaudeRuntime] Verification (attempt ${attempt + 1}): ${verificationStatus} (${verification.durationMs}ms, ${verification.heuristicIssues.length} heuristic + ${verification.llmIssues?.length || 0} LLM issues)`);

            if (verification.passed) break;
            if (!sdkSessionId) {
              if (privateAnalysisContext && errorIssues.length > 0) {
                verificationDegradedMessage = localize(
                  outputLanguage,
                  `私有源码/知识分析未通过最终验证，且当前 SDK 未提供可隔离的修正会话：${errorIssues[0].message}`,
                  `Private source/knowledge analysis did not pass final verification and the SDK did not provide an isolated correction session: ${errorIssues[0].message}`,
                );
              }
              break;
            }

            if (errorIssues.length === 0) break;
            if (shouldDeferToFinalGates) {
              console.log(
                `[ClaudeRuntime] Verification recorded ${errorIssues.length} non-blocking SDK-correction issue(s); ` +
                'the current conclusion is deliverable and final quality gates remain authoritative.',
              );
              break;
            }

            // P2-2: Check if these are the SAME errors as last attempt — if so, stop retrying
            const currentSignatures = new Set(errorIssues.map(i => `${i.type}:${i.message.substring(0, 60)}`));
            if (attempt > 0) {
              const newErrors = [...currentSignatures].filter(s => !previousErrorSignatures.has(s));
              if (newErrors.length === 0) {
                console.log(`[ClaudeRuntime] Reflection retry: same ${errorIssues.length} errors persist after correction, stopping`);
                // P1: Record persistent verification failures as negative memory
                for (const issue of errorIssues) {
                  failedApproaches.push({
                    type: 'verification_failure',
                    approach: issue.message.substring(0, 150),
                    reason: `验证发现持续性问题 (${issue.type})，修正重试未能解决`,
                  });
                }
                break;
              }
              console.log(`[ClaudeRuntime] Reflection retry: ${newErrors.length} new errors detected, attempting correction ${attempt + 1}`);
            }
            previousErrorSignatures = currentSignatures;

            this.emitUpdate({
              type: 'progress',
              content: {
                phase: 'concluding',
                message: localize(
                  outputLanguage,
                  `最终报告仍需补齐，正在自动修正 (${attempt + 1}/${MAX_CORRECTION_ATTEMPTS})...`,
                  `The final report still needs completion; applying automatic correction (${attempt + 1}/${MAX_CORRECTION_ATTEMPTS})...`,
                ),
              },
              timestamp: Date.now(),
            });

            try {
              const correctionPrompt = generateCorrectionPrompt(
                allIssues,
                conclusionText,
                outputLanguage,
                ctx.sceneType,
              );
              const correctionTurns = 1;
              const correctionSystemPrompt = localize(
                outputLanguage,
                '你是 SmartPerfetto 最终报告修正器。只根据用户给出的验证问题和原始结论改写最终报告。不要调用工具，不要重新查询数据，不要输出过程说明。',
                'You are the SmartPerfetto final-report corrector. Rewrite the final report only from the provided verification issues and original conclusion. Do not call tools, rerun queries, or narrate process.',
              );

              executionLease.throwIfAborted();
              const { stream: correctionStream, close: closeCorrection } = sdkQueryWithRetry({
                prompt: correctionPrompt,
                options: {
                  model: runtimeConfig.model,
                  maxTurns: correctionTurns,
                  systemPrompt: correctionSystemPrompt,
                  includePartialMessages: true,
                  settingSources: [],
                  tools: [],
                  ...resolveClaudeSdkPermissionOptions(),
                  cwd: runtimeConfig.cwd,
                  effort: ctx.effectiveEffort,
                  allowedTools: [],
                  env: sdkEnv,
                  persistSession: false,
                  stderr: (data: string) => {
                    console.warn(
                      `[ClaudeRuntime] SDK stderr (correction) [${sessionId}]: ${diagnosticLogIdentity(data.trimEnd())}`,
                    );
                  },
                },
              }, {
                emitUpdate: (update) => this.emitUpdate(update),
                outputLanguage: outputLanguage,
                runtimePerformance,
                signal: executionLease.signal,
              });
              const unregisterCorrectionAbortHandle = this.registerAbortHandle(sessionId, { abort: closeCorrection });

              // P1-G8: Independent timeout for correction retries — prevents indefinite hangs.
              // Even "normal" verification fixes may stream a full report after a few tool
              // calls, so use a shared per-turn budget instead of cutting non-FRC retries short.
              const correctionTimeoutMs = TEXT_ONLY_CORRECTION_TIMEOUT_MS;
              let correctionTimedOut = false;
              const correctionTimer = setTimeout(() => {
                correctionTimedOut = true;
                console.warn(`[ClaudeRuntime] Correction retry ${attempt + 1} timed out after ${correctionTimeoutMs}ms`);
                // Forcefully terminate the SDK subprocess so any queued MCP
                // tool calls (execute_sql, invoke_skill) stop running after
                // the main analyze() flow has moved on. Without this, those
                // calls hit trace_processor after the session has closed and
                // surface as orphan SQL errors with no owner.
                closeCorrection();
              }, correctionTimeoutMs);

              let correctedResult = '';
              const correctionAnswerBridge = createSseBridge(() => undefined, outputLanguage);
              try {
                for await (const msg of correctionStream) {
                  executionLease.throwIfAborted();
                  if (correctionTimedOut) break;
                  correctionAnswerBridge.handleMessage(msg);
                  if (msg.type === 'result' && (msg as any).subtype === 'success') {
                    correctedResult = (msg as any).result || correctionAnswerBridge.getAccumulatedAnswer() || '';
                    rounds += (msg as any).num_turns || 0;
                  }
                  // Bridge tool call events (agent_task_dispatched, agent_response)
                  // but suppress text/conclusion events to avoid duplicating the report.
                  // The corrected conclusion is captured in correctedResult and will
                  // replace conclusionText below — no need to stream it again.
                  if (msg.type !== 'stream_event' && msg.type !== 'assistant' && msg.type !== 'result') {
                    try { bridge(msg); } catch { /* non-fatal */ }
                  }
                }
              } finally {
                clearTimeout(correctionTimer);
                // Safety net: guarantee the correction SDK subprocess is
                // closed on every exit (success, break, throw). Idempotent.
                closeCorrection();
                unregisterCorrectionAbortHandle();
                if (!correctionTimedOut) {
                  correctionAnswerBridge.flushPendingAnswer();
                }
                if (!correctedResult && !correctionTimedOut) {
                  correctedResult = correctionAnswerBridge.getAccumulatedAnswer();
                }
                correctionAnswerBridge.dispose();
              }
              executionLease.throwIfAborted();
              correctedResult = ensureClaudeFinalReportHeading(
                correctedResult,
                ctx.sceneType,
                runtimeConfig.outputLanguage,
              );

              if (correctionTimedOut) {
                console.warn(`[ClaudeRuntime] Correction attempt ${attempt + 1} timed out, using partial result (${correctedResult.length} chars)`);
                if (shouldMarkCorrectionTimeoutPartial({ correctedResult, existingConclusion: conclusionText })) {
                  correctedResult = '';
                  verificationDegradedMessage = localize(
                    outputLanguage,
                    '修正重试超时，且当前结论仍不可独立交付；已保留原结论并标记为 partial。',
                    'Correction retry timed out and the current conclusion is still not independently deliverable; keeping the previous conclusion and marking the result partial.',
                  );
                } else if (!correctionResultLooksUsable(correctedResult)) {
                  correctedResult = '';
                }
              }

              // P2-G13: Compare correction quality by finding count and coverage, not text length.
              // A shorter corrected conclusion with more findings is better than a longer empty one.
              const correctedFindings = correctedResult ? extractFindingsFromText(correctedResult) : [];
              const previousFindingCount = mergedFindings.length;
              const hasSubstantiveCorrection = correctedResult && (
                correctedFindings.length >= previousFindingCount ||
                correctedResult.length > 100
              );

              if (hasSubstantiveCorrection) {
                conclusionText = correctedResult;
                // Re-extract findings from corrected conclusion and re-merge
                allFindings.push(correctedFindings);
                mergedFindings = mergeFindings(allFindings);
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: conclusion corrected (findings: ${previousFindingCount} → ${mergedFindings.length})`);
              } else {
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: correction insufficient (findings: ${correctedFindings.length} vs ${previousFindingCount}), keeping previous`);
                break; // No point retrying if correction failed to improve
              }
            } catch (correctionErr) {
              console.warn(`[ClaudeRuntime] Reflection retry ${attempt + 1} failed (non-blocking):`, (correctionErr as Error).message);
              break;
            }
          }
        } catch (err) {
          console.warn('[ClaudeRuntime] Verification failed (non-blocking):', diagnosticLogIdentity((err as Error).message));
          if (privateAnalysisContext) {
            verificationDegradedMessage = localize(
              outputLanguage,
              '私有源码/知识分析的最终验证执行失败；结果已按 partial 返回，不能视为已验证结论。',
              'Final verification failed to run for private source/knowledge analysis; the result is partial and must not be treated as verified.',
            );
          }
        }
      }

      // Fallback: if conclusionText is still incomplete after verification (or verification was skipped),
      // check if accumulatedAnswer has more content. This handles the case where the SDK result
      // was a short summary but the streamed answer_tokens contained the full report.
      const accumulatedAnswer = getAccumulatedAnswer();
      if (isConclusionIncomplete(conclusionText) && accumulatedAnswer.length > conclusionText.length) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: conclusionText incomplete (${conclusionText.length} chars), using accumulatedAnswer (${accumulatedAnswer.length} chars) instead`);
        conclusionText = accumulatedAnswer;
        // Re-extract findings from the more complete text
        allFindings.push(extractFindingsFromText(conclusionText));
        mergedFindings = mergeFindings(allFindings);
      }
      conclusionText = ensureClaudeFinalReportHeading(
        conclusionText,
        ctx.sceneType,
        runtimeConfig.outputLanguage,
      );

      const isPartialResult =
        terminationReason === MAX_TURNS_TERMINATION_REASON || terminationReason === 'timeout';
      if (isPartialResult) {
        const recoveredConclusion = recoverClaudeInterruptedFinalReport({
          accumulatedAnswer: conclusionText,
          plan: ctx.analysisPlan.current,
          hypotheses: this.sessionHypotheses.get(sessionId) || [],
          outputLanguage: runtimeConfig.outputLanguage,
        });
        if (recoveredConclusion) {
          conclusionText = ensureClaudeFinalReportHeading(
            recoveredConclusion,
            ctx.sceneType,
            runtimeConfig.outputLanguage,
          );
        }
        if (terminationReason === MAX_TURNS_TERMINATION_REASON) {
          terminationMessage ||= buildMaxTurnsTerminationMessage({
            mode: 'full',
            turns: rounds,
            maxTurns: runtimeConfig.maxTurns,
            outputLanguage: runtimeConfig.outputLanguage,
          });
        }
        terminationMessage ||= localize(
          runtimeConfig.outputLanguage,
          '完整分析超时，以下仅保留超时前已收集的部分结果。',
          'Full analysis timed out; only partial results collected before the timeout are retained below.',
        );
        conclusionText = conclusionText.trim()
          ? prependPartialNotice(conclusionText, terminationMessage, runtimeConfig.outputLanguage)
          : terminationReason === MAX_TURNS_TERMINATION_REASON
            ? buildMaxTurnsFallbackConclusion({
                mode: 'full',
                turns: rounds,
                maxTurns: runtimeConfig.maxTurns,
                outputLanguage: runtimeConfig.outputLanguage,
              })
            : ensureClaudeFinalReportHeading(
                localize(
                  runtimeConfig.outputLanguage,
                  `## 综合结论\n\n${terminationMessage}\n\n## 关键证据链\n\n- 超时前没有形成可安全交付的完整证据链。`,
                  `## Overall Conclusion\n\n${terminationMessage}\n\n## Key Evidence Chain\n\n- No complete evidence chain was safe to deliver before the timeout.`,
                ),
                ctx.sceneType,
                runtimeConfig.outputLanguage,
              );
        allFindings.push(extractFindingsFromText(conclusionText));
        mergedFindings = mergeFindings(allFindings);
        failedApproaches.push(terminationReason === MAX_TURNS_TERMINATION_REASON
          ? {
              type: 'strategy_failure',
              approach: `analysis reached ${runtimeConfig.maxTurns} full-mode turns`,
              reason: 'SDK returned error_max_turns before a normal success result',
            }
          : {
              type: 'strategy_failure',
              approach: `analysis exceeded ${isStreamIdleTimeout() ? 'provider stream idle' : 'request'} timeout`,
              reason: 'SDK stream was cancelled before a normal success result',
            });
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: terminationReason === MAX_TURNS_TERMINATION_REASON
              ? 'partial_result_after_max_turns'
              : 'partial_result_after_timeout',
            ...(terminationReason === MAX_TURNS_TERMINATION_REASON
              ? {error: SDK_MAX_TURNS_SUBTYPE}
              : {timeoutKind: timeoutState.kind}),
            message: terminationMessage,
            partial: true,
            terminationReason,
            turns: rounds,
            maxTurns: runtimeConfig.maxTurns,
          },
          timestamp: Date.now(),
        });
      }
      let isRuntimePartialResult = isPartialResult;
      if (providerErrorConclusion) {
        // Not a content problem the pipeline can repair. Mark the run itself
        // rather than relying on a downstream gate to notice: the gate can be
        // satisfied by evidence collected before the provider failed, and with
        // verification disabled it does not run at all.
        isRuntimePartialResult = true;
        // `execution_error` already means "the run did not execute", which is
        // exactly this. Adding a member to the reason union would ripple into
        // reports, snapshots and generated frontend types for no new meaning.
        terminationReason = terminationReason ?? 'execution_error';
        const providerErrorMessage = localize(
          outputLanguage,
          'Provider 返回的是错误信息而不是分析结论，本次结果不完整。',
          'The provider returned an error instead of an analysis; this result is incomplete.',
        );
        terminationMessage = terminationMessage
          ? `${terminationMessage}\n\n${providerErrorMessage}`
          : providerErrorMessage;
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: 'provider_error_conclusion',
            message: providerErrorMessage,
            partial: true,
            terminationReason: 'execution_error',
          },
          timestamp: Date.now(),
        });
      }
      if (verificationDegradedMessage && !isRuntimePartialResult) {
        isRuntimePartialResult = true;
        terminationMessage = terminationMessage
          ? `${terminationMessage}\n\n${verificationDegradedMessage}`
          : verificationDegradedMessage;
        conclusionText = conclusionText.trim()
          ? prependPartialNotice(conclusionText, verificationDegradedMessage, runtimeConfig.outputLanguage)
          : buildMaxTurnsFallbackConclusion({
              mode: 'full',
              turns: rounds,
              maxTurns: runtimeConfig.maxTurns,
              outputLanguage: runtimeConfig.outputLanguage,
            });
        mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: 'correction_timeout_without_deliverable_report',
            message: verificationDegradedMessage,
            partial: true,
          },
          timestamp: Date.now(),
        });
      }

      conclusionText = completeFinalReportCodeReferences({
        plan: ctx.analysisPlan.current,
        conclusion: conclusionText,
        outputLanguage: runtimeConfig.outputLanguage,
      });
      if (analysisContextUsesPrivateKnowledge(options)) {
        conclusionText = sanitizeCodeAwareText(sessionId, conclusionText);
      }
      mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);

      const baseConfidence = estimateAnalysisConfidence({findings: mergedFindings});
      const turnConfidence = isRuntimePartialResult
        ? capPartialConfidence(baseConfidence, mergedFindings.length > 0)
        : baseConfidence;
      const finalAnalysisResult: AnalysisResult = {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: (this.sessionHypotheses.get(sessionId) || []).map(h => this.toProtocolHypothesis(h)),
        conclusion: conclusionText,
        confidence: turnConfidence,
        rounds,
        totalDurationMs: Date.now() - startTime,
        partial: isRuntimePartialResult || undefined,
        terminationReason,
        terminationMessage,
      };
      finalizeSourceAwareAnalysisResult(finalAnalysisResult, ctx.sourceUse);
      const gateIssue = applyFinalResultQualityGate({
        result: finalAnalysisResult,
        query,
        sceneType,
        deferFocusedEvidenceFinalization: true,
      });
      if (gateIssue) {
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: gateIssue.code,
            message: gateIssue.message,
            partial: true,
          },
          timestamp: Date.now(),
        });
      }

      executionLease.throwIfAborted();
      ctx.sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'complex',
          followUpType: ctx.previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: finalAnalysisResult.success,
          findings: finalAnalysisResult.findings,
          confidence: finalAnalysisResult.confidence,
          message: finalAnalysisResult.conclusion,
          partial: finalAnalysisResult.partial,
          terminationReason: finalAnalysisResult.terminationReason,
          terminationMessage: finalAnalysisResult.terminationMessage,
        },
        finalAnalysisResult.findings,
      );

      if (finalAnalysisResult.partial !== true) {
        ctx.sessionContext.updateWorkingMemoryFromConclusion({
          turnIndex: ctx.previousTurns.length,
          query,
          conclusion: finalAnalysisResult.conclusion,
          confidence: finalAnalysisResult.confidence,
        });
      }

      // P2-2: Save analysis pattern to long-term memory (fire-and-forget)
      // Note: sceneType is from the outer analyze() scope (classified before context prep)
      const fullFeatures = extractTraceFeatures({
        architectureType: ctx.architecture?.type,
        sceneType,
        packageName: options.packageName,
        findingTitles: finalAnalysisResult.findings.map(f => f.title),
        findingCategories: finalAnalysisResult.findings.map(f => f.category).filter(Boolean) as string[],
      });
      // Per Self-Improving v3.3 §4.4: full-path patterns now save as
      // 'provisional' regardless of confidence. The state machine + 24h
      // auto-confirm decides whether they earn injection weight.
      if (
        !analysisContextUsesPrivateKnowledge(options) &&
        finalAnalysisResult.partial !== true &&
        finalAnalysisResult.findings.length > 0
      ) {
        const insights = extractKeyInsights(finalAnalysisResult.findings, finalAnalysisResult.conclusion);
        const patternExtras = {
          status: 'provisional' as const,
          provenance: {
            sessionId,
            turnIndex: ctx.previousTurns.length,
          },
          knowledgeScope: knowledgeScopeFromAnalysisOptions(options),
        };
        saveAnalysisPattern(fullFeatures, insights, sceneType, ctx.architecture?.type, finalAnalysisResult.confidence, patternExtras)
          .catch(err => console.warn('[ClaudeRuntime] Pattern save failed:', diagnosticLogIdentity((err as Error).message)));

        // Try to promote any matching quick-path pattern that has been waiting
        // for full-path verification. Best-effort — failure does not block.
        promoteQuickPatternIfMatching({
          fullPathFeatures: fullFeatures,
          fullPathInsights: insights,
          sceneType,
          architectureType: ctx.architecture?.type,
          verifierPassed: true,
          knowledgeScope: knowledgeScopeFromAnalysisOptions(options),
        }).catch(err => console.warn('[ClaudeRuntime] Quick→full promote failed:', diagnosticLogIdentity((err as Error).message)));
      }

      // Derive sql_error FailedApproach entries from persistent SQL errors
      // (errors that were never auto-fixed during the session — still in the array)
      const persistentSqlErrors = this.sessionSqlErrors.get(sessionId)?.filter(
        (e: any) => !e.fixedSql && e.errorMessage,
      ) || [];
      for (const sqlErr of persistentSqlErrors.slice(-3)) { // cap at 3 to avoid noise
        failedApproaches.push({
          type: 'sql_error',
          approach: sqlErr.errorSql?.substring(0, 150) || 'unknown SQL',
          reason: sqlErr.errorMessage?.substring(0, 150) || 'SQL query error',
        });
      }

      // P1: Save negative patterns to long-term memory (fire-and-forget)
      if (
        !analysisContextUsesPrivateKnowledge(options) &&
        failedApproaches.length > 0 &&
        fullFeatures.length > 0
      ) {
        saveNegativePattern(fullFeatures, failedApproaches, sceneType, ctx.architecture?.type, {
          knowledgeScope: knowledgeScopeFromAnalysisOptions(options),
        })
          .catch(err => console.warn('[ClaudeRuntime] Negative pattern save failed:', diagnosticLogIdentity((err as Error).message)));
      }

      return finalAnalysisResult;
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      const rawErrorMessage = (error as Error).message || 'Unknown error';
      const errMsg = explainClaudeRuntimeError(
        rawErrorMessage,
        outputLanguage,
        getCredentialSourceHint(options.providerId, providerScopeFromAnalysisOptions(options)),
      );
      const quotaExceeded = isClaudeQuotaError(rawErrorMessage);
      console.error('[ClaudeRuntime] Analysis failed:', diagnosticLogIdentity(rawErrorMessage));

      // P1-3: Preserve partial findings and generate partial conclusion on mid-stream errors
      const partialFindings = mergeFindings(allFindings);
      const hasPartialResults = partialFindings.length > 0;
      // P0-1: Export actual hypotheses even on error paths
      const runtimeHypotheses = this.sessionHypotheses.get(sessionId) || [];
      const errorHypotheses = runtimeHypotheses.map(h => this.toProtocolHypothesis(h));

      if (interruptionRecoveryState) {
        try {
          interruptionRecoveryState.flushPendingAnswer();
        } catch (flushError) {
          console.warn(
            '[ClaudeRuntime] Failed to flush interrupted answer buffer:',
            diagnosticLogIdentity((flushError as Error).message),
          );
        }
        const recoveryPlan = interruptionRecoveryState.getPlan();
        let recoveredConclusion = recoverClaudeInterruptedFinalReport({
          accumulatedAnswer: interruptionRecoveryState.getAccumulatedAnswer(),
          plan: recoveryPlan,
          hypotheses: runtimeHypotheses,
          outputLanguage,
        });
        const canRecover = recoveredConclusion && isRecoverableClaudeStreamInterruption({
          errorMessage: rawErrorMessage,
          streamStarted: interruptionRecoveryState.streamStarted,
          hasPartialEvidence: true,
          quotaExceeded,
        });

        if (canRecover && recoveredConclusion) {
          recoveredConclusion = completeFinalReportCodeReferences({
            plan: recoveryPlan,
            conclusion: recoveredConclusion,
            outputLanguage,
          });
          const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
          if (privateAnalysisContext) {
            recoveredConclusion = sanitizeCodeAwareText(sessionId, recoveredConclusion);
          }
          const recoveryMessage = localize(
            outputLanguage,
            '分析流在最终报告完成前中断；以下为已验证证据范围内保留的部分结果。',
            'The analysis stream ended before the final report completed; the partial result below preserves only available verified evidence.',
          );
          recoveredConclusion = prependPartialNotice(
            recoveredConclusion,
            recoveryMessage,
            outputLanguage,
          );
          const recoveredFindings = extractFindingsFromText(recoveredConclusion);
          const findings = privateAnalysisContext
            ? mergeFindings([recoveredFindings])
            : mergeFindings([...allFindings, recoveredFindings]);
          const terminationReason: AnalysisResult['terminationReason'] =
            /error_max_turns|max(?:imum)? turns/i.test(rawErrorMessage)
              ? MAX_TURNS_TERMINATION_REASON
              : /timeout|timed out|etimedout/i.test(rawErrorMessage)
                ? 'timeout'
                : 'execution_error';

          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'claudeRuntime',
              fallback: 'partial_result_after_stream_termination',
              message: recoveryMessage,
              partial: true,
              terminationReason,
            },
            timestamp: Date.now(),
          });
          return finalizeSourceAwareAnalysisResult({
            sessionId,
            success: true,
            findings,
            hypotheses: errorHypotheses,
            conclusion: recoveredConclusion,
            confidence: estimateAnalysisConfidence({findings, partial: true}),
            rounds,
            totalDurationMs: Date.now() - startTime,
            partial: true,
            terminationReason,
            terminationMessage: errMsg,
          }, sourceUse);
        }
      }

      const canPreservePartialFindings = hasPartialResults && isRecoverableClaudeStreamInterruption({
        errorMessage: rawErrorMessage,
        streamStarted: interruptionRecoveryState?.streamStarted ?? false,
        hasPartialEvidence: true,
        quotaExceeded,
      });
      if (canPreservePartialFindings) {
        let partialConclusion = localize(
          outputLanguage,
          `分析过程中出错 (${errMsg})，以下是已收集的部分发现：\n\n`,
          `An error occurred during analysis (${errMsg}). Partial findings collected so far:\n\n`,
        ) +
          partialFindings.map(f => `- **[${f.severity.toUpperCase()}]** ${f.title}: ${f.description || ''}`).join('\n');
        const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
        if (privateAnalysisContext) {
          partialConclusion = sanitizeCodeAwareText(sessionId, partialConclusion);
        }
        const safePartialFindings = privateAnalysisContext
          ? mergeFindings([extractFindingsFromText(partialConclusion)])
          : partialFindings;
        this.emitUpdate({
          type: 'progress',
          content: {
            phase: 'concluding',
            message: localize(
              outputLanguage,
              `分析中断，已保留 ${safePartialFindings.length} 个部分发现`,
              `Analysis interrupted; preserved ${safePartialFindings.length} partial finding(s)`,
            ),
          },
          timestamp: Date.now(),
        });
        return finalizeSourceAwareAnalysisResult({
          sessionId,
          success: true, // partial success — downstream can check confidence < 1
          findings: safePartialFindings,
          hypotheses: errorHypotheses,
          conclusion: partialConclusion,
          confidence: capPartialConfidence(
            estimateAnalysisConfidence({findings: safePartialFindings, partial: true}),
            safePartialFindings.length > 0,
          ),
          rounds,
          totalDurationMs: Date.now() - startTime,
          partial: true,
          terminationReason: quotaExceeded ? 'max_budget_usd' : 'execution_error',
          terminationMessage: errMsg,
        }, sourceUse);
      }

      this.emitUpdate({
        type: 'error',
        content: {
          message: localize(outputLanguage, `分析失败: ${errMsg}`, `Analysis failed: ${errMsg}`),
        },
        timestamp: Date.now(),
      });
      return finalizeSourceAwareAnalysisResult({
        sessionId,
        success: false,
        findings: partialFindings,
        hypotheses: errorHypotheses,
        conclusion: localize(
          outputLanguage,
          `分析过程中出错: ${errMsg}`,
          `An error occurred during analysis: ${errMsg}`,
        ),
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
        terminationReason: quotaExceeded ? 'max_budget_usd' : 'execution_error',
        terminationMessage: errMsg,
      }, sourceUse);
    } finally {
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        interruptionRecoveryState?.dispose();
        this.activeAnalyses.delete(sessionId);
        runSnapshots.release(sessionId);
        executionLease.settle();
        // Notes persistence now handled by unified SessionStateSnapshot in the route layer.
        // No separate disk I/O needed here.

        // Persist session metrics (fire-and-forget, non-blocking)
        try {
          if (!delegatedRetry) {
            metricsCollector.recordTurn(); // Record final turn
            persistSessionMetrics(
              metricsCollector.summarize(),
              analysisContextUsesPrivateKnowledge(options),
            );
          }
        } catch (metricsErr) {
          console.warn('[ClaudeRuntime] Failed to persist metrics:', (metricsErr as Error).message);
        }
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
      }
    }
  }

  /**
   * Quick analysis path for simple factual queries.
   * Minimal context prep, 3 MCP tools, no planning/verification/report.
   * Target: 3-8s latency, 2k-5k tokens.
   */
  private async analyzeQuick(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    precomputed: {
      sceneType: SceneType;
      focusResult: Awaited<ReturnType<typeof detectFocusApps>>;
      cachedArch: ArchitectureInfo | undefined;
      sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns: any[];
      metricsCollector: AgentMetricsCollector;
      startTime: number;
      analysisRunSpec: AnalysisRunSpec;
      skipQuickTracePreflightDetection: boolean;
      priorEvidenceOnlyFollowup: boolean;
      quickFocusAppPreEvidence: boolean;
      quickProcessIdentityPreEvidence: boolean;
      quickTraceFactPreEvidence: boolean;
      quickScrollingTriagePreEvidence: boolean;
      outputLanguage: import('../../../agentv3/outputLanguage').OutputLanguage;
      executionLease: RuntimeExecutionLease;
      runtimePerformance: RuntimePerformanceRun;
    },
  ): Promise<AnalysisResult> {
    const {
      sceneType,
      focusResult,
      cachedArch,
      sessionContext,
      previousTurns,
      metricsCollector,
      startTime,
      analysisRunSpec,
      skipQuickTracePreflightDetection,
      priorEvidenceOnlyFollowup,
      quickFocusAppPreEvidence,
      quickProcessIdentityPreEvidence,
      quickTraceFactPreEvidence,
      quickScrollingTriagePreEvidence,
      outputLanguage,
      executionLease,
      runtimePerformance,
    } = precomputed;
    let delegatedRetry = false;
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;

    try {
      executionLease.throwIfAborted();
      let effectivePackageName = options.packageName;
      if (!effectivePackageName && focusResult.primaryApp) {
        effectivePackageName = focusResult.primaryApp;
      }

      const providerScope = analysisRunSpec.scopes.provider;
      const sdkEnv = createSdkEnv(options.providerId, providerScope);
      const quickConfig = createQuickConfig(
        resolveRuntimeConfig(this.config, options.providerId, providerScope),
        sdkEnv,
      );
      const quickBudget = resolveQuickTurnBudget({
        env: sdkEnv,
        hardCapTurns: quickConfig.maxTurns,
        targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS', 'CLAUDE_QUICK_TARGET_TURNS'],
        hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS', 'CLAUDE_QUICK_MAX_TURNS'],
        enforcement: 'turn_cap',
      });

      const runtimeQuickEvidenceAttempt: RuntimeQuickEvidenceAttempt | undefined = (
        quickFocusAppPreEvidence ||
        quickProcessIdentityPreEvidence ||
        quickTraceFactPreEvidence ||
        quickScrollingTriagePreEvidence
      )
        ? await (async () => {
            const quickEvidencePhase = runtimePerformance.startPhase('quick_evidence');
            try {
              const answer = await buildRuntimeQuickEvidenceAttempt({
            query,
            traceId,
            packageName: options.packageName,
            selectionContext: options.selectionContext,
            traceProcessorService: this.traceProcessorService,
            outputLanguage: outputLanguage,
            quickFocusAppPreEvidence,
            quickProcessIdentityPreEvidence,
            quickTraceFactPreEvidence,
            quickScrollingTriagePreEvidence,
            focusResult,
            emitUpdate: update => this.emitUpdate(update),
              });
              quickEvidencePhase.end('ok');
              return answer;
            } catch (error) {
              quickEvidencePhase.end(runtimeOutcomeFromError(error, executionLease.signal));
              throw error;
            }
          })()
        : undefined;
      executionLease.throwIfAborted();
      if (runtimeQuickEvidenceAttempt?.directAnswer) {
        const quickResult = buildQuickDirectEvidenceAnalysisResult({
          query,
          sessionId,
          options,
          startedAt: startTime,
          analysisRunSpec,
          budget: quickBudget,
          directAnswer: runtimeQuickEvidenceAttempt.directAnswer,
          evidenceCounts: runtimeQuickEvidenceAttempt.evidenceCounts,
          previousTurns,
        });
        emitQuickDirectQualityGateIssue({
          emitUpdate: update => this.emitUpdate(update),
          module: 'claudeRuntime',
          result: quickResult,
          query,
          sceneType,
        });
        sessionContext.addTurn(
          query,
          {
            primaryGoal: query,
            aspects: [],
            expectedOutputType: 'summary',
            complexity: 'simple',
            followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
          },
          {
            agentId: 'claude-agent',
            success: quickResult.success,
            findings: quickResult.findings,
            confidence: quickResult.confidence,
            message: quickResult.conclusion,
          },
          quickResult.findings,
        );
        runtimePerformance.recordFirstOutput();
        emitQuickDirectAnswerEvents({
          emitUpdate: update => this.emitUpdate(update),
          result: quickResult,
          startedAt: startTime,
          outputLanguage: outputLanguage,
          runtime: 'claude-agent-sdk',
          model: 'runtime-pre-evidence',
        });
        console.log(`[ClaudeRuntime] Quick direct pre-evidence completed: 0 rounds, ${Date.now() - startTime}ms, ${quickResult.conclusion.length} chars`);
        return quickResult;
      }

      const reusableRuntimeQuickEvidenceAttempt = selectReusableRuntimeQuickEvidenceAttempt(
        runtimeQuickEvidenceAttempt,
      );
      if (!effectivePackageName && reusableRuntimeQuickEvidenceAttempt?.effectivePackageName) {
        effectivePackageName = reusableRuntimeQuickEvidenceAttempt.effectivePackageName;
      }

      const skipFocusEvidence = !quickFocusAppPreEvidence && (
        !!options.packageName
          ? (
            quickProcessIdentityPreEvidence ||
            quickTraceFactPreEvidence ||
            quickScrollingTriagePreEvidence
          )
          : quickTraceFactPreEvidence
            && !quickProcessIdentityPreEvidence
            && shouldSkipFocusDetectionForQuickTraceFactEvidence(query)
      );
      const focusEvidencePayload = skipFocusEvidence || reusableRuntimeQuickEvidenceAttempt
        ? undefined
        : buildFocusAppEvidencePayload(focusResult, traceId, 'current', outputLanguage);
      if (focusEvidencePayload?.envelope) {
        this.emitUpdate({
          type: 'data',
          content: [focusEvidencePayload.envelope],
          timestamp: Date.now(),
        });
      }

      const promptFocusResult = focusEvidencePayload?.focusResult ?? focusResult;
      const shouldBuildFallbackQuickEvidence = !reusableRuntimeQuickEvidenceAttempt;
      const quickProcessIdentityExecutor = quickProcessIdentityPreEvidence && shouldBuildFallbackQuickEvidence
        ? createQuickProcessIdentitySkillExecutor(this.traceProcessorService)
        : undefined;
      const processIdentityEvidencePromise: Promise<
        Awaited<ReturnType<typeof buildQuickProcessIdentityEvidence>>
      > = quickProcessIdentityExecutor
        ? buildQuickProcessIdentityEvidence({
            skillExecutor: quickProcessIdentityExecutor,
            traceId,
            focusResult: promptFocusResult,
            packageName: effectivePackageName,
            outputLanguage: outputLanguage,
        })
        : Promise.resolve({ envelopes: [] });
      const traceFactEvidencePromise: Promise<
        Awaited<ReturnType<typeof buildQuickTraceFactEvidence>>
      > = quickTraceFactPreEvidence && shouldBuildFallbackQuickEvidence
        ? buildQuickTraceFactEvidence({
            traceProcessor: this.traceProcessorService,
            traceId,
            query,
            focusResult: promptFocusResult,
            packageName: effectivePackageName,
            timeRange: focusAppTimeRangeFromSelection(options.selectionContext),
            outputLanguage: outputLanguage,
          })
        : Promise.resolve({ envelopes: [] });

      const detectQuickArchitecture = async (): Promise<ArchitectureInfo | undefined> => {
        if (cachedArch) return cachedArch;
        try {
          const detector = createArchitectureDetector();
          const arch = await detector.detect({
            traceId,
            traceProcessorService: this.traceProcessorService,
            packageName: effectivePackageName,
          });
          if (arch) {
            setLruCacheEntry(this.architectureCache, traceId, arch);
          }
          return arch;
        } catch (err) {
        console.warn('[ClaudeRuntime] Quick: architecture detection failed:', diagnosticLogIdentity((err as Error).message));
          return undefined;
        }
      };

      const skipQuickPreflightForEvidence = skipQuickTracePreflightDetection || quickFocusAppPreEvidence;
      const deferQuickTracePreflightToModel = options.assistantSurface === 'conversation';
      const skipQuickPreflight = skipQuickPreflightForEvidence || deferQuickTracePreflightToModel;
      const architecturePromise = skipQuickPreflight
        ? Promise.resolve(undefined)
        : detectQuickArchitecture();

      const skillRegistryReady = skipQuickPreflight
        ? undefined
        : ensureSkillRegistryInitialized();

      let [architecture, processIdentityEvidence, traceFactEvidence] = await Promise.all([
        architecturePromise,
        processIdentityEvidencePromise,
        traceFactEvidencePromise,
      ]);
      executionLease.throwIfAborted();

      const knowledgeScope = analysisRunSpec.scopes.knowledge;
      const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
      if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
        this.sessionSqlErrors.delete(sessionId);
        this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
      }
      let sqlErrors = this.sessionSqlErrors.get(sessionId);
      const ensureSqlErrorsLoaded = () => {
        if (!this.sessionSqlErrors.has(sessionId)) {
          sqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope, options);
          this.sessionSqlErrors.set(sessionId, sqlErrors);
        }
        sqlErrors = this.sessionSqlErrors.get(sessionId) ?? [];
        return sqlErrors;
      };
      if (!skipQuickPreflight) {
        ensureSqlErrorsLoaded();
      }
      sqlErrors ??= [];

      if (processIdentityEvidence.envelopes.length > 0) {
        executionLease.throwIfAborted();
        this.emitUpdate({
          type: 'data',
          content: processIdentityEvidence.envelopes,
          timestamp: Date.now(),
        });
      }
      if (traceFactEvidence.envelopes.length > 0) {
        executionLease.throwIfAborted();
        this.emitUpdate({
          type: 'data',
          content: traceFactEvidence.envelopes,
          timestamp: Date.now(),
        });
      }
      const useProcessIdentityEvidenceOnlyQuick = shouldUseEvidenceOnlyQuickAnalysis({
        skipQuickTracePreflightDetection,
        processIdentityEvidence,
      });
      const useTraceFactEvidenceOnlyQuick = shouldUseTraceFactEvidenceOnlyQuickAnalysis({
        quickTraceFactPreEvidence,
        traceFactEvidence,
      });
      const directProcessIdentityAnswer = quickProcessIdentityPreEvidence
        ? buildQuickProcessIdentityDirectAnswer({
            evidence: processIdentityEvidence,
            outputLanguage: outputLanguage,
          })
        : undefined;
      const directTraceFactAnswer = quickTraceFactPreEvidence
        ? buildQuickTraceFactDirectAnswer({
            evidence: traceFactEvidence,
            outputLanguage: outputLanguage,
          })
        : undefined;
      const directFocusAppAnswer = quickFocusAppPreEvidence
        ? buildQuickFocusAppDirectAnswer({
            query,
            evidence: focusEvidencePayload,
            selectionContext: options.selectionContext,
            outputLanguage: outputLanguage,
          })
        : undefined;
      const useFocusAppEvidenceOnlyQuick = quickFocusAppPreEvidence && Boolean(directFocusAppAnswer);
      const useEvidenceOnlyQuick = !quickScrollingTriagePreEvidence && (
        quickFocusAppPreEvidence || quickProcessIdentityPreEvidence || quickTraceFactPreEvidence
      )
        && (!quickFocusAppPreEvidence || useFocusAppEvidenceOnlyQuick)
        && (!quickProcessIdentityPreEvidence || useProcessIdentityEvidenceOnlyQuick)
        && (!quickTraceFactPreEvidence || useTraceFactEvidenceOnlyQuick);

      if (
        skipQuickPreflightForEvidence &&
        !deferQuickTracePreflightToModel &&
        !useEvidenceOnlyQuick &&
        !priorEvidenceOnlyFollowup
      ) {
        architecture = await detectQuickArchitecture();
        sqlErrors = ensureSqlErrorsLoaded();
        executionLease.throwIfAborted();
      }

      const quickTraceFeatures = useEvidenceOnlyQuick || priorEvidenceOnlyFollowup
        ? undefined
        : extractTraceFeatures({
            architectureType: architecture?.type,
            sceneType,
            packageName: effectivePackageName,
          });
      const quickMemoryPayload = quickTraceFeatures
        ? buildQuickMemoryContextPayload({
            patternContext: analysisContextUsesPrivateKnowledge(options)
              ? undefined
              : buildPatternContextSection(quickTraceFeatures, knowledgeScope),
            negativePatternContext: analysisContextUsesPrivateKnowledge(options)
              ? undefined
              : buildNegativePatternSection(quickTraceFeatures, knowledgeScope),
            caseBackgroundContext: buildRuntimeCaseBackgroundContext({
              sceneType,
              architectureType: architecture?.type,
              knowledgeScope,
              outputLanguage: outputLanguage,
              privateAnalysisContext: analysisContextUsesPrivateKnowledge(options),
            }),
            sqlErrorFixPairs: sqlErrors,
            recentSqlResultsContext: sessionContext.generateRecentSqlResultPromptContext(3),
            outputLanguage: outputLanguage,
          })
        : undefined;
      const quickMemoryContext = quickMemoryPayload?.text;
      // Quick mode hands the model execute_sql with no schema knowledge, so a
      // targeted lookup can only be reached by trial. This is a local index hit.
      const quickKnowledgeBaseContext = await buildQuickKnowledgeBaseContext(query);
      const quickConversationTurns = previousTurns.filter(turn => turn?.completed).slice(-3).length;

      const directQuickAnswer = useEvidenceOnlyQuick
        ? combineRuntimeQuickEvidenceDirectAnswers({
            focusAppAnswer: directFocusAppAnswer,
            processIdentityAnswer: directProcessIdentityAnswer,
            traceFactAnswer: directTraceFactAnswer,
            outputLanguage: outputLanguage,
          })
        : undefined;
      if (directQuickAnswer) {
        const quickResult = buildQuickDirectEvidenceAnalysisResult({
          query,
          sessionId,
          options,
          startedAt: startTime,
          analysisRunSpec,
          budget: quickBudget,
          directAnswer: directQuickAnswer,
          evidenceCounts: {
            currentRunDataEnvelopes: (
              (focusEvidencePayload?.envelope ? 1 : 0) +
              processIdentityEvidence.envelopes.length +
              traceFactEvidence.envelopes.length
            ),
            citedEvidenceRefs: countRuntimeQuickEvidenceCitedRefs(directQuickAnswer),
          },
          previousTurns,
          contextInjected: quickMemoryPayload?.counts,
        });
        emitQuickDirectQualityGateIssue({
          emitUpdate: update => this.emitUpdate(update),
          module: 'claudeRuntime',
          result: quickResult,
          query,
          sceneType,
        });
        sessionContext.addTurn(
          query,
          {
            primaryGoal: query,
            aspects: [],
            expectedOutputType: 'summary',
            complexity: 'simple',
            followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
          },
          {
            agentId: 'claude-agent',
            success: quickResult.success,
            findings: quickResult.findings,
            confidence: quickResult.confidence,
            message: quickResult.conclusion,
          },
          quickResult.findings,
        );
        runtimePerformance.recordFirstOutput();
        emitQuickDirectAnswerEvents({
          emitUpdate: update => this.emitUpdate(update),
          result: quickResult,
          startedAt: startTime,
          outputLanguage: outputLanguage,
          runtime: 'claude-agent-sdk',
          model: 'runtime-pre-evidence',
        });
        console.log(`[ClaudeRuntime] Quick direct pre-evidence completed: 0 rounds, ${Date.now() - startTime}ms, ${quickResult.conclusion.length} chars`);
        return quickResult;
      }

      let mcpServer: ReturnType<typeof createClaudeMcpServer>['server'] | undefined;
      let allowedTools: string[] = [];
      if (!useEvidenceOnlyQuick && !priorEvidenceOnlyFollowup) {
        executionLease.throwIfAborted();
        await (skillRegistryReady ?? ensureSkillRegistryInitialized());
        executionLease.throwIfAborted();
        const skillExecutor = createSkillExecutor(this.traceProcessorService);
        const effectiveSkillRegistry =
          resolveEffectiveSkillRegistryForRuntime(skillRegistry);
        skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
        skillExecutor.setFragmentRegistry(
          effectiveSkillRegistry.getFragmentCache(),
        );
        if (!this.artifactStores.has(sessionId)) {
          this.artifactStores.set(sessionId, new ArtifactStore());
        }
        const quickArtifactStore = this.artifactStores.get(sessionId)!;

        const watchdogWarning: { current: string | null } = { current: null };
        // Quick path defaults to no skill-notes injection per §8 of the
        // self-improving design. Operators can opt-in via the env override.
        const quickNotesBudget = createRuntimeSkillNotesBudget(true);
        const mcp = createClaudeMcpServer({
          runManifestAttributionSink: options.runManifestAttributionSink,
          sessionId,
          traceId,
          userQuery: query,
          traceProcessorService: this.traceProcessorService,
          skillExecutor,
          packageName: effectivePackageName,
          emitUpdate: (update) => this.emitUpdate(update),
          watchdogWarning,
          sceneType,
          lightweight: true,
          conversationTraceAttached: options.assistantSurface === 'conversation'
            ? options.conversationTraceAttached === true
            : undefined,
          artifactStore: quickArtifactStore,
          recentSqlErrors: sqlErrors,
          skillNotesBudget: quickNotesBudget,
          outputLanguage: outputLanguage,
          knowledgeScope,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
          knowledgeSourceIds: options.knowledgeSourceIds,
          sourceUsePolicy: options.sourceUsePolicy,
          analysisContextFingerprint: options.analysisContextFingerprint,
          androidInternalsPackPin: options.androidInternalsPackPin,
        });
        mcpServer = mcp.server;
        allowedTools = mcp.allowedTools;
        sourceUse = mcp.sourceUse;
      }

      const systemPrompt = buildQuickSystemPrompt({
        architecture,
        packageName: effectivePackageName,
        focusApps: promptFocusResult.apps.length > 0 ? promptFocusResult.apps : undefined,
        focusMethod: promptFocusResult.method,
        selectionContext: options.selectionContext,
        runtimeEvidenceContext: joinRuntimeEvidenceContexts(
          sanitizeRuntimeQuickEvidenceRoutingContext(
            reusableRuntimeQuickEvidenceAttempt?.runtimeEvidenceContext,
            outputLanguage,
          ),
          processIdentityEvidence.promptContext,
          traceFactEvidence.promptContext,
        ),
        quickMemoryContext,
        knowledgeBaseContext: quickKnowledgeBaseContext,
        outputLanguage: outputLanguage,
        codeAwareMode: options.codeAwareMode,
        codebaseIds: options.codebaseIds,
      });
      const quickConversationContext = buildQuickConversationContext(previousTurns, outputLanguage);

      const {
        handleMessage: bridge,
        getAccumulatedAnswer,
        flushPendingAnswer,
        dispose: disposeBridge,
      } = createSseBridge((update: StreamingUpdate) => {
        if (update.type === 'answer_token' || update.type === 'thought') {
          runtimePerformance.recordFirstOutput();
        }
        this.emitUpdate(update);
      }, outputLanguage, {
        tracePairContext: options.tracePairContext,
      }, ((options.codeAwareMode && options.codeAwareMode !== 'off') || options.knowledgeSourceIds?.length)
        ? createCodeAwareStreamingTextProjection(sessionId, 'claude-quick-answer')
        : undefined);
      executionLease.throwIfAborted();

      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'answering',
          message: localize(
            outputLanguage,
            `快速问答模式 (${quickConfig.model})...`,
            `Fast Q&A mode (${quickConfig.model})...`,
          ),
        },
        timestamp: Date.now(),
      });

      // Quick calls intentionally do not resume or persist Claude SDK sessions.
      // The SDK's maxTurns budget is tied to the resumed conversation, while
      // SmartPerfetto's fast mode budget is a per-question latency guard. Keep
      // cross-turn context local and compact so quick cannot exhaust or overwrite
      // the full-mode SDK conversation.
      let quickPrompt = query;
      if (quickConversationContext) {
        quickPrompt = `${quickConversationContext}\n\n${quickPrompt}`;
      }
      // Prepend pre-queried trace data so the AI skips basic SQL turns in fast mode.
      if (analysisRunSpec.traceContext.promptSection) {
        quickPrompt = `${analysisRunSpec.traceContext.promptSection}\n\n${quickPrompt}`;
      }
      executionLease.throwIfAborted();

      const {stream, close: closeSdk} = sdkQueryWithRetry({
          prompt: quickPrompt,
          options: {
            model: quickConfig.model,
            maxTurns: quickConfig.maxTurns,
            systemPrompt,
            ...(mcpServer ? { mcpServers: { smartperfetto: mcpServer } } : {}),
            includePartialMessages: true,
            settingSources: [],
            tools: [],
            ...resolveClaudeSdkPermissionOptions(),
            cwd: quickConfig.cwd,
            effort: quickConfig.effort,
            allowedTools,
            env: sdkEnv,
            persistSession: false,
            stderr: (data: string) => {
              console.warn(
                `[ClaudeRuntime] Quick SDK stderr [${sessionId}]: ${diagnosticLogIdentity(data.trimEnd())}`,
              );
            },
          },
      }, {
          emitUpdate: (update) => this.emitUpdate(update),
          outputLanguage: outputLanguage,
        runtimePerformance,
        signal: executionLease.signal,
        recordSdkStartPhase: true,
      });
      const unregisterSdkAbortHandle = this.registerAbortHandle(sessionId, { abort: closeSdk });

      let finalResult: string | undefined;
      let accumulatedAnswerAfterStream = '';
      let quickRounds = 0;
      let terminationReason: AnalysisResult['terminationReason'];
      let terminationMessage: string | undefined;
      const quickToolCalls: Array<{
        id?: string;
        name: string;
        startedAt: number;
        completed: boolean;
      }> = [];

      // Quick path per-turn budget from env CLAUDE_QUICK_PER_TURN_MS (default 40s/turn).
      const timeoutMs = quickConfig.maxTurns * quickConfig.quickPathPerTurnMs;
      let timedOut = false;
      let safetyTimer: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<void>((_, reject) => {
        safetyTimer = setTimeout(() => {
          timedOut = true;
          // Forcefully terminate SDK subprocess so queued MCP tool calls
          // stop running after analyzeQuick returns (prevents orphan queries).
          closeSdk();
          reject(new Error(`Quick analysis timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      const processStream = async () => {
        for await (const msg of stream) {
          executionLease.throwIfAborted();
          if (timedOut) break;

          const sdkResultError = getSdkResultErrorMessage(msg);
          if (sdkResultError) throw new Error(sdkResultError);

          try { bridge(msg); } catch { /* non-fatal */ }

          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            for (const block of (msg as any).message.content) {
              if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
              quickToolCalls.push({
                id: typeof block.id === 'string' ? block.id : undefined,
                name: block.name.replace(MCP_NAME_PREFIX, ''),
                startedAt: Date.now(),
                completed: false,
              });
            }
          }
          if (msg.type === 'user' && (msg as any).tool_use_result !== undefined) {
            const resultBlocks = extractSdkToolResultBlocks(msg);
            const observedResults = resultBlocks.length > 0
              ? resultBlocks
              : [{result: (msg as any).tool_use_result, isError: undefined, toolUseId: undefined}];
            for (const observed of observedResults) {
              const matched = observed.toolUseId
                ? quickToolCalls.find(call => call.id === observed.toolUseId && !call.completed)
                : [...quickToolCalls].reverse().find(call => !call.completed);
              if (!matched) continue;
              matched.completed = true;
              const failed = isSdkToolResultFailure(observed.result, observed.isError);
              metricsCollector.recordToolFromStream(
                matched.name,
                Date.now() - matched.startedAt,
                !failed,
              );
            }
          }

          if (msg.type === 'result') {
            quickRounds = (msg as any).num_turns || quickRounds;
            const resultSubtype = (msg as any).subtype;
            if (resultSubtype === 'success') {
              finalResult = (msg as any).result;
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              terminationReason = MAX_TURNS_TERMINATION_REASON;
              terminationMessage = buildMaxTurnsTerminationMessage({
                mode: 'fast',
                turns: quickRounds,
                maxTurns: quickConfig.maxTurns,
                outputLanguage: outputLanguage,
              });
            }
          }
        }
      };

      try {
        await Promise.race([processStream(), timeoutPromise]);
      } catch (err) {
        if (timedOut) {
          console.warn('[ClaudeRuntime] Quick analysis timeout reached — SDK subprocess has been closed');
        } else {
          throw err;
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
        closeSdk();
        unregisterSdkAbortHandle();
        flushPendingAnswer();
        accumulatedAnswerAfterStream = getAccumulatedAnswer();
        disposeBridge();
      }

      if (timedOut) {
        terminationReason = 'timeout';
        terminationMessage = localize(
          outputLanguage,
          `快速问答超过 ${Math.round(timeoutMs / 1000)} 秒超时，结果可能不完整。`,
          `Fast Q&A timed out after ${Math.round(timeoutMs / 1000)} seconds; the result may be incomplete.`,
        );
      }

      let conclusionText = finalResult || accumulatedAnswerAfterStream || '';
      executionLease.throwIfAborted();
      let mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
      const isPartialResult = terminationReason === MAX_TURNS_TERMINATION_REASON || terminationReason === 'timeout';
      if (isPartialResult) {
        if (terminationReason === MAX_TURNS_TERMINATION_REASON) {
          terminationMessage ||= buildMaxTurnsTerminationMessage({
            mode: 'fast',
            turns: quickRounds,
            maxTurns: quickConfig.maxTurns,
            outputLanguage: outputLanguage,
          });
        }
        const partialMessage = terminationMessage || localize(
          outputLanguage,
          '快速问答未能生成完整可核验答案。',
          'Fast Q&A could not produce a complete verifiable answer.',
        );
        conclusionText = conclusionText.trim()
          ? prependPartialNotice(conclusionText, partialMessage, outputLanguage)
          : terminationReason === 'timeout'
            ? (terminationMessage || localize(
                outputLanguage,
                '快速问答超时，未能生成可核验答案。',
                'Fast Q&A timed out before producing a verifiable answer.',
              ))
            : buildMaxTurnsFallbackConclusion({
              mode: 'fast',
              turns: quickRounds,
              maxTurns: quickConfig.maxTurns,
              outputLanguage: outputLanguage,
            });
        mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: 'partial_result_after_max_turns',
            error: SDK_MAX_TURNS_SUBTYPE,
            message: terminationMessage,
            partial: true,
            terminationReason,
            turns: quickRounds,
            maxTurns: quickConfig.maxTurns,
          },
          timestamp: Date.now(),
        });
      }
      if ((options.codeAwareMode && options.codeAwareMode !== 'off') || options.knowledgeSourceIds?.length) {
        conclusionText = sanitizeCodeAwareText(sessionId, conclusionText);
        mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
      }
      // Quick mode uses the same rule as full mode. The flat 0.8/0.5 it used
      // before asserted high confidence merely because findings had been
      // extracted from prose; the findings already carry severity-derived
      // confidences, so averaging them says something real.
      const quickConfidence = estimateAnalysisConfidence({
        findings: mergedFindings,
        partial: isPartialResult,
      });
      const quickResult: AnalysisResult = {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: [],
        conclusion: conclusionText,
        confidence: quickConfidence,
        rounds: quickRounds,
        totalDurationMs: Date.now() - startTime,
        partial: isPartialResult || undefined,
        terminationReason,
        terminationMessage,
        quickRun: buildQuickRunReceipt({
          requestedMode: options.analysisMode ?? 'auto',
          query,
          budget: quickBudget,
          actualTurns: quickRounds,
          elapsedMs: Date.now() - startTime,
          stopReason: quickStopReasonFromTermination({
            partial: isPartialResult,
            terminationReason,
            actualTurns: quickRounds,
            targetTurns: quickBudget.targetTurns,
            hardCapTurns: quickBudget.hardCapTurns,
          }),
          evidence: {
            frontendPrequeryInjected: analysisRunSpec.traceContext.datasetCount,
          },
          contextInjected: {
            conversationTurns: quickConversationTurns,
            ...(quickMemoryPayload?.counts ?? {}),
          },
          adaptiveRouting: analysisRunSpec.mode.adaptiveRouting,
        }),
      };
      finalizeSourceAwareAnalysisResult(quickResult, sourceUse);
      const quickGateIssue = applyFinalResultQualityGate({
        result: quickResult,
        query,
        sceneType,
        deferFocusedEvidenceFinalization: true,
      });
      executionLease.throwIfAborted();
      if (quickGateIssue) {
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: quickGateIssue.code,
            message: quickGateIssue.message,
            partial: true,
          },
          timestamp: Date.now(),
        });
      }

      if (quickResult.conclusion.length > 0 && quickResult.conclusion.length < 20) {
        console.warn(`[ClaudeRuntime] Quick: suspiciously short answer (${quickResult.conclusion.length} chars)`);
      }

      // Record turn in session context
      executionLease.throwIfAborted();
      sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'summary',
          complexity: 'simple',
          followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: quickResult.success,
          findings: quickResult.findings,
          confidence: quickResult.confidence,
          message: quickResult.conclusion,
          partial: quickResult.partial,
          terminationReason: quickResult.terminationReason,
          terminationMessage: quickResult.terminationMessage,
        },
        quickResult.findings,
      );

      console.log(`[ClaudeRuntime] Quick analysis completed: ${quickRounds} rounds, ${Date.now() - startTime}ms, ${quickResult.conclusion.length} chars`);

      // Quick path writes to a separate 7-day bucket — see Self-Improving v3.3 §6.
      // Insights are weaker (no verifier, 10-turn budget), so they only surface
      // as fallbacks at injection time. A future full-path run on similar
      // features may promote the bucket entry to long-term memory.
      if (
        !analysisContextUsesPrivateKnowledge(options) &&
        quickResult.partial !== true &&
        quickResult.findings.length > 0
      ) {
        executionLease.throwIfAborted();
        const insights = extractKeyInsights(quickResult.findings, quickResult.conclusion);
        const quickFeatures = extractTraceFeatures({
          architectureType: architecture?.type,
          sceneType,
          packageName: effectivePackageName,
          findingTitles: quickResult.findings.map(f => f.title),
          findingCategories: quickResult.findings.map(f => f.category).filter(Boolean) as string[],
        });
        saveQuickPathPattern(quickFeatures, insights, sceneType, architecture?.type, {
          status: 'provisional',
          provenance: { sessionId, turnIndex: previousTurns.length },
          knowledgeScope: knowledgeScopeFromAnalysisOptions(options),
        }).catch(err => console.warn('[ClaudeRuntime] Quick pattern save failed:', diagnosticLogIdentity((err as Error).message)));
      }

      return quickResult;
    } catch (error) {
      const rawErrorMessage = (error as Error).message || 'Unknown error';
      const errMsg = explainClaudeRuntimeError(
        rawErrorMessage,
        outputLanguage,
        getCredentialSourceHint(options.providerId, providerScopeFromAnalysisOptions(options)),
      );
      const quotaExceeded = isClaudeQuotaError(rawErrorMessage);
      console.error('[ClaudeRuntime] Quick analysis failed:', diagnosticLogIdentity(rawErrorMessage));
      this.emitUpdate({
        type: 'error',
        content: {
          message: localize(outputLanguage, `快速问答失败: ${errMsg}`, `Fast Q&A failed: ${errMsg}`),
        },
        timestamp: Date.now(),
      });
      return finalizeSourceAwareAnalysisResult({
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: localize(
          outputLanguage,
          `快速问答过程中出错: ${errMsg}`,
          `An error occurred during fast Q&A: ${errMsg}`,
        ),
        confidence: 0,
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
        terminationReason: quotaExceeded ? 'max_budget_usd' : 'execution_error',
        terminationMessage: errMsg,
      }, sourceUse);
    } finally {
      this.activeAnalyses.delete(sessionId);
      try {
        if (!delegatedRetry) {
          metricsCollector.recordTurn();
          persistSessionMetrics(
            metricsCollector.summarize(),
            analysisContextUsesPrivateKnowledge(options),
          );
        }
      } catch (metricsErr) {
        console.warn('[ClaudeRuntime] Failed to persist quick metrics:', (metricsErr as Error).message);
      }
    }
  }

  removeSession(sessionId: string): void {
    // Cancel any pending debounced save to prevent stale write after sync save
    const pendingTimer = saveTimers.get(this.sessionMap);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      saveTimers.delete(this.sessionMap);
    }
    this.removeSessionMapEntries(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionSqlErrorPartitions.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
    if (enterpriseSessionMapDbWritesEnabled()) {
      try {
        deleteClaudeSessionMapRuntimeSnapshots(sessionId);
      } catch (err) {
        console.warn('[ClaudeRuntime] Failed to delete runtime_snapshots session map:', diagnosticLogIdentity((err as Error).message));
      }
    }
    if (legacySessionMapWritesEnabled()) {
      // Use immediate save — session is being removed, must persist before cleanup completes
      savePersistedSessionMapSync(this.sessionMap);
    }
  }

  /** Clean up all session-scoped state for a given session. */
  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
    this.removeSession(sessionId);
  }

  abortSession(sessionId: string): void {
    void this.executionGuard.abortSession(sessionId);
    const handles = this.activeAbortHandles.get(sessionId);
    if (!handles) return;
    for (const handle of Array.from(handles)) {
      try {
        handle.abort();
      } catch (error) {
        console.warn('[ClaudeRuntime] Failed to abort SDK handle:', diagnosticLogIdentity((error as Error).message));
      }
    }
  }

  private registerAbortHandle(sessionId: string, handle: RuntimeAbortHandle): () => void {
    let handles = this.activeAbortHandles.get(sessionId);
    if (!handles) {
      handles = new Set();
      this.activeAbortHandles.set(sessionId, handles);
    }
    handles.add(handle);
    return () => {
      const current = this.activeAbortHandles.get(sessionId);
      if (!current) return;
      current.delete(handle);
      if (current.size === 0) this.activeAbortHandles.delete(sessionId);
    };
  }

  private abortAllSessions(): void {
    for (const sessionId of Array.from(this.activeAbortHandles.keys())) {
      this.abortSession(sessionId);
    }
    this.activeAbortHandles.clear();
  }

  /** P1-R3: Public getter for session notes — used by report generation. */
  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  /** P1-R3: Public getter for current analysis plan — used by report generation. */
  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  /** P1-R3: Public getter for uncertainty flags — used by report generation. */
  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  /** P1-1: Public getter for plan history — used for persistence. */
  getSessionPlanHistory(sessionId: string): AnalysisPlanV3[] {
    return this.sessionPlans.get(sessionId)?.history || [];
  }

  // ===========================================================================
  // Snapshot — atomic serialization / deserialization boundary
  // ===========================================================================

  /**
   * Take a snapshot of all session state for atomic persistence.
   *
   * Reads from ClaudeRuntime's 7 internal Maps (notes, plans, hypotheses,
   * flags, artifacts, architectureCache, sessionMap) and merges with
   * session-level arrays provided by the route layer.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID
   * @param sessionFields - Session-level arrays from AnalysisSession (route layer)
   */
  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const privateKnowledge = sessionFieldsUsePrivateKnowledge(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const notes = this.sessionNotes.get(sessionId) || [];
    const planState = this.sessionPlans.get(sessionId);
    const claudeHypotheses = this.sessionHypotheses.get(sessionId) || [];
    const flags = this.sessionUncertaintyFlags.get(sessionId) || [];
    const artifactStore = this.artifactStores.get(sessionId);
    const architecture = this.architectureCache.get(traceId);
    const sessionMapEntry = this.sessionMap.get(
      this.buildSessionMapKey(sessionId, sessionFields.referenceTraceId),
    );
    const sdkSessionId = !privateKnowledge && isFreshFullSdkSessionEntry(sessionMapEntry)
      ? sessionMapEntry.sdkSessionId
      : undefined;

    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,

      // Session fields (route layer) — fields match SessionFieldsForSnapshot exactly
      ...durableFields,

      // ClaudeRuntime Maps
      analysisNotes: privateKnowledge ? [] : notes,
      analysisPlan: privateKnowledge ? null : planState?.current ?? null,
      planHistory: privateKnowledge ? [] : planState?.history ?? [],
      uncertaintyFlags: privateKnowledge ? [] : flags,
      claudeHypotheses: !privateKnowledge && claudeHypotheses.length > 0 ? claudeHypotheses : undefined,

      // Cached detection
      architecture,
      engineState: createClaudeSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        sdkSessionId,
        sdkSessionMode: sdkSessionId ? 'full' : undefined,
      }),
      ...(sdkSessionId ? { sdkSessionId, sdkSessionMode: 'full' as const } : {}),
      agentRuntimeKind: 'claude-agent-sdk',
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,

      // Artifacts
      artifacts: privateKnowledge ? undefined : artifactStore?.serialize(),
    };
  }

  /**
   * Restore all ClaudeRuntime Maps from a persisted snapshot.
   *
   * Called during session resume to repopulate the 7 internal Maps
   * that are normally built up during analysis.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID (for architectureCache key)
   * @param snapshot - The persisted snapshot to restore from
   */
  restoreFromSnapshot(sessionId: string, traceId: string, snapshot: SessionStateSnapshot): void {
    if (snapshot.analysisNotes.length > 0) {
      this.sessionNotes.set(sessionId, [...snapshot.analysisNotes]);
    }

    if (snapshot.analysisPlan || snapshot.planHistory.length > 0) {
      this.sessionPlans.set(sessionId, {
        current: snapshot.analysisPlan,
        history: snapshot.planHistory,
      });
    }

    if (snapshot.claudeHypotheses && snapshot.claudeHypotheses.length > 0) {
      this.sessionHypotheses.set(sessionId, [...snapshot.claudeHypotheses]);
    }

    if (snapshot.uncertaintyFlags.length > 0) {
      this.sessionUncertaintyFlags.set(sessionId, [...snapshot.uncertaintyFlags]);
    }

    if (snapshot.artifacts && snapshot.artifacts.length > 0) {
      this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
    }

    if (snapshot.architecture) {
      setLruCacheEntry(this.architectureCache, traceId, snapshot.architecture);
    }

    const claudeEngineState = getClaudeSnapshotEngineState(snapshot);
    if (claudeEngineState?.sdkSessionId && claudeEngineState.sdkSessionMode === 'full') {
      this.sessionMap.set(this.buildSessionMapKey(sessionId, snapshot.referenceTraceId), {
        sdkSessionId: claudeEngineState.sdkSessionId,
        updatedAt: snapshot.snapshotTimestamp || Date.now(),
        mode: 'full',
      });
    }
  }

  /** P0-1: Convert agentv3 Hypothesis to agentProtocol Hypothesis format for AnalysisResult. */
  private toProtocolHypothesis(h: Hypothesis): ProtocolHypothesis {
    return toRuntimeProtocolHypothesis(h, 'claude');
  }

  reset(): void {
    this.executionGuard.clear();
    this.abortAllSessions();
    this.architectureCache.clear();
    this.vendorCache.clear();
    // Also clear all session-scoped stores to prevent unbounded growth
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionSqlErrorPartitions.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.activeAnalyses.clear();
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }

  /**
   * Collect the most recent findings from previous turns for system prompt injection.
   * Caps at 5 findings to prevent unbounded prompt growth.
   */
  private collectPreviousFindings(sessionContext: any, maxTurns?: number): Finding[] {
    return collectRecentFindings(sessionContext, { maxTurns, maxFindings: 5 });
  }

  /**
   * Build a compact entity context string for the system prompt.
   * Gives Claude awareness of known frames/sessions for drill-down resolution.
   */
  private buildEntityContext(entityStore: any): string | undefined {
    return buildEntityContext(entityStore);
  }

  /**
   * Prepare all context needed for a Claude analysis run.
   * Extracts focus app detection, architecture detection, session context,
   * scene classification, MCP server creation, and system prompt building
   * into a single cohesive preparation phase.
   */
  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    precomputed?: {
      focusResult?: Awaited<ReturnType<typeof detectFocusApps>>;
      sessionContext?: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns?: any[];
      sceneType?: SceneType;
      runtimeConfig?: ClaudeAgentConfig;
      analysisRunSpec?: AnalysisRunSpec;
      executionLease?: RuntimeExecutionLease;
      runtimePerformance?: RuntimePerformanceRun;
    },
  ) {
    const providerScope = precomputed?.analysisRunSpec?.scopes.provider
      ?? providerScopeFromAnalysisOptions(options);
    const knowledgeScope = precomputed?.analysisRunSpec?.scopes.knowledge
      ?? knowledgeScopeFromAnalysisOptions(options);
    const runtimeConfig = precomputed?.runtimeConfig
      ?? resolveRuntimeConfig(this.config, options.providerId, providerScope);
    const executionLease = precomputed?.executionLease;
    const runtimePerformance = precomputed?.runtimePerformance;
    const widenedPreflightDagAdmitted = isRuntimeCandidateAdmitted('task6');
    const startedPreflights: Promise<unknown>[] = [];
    const trackPreflight = <T>(promise: Promise<T>): Promise<T> => {
      startedPreflights.push(promise.then(
        () => undefined,
        () => undefined,
      ));
      return promise;
    };
    let serializedPreflightTail: Promise<void> = Promise.resolve();
    const schedulePreflight = <T>(work: () => Promise<T>): Promise<T> => {
      const promise = widenedPreflightDagAdmitted
        ? Promise.resolve().then(work)
        : serializedPreflightTail.then(work);
      if (!widenedPreflightDagAdmitted) {
        serializedPreflightTail = promise.then(
          () => undefined,
          () => undefined,
        );
      }
      return trackPreflight(promise);
    };
    const settleStartedPreflights = async (): Promise<void> => {
      await Promise.allSettled(startedPreflights);
    };
    const throwIfPreflightAborted = async (): Promise<void> => {
      if (!executionLease?.signal.aborted) return;
      await settleStartedPreflights();
      executionLease.throwIfAborted();
    };
    const runPreflightPhase = <T>(
      phaseName: Parameters<RuntimePerformanceRun['startPhase']>[0],
      work: () => Promise<T>,
    ): Promise<T> => {
      const phase = runtimePerformance?.startPhase(phaseName);
      return schedulePreflight(async () => {
        try {
          executionLease?.throwIfAborted();
          const value = await work();
          phase?.end(executionLease?.signal.aborted ? 'cancelled' : 'ok');
          return value;
        } catch (err) {
          phase?.end(runtimeOutcomeFromError(err, executionLease?.signal));
          throw err;
        }
      });
    };
    const skillRegistryReady = runPreflightPhase('skill_registry', async () => {
      await ensureSkillRegistryInitialized();
    });
    const knowledgeBaseContextPromise = runPreflightPhase('knowledge', async () => {
      try {
        const kb = await getExtendedKnowledgeBase();
        return kb.getContextForAI(query, 8);
      } catch {
        return undefined;
      }
    });

    // Phase 0: Selection context logging
    if (options.selectionContext) {
      const sc = options.selectionContext;
      const detail = sc.kind === 'area'
        ? `startNs=${sc.startNs}, endNs=${sc.endNs}`
        : `eventId=${sc.eventId}, ts=${sc.ts}`;
      console.log(`[ClaudeRuntime] Selection context received: kind=${sc.kind}, ${detail}`);
    }

    // Phase 0.5: Detect focus apps from trace data (reuse precomputed if available)
    let effectivePackageName = options.packageName;
    const focusResult = precomputed?.focusResult ?? await detectFocusApps(this.traceProcessorService, traceId, {
      timeRange: focusAppTimeRangeFromSelection(options.selectionContext),
    });

    if (focusResult.primaryApp) {
      if (!effectivePackageName) {
        effectivePackageName = focusResult.primaryApp;
        console.log(`[ClaudeRuntime] Auto-detected focus app: ${effectivePackageName} (via ${focusResult.method})`);
      } else {
        console.log(`[ClaudeRuntime] User-provided packageName: ${effectivePackageName}, also detected: ${focusResult.apps.map(a => a.packageName).join(', ')}`);
      }
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            runtimeConfig.outputLanguage,
            `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})`,
            `Detected focus app: ${focusResult.primaryApp} (${focusResult.method})`,
          ),
        },
        timestamp: Date.now(),
      });
    }

    // Phase 1: Skill executor setup
    const skillExecutor = createSkillExecutor(this.traceProcessorService);

    // Phase 2.8: Comparison context (dual-trace mode)
    const referenceTraceId = options.referenceTraceId;
    const comparisonContextPromise = referenceTraceId
      ? runPreflightPhase('comparison', async () => {
      console.log(`[ClaudeRuntime] Comparison mode: current=${traceId}, reference=${referenceTraceId}`);
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            runtimeConfig.outputLanguage,
            '对比模式：正在检测参考 Trace...',
            'Comparison mode: detecting the reference trace...',
          ),
        },
        timestamp: Date.now(),
      });

      const comparisonContext = await buildRuntimeTracePairComparisonContext({
        traceProcessorService: this.traceProcessorService,
        currentTraceId: traceId,
        referenceTraceId,
        ...(options.tracePairContext ? {tracePairContext: options.tracePairContext} : {}),
        detectReferenceArchitecture: async id => {
          const cached = getLruCacheEntry(this.architectureCache, id);
          if (cached) return cached;
          const detected = await createArchitectureDetector().detect({
            traceId: id,
            traceProcessorService: this.traceProcessorService,
            packageName: undefined,
          }) ?? undefined;
          if (detected) setLruCacheEntry(this.architectureCache, id, detected);
          return detected;
        },
        onCapabilityQueryError: (side, error) => {
          console.warn(
            `[ClaudeRuntime] Capability query failed for ${side} trace:`,
            diagnosticLogIdentity((error as Error).message),
          );
        },
      });

      console.log(`[ClaudeRuntime] Comparison context built: refApp=${comparisonContext?.referencePackageName || 'unknown'}, ` +
        `refArch=${comparisonContext?.referenceArchitecture?.type || 'unknown'}, commonCaps=${comparisonContext?.commonCapabilities.length ?? 0}, ` +
        `capDiff=${comparisonContext?.capabilityDiff ? `cur=${comparisonContext.capabilityDiff.currentOnly.length}/ref=${comparisonContext.capabilityDiff.referenceOnly.length}` : 'none'}`);
      return comparisonContext;
    })
      : undefined;

    // Phase 2: Architecture detection (LRU cached per traceId)
    const architecturePromise = runPreflightPhase('architecture', async () => {
      let architecture = getLruCacheEntry(this.architectureCache, traceId);
      if (!architecture) {
        try {
          const detector = createArchitectureDetector();
          architecture = await detector.detect({
            traceId,
            traceProcessorService: this.traceProcessorService,
            packageName: effectivePackageName,
          });
          if (architecture) {
            setLruCacheEntry(this.architectureCache, traceId, architecture);
          }
          this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
        } catch (err) {
          console.warn('[ClaudeRuntime] Architecture detection failed:', diagnosticLogIdentity((err as Error).message));
        }
      }
      return architecture;
    });

    // Phase 2.5: Vendor detection (LRU cached per traceId, reuses SkillAnalysisAdapter.detectVendor)
    const detectedVendorPromise = schedulePreflight(async () => {
      await architecturePromise;
      executionLease?.throwIfAborted();
      let detectedVendor = getLruCacheEntry(this.vendorCache, traceId) ?? null;
      if (!detectedVendor) {
        try {
          const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
          await adapter.ensureInitialized();
          const vendorResult = await adapter.detectVendor(traceId);
          detectedVendor = vendorResult.vendor;
          if (detectedVendor && detectedVendor !== 'aosp') {
            setLruCacheEntry(this.vendorCache, traceId, detectedVendor);
          }
        } catch (err) {
          console.warn('[ClaudeRuntime] Vendor detection failed:', diagnosticLogIdentity((err as Error).message));
        }
      }
      return detectedVendor;
    });

    // Phase 2.9: Trace data completeness probe (identity-safe shared cache)
    const traceCompletenessPromise = runPreflightPhase('completeness', async () => {
      const architecture = await architecturePromise;
      try {
        return await probeTraceCompleteness(
          this.traceProcessorService,
          traceId,
          architecture?.type,
        );
      } catch (err) {
        console.warn('[ClaudeRuntime] Trace completeness probe failed (non-fatal):', diagnosticLogIdentity((err as Error).message));
        return undefined;
      }
    });

    let architecture: Awaited<typeof architecturePromise>;
    let detectedVendor: Awaited<typeof detectedVendorPromise>;
    let traceCompleteness: Awaited<typeof traceCompletenessPromise>;
    let comparisonContext: Awaited<ReturnType<typeof buildRuntimeTracePairComparisonContext>> | undefined;
    let knowledgeBaseContext: Awaited<typeof knowledgeBaseContextPromise>;
    try {
      [architecture, detectedVendor, traceCompleteness, comparisonContext, knowledgeBaseContext] = await Promise.all([
        architecturePromise,
        detectedVendorPromise,
        traceCompletenessPromise,
        comparisonContextPromise ?? Promise.resolve(undefined),
        knowledgeBaseContextPromise,
      ]);
      await skillRegistryReady;
    } catch (error) {
      if (executionLease?.signal.aborted) {
        await settleStartedPreflights();
        executionLease.throwIfAborted();
      }
      throw error;
    }
    await throwIfPreflightAborted();
    executionLease?.throwIfAborted();

    // Phase 3: Session context + conversation history (reuse precomputed if available)
    const sessionContext = precomputed?.sessionContext ?? sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = precomputed?.previousTurns ?? (sessionContext.getAllTurns?.() || []);
    // Composite key for comparison mode session identity isolation
    const sessionMapKey = precomputed?.analysisRunSpec?.identity.sessionMapKey
      ?? this.buildSessionMapKey(sessionId, referenceTraceId);
    const sessionMapEntry = this.sessionMap.get(sessionMapKey);
    const existingSdkSession = analysisContextUsesPrivateKnowledge(options)
      ? undefined
      : isFreshFullSdkSessionEntry(sessionMapEntry)
      ? sessionMapEntry.sdkSessionId
      : undefined;
    // P0-3: SDK sessions on Anthropic's side expire after ~4 hours.
    // If the local sessionMap entry is stale, treat it as expired and inject full manual context.
    // Without this check, `hasActiveResume` stays true for stale entries, causing the system
    // to skip both SDK context (expired) AND manual context injection → silent context loss.
    const hasActiveResume = !!existingSdkSession;
    const previousFindings = hasActiveResume
      ? [] // SDK already has these in conversation history
      : this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0 && !hasActiveResume
      ? sessionContext.generatePromptContext(2000)
      : undefined;

    // Phase 4: Entity store + entity context for drill-down
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);

    // Phase 5: Scene classification + effort resolution (reuse precomputed if available)
    const sceneType = precomputed?.sceneType ?? classifyScene(query);
    const effectiveEffort = resolveEffort(runtimeConfig, sceneType, {
      configuredEffortOverridesScene: hasConfiguredClaudeEffortOverride(options.providerId, providerScope),
    });

    // Phase 5.5: Pattern memory — match similar historical traces (P2-2)
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const patternContext = privateAnalysisContext
      ? undefined
      : buildPatternContextSection(traceFeatures, knowledgeScope);
    const negativePatternContext = privateAnalysisContext
      ? undefined
      : buildNegativePatternSection(traceFeatures, knowledgeScope);
    const caseBackgroundContext = buildRuntimeCaseBackgroundContext({
      sceneType,
      architectureType: architecture?.type,
      knowledgeScope,
      outputLanguage: runtimeConfig.outputLanguage,
      privateAnalysisContext,
    });

    // Phase 6: Session-scoped artifact store + analysis notes
    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;
    // Notes restored from SessionStateSnapshot on resume — no separate disk I/O.
    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    // Phase 6.5: Session-scoped analysis plan (P0-1: Planning capability)
    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    // P1-B1: Preserve plan history (max 3 recent plans) for deeper cross-turn context
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    const previousPlan = analysisPlan.current ?? undefined;
    analysisPlan.current = null;
    resetPrePlanToolCallsForNewRun(analysisPlan);

    // Phase 6.6: Watchdog feedback ref — shared between runtime watchdog and MCP tools
    const watchdogWarning: { current: string | null } = { current: null };

    // Phase 6.7: Session-scoped hypotheses for hypothesis-verify cycle (P0-G4)
    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    // Reset for new turn (hypotheses are per-turn, resolved within each analysis cycle)
    hypotheses.splice(0);

    // Phase 6.8: Session-scoped uncertainty flags (P1-G1)
    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0); // Reset per turn

    // Phase 7: SQL error tracking for in-context learning
    // Seed new sessions with previously learned fix pairs from disk (cross-session learning)
    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope, options);
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    // Phase 8: MCP server with all session-scoped state
    // P2-G1: Destructure to get both server and auto-derived allowedTools
    await skillRegistryReady;
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      effectiveSkillRegistry.getFragmentCache(),
    );
    const fullNotesBudget = createRuntimeSkillNotesBudget(false);
    const { server: mcpServer, allowedTools, toolDefinitions, sourceUse } = createClaudeMcpServer({
      conversationTraceAttached: options.assistantSurface === 'conversation'
        ? options.conversationTraceAttached === true
        : undefined,
      runManifestAttributionSink: options.runManifestAttributionSink,
      sessionId,
      traceId,
      userQuery: query,
      traceProcessorService: this.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      emitUpdate: (update) => this.emitUpdate(update),
      onSkillResult: (result) => {
        if (result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      cachedVendor: detectedVendor,
      recentSqlErrors: sqlErrors,
      analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId,
      comparisonContext,
      skillNotesBudget: fullNotesBudget,
      outputLanguage: runtimeConfig.outputLanguage,
      knowledgeScope,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      sourceUsePolicy: options.sourceUsePolicy,
      analysisContextFingerprint: options.analysisContextFingerprint,
      androidInternalsPackPin: options.androidInternalsPackPin,
    });

    // Phase 9: (removed — skillCatalog was populated but never used in prompt;
    //           Claude uses list_skills MCP tool on demand instead)

    // Phase 10: Knowledge base context was prepared before session-state reset
    // and remains non-fatal — Claude can use lookup_sql_schema tool.

    // Phase 11: Sub-agent definitions (feature-gated)
    let agents: Record<string, any> | undefined;
    if (runtimeConfig.enableSubAgents && sceneType !== 'anr') {
      agents = buildAgentDefinitions(sceneType, {
        architecture,
        packageName: effectivePackageName,
        allowedTools,
        toolDefinitions,
        codeAwareMode: options.codeAwareMode,
        codebaseIds: options.codebaseIds,
        outputLanguage: runtimeConfig.outputLanguage,
        subAgentModel: runtimeConfig.subAgentModel,
      });
    }

    // Phase 12: SQL error-fix pairs for prompt injection
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));

    // Phase 13: System prompt assembly
    const traceInfo = this.traceProcessorService.getTrace(traceId);
    const analysisContextForRebuild: ClaudeAnalysisContext = {
      query,
      architecture,
      packageName: effectivePackageName,
      focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
      focusMethod: focusResult.method,
      previousFindings,
      conversationSummary,
      knowledgeBaseContext,
      entityContext,
      sceneType,
      analysisNotes: notes.length > 0 ? notes : undefined,
      availableAgents: agents ? Object.keys(agents) : undefined,
      sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
      patternContext,
      negativePatternContext,
      caseBackgroundContext,
      previousPlan,
      planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
      selectionContext: options.selectionContext,
      comparison: comparisonContext,
      traceCompleteness,
      traceOs: traceInfo?.traceOs,
      traceFormat: traceInfo?.traceFormat,
      outputLanguage: runtimeConfig.outputLanguage,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
    };
    const systemPromptParts = buildSystemPromptParts(analysisContextForRebuild);
    const systemPrompt = systemPromptParts.fullPrompt;
    const sdkSystemPrompt = buildClaudeSdkSystemPrompt(
      systemPromptParts,
      this.runtimeCapabilities,
    );

    return {
      mcpServer,
      systemPrompt,
      sdkSystemPrompt,
      effectiveEffort,
      agents,
      sessionContext,
      previousTurns,
      entityStore,
      analysisPlan,
      architecture,
      watchdogWarning,
      hypotheses,
      sceneType,
      allowedTools, // P2-G1: auto-derived from MCP server registration
      analysisContextForRebuild, // Used by correction retry to rebuild prompt with reduced budget
      sessionMapKey, // Composite key for comparison mode session identity isolation
      analysisRunSpec: precomputed?.analysisRunSpec,
      sourceUse,
    };
  }


  /** Capture entities from skill displayResults into EntityStore for multi-turn drill-down. */
  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    captureSkillDisplayEntities(displayResults, entityStore, 'claude-agent');
  }
}

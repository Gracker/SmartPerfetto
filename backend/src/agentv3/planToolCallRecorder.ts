// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  expectedCallMatchesRecord,
  expectedToolNames,
  formatExpectedCall,
  isEvidenceCapableToolName,
  phaseMatchesCall,
  type AnalysisPlanV3,
  type ExpectedCall,
  type PlanPhase,
  type ToolCallRecord,
} from './types';
import {
  isComparisonSynthesisPlanPhase,
  isConclusionLikePlanPhase,
} from './planPhaseSemantics';
import { summarizeToolCallInput } from './toolCallSummary';
import {
  getSourceLookupCodeReferences,
  rememberSourceLookupCodeReferences,
  sourceLookupResultHasCodeReferences,
  type SourceLookupCodeReference,
} from '../services/codebase/sourceLookupTools';

const MCP_NAME_PREFIX = 'mcp__smartperfetto__';
const MAX_PLAN_TOOL_CALL_LOG = 100;

export interface PlanToolCallRecorderInput {
  toolName: string;
  input?: unknown;
  resultText?: string;
  /** Privacy-safe fact extracted from the raw result before any external-surface projection. */
  returnedCodeReferences?: boolean;
  /** Ephemeral only: retained in memory and never copied into ToolCallRecord or snapshots. */
  returnedCodeReferenceHints?: readonly SourceLookupCodeReference[];
  timestamp?: number;
}

export interface AnalysisPlanTracker {
  current: AnalysisPlanV3 | null;
  prePlanToolCallLog?: ToolCallRecord[];
}

export function resetPrePlanToolCallsForNewRun(
  tracker: AnalysisPlanTracker | null | undefined,
): void {
  if (tracker) tracker.prePlanToolCallLog = [];
}

export interface PlanEvidenceGap {
  phase: PlanPhase;
  matchedCalls: ToolCallRecord[];
  missingExpectedCalls: ExpectedCall[];
  /** True when a legacy expectedTools-only phase has no valid call attributed to it. */
  missingGenericToolEvidence?: boolean;
}

export interface PhaseToolEvidenceStatus {
  satisfied: boolean;
  matchedCalls: ToolCallRecord[];
  missingExpectedCalls: ExpectedCall[];
  missingGenericToolEvidence: boolean;
}

function shortToolName(toolName: string): string {
  return toolName.startsWith(MCP_NAME_PREFIX) ? toolName.slice(MCP_NAME_PREFIX.length) : toolName;
}

function buildToolCallRecord(input: PlanToolCallRecorderInput): ToolCallRecord {
  const callSummary = summarizeToolCallInput(shortToolName(input.toolName), input.input);
  const success = extractToolCallSuccessFromResult(input.resultText);
  const returnedCodeReferences = input.returnedCodeReferences ?? (
    Boolean(input.returnedCodeReferenceHints?.length) ||
    sourceLookupResultHasCodeReferences(input.toolName, input.resultText)
  );
  return {
    toolName: input.toolName,
    timestamp: input.timestamp ?? Date.now(),
    ...(success === undefined ? {} : { success }),
    ...(returnedCodeReferences ? { returnedCodeReferences: true } : {}),
    ...callSummary,
  };
}

function parseLeadingJsonObject(text: string): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function collectToolResultCandidates(resultText: string): string[] {
  const candidates = [resultText];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(entry => collect(entry, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') candidates.push(record.text);
    if (typeof record.output === 'string') candidates.push(record.output);
    collect(record.content, depth + 1);
    collect(record.result, depth + 1);
  };

  try {
    collect(JSON.parse(resultText), 0);
  } catch {
    // A tool result may append a reasoning nudge after its leading JSON object.
  }
  return [...new Set(candidates)];
}

export function extractToolCallSuccessFromResult(resultText?: string): boolean | undefined {
  if (!resultText) return undefined;
  for (const candidate of collectToolResultCandidates(resultText)) {
    const parsed = parseLeadingJsonObject(candidate.trim());
    if (!parsed) continue;
    if (typeof parsed.success === 'boolean') return parsed.success;
    if (parsed.isError === true) return false;
    if (parsed.outcome === 'success') return true;
    if (
      parsed.outcome === 'rejected' ||
      parsed.outcome === 'budget_exceeded' ||
      parsed.outcome === 'consent_blocked' ||
      parsed.outcome === 'license_blocked' ||
      parsed.outcome === 'unresolved' ||
      parsed.outcome === 'sidecar_missing'
    ) {
      return false;
    }
  }
  return undefined;
}

export function extractPlanPhaseIdFromToolResult(resultText?: string): string | undefined {
  if (!resultText) return undefined;
  for (const candidate of collectToolResultCandidates(resultText)) {
    const trimmed = candidate.trim();
    const parsed = parseLeadingJsonObject(trimmed);
    const planPhaseId = parsed?.planPhaseId;
    if (typeof planPhaseId === 'string' && planPhaseId.trim()) return planPhaseId.trim();
  }
  return undefined;
}

export function recordPlanToolCall(
  plan: AnalysisPlanV3 | null | undefined,
  input: PlanToolCallRecorderInput,
): ToolCallRecord | undefined {
  if (!plan) return undefined;
  if (!Array.isArray(plan.toolCallLog)) {
    plan.toolCallLog = [];
  }
  const shortName = shortToolName(input.toolName);
  const canSatisfyEvidence = isEvidenceCapableToolName(shortName);
  const candidate = buildToolCallRecord(input);

  const expectedGapPhase = canSatisfyEvidence
    ? findBestPhaseForExpectedCallGap(plan, candidate, 'structured_only')
    : undefined;
  const toolReturnedPhaseId = extractPlanPhaseIdFromToolResult(input.resultText);
  let matchedPhaseId = expectedGapPhase?.id;

  if (!matchedPhaseId && canSatisfyEvidence) {
    const returnedPhase = toolReturnedPhaseId
      ? plan.phases.find(phase => phase.id === toolReturnedPhaseId)
      : undefined;
    matchedPhaseId = returnedPhase && phaseMatchesCall(returnedPhase, candidate)
      ? returnedPhase.id
      : undefined;
  }

  if (!matchedPhaseId && canSatisfyEvidence) {
    const activePhase = plan.phases.find(p => p.status === 'in_progress');
    if (activePhase && phaseMatchesCall(activePhase, candidate)) {
      matchedPhaseId = activePhase.id;
    }
  }
  if (!matchedPhaseId && canSatisfyEvidence) {
    const pendingMatches = plan.phases.filter(p =>
      p.status === 'pending' && phaseMatchesCall(p, candidate),
    );
    matchedPhaseId = pendingMatches.length === 1 ? pendingMatches[0].id : undefined;
  }

  const record = { ...candidate, matchedPhaseId };
  plan.toolCallLog.push(record);
  rememberSourceLookupCodeReferences(plan, input.returnedCodeReferenceHints ?? []);
  if (plan.toolCallLog.length > MAX_PLAN_TOOL_CALL_LOG) {
    plan.toolCallLog.splice(0, plan.toolCallLog.length - MAX_PLAN_TOOL_CALL_LOG);
  }
  return record;
}

export function recordPlanOrPrePlanToolCall(
  tracker: AnalysisPlanTracker | null | undefined,
  input: PlanToolCallRecorderInput,
): ToolCallRecord | undefined {
  if (!tracker) return undefined;
  if (tracker.current) {
    return recordPlanToolCall(tracker.current, input);
  }

  const shortName = shortToolName(input.toolName);
  if (!isEvidenceCapableToolName(shortName)) return undefined;

  if (!Array.isArray(tracker.prePlanToolCallLog)) {
    tracker.prePlanToolCallLog = [];
  }
  const record = buildToolCallRecord(input);
  tracker.prePlanToolCallLog.push(record);
  rememberSourceLookupCodeReferences(record, input.returnedCodeReferenceHints ?? []);
  if (tracker.prePlanToolCallLog.length > MAX_PLAN_TOOL_CALL_LOG) {
    tracker.prePlanToolCallLog.splice(0, tracker.prePlanToolCallLog.length - MAX_PLAN_TOOL_CALL_LOG);
  }
  return record;
}

export function replayPrePlanToolCalls(tracker: AnalysisPlanTracker | null | undefined): number {
  const plan = tracker?.current;
  const prePlanToolCallLog = tracker?.prePlanToolCallLog;
  if (!plan || !Array.isArray(prePlanToolCallLog) || prePlanToolCallLog.length === 0) return 0;
  if (!Array.isArray(plan.toolCallLog)) {
    plan.toolCallLog = [];
  }

  let replayed = 0;
  for (const candidate of prePlanToolCallLog) {
    const matchedPhase = findBestPhaseForExpectedCallGap(
      plan,
      candidate,
      'structured_or_generic',
    );
    if (!matchedPhase) continue;
    plan.toolCallLog.push({
      ...candidate,
      matchedPhaseId: matchedPhase.id,
    });
    rememberSourceLookupCodeReferences(plan, getSourceLookupCodeReferences(candidate));
    replayed++;
    if (plan.toolCallLog.length > MAX_PLAN_TOOL_CALL_LOG) {
      plan.toolCallLog.splice(0, plan.toolCallLog.length - MAX_PLAN_TOOL_CALL_LOG);
    }
  }

  tracker.prePlanToolCallLog = [];
  return replayed;
}

export function findMissingExpectedCallsForPhase(
  phase: PlanPhase,
  toolCallLog: readonly ToolCallRecord[],
): ExpectedCall[] {
  const expectedCalls = phase.expectedCalls ?? [];
  if (expectedCalls.length === 0) return [];
  const matchedCalls = toolCallLog.filter(call => call.matchedPhaseId === phase.id);
  return expectedCalls
    .filter(call => !matchedCalls.some(record => expectedCallMatchesRecord(call, record)));
}

function expectedCallWasExecutedAnywhere(
  toolCallLog: readonly ToolCallRecord[],
  expectedCall: ExpectedCall,
): boolean {
  return toolCallLog.some(record => expectedCallMatchesRecord(expectedCall, record));
}

function hasNonConclusionPhaseToolEvidence(
  plan: AnalysisPlanV3,
  conclusionPhaseId: string,
  toolCallLog: readonly ToolCallRecord[],
): boolean {
  const phaseById = new Map(plan.phases.map(phase => [phase.id, phase]));
  return toolCallLog.some(record => {
    if (!record.matchedPhaseId || record.matchedPhaseId === conclusionPhaseId) return false;
    const matchedPhase = phaseById.get(record.matchedPhaseId);
    return Boolean(
      matchedPhase &&
      !isConclusionLikePlanPhase(matchedPhase) &&
      phaseMatchesCall(matchedPhase, record),
    );
  });
}

function hasPriorNonConclusionMatchingToolEvidence(
  plan: AnalysisPlanV3,
  phase: PlanPhase,
  toolCallLog: readonly ToolCallRecord[],
): boolean {
  const phaseById = new Map(plan.phases.map(entry => [entry.id, entry]));
  const phaseIndex = plan.phases.findIndex(entry => entry.id === phase.id);
  return toolCallLog.some(record => {
    if (!record.matchedPhaseId || record.matchedPhaseId === phase.id) return false;
    const matchedPhase = phaseById.get(record.matchedPhaseId);
    if (
      !matchedPhase ||
      isConclusionLikePlanPhase(matchedPhase) ||
      !phaseMatchesCall(matchedPhase, record)
    ) {
      return false;
    }
    if (phaseIndex >= 0) {
      const matchedIndex = plan.phases.findIndex(entry => entry.id === matchedPhase.id);
      if (matchedIndex > phaseIndex) return false;
    }
    return phaseMatchesCall(phase, record);
  });
}

/**
 * Single source of truth for whether a phase has fulfilled its tool-evidence
 * contract. Structured calls are exact requirements; legacy expectedTools
 * require at least one valid call attributed to the phase. A pure conclusion
 * phase may reuse valid evidence from an earlier non-conclusion phase.
 */
export function getPhaseToolEvidenceStatus(
  plan: AnalysisPlanV3,
  phase: PlanPhase,
  toolCallLog: readonly ToolCallRecord[] = plan.toolCallLog,
): PhaseToolEvidenceStatus {
  const matchedCalls = toolCallLog.filter(record =>
    record.matchedPhaseId === phase.id && phaseMatchesCall(phase, record),
  );
  const missingForPhase = findMissingExpectedCallsForPhase(phase, toolCallLog);
  const conclusionLike = isConclusionLikePlanPhase(phase);
  const missingExpectedCalls = conclusionLike
    ? missingForPhase.filter(call => !expectedCallWasExecutedAnywhere(toolCallLog, call))
    : missingForPhase;

  const hasReusableConclusionEvidence = conclusionLike &&
    hasNonConclusionPhaseToolEvidence(plan, phase.id, toolCallLog);
  const hasReusableComparisonEvidence = isComparisonSynthesisPlanPhase(phase) &&
    hasPriorNonConclusionMatchingToolEvidence(plan, phase, toolCallLog);
  const missingGenericToolEvidence = missingExpectedCalls.length === 0 &&
    (phase.expectedTools ?? []).length > 0 &&
    matchedCalls.length === 0 &&
    !hasReusableConclusionEvidence &&
    !hasReusableComparisonEvidence;

  return {
    satisfied: missingExpectedCalls.length === 0 && !missingGenericToolEvidence,
    matchedCalls,
    missingExpectedCalls,
    missingGenericToolEvidence,
  };
}

export function findBestPhaseForExpectedCallGap(
  plan: AnalysisPlanV3,
  record: ToolCallRecord,
  mode: 'structured_only' | 'structured_or_generic',
): PlanPhase | undefined {
  const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
  const phasesWithStructuredGap = plan.phases.filter(phase => {
    if (phase.status === 'skipped') return false;
    const missingExpectedCalls = findMissingExpectedCallsForPhase(phase, toolCallLog);
    return missingExpectedCalls.some(call => expectedCallMatchesRecord(call, record));
  });
  const phasesWithMatchingGap = phasesWithStructuredGap.length > 0 || mode === 'structured_only'
    ? phasesWithStructuredGap
    : plan.phases.filter(phase => {
        if (phase.status === 'skipped' || !phaseMatchesCall(phase, record)) return false;
        return !toolCallLog.some(call =>
          call.matchedPhaseId === phase.id && phaseMatchesCall(phase, call),
        );
      });
  if (phasesWithMatchingGap.length === 0) return undefined;

  const statusPriority: Record<PlanPhase['status'], number> = {
    in_progress: 0,
    completed: 1,
    pending: 2,
    skipped: 3,
  };
  const highestPriority = Math.min(
    ...phasesWithMatchingGap.map(phase => statusPriority[phase.status]),
  );
  const highestPriorityMatches = phasesWithMatchingGap.filter(
    phase => statusPriority[phase.status] === highestPriority,
  );
  return highestPriorityMatches.length === 1 ? highestPriorityMatches[0] : undefined;
}

export function findCompletedPhaseEvidenceGaps(plan: AnalysisPlanV3): PlanEvidenceGap[] {
  const gaps: PlanEvidenceGap[] = [];
  const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
  for (const phase of plan.phases) {
    if (phase.status !== 'completed') continue;
    const status = getPhaseToolEvidenceStatus(plan, phase, toolCallLog);
    if (!status.satisfied) {
      gaps.push({
        phase,
        matchedCalls: status.matchedCalls,
        missingExpectedCalls: status.missingExpectedCalls,
        ...(status.missingGenericToolEvidence ? {missingGenericToolEvidence: true} : {}),
      });
    }
  }
  return gaps;
}

export function formatPlanEvidenceGap(gap: PlanEvidenceGap, outputLanguage: string = 'zh-CN'): string {
  const expected = expectedToolNames(gap.phase).join(', ');
  if (gap.missingGenericToolEvidence) {
    if (outputLanguage === 'en') {
      return `Phase "${gap.phase.name}" (${gap.phase.id}) has no matching tool evidence; run one of: ${expected}`;
    }
    return `阶段 "${gap.phase.name}" (${gap.phase.id}) 没有匹配的工具证据；请至少执行以下工具之一: ${expected}`;
  }
  const missing = gap.missingExpectedCalls.map(formatExpectedCall).join(', ');
  if (outputLanguage === 'en') {
    return `Phase "${gap.phase.name}" (${gap.phase.id}) is missing required structured calls: ${missing}; expected: ${expected}`;
  }
  return `阶段 "${gap.phase.name}" (${gap.phase.id}) 缺少结构化预期调用: ${missing}; 阶段预期: ${expected}`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  expectedCallMatchesRecord,
  getPlanToolCapability,
  isEvidenceCapableToolName,
  phaseMatchesCall,
  type AnalysisPlanV3,
  type ExpectedCall,
  type PlanPhase,
  type ToolCallRecord,
} from './types';
import {resolvePlanPhaseForCall} from './planPhaseSemantics';
import { summarizeToolCallInput } from './toolCallSummary';
import {readRuntimeToolResultFacts, type RuntimeToolResultFacts} from '../agentRuntime/runtimeToolResult';

const MCP_NAME_PREFIX = 'mcp__smartperfetto__';
const MAX_PLAN_TOOL_CALL_LOG = 100;

export interface PlanToolCallRecorderInput {
  toolName: string;
  /** Actual SDK/handler invocation ID. Never substitute a parameter hash. */
  toolCallId?: string;
  /** Emitted only after recorded success completes an earlier pending phase. */
  onPhaseAutoCompleted?: (phase: PlanPhase) => void;
  input?: unknown;
  /**
   * Transport form of the result: byte-truncated to
   * `DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS`. Structured facts must not be
   * re-derived from it — a realistic 13.8 KB skill result truncates to 2000
   * chars and loses both `planPhaseId` and `success`, because both are
   * appended after the result body. Pass `resultFacts` instead; this stays
   * only as the fallback for callers that have nothing better.
   */
  resultText?: string;
  /**
   * Facts read from the intact result, before truncation or external-surface
   * projection. Without these, a large result silently degrades plan phase
   * attribution to an unresolved dispatch and leaves tool success unknown.
   */
  resultFacts?: ToolResultFacts;
  timestamp?: number;
}

export interface AnalysisPlanTracker {
  current: AnalysisPlanV3 | null;
  prePlanToolCallLog?: ToolCallRecord[];
  /**
   * How many tool calls this run has dispatched, counted once and never
   * revised.
   *
   * The bounded logs can be trimmed or transferred during plan submission.
   * Their lengths cannot provide a monotone dispatch count.
   */
  dispatchedToolCallCount?: number;
}

const recordedCallIds = new WeakMap<AnalysisPlanTracker, Set<string>>();

function realToolCallId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id && id !== 'unknown' ? id : undefined;
}

export function resetPrePlanToolCallsForNewRun(
  tracker: AnalysisPlanTracker | null | undefined,
): void {
  if (!tracker) return;
  tracker.prePlanToolCallLog = [];
  tracker.dispatchedToolCallCount = 0;
  recordedCallIds.delete(tracker);
}

export interface PlanEvidenceGap {
  phase: PlanPhase;
  matchedCalls: ToolCallRecord[];
  missingExpectedCalls: ExpectedCall[];
  /** True when a legacy expectedTools-only phase has no valid call attributed to it. */
  missingGenericToolEvidence?: boolean;
  missingExpectedTools?: string[];
}

export interface PhaseToolEvidenceStatus {
  satisfied: boolean;
  matchedCalls: ToolCallRecord[];
  missingExpectedCalls: ExpectedCall[];
  missingGenericToolEvidence: boolean;
  missingExpectedTools: string[];
}

function shortToolName(toolName: string): string {
  return toolName.startsWith(MCP_NAME_PREFIX) ? toolName.slice(MCP_NAME_PREFIX.length) : toolName;
}

function buildToolCallRecord(input: PlanToolCallRecorderInput): ToolCallRecord {
  const callSummary = summarizeToolCallInput(shortToolName(input.toolName), input.input);
  const success = input.resultFacts !== undefined
    ? input.resultFacts.success : extractToolCallSuccessFromResult(input.resultText);
  const planCapability = getPlanToolCapability(input.toolName);
  const requestedPhaseId = input.input && typeof input.input === 'object'
    ? (input.input as Record<string, unknown>).planPhaseId : undefined;
  return {
    toolName: input.toolName,
    ...(realToolCallId(input.toolCallId) ? {toolCallId: realToolCallId(input.toolCallId)} : {}),
    timestamp: input.timestamp ?? Date.now(),
    ...(planCapability === 'evidence' ? {} : {planCapability}),
    ...(success === undefined ? {} : { success }),
    ...(typeof requestedPhaseId === 'string' ? {requestedPhaseId} : {}),
    ...callSummary,
  };
}

export type ToolResultFacts = RuntimeToolResultFacts;

export function readToolResultFacts(result: unknown): ToolResultFacts {
  return readRuntimeToolResultFacts(result);
}

export function extractToolCallSuccessFromResult(resultText?: string): boolean | undefined {
  return readToolResultFacts(resultText).success;
}

export function extractPlanPhaseIdFromToolResult(resultText?: string): string | undefined {
  return readToolResultFacts(resultText).planPhaseId;
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

  const returnedPhaseId = input.resultFacts !== undefined
    ? input.resultFacts.planPhaseId : extractPlanPhaseIdFromToolResult(input.resultText);
  const explicitPhaseId = candidate.requestedPhaseId ?? returnedPhaseId;
  const conflictingPhaseIds = candidate.requestedPhaseId !== undefined && returnedPhaseId !== undefined &&
    candidate.requestedPhaseId !== returnedPhaseId;
  const matchedPhaseId = canSatisfyEvidence && !conflictingPhaseIds
    ? resolvePlanPhaseForCall(plan, candidate, explicitPhaseId).phase?.id
    : undefined;

  const record = { ...candidate, matchedPhaseId };
  plan.toolCallLog.push(record);
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
  const toolCallId = realToolCallId(input.toolCallId);
  if (toolCallId) {
    const seen = recordedCallIds.get(tracker) ?? new Set<string>();
    if (seen.has(toolCallId)) return undefined;
    seen.add(toolCallId);
    recordedCallIds.set(tracker, seen);
  }
  // Counted before any filtering: the model dispatched this call whether or not
  // the call is one the plan cares to remember.
  tracker.dispatchedToolCallCount = (tracker.dispatchedToolCallCount ?? 0) + 1;
  if (tracker.current) {
    const record = recordPlanToolCall(tracker.current, input);
    if (record) reconcileSuccessfulBackfill(tracker.current, record, input.onPhaseAutoCompleted);
    return record;
  }

  const shortName = shortToolName(input.toolName);
  if (!isEvidenceCapableToolName(shortName)) {
    return undefined;
  }

  if (!Array.isArray(tracker.prePlanToolCallLog)) {
    tracker.prePlanToolCallLog = [];
  }
  const record = buildToolCallRecord(input);
  tracker.prePlanToolCallLog.push(record);
  if (tracker.prePlanToolCallLog.length > MAX_PLAN_TOOL_CALL_LOG) {
    tracker.prePlanToolCallLog.splice(0, tracker.prePlanToolCallLog.length - MAX_PLAN_TOOL_CALL_LOG);
  }
  return record;
}

function reconcileSuccessfulBackfill(
  plan: AnalysisPlanV3,
  record: ToolCallRecord,
  notify?: (phase: PlanPhase) => void,
): void {
  if (record.success !== true || !record.matchedPhaseId) return;
  const index = plan.phases.findIndex(phase => phase.id === record.matchedPhaseId);
  const phase = plan.phases[index];
  if (!phase || phase.status !== 'pending') return;
  if (!(phase.expectedCalls?.length || phase.expectedTools?.length)) return;
  if (!plan.phases.some((candidate, position) => position > index && candidate.status === 'in_progress')) return;
  if (!getPhaseToolEvidenceStatus(plan, phase).satisfied) return;
  phase.status = 'completed';
  phase.completedAt = record.timestamp;
  phase.completionSource = 'evidence_backfill';
  try { notify?.(phase); } catch { /* Display observers cannot change a recorded tool outcome. */ }
}

/**
 * How many tool calls this run dispatched.
 *
 * Reads the monotone counter, not the logs: see `dispatchedToolCallCount` for
 * why the logs cannot answer this. Every runtime dispatches through
 * `recordPlanOrPrePlanToolCall`, so this is the provider-neutral signal and
 * runtimes should read it here rather than keeping private counters that drift.
 */
export function countDispatchedToolCalls(
  tracker: AnalysisPlanTracker | null | undefined,
): number {
  return tracker?.dispatchedToolCallCount ?? 0;
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
    const matchedPhase = resolvePlanPhaseForCall(plan, candidate, candidate.requestedPhaseId).phase;
    plan.toolCallLog.push({
      ...candidate,
      matchedPhaseId: matchedPhase?.id,
    });
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
  const matchedCalls = toolCallLog.filter(call => call.success === true && call.matchedPhaseId === phase.id);
  return expectedCalls
    .filter(call => !matchedCalls.some(record => expectedCallMatchesRecord(call, record)));
}

/** Only successful receipts attributed to this phase satisfy its declared calls. */
export function getPhaseToolEvidenceStatus(
  plan: AnalysisPlanV3,
  phase: PlanPhase,
  toolCallLog: readonly ToolCallRecord[] = plan.toolCallLog,
): PhaseToolEvidenceStatus {
  const matchedCalls = toolCallLog.filter(record =>
    record.success === true && record.matchedPhaseId === phase.id && phaseMatchesCall(phase, record),
  );
  const missingExpectedCalls = findMissingExpectedCallsForPhase(phase, toolCallLog);
  const structuredTools = new Set((phase.expectedCalls ?? []).map(call => shortToolName(call.tool)));
  const missingExpectedTools = [...new Set((phase.expectedTools ?? []).map(shortToolName))]
    .filter(tool => !structuredTools.has(tool) && !matchedCalls.some(call => shortToolName(call.toolName) === tool));
  const missingGenericToolEvidence = missingExpectedTools.length > 0;

  return {
    satisfied: missingExpectedCalls.length === 0 && !missingGenericToolEvidence,
    matchedCalls,
    missingExpectedCalls,
    missingGenericToolEvidence,
    missingExpectedTools,
  };
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
        missingExpectedTools: status.missingExpectedTools,
        ...(status.missingGenericToolEvidence ? {missingGenericToolEvidence: true} : {}),
      });
    }
  }
  return gaps;
}

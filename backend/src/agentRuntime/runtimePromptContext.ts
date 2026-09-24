// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceDataset } from '../agent/core/orchestratorTypes';
import type { QuickRunContextInjectedCounts } from '../agent/core/orchestratorTypes';
import type { Finding, SubAgentResult } from '../agent/types';
import type { ComparisonContext, TracePairContext } from '../agentv3/types';
import type {ArchitectureInfo} from '../agent/detectors/types';
import {
  detectFocusApps,
  focusAppTimeRangeFromSelection,
  type FocusAppDetectionResult,
  type FocusAppTimeRange,
} from '../agentv3/focusAppDetector';
import {
  comparisonPackageSources,
  hasFocusAppDetectionData,
  resolveFocusAppTarget,
  type FocusAppTarget,
} from './focusAppTarget';
import type {RuntimeTurnPolicy} from './runtimeTurnPolicy';
import type {FinalResultComparisonIdentity} from '../services/finalResultQualityGate';
import {createArchitectureDetector} from '../agent/detectors/architectureDetector';
import type {TraceProcessorService} from '../services/traceProcessorService';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import {renderAnalysisHistoryContext, toAnalysisHistoryTurn} from './analysisHistory';

function freezeComparisonContext<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach(child => freezeComparisonContext(child, seen));
  return Object.freeze(value);
}

/**
 * The run's focus-app detection, shared by every runtime: it runs only when the
 * turn's preflight gathers trace facts, scoped to `timeRange` or else to the
 * selection's range. `measure` wraps the detection (a runtime phase span, a
 * non-fatal failure); `undefined` means no detection, which
 * `resolveFocusAppTarget` reads as nothing detected.
 */
export async function detectRunFocusApps(input: {
  traceProcessorService: TraceProcessorService;
  traceId: string;
  preflight: RuntimeTurnPolicy['preflight'];
  selectionContext?: Parameters<typeof focusAppTimeRangeFromSelection>[0];
  /** An explicit scope that overrides the selection's range (Qoder accepts one in its options). */
  timeRange?: FocusAppTimeRange;
  measure?: (detect: () => Promise<FocusAppDetectionResult>) => Promise<FocusAppDetectionResult | undefined>;
}): Promise<FocusAppDetectionResult | undefined> {
  if (input.preflight === 'none') return undefined;
  const detect = () => detectFocusApps(input.traceProcessorService, input.traceId, {
    timeRange: input.timeRange ?? focusAppTimeRangeFromSelection(input.selectionContext),
  });
  return input.measure ? input.measure(detect) : detect();
}

/** Both sides of a comparison's package identity, with their provenance; undefined without a comparison. */
export function buildComparisonIdentity(
  focusTarget: FocusAppTarget,
  comparison: ComparisonContext | undefined,
): FinalResultComparisonIdentity | undefined {
  if (!comparison) return undefined;
  return {
    currentPackageName: focusTarget.packageName,
    referencePackageName: comparison.referencePackageName,
    ...comparisonPackageSources(focusTarget, comparison),
  };
}

/** Pure pair identity. Presence of a reference trace does not authorize a probe. */
export function buildRuntimeTracePairIdentityContext(input: {
  referenceTraceId?: string;
  tracePairContext?: TracePairContext;
}): ComparisonContext | undefined {
  if (!input.referenceTraceId) return undefined;
  return freezeComparisonContext<ComparisonContext>({
    referenceTraceId: input.referenceTraceId,
    ...(input.tracePairContext ? {tracePairContext: structuredClone(input.tracePairContext)} : {}),
    commonCapabilities: [],
    capabilityProbeStatus: 'not_checked',
  });
}

export async function buildRuntimeTracePairComparisonContext(input: {
  readonly traceProcessorService: TraceProcessorService;
  readonly currentTraceId: string;
  readonly referenceTraceId?: string;
  readonly tracePairContext?: TracePairContext;
  readonly detectReferenceArchitecture?: (traceId: string) => Promise<ArchitectureInfo | undefined>;
  readonly onCapabilityQueryError?: (
    side: 'current' | 'reference',
    error: unknown,
  ) => void;
}): Promise<ComparisonContext | undefined> {
  const identity = buildRuntimeTracePairIdentityContext(input);
  if (!identity) return undefined;
  const referenceTraceId = identity.referenceTraceId;
  const capabilitySql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE 'android_%' OR name LIKE 'linux_%' OR name LIKE 'sched_%' OR name LIKE 'slices_%')";
  const [referenceFocus, referenceArchitecture, currentTables, referenceTables] = await Promise.all([
    detectFocusApps(input.traceProcessorService, referenceTraceId).catch(() => undefined),
    (input.detectReferenceArchitecture
      ? input.detectReferenceArchitecture(referenceTraceId)
      : createArchitectureDetector().detect({
          traceId: referenceTraceId,
          traceProcessorService: input.traceProcessorService,
          packageName: undefined,
        })).catch(() => undefined),
    input.traceProcessorService.query(input.currentTraceId, capabilitySql).catch(error => {
      input.onCapabilityQueryError?.('current', error);
      return null;
    }),
    input.traceProcessorService.query(referenceTraceId, capabilitySql).catch(error => {
      input.onCapabilityQueryError?.('reference', error);
      return null;
    }),
  ]);

  let commonCapabilities: string[] = [];
  let capabilityDiff: ComparisonContext['capabilityDiff'];
  const capabilityProbeSucceeded = currentTables && referenceTables
    && currentTables.error === undefined && referenceTables.error === undefined;
  if (capabilityProbeSucceeded) {
    const current = new Set(currentTables.rows.map((row: unknown[]) => String(row[0])));
    const reference = new Set(referenceTables.rows.map((row: unknown[]) => String(row[0])));
    commonCapabilities = [...current].filter(name => reference.has(name)).sort();
    const currentOnly = [...current].filter(name => !reference.has(name)).sort();
    const referenceOnly = [...reference].filter(name => !current.has(name)).sort();
    if (currentOnly.length > 0 || referenceOnly.length > 0) {
      capabilityDiff = {currentOnly, referenceOnly};
    }
  }

  // The reference side has no user-named package: only a confident inference
  // becomes its effective package, and the candidates travel with it.
  const referenceFocusTarget = referenceFocus ? resolveFocusAppTarget({focusResult: referenceFocus}) : undefined;
  return {
    ...identity,
    referencePackageName: referenceFocusTarget?.packageName,
    ...(hasFocusAppDetectionData(referenceFocusTarget) ? {referenceFocusTarget} : {}),
    referenceArchitecture,
    commonCapabilities,
    capabilityProbeStatus: capabilityProbeSucceeded ? 'checked' : 'unavailable',
    capabilityDiff,
  };
}

export function formatTraceContext(
  datasets: TraceDataset[] | undefined,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  if (!datasets || datasets.length === 0) return '';
  const parts = datasets.map((d) => {
    const sourceLines = [
      d.evidenceRefId ? `- evidence_ref_id: \`${d.evidenceRefId}\`` : undefined,
      d.sourceToolCallId ? `- source_tool_call_id: \`${d.sourceToolCallId}\`` : undefined,
      d.queryHash ? `- query_hash: \`${d.queryHash}\`` : undefined,
      d.traceSide ? `- trace_side: \`${d.traceSide}\`` : undefined,
      d.paneSide ? `- pane_side: \`${d.paneSide}\`` : undefined,
    ].filter(Boolean).join('\n');
    const header = `| ${d.columns.join(' | ')} |`;
    const sep = `| ${d.columns.map(() => '---').join(' | ')} |`;
    const rows = d.rows.slice(0, 100).map(
      (r) => `| ${r.map((v) => String(v ?? '-')).join(' | ')} |`,
    );
    const truncNote = d.rows.length > 100
      ? localize(outputLanguage, `\n*(前 100 行，共 ${d.rows.length} 行)*`, `\n*(first 100 rows out of ${d.rows.length})*`)
      : '';
    return `### ${d.label}\n${sourceLines ? `${sourceLines}\n\n` : ''}${header}\n${sep}\n${rows.join('\n')}${truncNote}`;
  });
  return renderRequiredLocalizedStrategyTemplate(
    'prompt-runtime-trace-context',
    outputLanguage,
    {datasets: parts.join('\n\n')},
  );
}

function compactForPrompt(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}...`;
}

export interface QuickConversationContextTurn {
  id?: string;
  timestamp?: number;
  query: string;
  intent?: unknown;
  result?: Pick<SubAgentResult, 'message' | 'partial' | 'completion' | 'terminationReason' | 'terminationMessage' | 'conclusionContract'>;
  findings?: Array<Pick<Finding, 'severity' | 'title'>>;
  turnIndex: number;
  completed: boolean;
}

interface FindingSessionContext<TFinding extends Pick<Finding, 'title'>> {
  getAllTurns?: () => Array<{ findings?: TFinding[] }>;
}

export function buildQuickConversationContext(
  previousTurns: QuickConversationContextTurn[],
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string | undefined {
  return renderAnalysisHistoryContext(previousTurns.filter(turn => turn.result).map(turn => toAnalysisHistoryTurn({
    id: turn.id ?? `legacy-turn-${turn.turnIndex}`, turnIndex: turn.turnIndex,
    query: turn.query, traceId: '', timestamp: turn.timestamp ?? 0, result: turn.result,
  })), {outputLanguage});
}

export interface QuickMemoryContextInput {
  patternContext?: string;
  negativePatternContext?: string;
  caseBackgroundContext?: string;
  sqlErrorFixPairs?: Array<{
    errorSql?: string;
    errorMessage?: string;
    fixedSql?: string;
  }>;
  recentSqlResultsContext?: string;
  recentSqlResultsCount?: number;
  outputLanguage?: OutputLanguage;
}

export interface QuickMemoryContextPayload {
  text?: string;
  counts: Omit<QuickRunContextInjectedCounts, 'conversationTurns'>;
  tokenEstimate: number;
  dropped: string[];
}

function estimatePromptTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function countRecentSqlResultSections(text: string | undefined): number {
  if (!text?.trim()) return 0;
  const matches = text.match(/SQL Result\s+\d+/gi);
  if (matches && matches.length > 0) return matches.length;
  return 1;
}

export function buildQuickMemoryContextPayload(input: QuickMemoryContextInput): QuickMemoryContextPayload {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const parts: string[] = [];
  const dropped: string[] = [];
  const counts: QuickMemoryContextPayload['counts'] = {
    recentSqlResults: 0,
    sqlPitfallPairs: 0,
    patternHints: 0,
    negativePatternHints: 0,
    caseBackgroundCases: 0,
  };

  if (input.recentSqlResultsContext?.trim()) {
    parts.push(input.recentSqlResultsContext.trim());
    counts.recentSqlResults = input.recentSqlResultsCount ?? countRecentSqlResultSections(input.recentSqlResultsContext);
  }

  const sqlPairs = (input.sqlErrorFixPairs ?? [])
    .filter(pair => pair.errorMessage && pair.fixedSql)
    .slice(-3);
  if (sqlPairs.length > 0) {
    const pairLines = sqlPairs.map((pair, index) => [
      `${index + 1}. ERROR: \`${compactForPrompt(pair.errorMessage, 100)}\``,
      `   BAD: \`${compactForPrompt(pair.errorSql, 150)}\``,
      `   FIX: \`${compactForPrompt(pair.fixedSql, 150)}\``,
    ].join('\n'));
    parts.push(renderRequiredLocalizedStrategyTemplate(
      'prompt-runtime-sql-pitfalls',
      outputLanguage,
      {pairs: pairLines.join('\n')},
    ));
    counts.sqlPitfallPairs = sqlPairs.length;
  }
  const droppedSqlPairs = (input.sqlErrorFixPairs ?? []).filter(pair => pair.errorMessage && !pair.fixedSql).length;
  if (droppedSqlPairs > 0) dropped.push(`sqlPitfallPairs:${droppedSqlPairs}`);

  if (input.patternContext?.trim()) {
    parts.push(input.patternContext.trim());
    counts.patternHints = 1;
  }
  if (input.negativePatternContext?.trim()) {
    parts.push(input.negativePatternContext.trim());
    counts.negativePatternHints = 1;
  }
  if (input.caseBackgroundContext?.trim()) {
    parts.push(input.caseBackgroundContext.trim());
    counts.caseBackgroundCases = 1;
  }

  if (parts.length === 0) {
    return { counts, tokenEstimate: 0, dropped };
  }
  const text = renderRequiredLocalizedStrategyTemplate(
    'prompt-runtime-fast-memory',
    outputLanguage,
    {context: parts.join('\n\n')},
  );
  return {
    text,
    counts,
    tokenEstimate: estimatePromptTokens(text),
    dropped,
  };
}

export function buildQuickMemoryContext(input: QuickMemoryContextInput): string | undefined {
  return buildQuickMemoryContextPayload(input).text;
}

export function collectRecentFindings<TFinding extends Pick<Finding, 'title'> = Finding>(
  sessionContext: FindingSessionContext<TFinding>,
  options: { maxTurns?: number; maxFindings?: number } = {},
): TFinding[] {
  try {
    let turns = sessionContext.getAllTurns?.() ?? [];
    if (options.maxTurns && options.maxTurns > 0) {
      turns = turns.slice(-options.maxTurns);
    }
    return turns.flatMap(turn => turn.findings ?? []).slice(-(options.maxFindings ?? 5));
  } catch {
    return [];
  }
}

/**
 * Perfetto SQL definitions matched to the question, for the quick prompt.
 *
 * Quick mode hands the model `execute_sql` with no schema knowledge, so a
 * targeted question can only be approached by trial: measured runs issued 1-18
 * exploratory queries for a single-slice lookup. The lookup itself is a local
 * index hit (~1-2ms, bounded output), which is far cheaper than the round trips
 * it removes.
 *
 * Returns undefined when nothing matches — broad questions are served by skills,
 * not by table definitions.
 */
export async function buildQuickKnowledgeBaseContext(
  query: string,
  maxTemplates = 6,
): Promise<string | undefined> {
  if (!query.trim()) return undefined;
  try {
    const {getExtendedKnowledgeBase} = await import('../services/sqlKnowledgeBase');
    const kb = await getExtendedKnowledgeBase();
    const context = kb.getContextForAI(query, maxTemplates).trim();
    return context.length > 0 ? context : undefined;
  } catch {
    // Schema hints are an accelerator, never a precondition for answering.
    return undefined;
  }
}

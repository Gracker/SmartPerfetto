// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceDataset } from '../agent/core/orchestratorTypes';
import type { QuickRunContextInjectedCounts } from '../agent/core/orchestratorTypes';
import type { Finding, SubAgentResult } from '../agent/types';
import type { ComparisonContext, TracePairContext } from '../agentv3/types';
import type {ArchitectureInfo} from '../agent/detectors/types';
import {detectFocusApps} from '../agentv3/focusAppDetector';
import {createArchitectureDetector} from '../agent/detectors/architectureDetector';
import type {TraceProcessorService} from '../services/traceProcessorService';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';

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
  if (!input.referenceTraceId) return undefined;
  const capabilitySql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE 'android_%' OR name LIKE 'linux_%' OR name LIKE 'sched_%' OR name LIKE 'slices_%')";
  const [referenceFocus, referenceArchitecture, currentTables, referenceTables] = await Promise.all([
    detectFocusApps(input.traceProcessorService, input.referenceTraceId).catch(() => ({
      apps: [],
      method: 'none' as const,
      primaryApp: undefined,
    })),
    (input.detectReferenceArchitecture
      ? input.detectReferenceArchitecture(input.referenceTraceId)
      : createArchitectureDetector().detect({
          traceId: input.referenceTraceId,
          traceProcessorService: input.traceProcessorService,
          packageName: undefined,
        })).catch(() => undefined),
    input.traceProcessorService.query(input.currentTraceId, capabilitySql).catch(error => {
      input.onCapabilityQueryError?.('current', error);
      return null;
    }),
    input.traceProcessorService.query(input.referenceTraceId, capabilitySql).catch(error => {
      input.onCapabilityQueryError?.('reference', error);
      return null;
    }),
  ]);

  let commonCapabilities: string[] = [];
  let capabilityDiff: ComparisonContext['capabilityDiff'];
  if (currentTables && referenceTables) {
    const current = new Set(currentTables.rows.map((row: unknown[]) => String(row[0])));
    const reference = new Set(referenceTables.rows.map((row: unknown[]) => String(row[0])));
    commonCapabilities = [...current].filter(name => reference.has(name)).sort();
    const currentOnly = [...current].filter(name => !reference.has(name)).sort();
    const referenceOnly = [...reference].filter(name => !current.has(name)).sort();
    if (currentOnly.length > 0 || referenceOnly.length > 0) {
      capabilityDiff = {currentOnly, referenceOnly};
    }
  }

  return {
    referenceTraceId: input.referenceTraceId,
    ...(input.tracePairContext ? { tracePairContext: input.tracePairContext } : {}),
    referencePackageName: referenceFocus.primaryApp,
    referenceFocusApps: referenceFocus.apps.length > 0 ? referenceFocus.apps : undefined,
    referenceArchitecture,
    commonCapabilities,
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
  result?: Pick<SubAgentResult, 'message'>;
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
  const turns = previousTurns.filter(turn => turn.completed).slice(-3);
  if (turns.length === 0) return undefined;

  const renderedTurns: string[] = [];

  for (const turn of turns) {
    const query = compactForPrompt(turn.query, 220);
    const answer = compactForPrompt(turn.result?.message || '', 700);
    const findings = (turn.findings ?? [])
      .slice(0, 3)
      .map(f => `[${f.severity}] ${compactForPrompt(f.title, 160)}`)
      .filter(Boolean);

    renderedTurns.push(renderRequiredLocalizedStrategyTemplate(
      'prompt-runtime-conversation-turn',
      outputLanguage,
      {
        turnNumber: turn.turnIndex + 1,
        query,
        answerLine: answer
          ? `- ${localize(outputLanguage, '上轮回答', 'Previous answer')}: ${answer}`
          : '',
        findingsLine: findings.length > 0
          ? `- ${localize(outputLanguage, '上轮发现', 'Previous findings')}: ${findings.join('; ')}`
          : '',
      },
    ));
  }

  return renderRequiredLocalizedStrategyTemplate(
    'prompt-runtime-conversation-context',
    outputLanguage,
    {turns: renderedTurns.join('\n\n')},
  );
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

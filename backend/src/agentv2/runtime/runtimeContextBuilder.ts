import { ModelRouter } from '../../agent/core/modelRouter';
import type { AnalysisOptions, ProgressEmitter } from '../../agent/core/orchestratorTypes';
import { understandIntent } from '../../agent/core/intentUnderstanding';
import { resolveFollowUp, type FollowUpResolution } from '../../agent/core/followUpHandler';
import { resolveDrillDown } from '../../agent/core/drillDownResolver';
import type { Intent, ReferencedEntity, Finding } from '../../agent/types';
import type { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import type { FocusInterval } from '../../agent/strategies/types';
import type { StrategyMatchResult } from '../../agent/strategies';
import type { DecisionContext } from '../contracts/policy';

export interface PreparedRuntimeContext {
  sessionContext: EnhancedSessionContext;
  intent: Intent;
  followUp: FollowUpResolution;
  decisionContext: DecisionContext;
  executionOptions: AnalysisOptions;
}

interface PrepareRuntimeContextInput {
  query: string;
  sessionContext: EnhancedSessionContext;
  options: AnalysisOptions;
  modelRouter: ModelRouter;
  emitter: ProgressEmitter;
}

export async function prepareRuntimeContext({
  query,
  sessionContext,
  options,
  modelRouter,
  emitter,
}: PrepareRuntimeContextInput): Promise<PreparedRuntimeContext> {
  const intent = await understandIntent(query, sessionContext, modelRouter, emitter);
  const followUp = resolveFollowUp(intent, sessionContext);

  let drillDownIntervals = followUp.focusIntervals;
  if (intent.followUpType === 'drill_down') {
    const drillResolved = await resolveDrillDown(
      intent,
      followUp,
      sessionContext,
      options.traceProcessorService,
      sessionContext.getTraceId()
    );
    if (drillResolved?.intervals.length) {
      drillDownIntervals = drillResolved.intervals;
    }
  }

  const decisionContext = buildDecisionContextFromIntent(
    query,
    sessionContext,
    intent,
    followUp,
    drillDownIntervals || []
  );

  const executionOptions = buildRuntimeExecutionOptions(options, followUp, drillDownIntervals, intent);

  return {
    sessionContext,
    intent,
    followUp,
    decisionContext,
    executionOptions,
  };
}

export function buildDecisionContextFromIntent(
  query: string,
  sessionContext: EnhancedSessionContext,
  intent: Intent,
  followUpResolution: { isFollowUp: boolean; confidence: number; resolvedParams: Record<string, unknown> },
  focusIntervals: Array<{ startTs: string; endTs: string }>
): DecisionContext {
  const traceAgentState = sessionContext.getTraceAgentState();
  const turns = sessionContext.getAllTurns();
  const mode = mapFollowUpTypeToMode(intent.followUpType);
  const requestedDomains = deriveRequestedDomainsFromIntent(intent, query);
  const requestedActions = deriveRequestedActionsFromIntent(intent, followUpResolution, focusIntervals);

  return {
    sessionId: sessionContext.getSessionId(),
    traceId: sessionContext.getTraceId(),
    turnIndex: turns.length,
    mode,
    userGoal: intent.primaryGoal || query,
    requestedDomains,
    requestedActions,
    referencedEntities: mapReferencedEntities(intent.referencedEntities || []),
    coverageDomains: traceAgentState?.coverage?.domains || [],
    evidenceCount: Array.isArray(traceAgentState?.evidence) ? traceAgentState!.evidence.length : 0,
    contradictionCount: Array.isArray(traceAgentState?.contradictions)
      ? traceAgentState!.contradictions.length
      : 0,
  };
}

export function buildRuntimeExecutionOptions(
  baseOptions: AnalysisOptions,
  followUpResolution: {
    resolvedParams: Record<string, unknown>;
    confidence: number;
    focusIntervals?: FocusInterval[];
  },
  resolvedIntervals: FocusInterval[] | undefined,
  intent: Intent
): AnalysisOptions {
  return {
    ...baseOptions,
    ...(Object.keys(followUpResolution.resolvedParams || {}).length > 0
      ? { resolvedFollowUpParams: followUpResolution.resolvedParams }
      : {}),
    ...(Array.isArray(resolvedIntervals) && resolvedIntervals.length > 0
      ? { prebuiltIntervals: resolvedIntervals }
      : {}),
    ...(intent.followUpType === 'drill_down' ? { suggestedStrategy: { id: 'drill_down', name: 'Direct drill-down', confidence: followUpResolution.confidence } } : {}),
  };
}

export function applyBlockedStrategyIds(
  matchResult: StrategyMatchResult | null,
  blockedStrategyIds?: string[]
): StrategyMatchResult | null {
  if (!matchResult?.strategy) {
    return matchResult;
  }

  const blocked = new Set(
    (blockedStrategyIds || [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  );
  if (!blocked.has(matchResult.strategy.id)) {
    return matchResult;
  }

  return {
    strategy: null,
    matchMethod: matchResult.matchMethod,
    confidence: matchResult.confidence,
    reasoning: matchResult.reasoning,
    shouldFallback: true,
    fallbackReason: `策略 ${matchResult.strategy.id} 已被 blockedStrategyIds 禁用`,
  };
}

export function mapFollowUpTypeToMode(followUpType: Intent['followUpType']): DecisionContext['mode'] {
  if (followUpType === 'clarify') return 'clarify';
  if (followUpType === 'compare') return 'compare';
  if (followUpType === 'extend') return 'extend';
  if (followUpType === 'drill_down') return 'drill_down';
  return 'initial';
}

export function deriveRequestedDomainsFromIntent(intent: Intent, query: string): string[] {
  const aspectTokens = Array.isArray(intent.aspects)
    ? intent.aspects.map(token => String(token || '').toLowerCase())
    : [];
  const queryTokens = String(query || '').toLowerCase();

  const mappings: Array<{ tokens: string[]; domain: string }> = [
    { tokens: ['frame', 'jank', 'render', '卡顿', '帧'], domain: 'frame' },
    { tokens: ['cpu', 'sched', '调度'], domain: 'cpu' },
    { tokens: ['binder', 'ipc'], domain: 'binder' },
    { tokens: ['memory', 'gc', '内存'], domain: 'memory' },
    { tokens: ['startup', 'launch', '启动'], domain: 'startup' },
    { tokens: ['gpu'], domain: 'gpu' },
    { tokens: ['surfaceflinger', 'sf'], domain: 'surfaceflinger' },
    { tokens: ['input', 'touch', '交互'], domain: 'interaction' },
  ];

  const domains = mappings
    .filter(item =>
      item.tokens.some(token =>
        aspectTokens.some(aspect => aspect.includes(token)) || queryTokens.includes(token)
      )
    )
    .map(item => item.domain);

  return domains.length > 0 ? Array.from(new Set(domains)) : ['frame', 'cpu'];
}

function deriveRequestedActionsFromIntent(
  intent: Intent,
  followUpResolution: { isFollowUp: boolean },
  focusIntervals: Array<{ startTs: string; endTs: string }>
): string[] {
  const actions: string[] = [];
  if (intent.followUpType === 'compare') actions.push('compare_entities');
  if (intent.followUpType === 'extend') actions.push('expand_scope');
  if (intent.followUpType === 'drill_down') actions.push('drill_down');
  if (followUpResolution.isFollowUp) actions.push('follow_up');
  if (focusIntervals.length > 0) actions.push('has_focus_intervals');
  return actions;
}

function mapReferencedEntities(referencedEntities: ReferencedEntity[]): DecisionContext['referencedEntities'] {
  const allowedTypes = new Set<DecisionContext['referencedEntities'][number]['type']>([
    'frame',
    'session',
    'startup',
    'process',
    'binder_call',
    'time_range',
  ]);

  const mapped: DecisionContext['referencedEntities'] = [];
  for (const entity of referencedEntities) {
    if (!allowedTypes.has(entity.type as DecisionContext['referencedEntities'][number]['type'])) {
      continue;
    }
    mapped.push({
      type: entity.type as DecisionContext['referencedEntities'][number]['type'],
      id: entity.id,
      value: entity.value,
    });
  }

  return mapped;
}

export function buildNativeClarifyPrompt(
  query: string,
  contextSummary: string,
  recentFindings: Finding[]
): string {
  const parts: string[] = [];
  parts.push('你是 SmartPerfetto 的 Android 性能分析助手。请回答用户的澄清问题。');
  parts.push('要求：只基于给定上下文，不编造数据；若信息不足，明确说明不足。');
  parts.push('');
  parts.push(`用户问题: ${query}`);
  parts.push('');

  if (contextSummary.trim()) {
    parts.push('上下文摘要:');
    parts.push(contextSummary);
    parts.push('');
  }

  if (recentFindings.length > 0) {
    parts.push('近期发现:');
    for (const finding of recentFindings) {
      parts.push(`- [${finding.severity}] ${finding.title}: ${finding.description}`);
    }
    parts.push('');
  }

  parts.push('请直接给出中文解释，结构：结论 -> 依据 -> 建议（如果有）。');
  return parts.join('\n');
}

export function buildNativeClarifyFallback(query: string, recentFindings: Finding[]): string {
  if (recentFindings.length === 0) {
    return `当前缺少足够上下文来直接回答“${query}”。建议先运行一次完整分析，再针对具体帧/会话继续提问。`;
  }

  const top = recentFindings[0];
  return `基于当前会话，最相关发现是“${top.title}”。\n${top.description}\n如果你希望，我可以继续展开这个发现的根因链路和优化优先级。`;
}

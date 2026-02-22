import type {
  AnalysisResult,
  AgentRuntimeConfig,
  ExecutionContext,
} from '../../agent/core/orchestratorTypes';
import type { Finding } from '../../agent/types';
import type { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import {
  IncrementalAnalyzer,
  type IncrementalScope,
  type PreviousAnalysisState,
} from '../../agent/core/incrementalAnalyzer';
import type { FocusStore } from '../../agent/context/focusStore';
import { ModelRouter } from '../../agent/core/modelRouter';
import type { DomainAgentRegistry } from '../../agent/agents/domain';
import type { IterationStrategyPlanner } from '../../agent/agents/iterationStrategyPlanner';
import type { StrategyRegistry } from '../../agent/strategies';
import { buildNativeClarifyFallback, buildNativeClarifyPrompt, type PreparedRuntimeContext } from './runtimeContextBuilder';
import { RuntimeExecutionFactory } from './runtimeExecutionFactory';
import { RuntimeResultFinalizer } from './runtimeResultFinalizer';
import { selectInitialExecutor } from './runtimeInitialExecutorSelector';
import { RuntimeUpdateBridge } from './runtimeUpdateBridge';

interface RuntimeModeExecutorInput {
  runtimeConfig: AgentRuntimeConfig;
  modelRouter: ModelRouter;
  executionFactory: RuntimeExecutionFactory;
  resultFinalizer: RuntimeResultFinalizer;
  incrementalAnalyzer: IncrementalAnalyzer;
  focusStore: FocusStore;
  agentRegistry: DomainAgentRegistry;
  strategyPlanner: IterationStrategyPlanner;
  strategyRegistry: StrategyRegistry;
  updateBridge: RuntimeUpdateBridge;
}

export class RuntimeModeExecutor {
  private readonly runtimeConfig: AgentRuntimeConfig;
  private readonly modelRouter: ModelRouter;
  private readonly executionFactory: RuntimeExecutionFactory;
  private readonly resultFinalizer: RuntimeResultFinalizer;
  private readonly incrementalAnalyzer: IncrementalAnalyzer;
  private readonly focusStore: FocusStore;
  private readonly agentRegistry: DomainAgentRegistry;
  private readonly strategyPlanner: IterationStrategyPlanner;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly updateBridge: RuntimeUpdateBridge;

  constructor(input: RuntimeModeExecutorInput) {
    this.runtimeConfig = input.runtimeConfig;
    this.modelRouter = input.modelRouter;
    this.executionFactory = input.executionFactory;
    this.resultFinalizer = input.resultFinalizer;
    this.incrementalAnalyzer = input.incrementalAnalyzer;
    this.focusStore = input.focusStore;
    this.agentRegistry = input.agentRegistry;
    this.strategyPlanner = input.strategyPlanner;
    this.strategyRegistry = input.strategyRegistry;
    this.updateBridge = input.updateBridge;
  }

  async execute(
    runtimeContext: PreparedRuntimeContext,
    query: string,
    sessionId: string,
    traceId: string
  ): Promise<AnalysisResult> {
    const mode = runtimeContext.decisionContext.mode;

    if (mode === 'clarify') {
      return this.executeNativeClarify(query, sessionId, traceId, runtimeContext);
    }

    if (mode === 'compare' || mode === 'extend' || mode === 'drill_down') {
      return this.executeNativeFollowUpExecutor(query, sessionId, traceId, runtimeContext);
    }

    return this.executeNativeInitialExecutor(query, sessionId, traceId, runtimeContext);
  }

  private async executeNativeInitialExecutor(
    query: string,
    sessionId: string,
    traceId: string,
    runtimeContext: PreparedRuntimeContext
  ): Promise<AnalysisResult> {
    const services = this.executionFactory.createExecutionServices();
    const emitter = this.updateBridge.createEmitter();
    const sharedContext = services.messageBus.createSharedContext(sessionId, traceId);

    const incrementalScope = this.determineIncrementalScope(query, runtimeContext.sessionContext);
    emitter.emitUpdate('incremental_scope', {
      scopeType: incrementalScope.type,
      entitiesCount: incrementalScope.entities?.length || 0,
      timeRangesCount: incrementalScope.timeRanges?.length || 0,
      isExtension: incrementalScope.isExtension,
      reason: incrementalScope.reason,
      relevantAgents: incrementalScope.relevantAgents,
    });

    const selection = await selectInitialExecutor({
      query,
      traceId,
      runtimeContext,
      services,
      emitter,
      runtimeConfig: this.runtimeConfig,
      modelRouter: this.modelRouter,
      agentRegistry: this.agentRegistry,
      strategyPlanner: this.strategyPlanner,
      strategyRegistry: this.strategyRegistry,
      focusStore: this.focusStore,
    });

    const executionCtx: ExecutionContext = {
      query,
      sessionId,
      traceId,
      intent: runtimeContext.intent,
      initialHypotheses: selection.initialHypotheses,
      sharedContext,
      options: runtimeContext.executionOptions,
      sessionContext: runtimeContext.sessionContext,
      incrementalScope,
      config: selection.effectiveConfig,
    };

    if (selection.strategyMatchResult?.strategy) {
      executionCtx.options.suggestedStrategy = {
        id: selection.strategyMatchResult.strategy.id,
        name: selection.strategyMatchResult.strategy.name,
        confidence: selection.strategyMatchResult.confidence,
        matchMethod: selection.strategyMatchResult.matchMethod,
        reasoning: selection.strategyMatchResult.reasoning,
      };
    }

    const startTime = Date.now();
    const executorResult = await selection.executor.execute(executionCtx, emitter);

    this.resultFinalizer.handleExecutorIntervention(sessionId, executorResult);
    this.resultFinalizer.applyEntityWriteback(runtimeContext.sessionContext, executorResult);

    const previousFindings = runtimeContext.sessionContext.getAllFindings();
    const mergedFindings = incrementalScope.isExtension
      ? this.incrementalAnalyzer.mergeFindings(previousFindings, executorResult.findings)
      : executorResult.findings;

    const conclusionHistoryBudget = mergedFindings.length > 24
      ? 380
      : mergedFindings.length > 12
        ? 500
        : 600;

    return this.resultFinalizer.finalizeAnalysisResult({
      query,
      sessionId,
      intent: runtimeContext.intent,
      sessionContext: runtimeContext.sessionContext,
      sharedContext,
      emitter,
      executorResult,
      mergedFindings,
      startTime,
      singleFrameDrillDown: false,
      mode: runtimeContext.sessionContext.getAllTurns().length > 0 ? 'focused_answer' : 'initial_report',
      historyBudget: conclusionHistoryBudget,
    });
  }

  private async executeNativeFollowUpExecutor(
    query: string,
    sessionId: string,
    traceId: string,
    runtimeContext: PreparedRuntimeContext
  ): Promise<AnalysisResult> {
    const services = this.executionFactory.createExecutionServices();
    const emitter = this.updateBridge.createEmitter();
    const sharedContext = services.messageBus.createSharedContext(sessionId, traceId);

    const executionCtx: ExecutionContext = {
      query,
      sessionId,
      traceId,
      intent: runtimeContext.intent,
      initialHypotheses: [],
      sharedContext,
      options: runtimeContext.executionOptions,
      sessionContext: runtimeContext.sessionContext,
      config: this.runtimeConfig,
    };

    const executor = this.executionFactory.createFollowUpModeExecutor(runtimeContext, services);
    if (!executor) {
      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: 'Unable to resolve drill-down execution target intervals',
        confidence: 0,
        rounds: 0,
        totalDurationMs: 0,
      };
    }

    const startTime = Date.now();
    const executorResult = await executor.execute(executionCtx, emitter);

    this.resultFinalizer.handleExecutorIntervention(sessionId, executorResult);
    this.resultFinalizer.applyEntityWriteback(runtimeContext.sessionContext, executorResult);

    const previousFindings = runtimeContext.sessionContext.getAllFindings();
    const mergedFindings = runtimeContext.decisionContext.mode === 'extend'
      ? this.incrementalAnalyzer.mergeFindings(previousFindings, executorResult.findings)
      : executorResult.findings;

    const singleFrameDrillDown =
      runtimeContext.intent.followUpType === 'drill_down' &&
      (runtimeContext.intent.referencedEntities || []).filter(entity => entity.type === 'frame').length === 1;

    emitter.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });

    return this.resultFinalizer.finalizeAnalysisResult({
      query,
      sessionId,
      intent: runtimeContext.intent,
      sessionContext: runtimeContext.sessionContext,
      sharedContext,
      emitter,
      executorResult,
      mergedFindings,
      startTime,
      singleFrameDrillDown,
      mode: runtimeContext.sessionContext.getAllTurns().length > 0 ? 'focused_answer' : 'initial_report',
      historyBudget: 600,
    });
  }

  private async executeNativeClarify(
    query: string,
    sessionId: string,
    traceId: string,
    runtimeContext: PreparedRuntimeContext
  ): Promise<AnalysisResult> {
    const contextSummary = runtimeContext.sessionContext.generatePromptContext(700);
    const recentFindings = runtimeContext.sessionContext.getAllFindings().slice(-5);

    const prompt = buildNativeClarifyPrompt(query, contextSummary, recentFindings);
    const start = Date.now();

    let explanation = '';
    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis', {
        sessionId,
        traceId,
        promptId: 'agentv2.nativeClarify',
        promptVersion: '1.0.0',
        contractVersion: 'clarify_text@1.0.0',
      });
      explanation = (response.response || '').trim();
    } catch {
      explanation = '';
    }

    const outputText = explanation || buildNativeClarifyFallback(query, recentFindings);
    const finding: Finding = {
      id: `agentv2_clarify_${Date.now()}`,
      category: 'explanation',
      type: 'clarification',
      severity: 'info',
      title: '解释说明',
      description: outputText,
      source: 'agentv2.runtime',
      confidence: 0.88,
    };

    const turn = runtimeContext.sessionContext.addTurn(
      query,
      runtimeContext.intent,
      {
        success: true,
        findings: [finding],
        confidence: 0.88,
        message: outputText,
      },
      [finding]
    );
    runtimeContext.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: turn.turnIndex,
      query,
      conclusion: outputText,
      confidence: 0.88,
    });
    runtimeContext.sessionContext.recordTraceAgentTurn({
      turnId: turn.id,
      turnIndex: turn.turnIndex,
      query,
      followUpType: runtimeContext.intent.followUpType,
      intentPrimaryGoal: runtimeContext.intent.primaryGoal,
      conclusion: outputText,
      confidence: 0.88,
    });

    return {
      sessionId,
      success: true,
      findings: [finding],
      hypotheses: [],
      conclusion: outputText,
      confidence: 0.88,
      rounds: 1,
      totalDurationMs: Date.now() - start,
    };
  }

  private determineIncrementalScope(
    query: string,
    sessionContext: EnhancedSessionContext
  ): IncrementalScope {
    const entityStore = sessionContext.getEntityStore();
    const previousFindings = sessionContext.getAllFindings();
    const previousState: PreviousAnalysisState | undefined = previousFindings.length > 0
      ? {
          findings: previousFindings,
          analyzedEntityIds: new Set([
            ...entityStore.getAnalyzedFrameIds().map(id => `frame_${id}`),
            ...entityStore.getAnalyzedSessionIds().map(id => `session_${id}`),
          ]),
          analyzedTimeRanges: [],
          analyzedQuestions: new Set(),
        }
      : undefined;

    return this.incrementalAnalyzer.determineScope(
      query,
      this.focusStore,
      entityStore,
      previousState
    );
  }
}

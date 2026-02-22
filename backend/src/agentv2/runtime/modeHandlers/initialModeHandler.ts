import type {
  AnalysisResult,
  AgentRuntimeConfig,
  ExecutionContext,
  ExecutorResult,
} from '../../../agent/core/orchestratorTypes';
import type { EnhancedSessionContext } from '../../../agent/context/enhancedSessionContext';
import {
  IncrementalAnalyzer,
  type IncrementalScope,
  type PreviousAnalysisState,
} from '../../../agent/core/incrementalAnalyzer';
import type { FocusStore } from '../../../agent/context/focusStore';
import { ModelRouter } from '../../../agent/core/modelRouter';
import type { DomainAgentRegistry } from '../../../agent/agents/domain';
import type { IterationStrategyPlanner } from '../../../agent/agents/iterationStrategyPlanner';
import type { StrategyRegistry } from '../../../agent/strategies';
import { HypothesisExecutor } from '../../../agent/core/executors/hypothesisExecutor';
import { mergeCapturedEntities } from '../../../agent/core/entityCapture';
import { RuntimeExecutionFactory } from '../runtimeExecutionFactory';
import { RuntimeResultFinalizer } from '../runtimeResultFinalizer';
import { selectInitialExecutor } from '../runtimeInitialExecutorSelector';
import { RuntimeUpdateBridge } from '../runtimeUpdateBridge';
import type { RuntimeModeHandler, RuntimeModeExecutionRequest } from '../runtimeModeContracts';

interface InitialModeHandlerDeps {
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

export class InitialModeHandler implements RuntimeModeHandler {
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

  constructor(deps: InitialModeHandlerDeps) {
    this.runtimeConfig = deps.runtimeConfig;
    this.modelRouter = deps.modelRouter;
    this.executionFactory = deps.executionFactory;
    this.resultFinalizer = deps.resultFinalizer;
    this.incrementalAnalyzer = deps.incrementalAnalyzer;
    this.focusStore = deps.focusStore;
    this.agentRegistry = deps.agentRegistry;
    this.strategyPlanner = deps.strategyPlanner;
    this.strategyRegistry = deps.strategyRegistry;
    this.updateBridge = deps.updateBridge;
  }

  supports(mode: RuntimeModeExecutionRequest['runtimeContext']['decisionContext']['mode']): boolean {
    return mode === 'initial';
  }

  async execute(request: RuntimeModeExecutionRequest): Promise<AnalysisResult> {
    const { runtimeContext, query, sessionId, traceId } = request;
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
    let executorResult = await selection.executor.execute(executionCtx, emitter);
    const fallbackDecision = this.shouldFallbackToHypothesis(selection.executorType, executorResult);

    if (fallbackDecision.shouldFallback) {
      emitter.emitUpdate('strategy_fallback', {
        reason: fallbackDecision.reason,
        candidatesEvaluated: this.strategyRegistry.getAll().length,
        topCandidateConfidence: selection.strategyMatchResult?.confidence,
        fallbackTo: 'hypothesis_driven',
      });

      const hypothesisExecutor = new HypothesisExecutor(
        services,
        this.agentRegistry,
        this.strategyPlanner
      );
      hypothesisExecutor.setFocusStore(this.focusStore);

      const fallbackResult = await hypothesisExecutor.execute(executionCtx, emitter);
      executorResult = this.mergeExecutorResultsForFallback(executorResult, fallbackResult);
    }

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

  private shouldFallbackToHypothesis(
    executorType: 'strategy' | 'hypothesis',
    executorResult: ExecutorResult
  ): { shouldFallback: boolean; reason: string } {
    if (executorType !== 'strategy') {
      return { shouldFallback: false, reason: '' };
    }

    const stopReason = String(executorResult.stopReason || '').trim();
    if (!stopReason) {
      return { shouldFallback: false, reason: '' };
    }

    if (/^Strategy .+ completed$/i.test(stopReason)) {
      return { shouldFallback: false, reason: '' };
    }

    if (stopReason.includes('Circuit breaker')) {
      return { shouldFallback: false, reason: '' };
    }

    if (stopReason.startsWith('No tasks generated for strategy stage:')) {
      return { shouldFallback: true, reason: stopReason };
    }

    if (stopReason.startsWith('Reached hard stage budget')) {
      return { shouldFallback: true, reason: stopReason };
    }

    const insufficientEvidence = executorResult.findings.length === 0 || executorResult.confidence < 0.65;
    if (insufficientEvidence) {
      return { shouldFallback: true, reason: stopReason };
    }

    return { shouldFallback: false, reason: '' };
  }

  private mergeExecutorResultsForFallback(
    strategyResult: ExecutorResult,
    fallbackResult: ExecutorResult
  ): ExecutorResult {
    const mergedFindings = this.incrementalAnalyzer.mergeFindings(
      strategyResult.findings,
      fallbackResult.findings
    );

    const mergedInformationGaps = Array.from(new Set([
      ...(strategyResult.informationGaps || []),
      ...(fallbackResult.informationGaps || []),
    ]));

    const mergedCapturedEntities = strategyResult.capturedEntities && fallbackResult.capturedEntities
      ? mergeCapturedEntities(strategyResult.capturedEntities, fallbackResult.capturedEntities)
      : strategyResult.capturedEntities || fallbackResult.capturedEntities;

    const mergedFrames = Array.from(new Set([
      ...(strategyResult.analyzedEntityIds?.frames || []),
      ...(fallbackResult.analyzedEntityIds?.frames || []),
    ]));
    const mergedSessions = Array.from(new Set([
      ...(strategyResult.analyzedEntityIds?.sessions || []),
      ...(fallbackResult.analyzedEntityIds?.sessions || []),
    ]));

    const analyzedEntityIds = mergedFrames.length > 0 || mergedSessions.length > 0
      ? { frames: mergedFrames, sessions: mergedSessions }
      : undefined;

    return {
      ...fallbackResult,
      findings: mergedFindings,
      confidence: Math.max(strategyResult.confidence, fallbackResult.confidence),
      informationGaps: mergedInformationGaps,
      rounds: strategyResult.rounds + fallbackResult.rounds,
      stopReason: `Strategy fallback triggered (${strategyResult.stopReason || 'early stop'}); ${fallbackResult.stopReason || 'hypothesis complete'}`,
      lastStrategy: fallbackResult.lastStrategy || strategyResult.lastStrategy,
      capturedEntities: mergedCapturedEntities,
      analyzedEntityIds,
      interventionRequest: fallbackResult.interventionRequest || strategyResult.interventionRequest,
      pausedForIntervention: Boolean(
        fallbackResult.pausedForIntervention || strategyResult.pausedForIntervention
      ),
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

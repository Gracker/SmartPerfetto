import { EventEmitter } from 'events';
import { ModelRouter } from '../../agent/core/modelRouter';
import {
  createDomainAgentRegistry,
  type DomainAgentRegistry,
} from '../../agent/agents/domain';
import {
  createIterationStrategyPlanner,
  type IterationStrategyPlanner,
} from '../../agent/agents/iterationStrategyPlanner';
import type { Intent, ReferencedEntity, StreamingUpdate } from '../../agent/types';
import type { Finding } from '../../agent/types';
import { FocusStore, type FocusInteraction } from '../../agent/context/focusStore';
import {
  AnalysisOptions,
  AnalysisResult,
  AgentRuntimeConfig,
  AnalysisServices,
  DEFAULT_CONFIG,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
} from '../../agent/core/orchestratorTypes';
import { sessionContextManager, type EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import { understandIntent } from '../../agent/core/intentUnderstanding';
import { generateInitialHypotheses } from '../../agent/core/hypothesisGenerator';
import { resolveFollowUp, type FollowUpResolution } from '../../agent/core/followUpHandler';
import { resolveDrillDown } from '../../agent/core/drillDownResolver';
import type { FocusInterval } from '../../agent/strategies/types';
import {
  createEnhancedStrategyRegistry,
  type StrategyMatchResult,
  type StrategyRegistry,
} from '../../agent/strategies';
import { createAgentMessageBus } from '../../agent/communication';
import { CircuitBreaker } from '../../agent/core/circuitBreaker';
import { createEmittedEnvelopeRegistry } from '../../agent/core/emittedEnvelopeRegistry';
import { detectTraceContext } from '../../agent/core/strategySelector';
import type { AnalysisExecutor } from '../../agent/core/executors/analysisExecutor';
import { DirectDrillDownExecutor } from '../operations/directDrillDownExecutor';
import { StrategyExecutor } from '../../agent/core/executors/strategyExecutor';
import { HypothesisExecutor } from '../../agent/core/executors/hypothesisExecutor';
import { applyCapturedEntities } from '../../agent/core/entityCapture';
import { deriveConclusionContract, generateConclusion } from '../../agent/core/conclusionGenerator';
import { resolveConclusionScene } from '../../agent/core/conclusionSceneTemplates';
import { DEEP_REASON_LABEL } from '../../utils/analysisNarrative';
import {
  IncrementalAnalyzer,
  type IncrementalScope,
  type PreviousAnalysisState,
} from '../../agent/core/incrementalAnalyzer';
import { InterventionController } from '../../agent/core/interventionController';
import { ComparisonExecutor } from '../operations/comparisonExecutor';
import { ExtendExecutor } from '../operations/extendExecutor';
import {
  DecisionContext,
  PrincipleDecision,
  SoulViolation,
} from '../contracts/policy';
import { OperationPlanner } from '../operations/operationPlanner';
import { OperationExecutor } from '../operations/operationExecutor';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import { ApprovalController } from '../operations/approvalController';
import { PrincipleEngine } from '../principles/principleEngine';
import { createSoulProfile } from '../soul/soulProfile';
import { evaluateSoulGuard } from '../soul/soulGuard';
import { shouldPreferHypothesisLoop } from '../../agent/config/domainManifest';

export type AgentRuntimeAnalysisResult = AnalysisResult;

export class AgentRuntime extends EventEmitter {
  private readonly planner: OperationPlanner;
  private readonly principleEngine: PrincipleEngine;
  private readonly operationExecutor: OperationExecutor;
  private readonly evidenceSynthesizer: EvidenceSynthesizer;
  private readonly modelRouter: ModelRouter;
  private readonly runtimeConfig: AgentRuntimeConfig;
  private readonly incrementalAnalyzer: IncrementalAnalyzer;
  private readonly agentRegistry: DomainAgentRegistry;
  private readonly strategyPlanner: IterationStrategyPlanner;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly focusStore: FocusStore;
  private readonly interventionController: InterventionController;

  private resolveSceneIdHint(intent: Intent, findings: Finding[]): string | undefined {
    try {
      return resolveConclusionScene({
        intent,
        findings,
        deepReasonLabel: DEEP_REASON_LABEL,
      }).selectedTemplate.id;
    } catch {
      return undefined;
    }
  }

  constructor(modelRouter: ModelRouter, config?: Partial<AgentRuntimeConfig>) {
    super();

    this.modelRouter = modelRouter;
    this.runtimeConfig = {
      ...DEFAULT_CONFIG,
      ...(config || {}),
    };
    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);
    this.strategyRegistry = createEnhancedStrategyRegistry(modelRouter, 'keyword_first');
    this.circuitBreaker = new CircuitBreaker();
    this.focusStore = new FocusStore();
    this.interventionController = new InterventionController({
      confidenceThreshold: this.runtimeConfig.confidenceThreshold,
      timeoutThresholdMs: 120000,
      userResponseTimeoutMs: 60000,
    });
    this.incrementalAnalyzer = new IncrementalAnalyzer();
    this.planner = new OperationPlanner();
    this.principleEngine = new PrincipleEngine();
    this.evidenceSynthesizer = new EvidenceSynthesizer();
    this.operationExecutor = new OperationExecutor(
      new ApprovalController(this.interventionController)
    );
    this.setupInterventionEventForwarding();
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {}
  ): Promise<AgentRuntimeAnalysisResult> {
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const runtimeContext = await this.prepareRuntimeContext(query, sessionContext, options);
    const decision = this.principleEngine.decide(runtimeContext.decisionContext);
    const plan = this.planner.buildPlan({ context: runtimeContext.decisionContext, policy: decision.policy });

    this.emit('update', buildPrinciplesAppliedUpdate(decision, plan.id));

    const soulResult = evaluateSoulGuard(createSoulProfile(), {
      context: runtimeContext.decisionContext,
      plan,
    });

    if (!soulResult.passed) {
      this.emit('update', buildSoulViolationUpdate(soulResult.violations));
      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `Soul guard blocked execution: ${soulResult.violations.map(v => v.code).join(', ')}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs: 0,
      };
    }

    const execution = await this.operationExecutor.execute({
      query,
      sessionId,
      traceId,
      context: runtimeContext.decisionContext,
      decision,
      plan,
      analyzeWithRuntimeEngine: () => this.executeWithRuntimeMode(runtimeContext, query, sessionId, traceId),
      emitUpdate: update => this.emit('update', update),
    });

    const synthesized = this.evidenceSynthesizer.synthesize({
      originalConclusion: execution.result.conclusion,
      findings: execution.result.findings,
      decision,
    });

    return {
      ...execution.result,
      findings: synthesized.findings,
      conclusion: synthesized.conclusion,
    };
  }

  getFocusStore() {
    return this.focusStore;
  }

  getInterventionController() {
    return this.interventionController;
  }

  recordUserInteraction(interaction: FocusInteraction): void {
    this.focusStore.recordInteraction(interaction);

    const focusType =
      interaction.target.entityType && interaction.target.entityId
        ? 'entity'
        : interaction.target.timeRange
          ? 'timeRange'
          : interaction.target.metricName
            ? 'metric'
            : interaction.target.question
              ? 'question'
              : 'question';

    this.emit('update', {
      type: 'focus_updated',
      content: {
        focusType,
        target: interaction.target,
        weight: 0.5,
        interactionType: interaction.source,
      },
      timestamp: Date.now(),
    } as StreamingUpdate);
  }

  reset(): void {
    this.circuitBreaker.reset();
    this.focusStore.clear();
  }

  private async prepareRuntimeContext(
    query: string,
    sessionContext: EnhancedSessionContext,
    options: AnalysisOptions
  ): Promise<PreparedRuntimeContext> {
    const emitter = this.createRuntimeEmitter();
    const intent = await understandIntent(query, sessionContext, this.modelRouter, emitter);
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

  private async executeWithRuntimeMode(
    runtimeContext: PreparedRuntimeContext,
    query: string,
    sessionId: string,
    traceId: string
  ): Promise<AgentRuntimeAnalysisResult> {
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
  ): Promise<AgentRuntimeAnalysisResult> {
    const services = this.createNativeExecutionServices();
    const emitter = this.createRuntimeEmitter();
    const sharedContext = services.messageBus.createSharedContext(sessionId, traceId);

    this.strategyPlanner.resetProgressTracking();

    const traceAgentState = runtimeContext.sessionContext.getOrCreateTraceAgentState(query);
    const hardMaxRounds = Math.max(1, this.runtimeConfig.maxRounds);
    const softMaxRounds = Math.max(
      1,
      Math.floor(Number(traceAgentState.preferences?.maxExperimentsPerTurn || 3))
    );
    const effectiveConfig: AgentRuntimeConfig = {
      ...this.runtimeConfig,
      maxRounds: hardMaxRounds,
      softMaxRounds: Math.min(hardMaxRounds, softMaxRounds),
    };

    const initialHypotheses = await generateInitialHypotheses(
      query,
      runtimeContext.intent,
      runtimeContext.sessionContext,
      this.modelRouter,
      this.agentRegistry,
      emitter
    );
    for (const hypothesis of initialHypotheses) {
      services.messageBus.updateHypothesis(hypothesis);
    }

    let strategyMatchResult: StrategyMatchResult | null = null;
    try {
      const traceContext = runtimeContext.executionOptions.traceProcessorService
        ? await detectTraceContext(runtimeContext.executionOptions.traceProcessorService, traceId)
        : undefined;
      strategyMatchResult = await this.strategyRegistry.matchEnhanced(
        query,
        runtimeContext.intent,
        traceContext
      );
    } catch {
      strategyMatchResult = null;
    }

    strategyMatchResult = applyBlockedStrategyIds(
      strategyMatchResult,
      runtimeContext.executionOptions.blockedStrategyIds
    );

    const preferredLoopMode = runtimeContext.sessionContext.getTraceAgentState()?.preferences?.defaultLoopMode;
    const preferHypothesisLoop = strategyMatchResult?.strategy
      ? shouldPreferHypothesisLoop({
          strategyId: strategyMatchResult.strategy.id,
          preferredLoopMode,
        })
      : false;

    const incrementalScope = this.determineIncrementalScope(query, runtimeContext.sessionContext);
    emitter.emitUpdate('incremental_scope', {
      scopeType: incrementalScope.type,
      entitiesCount: incrementalScope.entities?.length || 0,
      timeRangesCount: incrementalScope.timeRanges?.length || 0,
      isExtension: incrementalScope.isExtension,
      reason: incrementalScope.reason,
      relevantAgents: incrementalScope.relevantAgents,
    });

    const executionCtx: ExecutionContext = {
      query,
      sessionId,
      traceId,
      intent: runtimeContext.intent,
      initialHypotheses,
      sharedContext,
      options: runtimeContext.executionOptions,
      sessionContext: runtimeContext.sessionContext,
      incrementalScope,
      config: effectiveConfig,
    };

    if (strategyMatchResult?.strategy) {
      executionCtx.options.suggestedStrategy = {
        id: strategyMatchResult.strategy.id,
        name: strategyMatchResult.strategy.name,
        confidence: strategyMatchResult.confidence,
        matchMethod: strategyMatchResult.matchMethod,
        reasoning: strategyMatchResult.reasoning,
      };
    }

    let executor: AnalysisExecutor;
    if (strategyMatchResult?.strategy && !preferHypothesisLoop) {
      emitter.emitUpdate('strategy_selected', {
        strategyId: strategyMatchResult.strategy.id,
        strategyName: strategyMatchResult.strategy.name,
        confidence: strategyMatchResult.confidence,
        reasoning: strategyMatchResult.reasoning || 'keyword match',
        selectionMethod: strategyMatchResult.matchMethod === 'keyword' ? 'keyword' : 'llm',
      });
      executor = new StrategyExecutor(strategyMatchResult.strategy, services);
    } else {
      if (strategyMatchResult?.fallbackReason) {
        emitter.emitUpdate('strategy_fallback', {
          reason: strategyMatchResult.fallbackReason,
          candidatesEvaluated: this.strategyRegistry.getAll().length,
          topCandidateConfidence: strategyMatchResult.confidence,
          fallbackTo: 'hypothesis_driven',
        });
      }
      const hypothesisExecutor = new HypothesisExecutor(
        services,
        this.agentRegistry,
        this.strategyPlanner
      );
      hypothesisExecutor.setFocusStore(this.focusStore);
      executor = hypothesisExecutor;
    }

    const startTime = Date.now();
    const executorResult = await executor.execute(executionCtx, emitter);

    this.handleExecutorIntervention(sessionId, executorResult);
    this.applyEntityWriteback(runtimeContext.sessionContext, executorResult);

    const previousFindings = runtimeContext.sessionContext.getAllFindings();
    const mergedFindings = incrementalScope.isExtension
      ? this.incrementalAnalyzer.mergeFindings(previousFindings, executorResult.findings)
      : executorResult.findings;

    const conclusionHistoryBudget = mergedFindings.length > 24
      ? 380
      : mergedFindings.length > 12
        ? 500
        : 600;
    const conclusion = await generateConclusion(
      sharedContext,
      mergedFindings,
      runtimeContext.intent,
      this.modelRouter,
      emitter,
      executorResult.stopReason || undefined,
      {
        turnCount: runtimeContext.sessionContext.getAllTurns().length,
        historyContext: runtimeContext.sessionContext.generatePromptContext(conclusionHistoryBudget),
      }
    );

    const result: AgentRuntimeAnalysisResult = {
      sessionId,
      success: true,
      findings: mergedFindings,
      hypotheses: Array.from(sharedContext.hypotheses.values()),
      conclusion,
      conclusionContract: deriveConclusionContract(conclusion, {
        mode: runtimeContext.sessionContext.getAllTurns().length > 0 ? 'focused_answer' : 'initial_report',
        singleFrameDrillDown: false,
        sceneId: this.resolveSceneIdHint(runtimeContext.intent, mergedFindings),
      }) || undefined,
      confidence: executorResult.confidence,
      rounds: executorResult.rounds,
      totalDurationMs: Date.now() - startTime,
    };

    const recordedTurn = runtimeContext.sessionContext.addTurn(
      query,
      runtimeContext.intent,
      {
        success: true,
        findings: executorResult.findings,
        confidence: result.confidence,
        message: conclusion,
      },
      executorResult.findings
    );
    runtimeContext.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: recordedTurn.turnIndex,
      query,
      conclusion,
      confidence: result.confidence,
    });
    runtimeContext.sessionContext.recordTraceAgentTurn({
      turnId: recordedTurn.id,
      turnIndex: recordedTurn.turnIndex,
      query,
      followUpType: runtimeContext.intent.followUpType,
      intentPrimaryGoal: runtimeContext.intent.primaryGoal,
      conclusion,
      confidence: result.confidence,
    });

    return result;
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

  private async executeNativeFollowUpExecutor(
    query: string,
    sessionId: string,
    traceId: string,
    runtimeContext: PreparedRuntimeContext
  ): Promise<AgentRuntimeAnalysisResult> {
    const services = this.createNativeExecutionServices();
    const emitter = this.createRuntimeEmitter();
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

    const executor = this.createModeExecutor(runtimeContext, services);
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

    this.handleExecutorIntervention(sessionId, executorResult);
    this.applyEntityWriteback(runtimeContext.sessionContext, executorResult);

    const previousFindings = runtimeContext.sessionContext.getAllFindings();
    const mergedFindings = runtimeContext.decisionContext.mode === 'extend'
      ? this.incrementalAnalyzer.mergeFindings(previousFindings, executorResult.findings)
      : executorResult.findings;

    emitter.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
    const conclusion = await generateConclusion(
      sharedContext,
      mergedFindings,
      runtimeContext.intent,
      this.modelRouter,
      emitter,
      executorResult.stopReason || undefined,
      {
        turnCount: runtimeContext.sessionContext.getAllTurns().length,
        historyContext: runtimeContext.sessionContext.generatePromptContext(600),
      }
    );

    const singleFrameDrillDown =
      runtimeContext.intent.followUpType === 'drill_down' &&
      (runtimeContext.intent.referencedEntities || []).filter(entity => entity.type === 'frame').length === 1;

    const result: AgentRuntimeAnalysisResult = {
      sessionId,
      success: true,
      findings: mergedFindings,
      hypotheses: Array.from(sharedContext.hypotheses.values()),
      conclusion,
      conclusionContract: deriveConclusionContract(conclusion, {
        mode: runtimeContext.sessionContext.getAllTurns().length > 0 ? 'focused_answer' : 'initial_report',
        singleFrameDrillDown,
        sceneId: this.resolveSceneIdHint(runtimeContext.intent, mergedFindings),
      }) || undefined,
      confidence: executorResult.confidence,
      rounds: executorResult.rounds,
      totalDurationMs: Date.now() - startTime,
    };

    const recordedTurn = runtimeContext.sessionContext.addTurn(
      query,
      runtimeContext.intent,
      {
        success: true,
        findings: executorResult.findings,
        confidence: result.confidence,
        message: conclusion,
      },
      executorResult.findings
    );
    runtimeContext.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: recordedTurn.turnIndex,
      query,
      conclusion,
      confidence: result.confidence,
    });
    runtimeContext.sessionContext.recordTraceAgentTurn({
      turnId: recordedTurn.id,
      turnIndex: recordedTurn.turnIndex,
      query,
      followUpType: runtimeContext.intent.followUpType,
      intentPrimaryGoal: runtimeContext.intent.primaryGoal,
      conclusion,
      confidence: result.confidence,
    });

    return result;
  }

  private createNativeExecutionServices(): AnalysisServices {
    const messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.runtimeConfig.maxConcurrentTasks,
      messageTimeoutMs: this.runtimeConfig.taskTimeoutMs ?? DEFAULT_CONFIG.taskTimeoutMs ?? 180000,
      enableLogging: this.runtimeConfig.enableLogging,
    });

    for (const agent of this.agentRegistry.getAll()) {
      messageBus.registerAgent(agent);
    }

    return {
      modelRouter: this.modelRouter,
      messageBus,
      circuitBreaker: this.circuitBreaker,
      emittedEnvelopeRegistry: createEmittedEnvelopeRegistry(),
    };
  }

  private createModeExecutor(
    runtimeContext: PreparedRuntimeContext,
    services: AnalysisServices
  ): AnalysisExecutor | null {
    if (runtimeContext.decisionContext.mode === 'compare') {
      return new ComparisonExecutor(
        runtimeContext.sessionContext,
        services,
        runtimeContext.executionOptions.traceProcessorService,
        runtimeContext.sessionContext.getTraceId()
      );
    }

    if (runtimeContext.decisionContext.mode === 'extend') {
      const extendExecutor = new ExtendExecutor(
        runtimeContext.sessionContext,
        services,
        runtimeContext.executionOptions.traceProcessorService,
        runtimeContext.sessionContext.getTraceId()
      );
      extendExecutor.setFocusStore(this.focusStore);
      return extendExecutor;
    }

    if (runtimeContext.decisionContext.mode === 'drill_down') {
      const intervals = runtimeContext.executionOptions.prebuiltIntervals || runtimeContext.followUp.focusIntervals || [];
      if (intervals.length === 0) {
        return null;
      }
      const followUp: FollowUpResolution = {
        ...runtimeContext.followUp,
        focusIntervals: intervals,
      };
      return new DirectDrillDownExecutor(followUp, services);
    }

    return null;
  }

  private handleExecutorIntervention(sessionId: string, executorResult: ExecutorResult): void {
    if (!executorResult.interventionRequest) {
      return;
    }

    const intervention = executorResult.interventionRequest;
    const options = [
      {
        id: 'continue',
        label: '继续分析',
        description: '继续当前分析策略',
        action: 'continue' as const,
        recommended: true,
      },
      {
        id: 'abort',
        label: '结束分析',
        description: '以当前结果结束',
        action: 'abort' as const,
      },
    ];

    this.interventionController.createAgentIntervention(
      sessionId,
      intervention.reason,
      options,
      {
        currentFindings: executorResult.findings,
        possibleDirections: intervention.possibleDirections.map(direction => ({
          id: direction.id,
          description: direction.description,
          confidence: direction.confidence,
          requiredAgents: [],
        })),
        elapsedTimeMs: intervention.elapsedTimeMs,
        confidence: intervention.confidence,
        roundsCompleted: intervention.roundsCompleted,
        progressSummary: intervention.progressSummary,
      }
    );
  }

  private applyEntityWriteback(sessionContext: EnhancedSessionContext, executorResult: ExecutorResult): void {
    if (executorResult.capturedEntities) {
      applyCapturedEntities(sessionContext.getEntityStore(), executorResult.capturedEntities);
    }

    if (executorResult.analyzedEntityIds) {
      const store = sessionContext.getEntityStore();
      for (const frameId of executorResult.analyzedEntityIds.frames || []) {
        store.markFrameAnalyzed(frameId);
      }
      for (const sessionId of executorResult.analyzedEntityIds.sessions || []) {
        store.markSessionAnalyzed(sessionId);
      }
    }

    sessionContext.refreshTraceAgentCoverage();
  }

  private async executeNativeClarify(
    query: string,
    sessionId: string,
    traceId: string,
    runtimeContext: PreparedRuntimeContext
  ): Promise<AgentRuntimeAnalysisResult> {
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

  private setupInterventionEventForwarding(): void {
    this.interventionController.on('intervention_required', (intervention: any) => {
      this.emit('update', {
        type: 'intervention_required',
        content: {
          interventionId: intervention.id,
          type: intervention.type,
          options: intervention.options.map((option: any) => ({
            id: option.id,
            label: option.label,
            description: option.description,
            action: option.action,
            recommended: option.recommended,
          })),
          context: {
            confidence: intervention.context.confidence,
            elapsedTimeMs: intervention.context.elapsedTimeMs,
            roundsCompleted: intervention.context.roundsCompleted || 0,
            progressSummary: intervention.context.progressSummary || '',
            triggerReason: intervention.context.triggerReason || '',
            findingsCount: intervention.context.currentFindings?.length || 0,
          },
          timeout: intervention.timeout || 60000,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });

    this.interventionController.on('intervention_resolved', (data: any) => {
      this.emit('update', {
        type: 'intervention_resolved',
        content: {
          interventionId: data.interventionId,
          action: data.action,
          sessionId: data.sessionId,
          directive: data.directive,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });

    this.interventionController.on('intervention_timeout', (data: any) => {
      this.emit('update', {
        type: 'intervention_timeout',
        content: {
          interventionId: data.interventionId,
          sessionId: data.sessionId,
          defaultAction: data.defaultAction,
          timeoutMs: data.timeoutMs,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });
  }

  private createRuntimeEmitter(): ProgressEmitter {
    return {
      emitUpdate: (type, content) => {
        this.emit('update', {
          type,
          content,
          timestamp: Date.now(),
        } as StreamingUpdate);
      },
      log: (message: string) => {
        this.emit('update', {
          type: 'progress',
          content: {
            phase: 'runtime_planning',
            message,
          },
          timestamp: Date.now(),
        } as StreamingUpdate);
      },
    };
  }
}

interface PreparedRuntimeContext {
  sessionContext: EnhancedSessionContext;
  intent: Intent;
  followUp: FollowUpResolution;
  decisionContext: DecisionContext;
  executionOptions: AnalysisOptions;
}

export function createAgentRuntime(
  modelRouter: ModelRouter,
  config?: Partial<AgentRuntimeConfig>
): AgentRuntime {
  return new AgentRuntime(modelRouter, config);
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

function buildPrinciplesAppliedUpdate(decision: PrincipleDecision, planId: string): StreamingUpdate {
  return {
    type: 'progress',
    content: {
      phase: 'principles_applied',
      planId,
      outcome: decision.outcome,
      matchedPrinciples: decision.matchedPrincipleIds,
      reasonCodes: decision.reasonCodes,
    },
    timestamp: Date.now(),
    id: `principles.${planId}`,
  };
}

function buildSoulViolationUpdate(violations: SoulViolation[]): StreamingUpdate {
  return {
    type: 'error',
    content: {
      message: `Soul guard violations: ${violations.map(v => v.code).join(', ')}`,
      violations,
    },
    timestamp: Date.now(),
    id: `soul.violation.${Date.now()}`,
  };
}

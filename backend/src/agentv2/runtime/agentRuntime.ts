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
import type { Intent, StreamingUpdate } from '../../agent/types';
import type { Finding } from '../../agent/types';
import { FocusStore, type FocusInteraction } from '../../agent/context/focusStore';
import {
  AnalysisOptions,
  AnalysisResult,
  AgentRuntimeConfig,
  DEFAULT_CONFIG,
  ExecutionContext,
  ProgressEmitter,
} from '../../agent/core/orchestratorTypes';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import {
  createEnhancedStrategyRegistry,
  type StrategyRegistry,
} from '../../agent/strategies';
import { CircuitBreaker } from '../../agent/core/circuitBreaker';
import {
  IncrementalAnalyzer,
  type IncrementalScope,
  type PreviousAnalysisState,
} from '../../agent/core/incrementalAnalyzer';
import { InterventionController } from '../../agent/core/interventionController';
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
import {
  buildNativeClarifyFallback,
  buildNativeClarifyPrompt,
  prepareRuntimeContext,
  type PreparedRuntimeContext,
} from './runtimeContextBuilder';
import { RuntimeExecutionFactory } from './runtimeExecutionFactory';
import { RuntimeResultFinalizer } from './runtimeResultFinalizer';
import { selectInitialExecutor } from './runtimeInitialExecutorSelector';

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
  private readonly executionFactory: RuntimeExecutionFactory;
  private readonly resultFinalizer: RuntimeResultFinalizer;

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

    this.executionFactory = new RuntimeExecutionFactory({
      modelRouter: this.modelRouter,
      runtimeConfig: this.runtimeConfig,
      agentRegistry: this.agentRegistry,
      circuitBreaker: this.circuitBreaker,
      focusStore: this.focusStore,
    });
    this.resultFinalizer = new RuntimeResultFinalizer(this.modelRouter, this.interventionController);

    this.setupInterventionEventForwarding();
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {}
  ): Promise<AgentRuntimeAnalysisResult> {
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const runtimeContext = await prepareRuntimeContext({
      query,
      sessionContext,
      options,
      modelRouter: this.modelRouter,
      emitter: this.createRuntimeEmitter(),
    });

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
    const services = this.executionFactory.createExecutionServices();
    const emitter = this.createRuntimeEmitter();
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

  private determineIncrementalScope(
    query: string,
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>
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
    const services = this.executionFactory.createExecutionServices();
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

export function createAgentRuntime(
  modelRouter: ModelRouter,
  config?: Partial<AgentRuntimeConfig>
): AgentRuntime {
  return new AgentRuntime(modelRouter, config);
}

export {
  applyBlockedStrategyIds,
  buildDecisionContextFromIntent,
  buildNativeClarifyFallback,
  buildNativeClarifyPrompt,
  buildRuntimeExecutionOptions,
  deriveRequestedDomainsFromIntent,
  mapFollowUpTypeToMode,
} from './runtimeContextBuilder';

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

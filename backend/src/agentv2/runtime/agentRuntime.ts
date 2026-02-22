import { EventEmitter } from 'events';
import { ModelRouter } from '../../agent/core/modelRouter';
import {
  createDomainAgentRegistry,
} from '../../agent/agents/domain';
import {
  createIterationStrategyPlanner,
} from '../../agent/agents/iterationStrategyPlanner';
import type { StreamingUpdate } from '../../agent/types';
import { FocusStore, type FocusInteraction } from '../../agent/context/focusStore';
import {
  AnalysisOptions,
  AnalysisResult,
  AgentRuntimeConfig,
  DEFAULT_CONFIG,
} from '../../agent/core/orchestratorTypes';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import {
  createEnhancedStrategyRegistry,
} from '../../agent/strategies';
import { CircuitBreaker } from '../../agent/core/circuitBreaker';
import { IncrementalAnalyzer } from '../../agent/core/incrementalAnalyzer';
import { InterventionController } from '../../agent/core/interventionController';
import { OperationPlanner } from '../operations/operationPlanner';
import { OperationExecutor } from '../operations/operationExecutor';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import { ApprovalController } from '../operations/approvalController';
import { PrincipleEngine } from '../principles/principleEngine';
import {
  prepareRuntimeContext,
} from './runtimeContextBuilder';
import { RuntimeExecutionFactory } from './runtimeExecutionFactory';
import { RuntimeResultFinalizer } from './runtimeResultFinalizer';
import { RuntimeModeExecutor } from './runtimeModeExecutor';
import { RuntimeUpdateBridge } from './runtimeUpdateBridge';
import { executeGovernedRuntimeAnalysis } from './runtimeGovernancePipeline';

export type AgentRuntimeAnalysisResult = AnalysisResult;

export class AgentRuntime extends EventEmitter {
  private readonly modelRouter: ModelRouter;
  private readonly runtimeConfig: AgentRuntimeConfig;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly focusStore: FocusStore;
  private readonly interventionController: InterventionController;

  private readonly planner: OperationPlanner;
  private readonly principleEngine: PrincipleEngine;
  private readonly operationExecutor: OperationExecutor;
  private readonly evidenceSynthesizer: EvidenceSynthesizer;

  private readonly updateBridge: RuntimeUpdateBridge;
  private readonly modeExecutor: RuntimeModeExecutor;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentRuntimeConfig>) {
    super();

    this.modelRouter = modelRouter;
    this.runtimeConfig = {
      ...DEFAULT_CONFIG,
      ...(config || {}),
    };
    this.circuitBreaker = new CircuitBreaker();
    this.focusStore = new FocusStore();
    this.interventionController = new InterventionController({
      confidenceThreshold: this.runtimeConfig.confidenceThreshold,
      timeoutThresholdMs: 120000,
      userResponseTimeoutMs: 60000,
    });

    this.planner = new OperationPlanner();
    this.principleEngine = new PrincipleEngine();
    this.evidenceSynthesizer = new EvidenceSynthesizer();
    this.operationExecutor = new OperationExecutor(
      new ApprovalController(this.interventionController)
    );

    this.updateBridge = new RuntimeUpdateBridge((update) => {
      this.emit('update', update);
    });
    this.updateBridge.bindInterventionForwarding(this.interventionController);

    const agentRegistry = createDomainAgentRegistry(modelRouter);
    const strategyPlanner = createIterationStrategyPlanner(modelRouter);
    const strategyRegistry = createEnhancedStrategyRegistry(modelRouter, 'keyword_first');
    const incrementalAnalyzer = new IncrementalAnalyzer();

    const executionFactory = new RuntimeExecutionFactory({
      modelRouter: this.modelRouter,
      runtimeConfig: this.runtimeConfig,
      agentRegistry,
      circuitBreaker: this.circuitBreaker,
      focusStore: this.focusStore,
    });
    const resultFinalizer = new RuntimeResultFinalizer(this.modelRouter, this.interventionController);

    this.modeExecutor = new RuntimeModeExecutor({
      runtimeConfig: this.runtimeConfig,
      modelRouter: this.modelRouter,
      executionFactory,
      resultFinalizer,
      incrementalAnalyzer,
      focusStore: this.focusStore,
      agentRegistry,
      strategyPlanner,
      strategyRegistry,
      updateBridge: this.updateBridge,
    });
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
      emitter: this.updateBridge.createEmitter(),
    });

    return executeGovernedRuntimeAnalysis({
      query,
      sessionId,
      traceId,
      runtimeContext,
      principleEngine: this.principleEngine,
      planner: this.planner,
      operationExecutor: this.operationExecutor,
      evidenceSynthesizer: this.evidenceSynthesizer,
      emitUpdate: (update) => this.updateBridge.emit(update),
      analyzeWithRuntimeEngine: () => this.modeExecutor.execute(runtimeContext, query, sessionId, traceId),
    });
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

    this.updateBridge.emit({
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

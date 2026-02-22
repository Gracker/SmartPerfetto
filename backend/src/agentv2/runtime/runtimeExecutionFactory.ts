import { ModelRouter } from '../../agent/core/modelRouter';
import {
  AnalysisServices,
  AgentRuntimeConfig,
  DEFAULT_CONFIG,
} from '../../agent/core/orchestratorTypes';
import {
  createDomainAgentRegistry,
  type DomainAgentRegistry,
} from '../../agent/agents/domain';
import { createAgentMessageBus } from '../../agent/communication';
import { CircuitBreaker } from '../../agent/core/circuitBreaker';
import { createEmittedEnvelopeRegistry } from '../../agent/core/emittedEnvelopeRegistry';
import type { AnalysisExecutor } from '../../agent/core/executors/analysisExecutor';
import { DirectDrillDownExecutor } from '../operations/directDrillDownExecutor';
import { ComparisonExecutor } from '../operations/comparisonExecutor';
import { ExtendExecutor } from '../operations/extendExecutor';
import type { FocusStore } from '../../agent/context/focusStore';
import type { FollowUpResolution } from '../../agent/core/followUpHandler';
import type { PreparedRuntimeContext } from './runtimeContextBuilder';

interface RuntimeExecutionFactoryInput {
  modelRouter: ModelRouter;
  runtimeConfig: AgentRuntimeConfig;
  agentRegistry: DomainAgentRegistry;
  circuitBreaker: CircuitBreaker;
  focusStore: FocusStore;
}

export class RuntimeExecutionFactory {
  private readonly modelRouter: ModelRouter;
  private readonly runtimeConfig: AgentRuntimeConfig;
  private readonly agentRegistry: DomainAgentRegistry;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly focusStore: FocusStore;

  constructor(input: RuntimeExecutionFactoryInput) {
    this.modelRouter = input.modelRouter;
    this.runtimeConfig = input.runtimeConfig;
    this.agentRegistry = input.agentRegistry;
    this.circuitBreaker = input.circuitBreaker;
    this.focusStore = input.focusStore;
  }

  createExecutionServices(): AnalysisServices {
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

  createFollowUpModeExecutor(
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
}

export function buildRuntimeExecutionFactory(
  modelRouter: ModelRouter,
  runtimeConfig: AgentRuntimeConfig,
  circuitBreaker: CircuitBreaker,
  focusStore: FocusStore,
  agentRegistry?: DomainAgentRegistry
): RuntimeExecutionFactory {
  return new RuntimeExecutionFactory({
    modelRouter,
    runtimeConfig,
    circuitBreaker,
    focusStore,
    agentRegistry: agentRegistry || createDomainAgentRegistry(modelRouter),
  });
}

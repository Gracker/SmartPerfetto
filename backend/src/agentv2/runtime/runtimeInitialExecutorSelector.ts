import { ModelRouter } from '../../agent/core/modelRouter';
import type { ProgressEmitter, AgentRuntimeConfig, AnalysisServices } from '../../agent/core/orchestratorTypes';
import type { AnalysisExecutor } from '../../agent/core/executors/analysisExecutor';
import { StrategyExecutor } from '../../agent/core/executors/strategyExecutor';
import { HypothesisExecutor } from '../../agent/core/executors/hypothesisExecutor';
import { generateInitialHypotheses } from '../../agent/core/hypothesisGenerator';
import { detectTraceContext } from '../../agent/core/strategySelector';
import type { StrategyMatchResult, StrategyRegistry } from '../../agent/strategies';
import type { DomainAgentRegistry } from '../../agent/agents/domain';
import type { IterationStrategyPlanner } from '../../agent/agents/iterationStrategyPlanner';
import type { FocusStore } from '../../agent/context/focusStore';
import { shouldPreferHypothesisLoop } from '../../agent/config/domainManifest';
import { applyBlockedStrategyIds, type PreparedRuntimeContext } from './runtimeContextBuilder';

interface SelectInitialExecutorInput {
  query: string;
  traceId: string;
  runtimeContext: PreparedRuntimeContext;
  services: AnalysisServices;
  emitter: ProgressEmitter;
  runtimeConfig: AgentRuntimeConfig;
  modelRouter: ModelRouter;
  agentRegistry: DomainAgentRegistry;
  strategyPlanner: IterationStrategyPlanner;
  strategyRegistry: StrategyRegistry;
  focusStore: FocusStore;
}

export interface InitialExecutorSelection {
  executor: AnalysisExecutor;
  executorType: 'strategy' | 'hypothesis';
  initialHypotheses: Awaited<ReturnType<typeof generateInitialHypotheses>>;
  strategyMatchResult: StrategyMatchResult | null;
  effectiveConfig: AgentRuntimeConfig;
}

export async function selectInitialExecutor(input: SelectInitialExecutorInput): Promise<InitialExecutorSelection> {
  input.strategyPlanner.resetProgressTracking();

  const traceAgentState = input.runtimeContext.sessionContext.getOrCreateTraceAgentState(input.query);
  const hardMaxRounds = Math.max(1, input.runtimeConfig.maxRounds);
  const softMaxRounds = Math.max(
    1,
    Math.floor(Number(traceAgentState.preferences?.maxExperimentsPerTurn || 3))
  );
  const effectiveConfig: AgentRuntimeConfig = {
    ...input.runtimeConfig,
    maxRounds: hardMaxRounds,
    softMaxRounds: Math.min(hardMaxRounds, softMaxRounds),
  };

  const initialHypotheses = await generateInitialHypotheses(
    input.query,
    input.runtimeContext.intent,
    input.runtimeContext.sessionContext,
    input.modelRouter,
    input.agentRegistry,
    input.emitter
  );
  for (const hypothesis of initialHypotheses) {
    input.services.messageBus.updateHypothesis(hypothesis);
  }

  let strategyMatchResult: StrategyMatchResult | null = null;
  try {
    const traceContext = input.runtimeContext.executionOptions.traceProcessorService
      ? await detectTraceContext(input.runtimeContext.executionOptions.traceProcessorService, input.traceId)
      : undefined;
    strategyMatchResult = await input.strategyRegistry.matchEnhanced(
      input.query,
      input.runtimeContext.intent,
      traceContext
    );
  } catch {
    strategyMatchResult = null;
  }

  strategyMatchResult = applyBlockedStrategyIds(
    strategyMatchResult,
    input.runtimeContext.executionOptions.blockedStrategyIds
  );

  const preferredLoopMode = input.runtimeContext.sessionContext.getTraceAgentState()?.preferences?.defaultLoopMode;
  const preferHypothesisLoop = strategyMatchResult?.strategy
    ? shouldPreferHypothesisLoop({
        strategyId: strategyMatchResult.strategy.id,
        preferredLoopMode,
      })
    : false;

  if (strategyMatchResult?.strategy && !preferHypothesisLoop) {
    input.emitter.emitUpdate('strategy_selected', {
      strategyId: strategyMatchResult.strategy.id,
      strategyName: strategyMatchResult.strategy.name,
      confidence: strategyMatchResult.confidence,
      reasoning: strategyMatchResult.reasoning || 'keyword match',
      selectionMethod: strategyMatchResult.matchMethod === 'keyword' ? 'keyword' : 'llm',
    });

    return {
      executor: new StrategyExecutor(strategyMatchResult.strategy, input.services),
      executorType: 'strategy',
      initialHypotheses,
      strategyMatchResult,
      effectiveConfig,
    };
  }

  if (strategyMatchResult?.fallbackReason) {
    input.emitter.emitUpdate('strategy_fallback', {
      reason: strategyMatchResult.fallbackReason,
      candidatesEvaluated: input.strategyRegistry.getAll().length,
      topCandidateConfidence: strategyMatchResult.confidence,
      fallbackTo: 'hypothesis_driven',
    });
  }

  const hypothesisExecutor = new HypothesisExecutor(
    input.services,
    input.agentRegistry,
    input.strategyPlanner
  );
  hypothesisExecutor.setFocusStore(input.focusStore);

  return {
    executor: hypothesisExecutor,
    executorType: 'hypothesis',
    initialHypotheses,
    strategyMatchResult,
    effectiveConfig,
  };
}

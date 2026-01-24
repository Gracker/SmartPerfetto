/**
 * SmartPerfetto Agent-Driven Orchestrator (Thin Coordinator)
 *
 * This orchestrator is a thin coordination layer that:
 * 1. Initializes infrastructure (message bus, agent registry, etc.)
 * 2. Understands user intent and generates hypotheses
 * 3. Selects the appropriate executor (Strategy or Hypothesis)
 * 4. Delegates execution to the chosen executor
 * 5. Generates conclusion from executor results
 *
 * All heavy logic lives in extracted modules:
 * - intentUnderstanding.ts — intent parsing
 * - hypothesisGenerator.ts — hypothesis generation
 * - taskGraphPlanner.ts — task planning
 * - taskGraphExecutor.ts — dependency-ordered execution
 * - feedbackSynthesizer.ts — LLM synthesis
 * - conclusionGenerator.ts — conclusion generation
 * - executors/strategyExecutor.ts — deterministic pipeline
 * - executors/hypothesisExecutor.ts — adaptive loop
 */

import { EventEmitter } from 'events';
import { StreamingUpdate } from '../types';
import { ModelRouter } from './modelRouter';
import { AgentMessageBus, createAgentMessageBus } from '../communication';
import { DomainAgentRegistry, createDomainAgentRegistry } from '../agents/domain';
import {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
} from '../agents/iterationStrategyPlanner';
import {
  createStrategyRegistry,
  StrategyRegistry,
} from '../strategies';
import {
  sessionContextManager,
} from '../context/enhancedSessionContext';
import { CircuitBreaker } from './circuitBreaker';

import {
  AgentDrivenOrchestratorConfig,
  DEFAULT_CONFIG,
  AnalysisResult,
  AnalysisOptions,
  AnalysisServices,
  ProgressEmitter,
  ExecutionContext,
} from './orchestratorTypes';
import { understandIntent } from './intentUnderstanding';
import { generateInitialHypotheses } from './hypothesisGenerator';
import { generateConclusion } from './conclusionGenerator';
import { StrategyExecutor } from './executors/strategyExecutor';
import { HypothesisExecutor } from './executors/hypothesisExecutor';

// =============================================================================
// Agent-Driven Orchestrator
// =============================================================================

export class AgentDrivenOrchestrator extends EventEmitter {
  private config: AgentDrivenOrchestratorConfig;
  private modelRouter: ModelRouter;
  private messageBus: AgentMessageBus;
  private agentRegistry: DomainAgentRegistry;
  private strategyPlanner: IterationStrategyPlanner;
  private strategyRegistry: StrategyRegistry;
  private circuitBreaker: CircuitBreaker;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentDrivenOrchestratorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = modelRouter;

    this.messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      enableLogging: this.config.enableLogging,
    });

    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);
    this.strategyRegistry = createStrategyRegistry();
    this.circuitBreaker = new CircuitBreaker();

    // Register all agents with message bus
    for (const agent of this.agentRegistry.getAll()) {
      this.messageBus.registerAgent(agent);
    }

    this.setupEventForwarding();
  }

  // ==========================================================================
  // Core Analysis Method
  // ==========================================================================

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {}
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    this.strategyPlanner.resetProgressTracking();
    // NOTE: CircuitBreaker is NOT reset per-call — failure history persists
    // across multi-turn sessions. Use orchestrator.reset() for full cleanup.

    const emitter = this.createProgressEmitter();
    emitter.log(`Starting agent-driven analysis for: ${query}`);
    emitter.emitUpdate('progress', { phase: 'starting', message: '开始 AI Agent 分析' });

    try {
      // 1. Initialize context
      sessionContextManager.getOrCreate(sessionId, traceId);
      const sharedContext = this.messageBus.createSharedContext(sessionId, traceId);

      // 2. Understand intent
      emitter.emitUpdate('progress', { phase: 'understanding', message: '理解用户意图' });
      const intent = await understandIntent(query, this.modelRouter, emitter);

      // 3. Generate hypotheses
      const initialHypotheses = await generateInitialHypotheses(
        query, intent, this.modelRouter, this.agentRegistry, emitter
      );
      for (const hypothesis of initialHypotheses) {
        this.messageBus.updateHypothesis(hypothesis);
      }
      emitter.emitUpdate('progress', {
        phase: 'hypotheses_generated',
        message: `生成 ${initialHypotheses.length} 个假设`,
        hypotheses: initialHypotheses.map(h => h.description),
      });

      // 4. Build execution context
      const executionCtx: ExecutionContext = {
        query,
        sessionId,
        traceId,
        intent,
        initialHypotheses,
        sharedContext,
        options,
        config: this.config,
      };

      // 5. Select and run executor
      const services: AnalysisServices = {
        modelRouter: this.modelRouter,
        messageBus: this.messageBus,
        circuitBreaker: this.circuitBreaker,
      };
      const matchedStrategy = this.strategyRegistry.match(query);
      const executor = matchedStrategy
        ? new StrategyExecutor(matchedStrategy, services)
        : new HypothesisExecutor(services, this.agentRegistry, this.strategyPlanner);

      const executorResult = await executor.execute(executionCtx, emitter);

      // 6. Generate conclusion
      emitter.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
      const conclusion = await generateConclusion(
        sharedContext, executorResult.findings, intent,
        this.modelRouter, emitter, executorResult.stopReason || undefined
      );

      emitter.emitUpdate('conclusion', {
        sessionId,
        summary: conclusion,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
      });

      // 7. Return result
      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings: executorResult.findings,
        hypotheses: Array.from(sharedContext.hypotheses.values()),
        conclusion,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
        totalDurationMs: Date.now() - startTime,
      };

      emitter.log(`Analysis complete: ${executorResult.findings.length} findings, ${executorResult.rounds} rounds`);
      return result;

    } catch (error: any) {
      emitter.log(`Analysis failed: ${error.message}`);
      emitter.emitUpdate('error', { message: error.message });

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `分析失败: ${error.message}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  // ==========================================================================
  // Infrastructure
  // ==========================================================================

  private createProgressEmitter(): ProgressEmitter {
    return {
      emitUpdate: (type, content) => {
        const update: StreamingUpdate = { type, content, timestamp: Date.now() };
        this.emit('update', update);
        if (this.config.streamingCallback) {
          this.config.streamingCallback(update);
        }
      },
      log: (message) => {
        if (this.config.enableLogging) {
          console.log(`[AgentDrivenOrchestrator] ${message}`);
        }
      },
    };
  }

  private setupEventForwarding(): void {
    this.messageBus.on('task_dispatched', (data) => {
      this.emitRaw('progress', { phase: 'task_dispatched', ...data });
    });
    this.messageBus.on('task_completed', (data) => {
      this.emitRaw('progress', { phase: 'task_completed', ...data });
    });
    this.messageBus.on('agent_question', (question) => {
      this.emitRaw('progress', { phase: 'agent_question', ...question });
    });
    this.messageBus.on('broadcast', (message) => {
      this.emitRaw('progress', { phase: 'broadcast', ...message });
    });
  }

  private emitRaw(type: StreamingUpdate['type'], content: any): void {
    const update: StreamingUpdate = { type, content, timestamp: Date.now() };
    this.emit('update', update);
    if (this.config.streamingCallback) {
      this.config.streamingCallback(update);
    }
  }

  reset(): void {
    this.messageBus.reset();
    this.circuitBreaker.reset();
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgentDrivenOrchestrator(
  modelRouter: ModelRouter,
  config?: Partial<AgentDrivenOrchestratorConfig>
): AgentDrivenOrchestrator {
  return new AgentDrivenOrchestrator(modelRouter, config);
}

// Re-export types for backward compatibility
export type { AgentDrivenOrchestratorConfig, AnalysisResult } from './orchestratorTypes';

export default AgentDrivenOrchestrator;

/**
 * SmartPerfetto Agent Core Module
 *
 * 导出核心架构组件
 */

export { AgentStateMachine } from './stateMachine';
export { CircuitBreaker } from './circuitBreaker';
export { ModelRouter, AllModelsFailedError } from './modelRouter';
export { PipelineExecutor } from './pipelineExecutor';

// Orchestrator and executors
export { AgentDrivenOrchestrator, createAgentDrivenOrchestrator } from './agentDrivenOrchestrator';
export { StrategyExecutor } from './executors/strategyExecutor';
export { HypothesisExecutor } from './executors/hypothesisExecutor';

// Orchestrator sub-modules
export { understandIntent } from './intentUnderstanding';
export { generateInitialHypotheses, generateDefaultHypotheses, createHypothesis } from './hypothesisGenerator';
export { generateConclusion, generateSimpleConclusion } from './conclusionGenerator';
export { executeTaskGraph, emitDataEnvelopes } from './taskGraphExecutor';
export { synthesizeFeedback } from './feedbackSynthesizer';
export { planTaskGraph, buildTasksFromGraph, parseTimeRange, resolveAgentIdForDomain } from './taskGraphPlanner';

// Orchestrator types
export type {
  AgentDrivenOrchestratorConfig,
  AnalysisResult,
  AnalysisOptions,
  AnalysisServices,
  ProgressEmitter,
  StreamingEventPayloads,
  PayloadFor,
  ExecutionContext,
  ExecutorResult,
  TaskGraphNode,
  TaskGraphPlan,
} from './orchestratorTypes';
export {
  AGENT_IDS,
  DEFAULT_CONFIG,
  DOMAIN_ALIASES,
  DEFAULT_EVIDENCE,
  normalizeDomain,
  concludeDecision,
  translateStrategy,
} from './orchestratorTypes';
export type { AnalysisExecutor } from './executors/analysisExecutor';
export type { SynthesisResult } from './feedbackSynthesizer';

// 重新导出类型
export type {
  // State Machine Types
  AgentPhase,
  StateEvent,
  Checkpoint,
  SerializedAgentState,
  StateMachineConfig,
  AgentStateMachineState,
  // Pipeline Types
  PipelineStage,
  StageResult,
  PipelineConfig,
  PipelineErrorDecision,
  PipelineResult,
  PipelineCallbacks,
  PipelineProgress,
  // Circuit Breaker Types
  CircuitState,
  CircuitBreakerConfig,
  CircuitDecision,
  CircuitDiagnostics,
  CircuitBreakerState,
  // Model Router Types
  ModelProvider,
  ModelStrength,
  TaskType,
  ModelProfile,
  ModelRouterConfig,
  ModelCallResult,
  EnsembleResult,
} from '../types';

export * from './types';
export * from './toolRegistry';
export {
  registerCoreTools,
  sqlExecutorTool,
  frameAnalyzerTool,
  dataStatsTool,
  skillInvokerTool,
  getAvailableSkillIds,
  getSkillIdForSceneType,
} from './tools';

// Legacy architecture exports (保持向后兼容)
export {
  BaseExpertAgent,
  LLMClient,
  ScrollingExpertAgent,
  createScrollingExpertAgent,
  SceneReconstructionExpertAgent,
  createSceneReconstructionAgent,
  DetectedScene,
  TrackEvent,
  SceneReconstructionResult,
  SceneCategory,
} from './agents';
export { PerfettoOrchestratorAgent, createOrchestrator } from './orchestrator';
export {
  createLLMClient,
  createDeepSeekLLMClient,
  createOpenAILLMClient,
  LLMAdapterConfig,
  LLMConfigurationError,
} from './llmAdapter';
export {
  AgentTraceRecorder,
  getAgentTraceRecorder,
  resetAgentTraceRecorder,
  RecordedTrace,
  TraceRecorderConfig,
} from './traceRecorder';
export {
  AgentEvalSystem,
  createEvalSystem,
  EvalCase,
  EvalResult,
  EvalSummary,
  ExpectedFinding,
  SCROLLING_EVAL_CASES,
} from './evalSystem';

// =============================================================================
// New Architecture Exports (新架构导出)
// =============================================================================

// Core components
export {
  AgentStateMachine,
  CircuitBreaker,
  ModelRouter,
  PipelineExecutor,
} from './core';

// State management
export {
  CheckpointManager,
  SessionStore,
} from './state';

// New SubAgent architecture
export {
  BaseSubAgent,
  PlannerAgent,
  EvaluatorAgent,
} from './agents';

// Master Orchestrator (新的主编排者)
export { MasterOrchestrator, createMasterOrchestrator } from './core/masterOrchestrator';

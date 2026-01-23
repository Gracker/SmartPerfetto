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

// Legacy utilities still used by scene reconstruction and tooling
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
// Core exports (Agent-Driven)
// =============================================================================

export { ModelRouter } from './core';

// =============================================================================
// Agent-Driven Architecture (唯一主链路)
// =============================================================================

// Agent-Driven Orchestrator (假设驱动分析)
export {
  AgentDrivenOrchestrator,
  createAgentDrivenOrchestrator,
  AnalysisResult as AgentDrivenAnalysisResult,
  AgentDrivenOrchestratorConfig,
} from './core/agentDrivenOrchestrator';

// Domain Agents (领域 Agent)
export {
  BaseAgent,
  FrameAgent,
  createFrameAgent,
  CPUAgent,
  createCPUAgent,
  BinderAgent,
  createBinderAgent,
  MemoryAgent,
  createMemoryAgent,
  StartupAgent,
  InteractionAgent,
  ANRAgent,
  SystemAgent,
  createStartupAgent,
  createInteractionAgent,
  createANRAgent,
  createSystemAgent,
  DomainAgentRegistry,
  createDomainAgentRegistry,
} from './agents/domain';

// Agent Communication (Agent 通信)
export {
  AgentMessageBus,
  createAgentMessageBus,
} from './communication';

// Agent Protocol Types (Agent 协议类型)
export {
  AgentTask,
  AgentResponse,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
  Evidence,
  SharedAgentContext,
  createTaskId,
  createHypothesisId,
  createMessageId,
} from './types/agentProtocol';

// Iteration Strategy Planner (迭代策略规划器)
export {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
  IterationStrategy,
  StrategyDecision,
} from './agents/iterationStrategyPlanner';

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

export { ModelRouter } from './core/modelRouter';

// =============================================================================
// Agent-Driven Architecture (唯一主链路)
// =============================================================================

export type {
  AgentRuntimeConfig,
  AnalysisResult,
} from './core/orchestratorTypes';

export {
  AgentRuntime,
  createAgentRuntime,
  AgentRuntimeAnalysisResult,
} from '../agentv2/runtime/agentRuntime';
export type {
  AgentRuntimeExtensions,
  RuntimeModeHandler,
  RuntimeModeHandlerRegistrationOptions,
} from '../agentv2/runtime/agentRuntime';

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
export type { FrameMechanismRecord } from './types/jankCause';

// Iteration Strategy Planner (迭代策略规划器)
export {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
  IterationStrategy,
  StrategyDecision,
} from './agents/iterationStrategyPlanner';

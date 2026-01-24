/**
 * SmartPerfetto Agent System - Core Types
 * 
 * This file defines the core interfaces for the Agent-based analysis system.
 * The architecture follows a layered design:
 * - Tool Layer: Atomic, deterministic operations (SQL execution, data analysis)
 * - Expert Agent Layer: Domain-specific analysis agents (Scrolling, Startup, Memory)
 * - Orchestrator Agent: High-level coordination and reasoning
 */

// =============================================================================
// Tool Layer Types
// =============================================================================

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp' | 'array' | 'object';
  required: boolean;
  description: string;
  default?: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'sql' | 'analysis' | 'data' | 'visualization' | 'knowledge';
  parameters: ToolParameter[];
  returns: {
    type: string;
    description: string;
  };
}

export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  executionTimeMs: number;
  metadata?: Record<string, any>;
}

export interface Tool<TParams = any, TResult = any> {
  definition: ToolDefinition;
  execute(params: TParams, context: ToolContext): Promise<ToolResult<TResult>>;
  validate?(params: TParams): { valid: boolean; errors: string[] };
}

export interface ToolContext {
  traceId: string;
  traceProcessor?: any;
  traceProcessorService?: any;
  package?: string;
  /** AI 服务，用于 ai_summary 和 ai_decision 步骤 */
  aiService?: {
    chat: (prompt: string) => Promise<string>;
  };
}

// =============================================================================
// Agent Types
// =============================================================================

export interface AgentThought {
  step: number;
  observation: string;
  reasoning: string;
  decision: string;
  confidence: number;
}

export interface AgentAction {
  type: 'tool_call' | 'delegate' | 'conclude';
  toolName?: string;
  toolParams?: Record<string, any>;
  delegateTo?: string;
  conclusion?: string;
}

export interface AgentState {
  query: string;
  context: AnalysisContext;
  thoughts: AgentThought[];
  toolResults: ToolResult[];
  findings: string[];
  currentStep: number;
  isComplete: boolean;
}

export interface AnalysisContext {
  traceId: string;
  package?: string;
  timeRange?: { start: string; end: string };
  previousFindings?: string[];
  userPreferences?: Record<string, any>;
}

export interface ExpertAgentConfig {
  name: string;
  domain: string;
  description: string;
  tools: string[];
  maxIterations: number;
  confidenceThreshold: number;
}

export interface ExpertResult {
  agentName: string;
  findings: Finding[];
  diagnostics: Diagnostic[];
  suggestions: string[];
  confidence: number;
  executionTimeMs: number;
  trace: AgentTrace;
}

export interface Finding {
  id: string;
  /** 发现分类 (如: scrolling, startup, memory) */
  category?: string;
  /** 发现类型 (如: root_cause, performance, issue) */
  type?: string;
  /** 严重程度 */
  severity: 'info' | 'warning' | 'critical' | 'low' | 'medium' | 'high';
  title: string;
  description: string;
  evidence?: any[];
  relatedTimestamps?: string[];
  timestampsNs?: number[];
  /** 来源 (如: decision_tree, skill, analysis) */
  source?: string;
  /** 置信度 (0-1) */
  confidence?: number;
  /** 详细信息 */
  details?: Record<string, any>;
  /** 优化建议 */
  recommendations?: Array<{
    id: string;
    text: string;
    priority: number;
  }>;
}

export interface Diagnostic {
  id: string;
  condition: string;
  matched: boolean;
  message: string;
  suggestions: string[];
}

// =============================================================================
// Orchestrator Types
// =============================================================================

export interface Intent {
  primaryGoal: string;
  aspects: string[];
  expectedOutputType: 'diagnosis' | 'comparison' | 'timeline' | 'summary';
  complexity: 'simple' | 'moderate' | 'complex';
}

export interface AnalysisPlan {
  tasks: AnalysisTask[];
  estimatedDuration: number;
  parallelizable: boolean;
}

export interface AnalysisTask {
  id: string;
  expertAgent: string;
  objective: string;
  dependencies: string[];
  priority: number;
  context: Partial<AnalysisContext>;
}

export interface OrchestratorResult {
  intent: Intent;
  plan: AnalysisPlan;
  expertResults: ExpertResult[];
  synthesizedAnswer: string;
  confidence: number;
  executionTimeMs: number;
  trace: OrchestratorTrace;
}

// =============================================================================
// Trace Types (Observability)
// =============================================================================

export interface ToolCall {
  toolName: string;
  params: Record<string, any>;
  result: ToolResult;
  startTime: number;
  endTime: number;
}

export interface AgentTrace {
  agentName: string;
  startTime: number;
  endTime: number;
  thoughts: AgentThought[];
  toolCalls: ToolCall[];
  totalTokens?: {
    input: number;
    output: number;
  };
}

export interface OrchestratorTrace {
  query: string;
  intent: Intent;
  plan: AnalysisPlan;
  expertTraces: AgentTrace[];
  synthesisThought: AgentThought;
  totalDuration: number;
  totalLLMCalls: number;
}

// =============================================================================
// Registry Types
// =============================================================================

export interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): ToolDefinition[];
  listByCategory(category: string): ToolDefinition[];
  getToolDescriptionsForLLM(): string;
}

export interface AgentRegistry {
  registerExpert(agent: ExpertAgent): void;
  getExpert(name: string): ExpertAgent | undefined;
  listExperts(): ExpertAgentConfig[];
  getExpertForDomain(domain: string): ExpertAgent | undefined;
}

// =============================================================================
// Agent Interfaces
// =============================================================================

export interface ExpertAgent {
  config: ExpertAgentConfig;
  analyze(context: AnalysisContext): Promise<ExpertResult>;
  canHandle(intent: Intent): boolean;
}

export interface OrchestratorAgent {
  handleQuery(query: string, traceId: string, options?: OrchestratorOptions): Promise<OrchestratorResult>;
  understandIntent(query: string): Promise<Intent>;
  planAnalysis(intent: Intent, context: AnalysisContext): Promise<AnalysisPlan>;
  selectExpert(task: AnalysisTask): ExpertAgent | undefined;
  synthesize(results: ExpertResult[], intent: Intent): Promise<string>;
}

export interface OrchestratorOptions {
  maxDuration?: number;
  maxLLMCalls?: number;
  maxExpertIterations?: number;
  confidenceThreshold?: number;
  streamingCallback?: (update: StreamingUpdate) => void;
}

export interface StreamingUpdate {
  /**
   * Event type for streaming updates
   *
   * v2.0 Events:
   * - 'data': Unified data event carrying DataEnvelope(s)
   *
   * Legacy Events (backward compatibility):
   * - 'skill_data': Skill execution results (LayeredSkillResult)
   *
   * Common Events:
   * - 'thought', 'worker_thought': Agent reasoning
   * - 'tool_call': Tool invocation
   * - 'finding': Diagnostic finding
   * - 'progress': Progress update
   * - 'conclusion': Analysis conclusion
   * - 'error': Error message
   *
   * Agent-Driven Events (Phase 2-4):
   * - 'hypothesis_generated': Initial hypotheses created
   * - 'agent_task_dispatched': Task sent to domain agent
   * - 'agent_dialogue': Agent communication event
   * - 'agent_response': Agent completed task
   * - 'round_start': Analysis round started
   * - 'synthesis_complete': Feedback synthesis complete
   * - 'strategy_decision': Next iteration strategy decided
   */
  type: 'data' | 'thought' | 'tool_call' | 'finding' | 'progress' | 'conclusion' | 'error' | 'scene_detected' | 'track_data' | 'skill_layered_result' | 'worker_thought' | 'architecture_detected'
    | 'hypothesis_generated' | 'agent_task_dispatched' | 'agent_dialogue' | 'agent_response' | 'round_start' | 'synthesis_complete' | 'strategy_decision'
    | 'degraded' | 'stage_transition' | 'circuit_breaker'
    /** @deprecated Use 'skill_layered_result' instead. Will be removed in v3.0 */
    | 'skill_data';
  content: any;
  timestamp: number;
  /**
   * Optional unique event ID for deduplication (v2.0)
   * Used with 'data' events to prevent duplicate rendering on frontend
   */
  id?: string;
}

// =============================================================================
// State Machine Types (新架构)
// =============================================================================

/**
 * Agent execution phase enum
 *
 * Provides type-safe state values for the agent state machine.
 * @see STATE_TRANSITIONS in stateMachine.ts for valid transitions
 */
export enum AgentPhase {
  IDLE = 'idle',
  PLANNING = 'planning',
  EXECUTING = 'executing',
  EVALUATING = 'evaluating',
  REFINING = 'refining',
  AWAITING_USER = 'awaiting_user',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * State machine event type enum
 *
 * Provides type-safe event names for state transitions.
 */
export enum StateEventType {
  START_ANALYSIS = 'START_ANALYSIS',
  INTENT_UNDERSTOOD = 'INTENT_UNDERSTOOD',
  PLAN_CREATED = 'PLAN_CREATED',
  STAGE_STARTED = 'STAGE_STARTED',
  STAGE_COMPLETED = 'STAGE_COMPLETED',
  EVALUATION_COMPLETE = 'EVALUATION_COMPLETE',
  NEEDS_REFINEMENT = 'NEEDS_REFINEMENT',
  CIRCUIT_TRIPPED = 'CIRCUIT_TRIPPED',
  USER_RESPONDED = 'USER_RESPONDED',
  ANALYSIS_COMPLETE = 'ANALYSIS_COMPLETE',
  ERROR_OCCURRED = 'ERROR_OCCURRED',
}

export interface StateEvent {
  type: StateEventType;
  payload?: any;
  timestamp?: number;
}

export interface Checkpoint {
  id: string;
  stageId: string;
  timestamp: number;
  phase: AgentPhase;
  agentState: SerializedAgentState;
  stageResults: StageResult[];
  findings: Finding[];
  canResume: boolean;
}

export interface SerializedAgentState {
  query: string;
  traceId: string;
  intent?: Intent;
  plan?: AnalysisPlan;
  expertResults: ExpertResult[];
  iterationCount: number;
  metadata: Record<string, any>;
}

export interface StateMachineConfig {
  sessionId: string;
  traceId: string;
  persistPath?: string;
  autoSave?: boolean;
  autoSaveIntervalMs?: number;
}

export interface AgentStateMachineState {
  sessionId: string;
  traceId: string;
  phase: AgentPhase;
  checkpoints: Map<string, Checkpoint>;
  iterationCounters: Map<string, number>;
  currentStageIndex: number;
  stageResults: Map<string, StageResult>;
  events: StateEvent[];
  createdAt: number;
  updatedAt: number;
}

// =============================================================================
// Pipeline Types (新架构)
// =============================================================================

export interface PipelineStage {
  id: string;
  name: string;
  description: string;
  agentType: 'planner' | 'worker' | 'evaluator' | 'synthesizer';
  dependencies: string[];
  canParallelize: boolean;
  timeout: number;
  maxRetries: number;
  /** 阶段元数据，用于配置额外选项如分析类型 */
  metadata?: {
    /** 决策树分析类型 (scrolling/launch/memory 等) */
    analysisType?: string;
    /** 其他自定义配置 */
    [key: string]: any;
  };
}

export interface StageResult {
  stageId: string;
  success: boolean;
  data?: any;
  error?: string;
  findings: Finding[];
  startTime: number;
  endTime: number;
  retryCount: number;
}

export interface PipelineConfig {
  stages: PipelineStage[];
  maxTotalDuration: number;
  enableParallelization: boolean;
  onStageComplete?: (stage: PipelineStage, result: StageResult) => void;
  onStageError?: (stage: PipelineStage, error: Error) => PipelineErrorDecision;
}

export type PipelineErrorDecision = 'retry' | 'skip' | 'abort' | 'ask_user';

export interface PipelineResult {
  success: boolean;
  stageResults: StageResult[];
  totalDuration: number;
  completedStages: string[];
  failedStages: string[];
  pausedAt?: string;
  error?: string;
}

export interface PipelineCallbacks {
  onStageComplete: (stage: PipelineStage, result: StageResult) => void;
  onStageStart: (stage: PipelineStage) => void;
  onError: (stage: PipelineStage, error: Error) => Promise<PipelineErrorDecision>;
  onProgress: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
  currentStage: string;
  completedStages: number;
  totalStages: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

// =============================================================================
// Circuit Breaker Types (新架构)
// =============================================================================

/**
 * Circuit breaker state enum
 *
 * Provides type-safe state values for the circuit breaker pattern.
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests are blocked
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export interface CircuitBreakerConfig {
  maxRetriesPerAgent: number;
  maxIterationsPerStage: number;
  cooldownMs: number;
  halfOpenAttempts: number;
  failureThreshold: number;
  successThreshold: number;
}

export interface CircuitDecision {
  action: 'continue' | 'retry' | 'skip' | 'abort' | 'ask_user';
  reason?: string;
  delay?: number;
  context?: CircuitDiagnostics;
}

export interface CircuitDiagnostics {
  agentId: string;
  failureCount: number;
  iterationCount: number;
  lastError?: string;
  lastAttemptTime: number;
  state: CircuitState;
  recentErrors: Array<{ time: number; error: string }>;
}

export interface CircuitBreakerState {
  state: CircuitState;
  retryCounters: Map<string, number>;
  iterationCounters: Map<string, number>;
  failureHistory: Map<string, Array<{ time: number; error: string }>>;
  lastStateChange: number;
  tripReason?: string;
}

// =============================================================================
// Multi-Model Router Types (新架构)
// =============================================================================

export type ModelProvider = 'anthropic' | 'openai' | 'deepseek' | 'glm' | 'mock';
export type ModelStrength = 'reasoning' | 'coding' | 'speed' | 'cost' | 'vision';
export type TaskType =
  | 'intent_understanding'
  | 'planning'
  | 'synthesis'
  | 'evaluation'
  | 'sql_generation'
  | 'code_analysis'
  | 'simple_extraction'
  | 'formatting'
  | 'general';

export interface ModelProfile {
  id: string;
  provider: ModelProvider;
  model: string;
  strengths: ModelStrength[];
  costPerInputToken: number;
  costPerOutputToken: number;
  avgLatencyMs: number;
  maxTokens: number;
  supportsJSON: boolean;
  supportsStreaming: boolean;
  enabled: boolean;
}

export interface ModelRouterConfig {
  models: ModelProfile[];
  defaultModel: string;
  taskModelMapping: Partial<Record<TaskType, string>>;
  fallbackChain: string[];
  enableEnsemble: boolean;
  ensembleThreshold: number;
}

export interface ModelCallResult {
  modelId: string;
  response: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface EnsembleResult {
  responses: ModelCallResult[];
  aggregatedResponse: string;
  confidence: number;
  agreementScore: number;
  totalCost: number;
  totalLatencyMs: number;
}

// =============================================================================
// SubAgent Types (新架构)
// =============================================================================

export interface SubAgentConfig {
  id: string;
  name: string;
  type: 'planner' | 'worker' | 'evaluator' | 'synthesizer';
  description: string;
  preferredModel?: TaskType;
  tools: string[];
  maxIterations: number;
  confidenceThreshold: number;
}

export interface SubAgentContext {
  sessionId: string;
  traceId: string;
  intent?: Intent;
  plan?: AnalysisPlan;
  previousResults?: StageResult[];
  /** 当前迭代编号（用于去重与多轮分析） */
  iteration?: number;
  feedback?: EvaluationFeedback;
  traceProcessor?: any;
  traceProcessorService?: any;
  /** 检测到的渲染架构信息 (Phase 1 新增) */
  architecture?: import('../agent/detectors').ArchitectureInfo;
  /** 用户原始查询 */
  query?: string;
  /** 用户查询 (别名) */
  userQuery?: string;
  /** 目标应用包名 */
  package?: string;
  /** 分析时间范围 (string for precision-safe ns timestamps) */
  timeRange?: { start: number | string; end: number | string };
  /** AI 服务，用于 Skill 的 ai_summary 和 ai_decision 步骤 */
  aiService?: {
    chat: (prompt: string) => Promise<string>;
  };
}

export interface SubAgentResult {
  agentId?: string;
  success: boolean;
  findings: Finding[];
  suggestions?: string[];
  data?: any;
  message?: string;
  confidence?: number;
  executionTimeMs?: number;
  tokensUsed?: { input: number; output: number };
  metrics?: Record<string, any>;
  error?: string;
}

// =============================================================================
// Evaluator Types (新架构)
// =============================================================================

export interface Evaluation {
  passed: boolean;
  qualityScore: number;
  completenessScore: number;
  contradictions: Contradiction[];
  feedback: EvaluationFeedback;
  needsImprovement: boolean;
  suggestedActions: string[];
}

export interface Contradiction {
  finding1: string;
  finding2: string;
  description: string;
  severity: 'minor' | 'major' | 'critical';
}

export interface EvaluationFeedback {
  strengths: string[];
  weaknesses: string[];
  missingAspects: string[];
  improvementSuggestions: string[];
  priorityActions: string[];
}

export interface EvaluationCriteria {
  minQualityScore: number;
  minCompletenessScore: number;
  maxContradictions: number;
  requiredAspects: string[];
}

// =============================================================================
// Master Orchestrator Types (新架构)
// =============================================================================

export interface MasterOrchestratorConfig {
  stateMachineConfig: StateMachineConfig;
  circuitBreakerConfig: CircuitBreakerConfig;
  modelRouterConfig: ModelRouterConfig;
  pipelineConfig: PipelineConfig;
  evaluationCriteria: EvaluationCriteria;
  maxTotalIterations: number;
  enableTraceRecording: boolean;
  streamingCallback?: (update: StreamingUpdate) => void;
}

export interface MasterOrchestratorResult {
  sessionId: string;
  intent: Intent;
  plan: AnalysisPlan;
  stageResults: StageResult[];
  evaluation: Evaluation;
  synthesizedAnswer: string;
  confidence: number;
  totalDuration: number;
  iterationCount: number;
  modelUsage: ModelUsageSummary;
  canResume: boolean;
  checkpointId?: string;
}

export interface ModelUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  modelBreakdown: Record<string, { calls: number; tokens: number; cost: number }>;
}

// =============================================================================
// Session & Recovery Types (新架构)
// =============================================================================

export interface SessionInfo {
  sessionId: string;
  traceId: string;
  query: string;
  phase: AgentPhase;
  createdAt: number;
  updatedAt: number;
  canResume: boolean;
  lastCheckpointId?: string;
  error?: string;
}

export interface RecoveryOptions {
  fromCheckpoint?: string;
  skipFailedStage?: boolean;
  overrideConfig?: Partial<MasterOrchestratorConfig>;
}

export interface RecoveryResult {
  success: boolean;
  resumedFrom: string;
  result?: MasterOrchestratorResult;
  error?: string;
}

// =============================================================================
// Multi-turn Dialogue Types (Phase 5)
// =============================================================================

/**
 * Represents a single conversation turn in multi-turn dialogue
 * Used to track history and enable context-aware responses
 */
export interface ConversationTurn {
  /** Unique turn identifier */
  id: string;
  /** Turn timestamp in milliseconds */
  timestamp: number;
  /** User's query for this turn */
  query: string;
  /** Understood intent for this query */
  intent: Intent;
  /** Analysis result from this turn */
  result?: SubAgentResult;
  /** Findings discovered in this turn */
  findings: Finding[];
  /** Turn index (0-based) */
  turnIndex: number;
  /** Whether this turn completed successfully */
  completed: boolean;
}

/**
 * Finding reference used to link between turns
 */
export interface FindingReference {
  /** Finding ID to reference */
  findingId: string;
  /** Turn ID where finding was discovered */
  turnId: string;
  /** Type of reference */
  refType: 'continuation' | 'clarification' | 'contrast' | 'expansion';
}

/**
 * Context summary for LLM consumption
 */
export interface ContextSummary {
  /** Total number of turns */
  turnCount: number;
  /** Summary of conversation so far */
  conversationSummary: string;
  /** Key findings from all turns */
  keyFindings: Array<{
    id: string;
    title: string;
    severity: string;
    turnIndex: number;
  }>;
  /** Topics discussed */
  topicsDiscussed: string[];
  /** Open questions remaining */
  openQuestions: string[];
}

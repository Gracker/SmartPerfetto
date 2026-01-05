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
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  evidence: any[];
  relatedTimestamps?: string[];
  timestampsNs?: number[];
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
  type: 'thought' | 'tool_call' | 'finding' | 'progress' | 'conclusion' | 'error';
  content: any;
  timestamp: number;
}

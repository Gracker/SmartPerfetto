// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

import type { ClaimSupportV1 } from '../types/evidenceContract';
import type { ClaimVerificationResult } from '../types/claimVerification';
import type { IdentityResolutionV1 } from '../types/identityContract';

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

export interface AnalysisContext {
  traceId: string;
  package?: string;
  timeRange?: { start: string; end: string };
  previousFindings?: string[];
  userPreferences?: Record<string, any>;
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

/**
 * Follow-up type classification for multi-turn dialogue
 */
export type FollowUpType = 'initial' | 'drill_down' | 'clarify' | 'extend' | 'compare';

/**
 * Referenced entity extracted from user query
 * Used to link follow-up queries to previous findings
 */
export interface ReferencedEntity {
  /** Entity type being referenced */
  type: 'frame' | 'session' | 'startup' | 'process' | 'binder_call' | 'time_range';
  /** Entity identifier (e.g., frame_id, session_id) */
  id?: number | string;
  /** Additional value data */
  value?: any;
  /** Which turn this entity was discovered in (0-based) */
  fromTurn?: number;
}

export interface Intent {
  primaryGoal: string;
  aspects: string[];
  expectedOutputType: 'diagnosis' | 'comparison' | 'timeline' | 'summary';
  complexity: 'simple' | 'moderate' | 'complex';

  /**
   * Follow-up type for multi-turn conversations
   * - initial: First query, no prior context
   * - drill_down: Deep dive into specific finding (e.g., "详细分析帧456")
   * - clarify: Request explanation of previous finding
   * - extend: Expand analysis scope
   * - compare: Compare multiple findings
   */
  followUpType?: FollowUpType;

  /**
   * Entities referenced in the user query that link to previous findings
   * Populated by LLM during intent understanding
   */
  referencedEntities?: ReferencedEntity[];

  /**
   * Parameters extracted from query that can be passed directly to skills
   * e.g., { frame_id: 456, session_id: 2 }
   */
  extractedParams?: Record<string, any>;
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
   * - 'answer_token': Display-only answer draft text (runId + attempt)
   * - 'answer_segment_reset': Revokes the current answer draft segment
   * - 'conclusion': Analysis conclusion
   * - 'error': Error message
   * - 'conversation_step': Strictly ordered conversational timeline event
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
  type: 'data' | 'thought' | 'tool_call' | 'finding' | 'progress' | 'answer_token' | 'answer_segment_reset' | 'conclusion' | 'error' | 'scene_detected' | 'track_data' | 'skill_layered_result' | 'worker_thought' | 'architecture_detected'
    | 'conversation_step'
    | 'hypothesis_generated' | 'agent_task_dispatched' | 'agent_dialogue' | 'agent_response' | 'round_start' | 'synthesis_complete' | 'strategy_decision'
    | 'degraded' | 'stage_transition' | 'circuit_breaker'
    // Agent-Driven Architecture v2.0 events
    | 'strategy_selected' | 'strategy_fallback'
    | 'sql_generated' | 'sql_validation_failed'
    | 'focus_updated' | 'incremental_scope'
    // Claude Agent SDK (agentv3) sub-agent events
    | 'sub_agent_started' | 'sub_agent_completed'
    // Claude Agent SDK (agentv3) planning events
    | 'plan_submitted' | 'plan_phase_updated' | 'plan_revised'
    // Scene Story Pipeline events — 'scene_story_' prefix keeps these strictly
    // distinct from legacy 'scene_detected' / 'track_data' (avoid single/plural trap).
    | 'scene_story_detected' | 'scene_story_selection_ready'
    | 'scene_story_queued' | 'scene_story_started'
    | 'scene_story_retrying' | 'scene_story_completed' | 'scene_story_failed'
    | 'scene_story_cancelled' | 'scene_story_dropped' | 'scene_story_report_ready'
    | 'scene_story_smart_eta_refined'
    | 'scene_timeline_updated'
    /** @deprecated Use 'skill_layered_result' instead. Will be removed in v3.0 */
    | 'skill_data';
  content: any;
  timestamp: number;
  /**
   * Optional unique event ID for deduplication (v2.0)
   * Used by frontend to deduplicate events across retries/reconnects.
   */
  id?: string;
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

// =============================================================================
// Multi-Model Router Types (新架构)
// =============================================================================

export type ModelProvider = 'anthropic' | 'openai' | 'deepseek' | 'mock';
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
  errorCode?: 'context_overflow' | 'provider_error';
}

export interface EnsembleResult {
  responses: ModelCallResult[];
  aggregatedResponse: string;
  confidence: number;
  agreementScore: number;
  totalCost: number;
  totalLatencyMs: number;
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
  /** 分析参数（可选） */
  analysisParams?: Record<string, any>;
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
  /** Stored final-turn metadata; presence does not authorize another turn. */
  turnIntent?: import('../agentRuntime/analysisTurnIntent').AnalysisTurnIntent;
  completion?: import('../types/analysisDelivery').AnalysisCompletion;
  outputOrigin?: import('../types/analysisDelivery').AnalysisOutputOrigin;
  runtimeAppendix?: import('../types/analysisDelivery').AnalysisRuntimeAppendix;
  reportAssessment?: import('../types/analysisDelivery').FinalReportAssessment;
  investigationAssessment?: import('../types/analysisInvestigationAssessment').FinalInvestigationAssessment;
  deliveryAssurance?: import('../types/analysisDelivery').AnalysisDeliveryAssurance;
  sourceUseDecision?: import('../services/codebase/sourceUseDecision').SourceUseDecisionV1;
  sourceClaimVerificationResult?: import('../services/codebase/sourceClaimVerifier').StoredSourceClaimVerificationResult;
  knowledgeUse?: import('../services/knowledge/knowledgeUse').KnowledgeUseV1;
  conclusionContract?: unknown;
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
  confidence?: number;
  executionTimeMs?: number;
  tokensUsed?: { input: number; output: number };
  metrics?: Record<string, any>;
  error?: string;
  /** True when this turn produced a usable but incomplete result. */
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  /** Explicit cross-turn metadata, independent of natural-language headings. */
  uncertainties?: string[];
  nextSteps?: string[];
  sourceDerived?: boolean;
  analysisContextFingerprint?: string;
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

// =============================================================================
// Master Orchestrator Types (新架构)
// =============================================================================

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

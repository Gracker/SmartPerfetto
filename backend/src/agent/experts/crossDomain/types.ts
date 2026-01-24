/**
 * Cross-Domain Expert System Types
 *
 * Defines the interfaces for the dialogue-based expert system where:
 * - Module Experts (YAML Skills) provide specialized data analysis
 * - Cross-Domain Experts (TypeScript) orchestrate multi-turn dialogues
 *
 * The dialogue protocol enables cross-domain experts to:
 * 1. Query module experts with structured questions
 * 2. Receive structured findings and follow-up suggestions
 * 3. Build and verify root cause hypotheses
 * 4. Terminate early when confident or request user intervention
 */

import { ModuleLayer, ConfidenceLevel } from '../../../services/skillEngine/types';
import { Finding } from '../../types';
import { ArchitectureInfo } from '../../detectors';

// =============================================================================
// Cross-Domain Expert Configuration
// =============================================================================

/**
 * Cross-domain expert categories
 */
export type CrossDomainType =
  | 'performance'   // 卡顿/启动/延迟分析
  | 'power'         // 功耗/待机/唤醒分析
  | 'thermal'       // 温度/热节流分析
  | 'stability';    // ANR/崩溃/死锁分析

/**
 * Configuration for a cross-domain expert
 */
export interface CrossDomainExpertConfig {
  /** Unique expert ID */
  id: string;
  /** Display name */
  name: string;
  /** Expert domain */
  domain: CrossDomainType;
  /** Description of capabilities */
  description: string;
  /** Entry modules to start analysis (ordered by priority) */
  entryModules: string[];
  /** Maximum dialogue turns before stopping */
  maxDialogueTurns: number;
  /** Confidence threshold to conclude analysis */
  confidenceThreshold: number;
  /** Intent categories this expert handles */
  handlesIntents: string[];
}

// =============================================================================
// Module Query/Response Protocol
// =============================================================================

/**
 * Query sent to a module expert
 */
export interface ModuleQuery {
  /** Unique query ID for tracking */
  queryId: string;
  /** Target module skill name */
  targetModule: string;
  /** Question capability ID from module's dialogue.capabilities */
  questionId: string;
  /** Parameters for the question */
  params: Record<string, any>;
  /** Dialogue context for multi-turn conversations */
  context?: DialogueContext;
  /** Time range constraint (string for precision-safe ns timestamps) */
  timeRange?: { start: number | string; end: number | string };
}

/**
 * Response from a module expert
 */
export interface ModuleResponse {
  /** Matching query ID */
  queryId: string;
  /** Whether the query succeeded */
  success: boolean;
  /** Raw data from the skill execution */
  data?: Record<string, any>;
  /** Structured findings extracted from results */
  findings: ModuleFinding[];
  /** Suggested next analysis steps */
  suggestions: ModuleSuggestion[];
  /** Confidence in the response (0-1) */
  confidence: number;
  /** Execution time in ms */
  executionTimeMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Structured finding from a module
 */
export interface ModuleFinding {
  /** Finding ID (module_findingType) */
  id: string;
  /** Severity level */
  severity: 'info' | 'warning' | 'critical';
  /** Human-readable title */
  title: string;
  /** Detailed description */
  description?: string;
  /** Evidence data supporting this finding */
  evidence: Record<string, any>;
  /** Source module name */
  sourceModule: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Timestamp for Perfetto navigation (optional) */
  perfettoTs?: string;
}

/**
 * Suggestion for follow-up analysis
 */
export interface ModuleSuggestion {
  /** Suggestion ID */
  id: string;
  /** Target module to query next */
  targetModule: string;
  /** Question template for the target */
  questionTemplate: string;
  /** Parameters to pass */
  params: Record<string, any>;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Why this suggestion was made */
  reason: string;
}

// =============================================================================
// Dialogue Context
// =============================================================================

/**
 * Context maintained across dialogue turns
 */
export interface DialogueContext {
  /** Session ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** Current dialogue turn number */
  turnNumber: number;
  /** Detected architecture */
  architecture?: ArchitectureInfo;
  /** Target package name */
  packageName?: string;
  /** User's original query */
  originalQuery: string;
  /** History of queries made */
  queryHistory: ModuleQuery[];
  /** History of responses received */
  responseHistory: ModuleResponse[];
  /** All findings collected so far */
  collectedFindings: ModuleFinding[];
  /** Current hypotheses being explored */
  activeHypotheses: Hypothesis[];
  /** Variables for parameter passing between turns */
  variables: Record<string, any>;
  /** TraceProcessor service reference */
  traceProcessorService?: any;
}

// =============================================================================
// Hypothesis Management
// =============================================================================

/**
 * Root cause hypothesis being explored
 */
export interface Hypothesis {
  /** Unique hypothesis ID */
  id: string;
  /** Short description */
  title: string;
  /** Detailed explanation */
  description: string;
  /** Category (APP, SYSTEM, MIXED) */
  category: 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';
  /** Specific component (e.g., "Binder", "GC", "CPU throttling") */
  component: string;
  /** Current confidence score (0-1) */
  confidence: number;
  /** Evidence supporting this hypothesis */
  supportingEvidence: HypothesisEvidence[];
  /** Evidence contradicting this hypothesis */
  contradictingEvidence: HypothesisEvidence[];
  /** Status */
  status: 'exploring' | 'confirmed' | 'rejected' | 'uncertain';
  /** When this hypothesis was created */
  createdAt: number;
  /** Last update time */
  updatedAt: number;
}

/**
 * Evidence for or against a hypothesis
 */
export interface HypothesisEvidence {
  /** Source module */
  sourceModule: string;
  /** Finding ID that provides this evidence */
  findingId: string;
  /** Weight of this evidence (-1 to 1, negative = contradicting) */
  weight: number;
  /** Human-readable summary */
  summary: string;
  /** Raw data */
  data?: Record<string, any>;
}

// =============================================================================
// Analysis Decision
// =============================================================================

/**
 * Decision made by cross-domain expert after analyzing responses
 */
export interface AnalysisDecision {
  /** What to do next */
  action: 'continue' | 'conclude' | 'fork' | 'ask_user';
  /** Next queries to make (if action is 'continue') */
  nextQueries?: ModuleQuery[];
  /** Conclusion (if action is 'conclude') */
  conclusion?: ExpertConclusion;
  /** Fork hypothesis (if action is 'fork') */
  forkRequest?: ForkRequest;
  /** Question for user (if action is 'ask_user') */
  userQuestion?: UserQuestion;
  /** Reasoning for this decision */
  reasoning: string;
}

/**
 * Final conclusion from cross-domain expert
 */
export interface ExpertConclusion {
  /** Root cause category */
  category: 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';
  /** Specific component responsible */
  component: string;
  /** Human-readable summary */
  summary: string;
  /** Detailed explanation */
  explanation: string;
  /** All supporting evidence */
  evidence: HypothesisEvidence[];
  /** Optimization suggestions */
  suggestions: string[];
  /** Overall confidence (0-1) */
  confidence: number;
  /** Confirmed hypothesis (if any) */
  confirmedHypothesis?: Hypothesis;
}

/**
 * Request to fork a session for parallel exploration
 */
export interface ForkRequest {
  /** Hypothesis to explore in fork */
  hypothesis: Hypothesis;
  /** Specific focus for the fork */
  focus: string;
  /** Additional context */
  context?: Record<string, any>;
}

/**
 * Question to ask the user for clarification
 */
export interface UserQuestion {
  /** Question text */
  question: string;
  /** Why we need this information */
  reason: string;
  /** Suggested options (if applicable) */
  options?: string[];
  /** What modules are waiting for this */
  blockingModules?: string[];
}

// =============================================================================
// Expert Input/Output
// =============================================================================

/**
 * AI Service interface for cross-domain experts
 */
export interface AIService {
  /** Call AI model with prompt and get response */
  callWithFallback: (
    prompt: string,
    taskType: 'reasoning' | 'synthesis' | 'evaluation' | 'general',
    options?: { jsonMode?: boolean; maxTokens?: number }
  ) => Promise<{ success: boolean; response: string; error?: string }>;
}

/**
 * Input to a cross-domain expert
 */
export interface CrossDomainInput {
  /** Session ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** User's query */
  query: string;
  /** Detected intent category */
  intentCategory: string;
  /** Detected architecture */
  architecture?: ArchitectureInfo;
  /** Target package name */
  packageName?: string;
  /** Time range for analysis (string for precision-safe ns timestamps) */
  timeRange?: { start: number | string; end: number | string };
  /** Trace processor service */
  traceProcessorService: any;
  /** Previous findings from other phases */
  previousFindings?: Finding[];
  /** AI service for expert analysis and synthesis (optional but recommended) */
  aiService?: AIService;
}

/**
 * Output from a cross-domain expert
 */
export interface CrossDomainOutput {
  /** Expert ID */
  expertId: string;
  /** Expert domain */
  domain: CrossDomainType;
  /** Whether analysis succeeded */
  success: boolean;
  /** Final conclusion */
  conclusion?: ExpertConclusion;
  /** All findings discovered */
  findings: ModuleFinding[];
  /** User-facing suggestions */
  suggestions: string[];
  /** Dialogue statistics */
  dialogueStats: {
    totalTurns: number;
    modulesQueried: string[];
    hypothesesExplored: number;
    totalExecutionTimeMs: number;
  };
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Module Catalog Types
// =============================================================================

/**
 * Module entry in the catalog
 */
export interface ModuleCatalogEntry {
  /** Module skill name */
  name: string;
  /** Display name */
  displayName: string;
  /** Architecture layer */
  layer: ModuleLayer;
  /** Component name */
  component: string;
  /** Sub-systems covered */
  subsystems: string[];
  /** Capabilities (question types) this module can answer */
  capabilities: ModuleCapability[];
  /** Related modules */
  relatedModules: string[];
}

/**
 * A capability (question type) a module can answer
 */
export interface ModuleCapability {
  /** Capability ID */
  id: string;
  /** Question template */
  questionTemplate: string;
  /** Required parameters */
  requiredParams: string[];
  /** Optional parameters */
  optionalParams: string[];
  /** Description */
  description: string;
}

// =============================================================================
// Event Types for SSE
// =============================================================================

/**
 * Events emitted by cross-domain experts for real-time updates
 */
export type CrossDomainEventType =
  | 'dialogue_started'
  | 'turn_started'
  | 'module_queried'
  | 'module_responded'
  | 'finding_discovered'
  | 'hypothesis_created'
  | 'hypothesis_updated'
  | 'decision_made'
  | 'conclusion_reached'
  | 'user_intervention_needed'
  | 'dialogue_completed'
  | 'skill_layered_result'
  /** @deprecated Use 'skill_layered_result' instead. Will be removed in v3.0 */
  | 'skill_data'
  | 'error';

export interface CrossDomainEvent {
  type: CrossDomainEventType;
  timestamp: number;
  expertId: string;
  turnNumber: number;
  data: Record<string, any>;
}

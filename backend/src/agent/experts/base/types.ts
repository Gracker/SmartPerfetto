/**
 * Expert System Types
 *
 * Type definitions for the domain expert agent system.
 * Experts are specialized agents that encapsulate domain knowledge
 * and use decision trees for intelligent analysis.
 */

import { ArchitectureInfo } from '../../detectors';
import { DecisionTree, DecisionTreeExecutionResult, ConclusionDefinition } from '../../decision/types';
import { Finding } from '../../types';

/**
 * Expert domain categories
 */
export type ExpertDomain =
  | 'interaction'   // 滑动、点击等用户交互分析
  | 'launch'        // 启动性能分析
  | 'system'        // 系统级分析 (CPU, Memory, IO)
  | 'general';      // 通用分析

/**
 * Analysis intent derived from user query
 */
export interface AnalysisIntent {
  /** Primary category */
  category: 'SCROLLING' | 'CLICK' | 'LAUNCH' | 'CPU' | 'MEMORY' | 'IO' | 'ANR' | 'GENERAL';
  /** User's original query */
  originalQuery: string;
  /** Extracted keywords */
  keywords: string[];
  /** Specific focus areas */
  focusAreas?: string[];
  /** Confidence in the intent classification */
  confidence: number;
}

/**
 * Input to an expert for analysis
 */
export interface ExpertInput {
  /** Session ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** User's query */
  query: string;
  /** Parsed intent */
  intent: AnalysisIntent;
  /** Detected architecture */
  architecture?: ArchitectureInfo;
  /** Trace processor service */
  traceProcessorService: any;
  /** Target package name */
  packageName?: string;
  /** Time range for analysis (string for precision-safe ns timestamps) */
  timeRange?: { start: number | string; end: number | string };
  /** Context from previous analysis turns */
  previousFindings?: Finding[];
}

/**
 * Output from an expert's analysis
 */
export interface ExpertOutput {
  /** Expert that produced this output */
  expertId: string;
  /** Expert domain */
  domain: ExpertDomain;
  /** Whether analysis succeeded */
  success: boolean;
  /** Root cause conclusion */
  conclusion?: ExpertConclusion;
  /** All findings discovered */
  findings: Finding[];
  /** Suggested next steps for the user */
  suggestions: string[];
  /** Raw data collected during analysis */
  data?: Record<string, any>;
  /** Decision tree execution details */
  executionDetails?: {
    treeId: string;
    executionPath: string[];
    totalDurationMs: number;
  };
  /** Error if analysis failed */
  error?: string;
  /** Confidence in the analysis results */
  confidence: number;
}

/**
 * Expert's conclusion about the root cause
 */
export interface ExpertConclusion {
  /** Problem category */
  category: 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';
  /** Specific component responsible */
  component: string;
  /** Human-readable summary */
  summary: string;
  /** Detailed explanation */
  explanation?: string;
  /** Evidence supporting this conclusion */
  evidence: string[];
  /** Optimization suggestions */
  optimizationSuggestions: string[];
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Expert configuration
 */
export interface ExpertConfig {
  /** Unique expert ID */
  id: string;
  /** Expert name */
  name: string;
  /** Expert domain */
  domain: ExpertDomain;
  /** Description of expert capabilities */
  description: string;
  /** Intent categories this expert handles */
  handlesIntents: AnalysisIntent['category'][];
  /** Decision trees available to this expert */
  decisionTrees: string[];
  /** Skills this expert can invoke */
  availableSkills: string[];
  /** Maximum analysis duration (ms) */
  maxDurationMs: number;
  /** Whether this expert can fork sessions */
  canForkSession: boolean;
}

/**
 * Expert state during analysis
 */
export interface ExpertState {
  /** Current phase */
  phase: 'initializing' | 'detecting' | 'analyzing' | 'concluding' | 'completed' | 'failed';
  /** Current decision tree node (if using decision tree) */
  currentNode?: string;
  /** Execution path so far */
  executionPath: string[];
  /** Data collected so far */
  collectedData: Map<string, any>;
  /** Start time */
  startTime: number;
  /** Last update time */
  lastUpdateTime: number;
}

/**
 * Fork request for deeper analysis
 */
export interface ExpertForkRequest {
  /** Reason for forking */
  reason: string;
  /** Hypothesis to explore */
  hypothesis: string;
  /** Specific focus for the forked analysis */
  focus: string;
  /** Additional context for the fork */
  context?: Record<string, any>;
}

/**
 * Fork result from deeper analysis
 */
export interface ExpertForkResult {
  /** Fork session ID */
  forkSessionId: string;
  /** Whether the fork succeeded */
  success: boolean;
  /** Findings from the fork */
  findings: Finding[];
  /** Conclusion from the fork */
  conclusion?: ExpertConclusion;
  /** Error if fork failed */
  error?: string;
}

/**
 * Expert registry for managing available experts
 */
export interface ExpertRegistry {
  /** Register an expert */
  register(expert: BaseExpertInterface): void;
  /** Get expert by ID */
  get(expertId: string): BaseExpertInterface | undefined;
  /** Get expert for a specific intent */
  getForIntent(intent: AnalysisIntent): BaseExpertInterface | undefined;
  /** List all registered experts */
  list(): ExpertConfig[];
}

/**
 * Base expert interface
 */
export interface BaseExpertInterface {
  /** Expert configuration */
  readonly config: ExpertConfig;

  /** Perform analysis */
  analyze(input: ExpertInput): Promise<ExpertOutput>;

  /** Check if this expert can handle the given intent */
  canHandle(intent: AnalysisIntent): boolean;

  /** Get the decision tree for this expert */
  getDecisionTree(analysisType?: string): DecisionTree | undefined;

  /** Get current state (for debugging/monitoring) */
  getState(): ExpertState | null;
}

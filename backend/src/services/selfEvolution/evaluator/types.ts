// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/**
 * Agent Evaluation Framework Types
 *
 * Defines types for evaluating agent response quality:
 * - Test scenarios (input/expected output)
 * - Grader interfaces (code-based and model-based)
 * - Evaluation results
 */

// =============================================================================
// Test Scenario Types
// =============================================================================

/**
 * A test scenario defines an evaluation case
 */
export interface TestScenario {
  /** Unique scenario ID */
  id: string;

  /** Human-readable description */
  description: string;

  /** Test category (e.g., 'scrolling', 'startup', 'memory') */
  category: string;

  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low';

  /** Input configuration */
  input: ScenarioInput;

  /** Expected outputs and criteria */
  expectations: ScenarioExpectations;

  /** Tags for filtering */
  tags?: string[];
}

/**
 * Input for a test scenario
 */
export interface ScenarioInput {
  /** Trace file to use */
  traceFile: string;

  /** Query to send to agent */
  query: string;

  /** Analysis mode */
  mode: 'skill' | 'agent';

  /** Optional package filter */
  package?: string;

  /** Max iterations for agent mode */
  maxIterations?: number;
}

/**
 * Expected outputs and criteria
 */
export interface ScenarioExpectations {
  /** Code-based (deterministic) expectations */
  code?: CodeExpectations;

  /** Model-based (LLM) expectations */
  model?: ModelExpectations;

  /** Human-provided ground truth (optional) */
  groundTruth?: GroundTruth;
}

/**
 * Code-based expectations (deterministic)
 */
export interface CodeExpectations {
  /** Should the analysis succeed */
  shouldSucceed: boolean;

  /** Minimum confidence score (0-1) */
  minConfidence?: number;

  /** Maximum execution time (ms) */
  maxExecutionTimeMs?: number;

  /** Required layers in output */
  requiredLayers?: ('L1' | 'L2' | 'L3' | 'L4')[];

  /** Required fields in output */
  requiredFields?: string[];

  /** Minimum number of findings */
  minFindings?: number;

  /** Expected finding categories */
  expectedCategories?: string[];

  /** Legacy executable assertions. Rejected by the shared runtime evaluator. */
  customAssertions?: string[];
}

/**
 * Model-based expectations (LLM graded)
 */
export interface ModelExpectations {
  /** Key topics that should be mentioned */
  shouldMention?: string[];

  /** Topics that should NOT be mentioned */
  shouldNotMention?: string[];

  /** Expected answer characteristics */
  answerCriteria?: {
    /** Should be technical */
    technical?: boolean;
    /** Should include recommendations */
    includeRecommendations?: boolean;
    /** Should cite specific data */
    citeData?: boolean;
    /** Maximum length (characters) */
    maxLength?: number;
  };

  /** Rubric for detailed grading */
  rubric?: RubricItem[];
}

/**
 * Rubric item for detailed grading
 */
export interface RubricItem {
  /** Criterion name */
  criterion: string;

  /** Description of what to evaluate */
  description: string;

  /** Weight (0-1, sum should be 1) */
  weight: number;

  /** Scoring guide */
  scoringGuide?: {
    excellent: string;
    good: string;
    fair: string;
    poor: string;
  };
}

/**
 * Human-provided ground truth
 */
export interface GroundTruth {
  /** Summary of correct answer */
  summary: string;

  /** Key facts that should be identified */
  keyFacts: string[];

  /** Numeric values for comparison */
  numericValues?: Record<string, number>;
}

// =============================================================================
// Grader Types
// =============================================================================

/**
 * Base grader interface
 */
export interface Grader {
  /** Grader name */
  name: string;

  /** Grader type */
  type: 'code' | 'model' | 'human';

  /** Grade a response */
  grade(response: AgentResponse, scenario: TestScenario): Promise<GradeResult>;
}

/**
 * Agent response to evaluate
 */
export interface AgentResponse {
  /** Session ID */
  sessionId: string;

  /** Was the analysis successful */
  success: boolean;

  /** Synthesized answer */
  answer?: string;

  /** Confidence score (0-1) */
  confidence?: number;

  /** Execution time (ms) */
  executionTimeMs: number;

  /** Number of iterations used */
  iterationCount?: number;

  /** Findings discovered */
  findings?: Finding[];

  /** Layer results */
  layers?: LayerResults;

  /** Evaluation result from agent */
  evaluation?: AgentEvaluation;

  /** Raw result object */
  raw?: any;

  /** Error message if failed */
  error?: string;
}

/**
 * Finding from analysis
 */
export interface Finding {
  id: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  timestampsNs?: string[];
}

/**
 * Layer results structure
 */
export interface LayerResults {
  L1?: Record<string, any>;
  L2?: Record<string, any>;
  L3?: Record<string, any>;
  L4?: Record<string, any>;
}

/**
 * Agent's self-evaluation
 */
export interface AgentEvaluation {
  passed: boolean;
  qualityScore: number;
  completenessScore: number;
  feedback?: {
    strengths: string[];
    weaknesses: string[];
    improvementSuggestions: string[];
  };
}

/**
 * Grade result from a grader
 */
export interface GradeResult {
  /** Grader name */
  graderName: string;

  /** Grader type */
  graderType: 'code' | 'model' | 'human';

  /** Overall score (0-1) */
  score: number;

  /** Pass/fail */
  passed: boolean;

  /** Detailed scores by criterion */
  criterionScores?: Record<string, number>;

  /** Feedback messages */
  feedback: string[];

  /** Warnings (non-blocking issues) */
  warnings?: string[];

  /** Errors (blocking issues) */
  errors?: string[];

  /** Raw grader output */
  raw?: any;
}

// =============================================================================
// Evaluation Result Types
// =============================================================================

/**
 * Complete evaluation result for a scenario
 */
export interface EvaluationResult {
  /** Scenario that was evaluated */
  scenarioId: string;

  /** Timestamp of evaluation */
  timestamp: number;

  /** Agent response */
  response: AgentResponse;

  /** Grade results from each grader */
  grades: GradeResult[];

  /** Aggregated score (0-1) */
  aggregatedScore: number;

  /** Overall pass/fail */
  passed: boolean;

  /** Summary */
  summary: string;

  /** Metadata */
  metadata?: Record<string, any>;
}

/**
 * Evaluation run summary
 */
export interface EvaluationRunSummary {
  /** Run ID */
  runId: string;

  /** Start time */
  startTime: number;

  /** End time */
  endTime: number;

  /** Total scenarios */
  totalScenarios: number;

  /** Passed scenarios */
  passedScenarios: number;

  /** Failed scenarios */
  failedScenarios: number;

  /** Skipped scenarios */
  skippedScenarios: number;

  /** Average score */
  averageScore: number;

  /** Results by category */
  byCategory: Record<string, CategorySummary>;

  /** Individual results */
  results: EvaluationResult[];
}

/**
 * Summary for a category
 */
export interface CategorySummary {
  total: number;
  passed: number;
  failed: number;
  averageScore: number;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Evaluation configuration
 */
export interface EvaluationConfig {
  /** Scenarios to run (glob pattern or list) */
  scenarios: string | string[];

  /** Graders to use */
  graders: GraderConfig[];

  /** Trace files directory */
  traceDir: string;

  /** Backend URL */
  backendUrl: string;

  /** Timeout for each scenario (ms) */
  timeoutMs: number;

  /** Retry count on failure */
  retries: number;

  /** Output directory for results */
  outputDir: string;
}

/**
 * Grader configuration
 */
export interface GraderConfig {
  /** Grader type */
  type: 'code' | 'model';

  /** Grader name */
  name: string;

  /** Weight in aggregated score */
  weight: number;

  /** Grader-specific options */
  options?: Record<string, any>;
}

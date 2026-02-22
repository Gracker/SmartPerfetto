/**
 * Evaluation Runner
 *
 * Orchestrates the execution of test scenarios and grading:
 * 1. Load test scenarios from YAML files
 * 2. Execute agent/skill analysis for each scenario
 * 3. Run graders (code-based and model-based)
 * 4. Aggregate and report results
 *
 * Can run against a live backend or in a simulated environment.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TestScenario,
  AgentResponse,
  Grader,
  GradeResult,
  EvaluationResult,
  EvaluationRunSummary,
  EvaluationConfig,
  GraderConfig,
  Finding,
} from './types';
import { loadScenarios, loadAllScenarios, LoadOptions } from './scenarioLoader';
import { CodeGrader } from './codeGrader';
import { ModelGrader, ModelGraderOptions } from './modelGrader';

// Default trace directory
const DEFAULT_TRACE_DIR = path.join(__dirname, '../../../test-traces');

export interface RunnerOptions {
  /** Backend base URL */
  backendUrl?: string;

  /** Trace files directory */
  traceDir?: string;

  /** Timeout for each scenario (ms) */
  timeoutMs?: number;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Retry count on failure */
  retries?: number;

  /** Skip scenarios that require specific features */
  skipTags?: string[];

  /** Only run scenarios with these tags */
  onlyTags?: string[];

  /** Custom graders */
  graders?: Grader[];

  /** Model grader options */
  modelGraderOptions?: ModelGraderOptions;

  /** Whether to use model grader (requires API key) */
  useModelGrader?: boolean;
}

export class EvaluationRunner {
  private options: Required<RunnerOptions>;
  private graders: Grader[] = [];

  constructor(options: RunnerOptions = {}) {
    this.options = {
      backendUrl: options.backendUrl || 'http://localhost:3000',
      traceDir: options.traceDir || DEFAULT_TRACE_DIR,
      timeoutMs: options.timeoutMs || 120000,
      verbose: options.verbose ?? false,
      retries: options.retries || 1,
      skipTags: options.skipTags || [],
      onlyTags: options.onlyTags || [],
      graders: options.graders || [],
      modelGraderOptions: options.modelGraderOptions || {},
      useModelGrader: options.useModelGrader ?? false,
    };

    // Initialize default graders
    this.graders = [new CodeGrader()];

    // Add model grader if enabled and API key available
    if (this.options.useModelGrader && process.env.DEEPSEEK_API_KEY) {
      try {
        this.graders.push(new ModelGrader(this.options.modelGraderOptions));
        this.log('ModelGrader initialized');
      } catch (error: any) {
        console.warn(`Warning: Could not initialize ModelGrader: ${error.message}`);
      }
    }

    // Add custom graders
    this.graders.push(...this.options.graders);
  }

  // ===========================================================================
  // Main Run Methods
  // ===========================================================================

  /**
   * Run all scenarios from the default directory
   */
  async runAll(loadOptions: LoadOptions = {}): Promise<EvaluationRunSummary> {
    const scenarios = await loadAllScenarios(loadOptions);
    return this.runScenarios(scenarios);
  }

  /**
   * Run scenarios from specific files
   */
  async runFromFiles(pattern: string | string[]): Promise<EvaluationRunSummary> {
    const scenarios = await loadScenarios(pattern);
    return this.runScenarios(scenarios);
  }

  /**
   * Run a list of scenarios
   */
  async runScenarios(scenarios: TestScenario[]): Promise<EvaluationRunSummary> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    const results: EvaluationResult[] = [];

    // Filter scenarios based on tags
    let filteredScenarios = scenarios;

    if (this.options.skipTags.length > 0) {
      filteredScenarios = filteredScenarios.filter(
        (s) => !s.tags?.some((tag) => this.options.skipTags.includes(tag)),
      );
    }

    if (this.options.onlyTags.length > 0) {
      filteredScenarios = filteredScenarios.filter(
        (s) => s.tags?.some((tag) => this.options.onlyTags.includes(tag)),
      );
    }

    this.log(`Starting evaluation run: ${runId}`);
    this.log(`Scenarios to run: ${filteredScenarios.length}`);

    for (const scenario of filteredScenarios) {
      this.log(`\n--- Running scenario: ${scenario.id} ---`);

      try {
        const result = await this.runScenario(scenario);
        results.push(result);

        const status = result.passed ? '✓ PASS' : '✗ FAIL';
        this.log(`${status} - Score: ${(result.aggregatedScore * 100).toFixed(1)}%`);
      } catch (error: any) {
        this.log(`✗ ERROR - ${error.message}`);
        results.push({
          scenarioId: scenario.id,
          timestamp: Date.now(),
          response: {
            sessionId: '',
            success: false,
            executionTimeMs: 0,
            error: error.message,
          },
          grades: [],
          aggregatedScore: 0,
          passed: false,
          summary: `Error: ${error.message}`,
        });
      }
    }

    const endTime = Date.now();

    // Build summary
    const summary = this.buildSummary(runId, startTime, endTime, results, scenarios.length);

    this.log(`\n=== Evaluation Run Complete ===`);
    this.log(`Total: ${summary.totalScenarios}`);
    this.log(`Passed: ${summary.passedScenarios}`);
    this.log(`Failed: ${summary.failedScenarios}`);
    this.log(`Skipped: ${summary.skippedScenarios}`);
    this.log(`Average Score: ${(summary.averageScore * 100).toFixed(1)}%`);
    this.log(`Duration: ${((endTime - startTime) / 1000).toFixed(1)}s`);

    return summary;
  }

  /**
   * Run a single scenario
   */
  async runScenario(scenario: TestScenario): Promise<EvaluationResult> {
    const startTime = Date.now();
    let response: AgentResponse;
    let lastError: Error | null = null;

    // Retry loop
    for (let attempt = 1; attempt <= this.options.retries; attempt++) {
      try {
        if (attempt > 1) {
          this.log(`Retry attempt ${attempt}/${this.options.retries}`);
        }

        response = await this.executeScenario(scenario);
        lastError = null;
        break;
      } catch (error: any) {
        lastError = error;
        this.log(`Attempt ${attempt} failed: ${error.message}`);
      }
    }

    if (lastError) {
      return {
        scenarioId: scenario.id,
        timestamp: startTime,
        response: {
          sessionId: '',
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: lastError.message,
        },
        grades: [],
        aggregatedScore: 0,
        passed: false,
        summary: `All ${this.options.retries} attempts failed: ${lastError.message}`,
      };
    }

    // Run graders
    const grades = await this.gradeResponse(response!, scenario);

    // Aggregate scores
    const { score, passed } = this.aggregateGrades(grades);

    return {
      scenarioId: scenario.id,
      timestamp: startTime,
      response: response!,
      grades,
      aggregatedScore: score,
      passed,
      summary: this.generateSummary(scenario, response!, grades, passed),
    };
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Execute a scenario against the backend
   */
  private async executeScenario(scenario: TestScenario): Promise<AgentResponse> {
    const startTime = Date.now();
    const input = scenario.input;

    // Get trace file path
    const tracePath = path.join(this.options.traceDir, input.traceFile);
    if (!fs.existsSync(tracePath)) {
      throw new Error(`Trace file not found: ${tracePath}`);
    }

    // 1. Upload trace to backend
    const traceId = await this.uploadTrace(tracePath);
    this.log(`Trace uploaded: ${traceId}`);

    // 2. Start analysis
    const sessionId = await this.startAnalysis(traceId, input);
    this.log(`Analysis started: ${sessionId}`);

    // 3. Wait for completion
    const result = await this.waitForCompletion(sessionId);
    this.log(`Analysis completed in ${Date.now() - startTime}ms`);

    return result;
  }

  /**
   * Upload a trace file to the backend
   */
  private async uploadTrace(tracePath: string): Promise<string> {
    const formData = new FormData();
    const fileBuffer = fs.readFileSync(tracePath);
    const fileName = path.basename(tracePath);

    // Create a Blob from the buffer
    const blob = new Blob([fileBuffer]);
    formData.append('trace', blob, fileName);

    const response = await fetch(`${this.options.backendUrl}/api/trace/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to upload trace: ${response.status} - ${text}`);
    }

    const data = await response.json();
    if (!data.success || !data.traceId) {
      throw new Error(`Upload failed: ${data.error || 'Unknown error'}`);
    }

    return data.traceId;
  }

  /**
   * Start analysis on the backend
   */
  private async startAnalysis(
    traceId: string,
    input: TestScenario['input'],
  ): Promise<string> {
    const body = {
      traceId,
      query: input.query,
      options: {
        maxIterations: input.maxIterations || 5,
        mode: input.mode,
        package: input.package,
      },
    };

    // Different endpoint for skill mode vs agent mode
    const endpoint =
      input.mode === 'skill'
        ? `${this.options.backendUrl}/api/skill/analyze`
        : `${this.options.backendUrl}/api/agent/analyze`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to start analysis: ${response.status} - ${text}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(`Analysis start failed: ${data.error || 'Unknown error'}`);
    }

    return data.sessionId || data.analysisId;
  }

  /**
   * Wait for analysis to complete via polling
   */
  private async waitForCompletion(sessionId: string): Promise<AgentResponse> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < this.options.timeoutMs) {
      const response = await fetch(
        `${this.options.backendUrl}/api/agent/${sessionId}/status`,
      );

      if (!response.ok) {
        throw new Error(`Failed to get status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'completed') {
        return this.extractAgentResponse(sessionId, data);
      }

      if (data.status === 'failed') {
        return {
          sessionId,
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: data.error || 'Analysis failed',
        };
      }

      // Still running, wait and poll again
      await this.sleep(pollInterval);
    }

    throw new Error(`Analysis timed out after ${this.options.timeoutMs}ms`);
  }

  /**
   * Extract AgentResponse from status data
   */
  private extractAgentResponse(sessionId: string, data: any): AgentResponse {
    const result = data.result || {};

    return {
      sessionId,
      success: true,
      answer: result.answer || result.conclusion,
      confidence: result.confidence,
      executionTimeMs: result.totalDurationMs || result.executionTimeMs || 0,
      iterationCount: result.rounds || result.iterationsUsed,
      findings: result.findings as Finding[],
      evaluation: result.evaluation
        ? {
            passed: result.evaluation.passed,
            qualityScore: result.evaluation.qualityScore,
            completenessScore: result.evaluation.completenessScore,
          }
        : undefined,
      layers: result.layers,
      raw: result,
    };
  }

  // ===========================================================================
  // Grading
  // ===========================================================================

  /**
   * Run all graders on a response
   */
  private async gradeResponse(
    response: AgentResponse,
    scenario: TestScenario,
  ): Promise<GradeResult[]> {
    const results: GradeResult[] = [];

    for (const grader of this.graders) {
      try {
        const result = await grader.grade(response, scenario);
        results.push(result);
        this.log(`  ${grader.name}: ${(result.score * 100).toFixed(0)}% - ${result.passed ? 'PASS' : 'FAIL'}`);
      } catch (error: any) {
        this.log(`  ${grader.name}: ERROR - ${error.message}`);
        results.push({
          graderName: grader.name,
          graderType: grader.type,
          score: 0,
          passed: false,
          feedback: [`Grader error: ${error.message}`],
          errors: [error.message],
        });
      }
    }

    return results;
  }

  /**
   * Aggregate grades from multiple graders
   */
  private aggregateGrades(grades: GradeResult[]): { score: number; passed: boolean } {
    if (grades.length === 0) {
      return { score: 1.0, passed: true };
    }

    // Default weights by grader type
    const weights: Record<string, number> = {
      code: 1.0,
      model: 0.8,
      human: 1.2,
    };

    let totalWeight = 0;
    let weightedScore = 0;
    let allPassed = true;

    for (const grade of grades) {
      const weight = weights[grade.graderType] || 1.0;
      totalWeight += weight;
      weightedScore += grade.score * weight;

      if (!grade.passed) {
        allPassed = false;
      }
    }

    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Pass if aggregate score >= 0.6 and no critical failures
    const passed = score >= 0.6 && allPassed;

    return { score, passed };
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  /**
   * Generate a summary message for a scenario result
   */
  private generateSummary(
    scenario: TestScenario,
    response: AgentResponse,
    grades: GradeResult[],
    passed: boolean,
  ): string {
    const parts: string[] = [];

    parts.push(`Scenario: ${scenario.id}`);
    parts.push(`Status: ${passed ? 'PASS' : 'FAIL'}`);

    if (response.answer) {
      parts.push(`Answer: ${response.answer.slice(0, 100)}...`);
    }

    if (response.confidence !== undefined) {
      parts.push(`Confidence: ${(response.confidence * 100).toFixed(0)}%`);
    }

    for (const grade of grades) {
      parts.push(`${grade.graderName}: ${(grade.score * 100).toFixed(0)}%`);
    }

    return parts.join(' | ');
  }

  /**
   * Build evaluation run summary
   */
  private buildSummary(
    runId: string,
    startTime: number,
    endTime: number,
    results: EvaluationResult[],
    totalLoaded: number,
  ): EvaluationRunSummary {
    const passedScenarios = results.filter((r) => r.passed).length;
    const failedScenarios = results.filter((r) => !r.passed).length;
    const skippedScenarios = totalLoaded - results.length;

    const scores = results.map((r) => r.aggregatedScore);
    const averageScore =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;

    // Group by category
    const byCategory: Record<string, any> = {};
    for (const result of results) {
      const scenario = result.scenarioId;
      // Find the scenario to get its category
      const category = 'general'; // Default, would need scenario lookup

      if (!byCategory[category]) {
        byCategory[category] = {
          total: 0,
          passed: 0,
          failed: 0,
          scores: [],
        };
      }

      byCategory[category].total++;
      if (result.passed) {
        byCategory[category].passed++;
      } else {
        byCategory[category].failed++;
      }
      byCategory[category].scores.push(result.aggregatedScore);
    }

    // Calculate category averages
    for (const cat of Object.keys(byCategory)) {
      const scores = byCategory[cat].scores;
      byCategory[cat].averageScore =
        scores.length > 0
          ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length
          : 0;
      delete byCategory[cat].scores;
    }

    return {
      runId,
      startTime,
      endTime,
      totalScenarios: results.length,
      passedScenarios,
      failedScenarios,
      skippedScenarios,
      averageScore,
      byCategory,
      results,
    };
  }

  /**
   * Export results to a JSON file
   */
  exportResults(summary: EvaluationRunSummary, outputPath: string): void {
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    this.log(`Results exported to: ${outputPath}`);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private log(message: string): void {
    if (this.options.verbose) {
      console.log(`[EvaluationRunner] ${message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ===========================================================================
// Factory and CLI Entry Point
// ===========================================================================

/**
 * Create an evaluation runner with default settings
 */
export function createEvaluationRunner(options?: RunnerOptions): EvaluationRunner {
  return new EvaluationRunner(options);
}

/**
 * Run evaluation from command line
 */
export async function runEvaluation(configPath?: string): Promise<void> {
  let config: Partial<EvaluationConfig> = {};

  if (configPath && fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  const runner = new EvaluationRunner({
    backendUrl: config.backendUrl || process.env.BACKEND_URL || 'http://localhost:3000',
    traceDir: config.traceDir || process.env.TRACE_DIR || DEFAULT_TRACE_DIR,
    timeoutMs: config.timeoutMs || 120000,
    verbose: true,
    useModelGrader: !!process.env.DEEPSEEK_API_KEY,
  });

  const summary = await runner.runAll();

  // Export results
  const outputPath = config.outputDir
    ? path.join(config.outputDir, `evaluation-${summary.runId}.json`)
    : `evaluation-${summary.runId}.json`;
  runner.exportResults(summary, outputPath);

  // Exit with error code if any tests failed
  if (summary.failedScenarios > 0) {
    process.exit(1);
  }
}

// CLI entry point
if (require.main === module) {
  const configPath = process.argv[2];
  runEvaluation(configPath).catch((error) => {
    console.error('Evaluation failed:', error);
    process.exit(1);
  });
}

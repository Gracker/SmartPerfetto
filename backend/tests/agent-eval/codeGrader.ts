/**
 * Code-based Grader
 *
 * Deterministic grader that evaluates agent responses based on:
 * - Success/failure status
 * - Confidence scores
 * - Execution time
 * - Output structure (layers, fields)
 * - Finding counts and categories
 * - Custom assertions
 *
 * All evaluations are 100% deterministic and reproducible.
 */

import {
  Grader,
  GradeResult,
  AgentResponse,
  TestScenario,
  CodeExpectations,
  GroundTruth,
} from './types';

export class CodeGrader implements Grader {
  name = 'CodeGrader';
  type: 'code' = 'code';

  async grade(response: AgentResponse, scenario: TestScenario): Promise<GradeResult> {
    const expectations = scenario.expectations.code;

    if (!expectations) {
      return {
        graderName: this.name,
        graderType: this.type,
        score: 1.0,
        passed: true,
        feedback: ['No code expectations defined, skipping code grading'],
      };
    }

    const checks: CheckResult[] = [];

    // 1. Success check
    checks.push(this.checkSuccess(response, expectations));

    // 2. Confidence check
    if (expectations.minConfidence !== undefined) {
      checks.push(this.checkConfidence(response, expectations.minConfidence));
    }

    // 3. Execution time check
    if (expectations.maxExecutionTimeMs !== undefined) {
      checks.push(this.checkExecutionTime(response, expectations.maxExecutionTimeMs));
    }

    // 4. Required layers check
    if (expectations.requiredLayers && expectations.requiredLayers.length > 0) {
      checks.push(this.checkLayers(response, expectations.requiredLayers));
    }

    // 5. Required fields check
    if (expectations.requiredFields && expectations.requiredFields.length > 0) {
      checks.push(this.checkFields(response, expectations.requiredFields));
    }

    // 6. Findings count check
    if (expectations.minFindings !== undefined) {
      checks.push(this.checkFindingsCount(response, expectations.minFindings));
    }

    // 7. Finding categories check
    if (expectations.expectedCategories && expectations.expectedCategories.length > 0) {
      checks.push(this.checkCategories(response, expectations.expectedCategories));
    }

    // 8. Custom assertions
    if (expectations.customAssertions && expectations.customAssertions.length > 0) {
      for (const assertion of expectations.customAssertions) {
        checks.push(this.checkCustomAssertion(response, assertion));
      }
    }

    // 9. Ground truth check (deterministic)
    if (scenario.expectations.groundTruth) {
      checks.push(this.checkGroundTruth(response, scenario.expectations.groundTruth));
    }

    // Aggregate results
    return this.aggregateChecks(checks);
  }

  // ===========================================================================
  // Individual Checks
  // ===========================================================================

  private checkSuccess(response: AgentResponse, expectations: CodeExpectations): CheckResult {
    const expected = expectations.shouldSucceed;
    const actual = response.success;

    return {
      name: 'success',
      passed: actual === expected,
      score: actual === expected ? 1.0 : 0.0,
      message: actual === expected
        ? `Success check passed (expected: ${expected}, got: ${actual})`
        : `Success check failed (expected: ${expected}, got: ${actual})`,
      severity: 'critical',
    };
  }

  private checkConfidence(response: AgentResponse, minConfidence: number): CheckResult {
    const actual = response.confidence ?? 0;
    const passed = actual >= minConfidence;

    return {
      name: 'confidence',
      passed,
      score: passed ? 1.0 : actual / minConfidence,
      message: passed
        ? `Confidence check passed (${actual.toFixed(2)} >= ${minConfidence})`
        : `Confidence check failed (${actual.toFixed(2)} < ${minConfidence})`,
      severity: 'high',
    };
  }

  private checkExecutionTime(response: AgentResponse, maxTimeMs: number): CheckResult {
    const actual = response.executionTimeMs;
    const passed = actual <= maxTimeMs;

    return {
      name: 'executionTime',
      passed,
      score: passed ? 1.0 : Math.max(0, 1 - (actual - maxTimeMs) / maxTimeMs),
      message: passed
        ? `Execution time check passed (${actual}ms <= ${maxTimeMs}ms)`
        : `Execution time check failed (${actual}ms > ${maxTimeMs}ms)`,
      severity: 'medium',
    };
  }

  private checkLayers(response: AgentResponse, requiredLayers: string[]): CheckResult {
    const layers = response.layers ?? {};
    const missingLayers: string[] = [];

    for (const layer of requiredLayers) {
      const layerData = (layers as any)[layer];
      if (!layerData || Object.keys(layerData).length === 0) {
        missingLayers.push(layer);
      }
    }

    const passed = missingLayers.length === 0;
    const score = (requiredLayers.length - missingLayers.length) / requiredLayers.length;

    return {
      name: 'requiredLayers',
      passed,
      score,
      message: passed
        ? `All required layers present: ${requiredLayers.join(', ')}`
        : `Missing layers: ${missingLayers.join(', ')}`,
      severity: 'high',
    };
  }

  private checkFields(response: AgentResponse, requiredFields: string[]): CheckResult {
    const missingFields: string[] = [];

    for (const fieldPath of requiredFields) {
      const value = this.getNestedValue(response, fieldPath);
      if (value === undefined || value === null) {
        missingFields.push(fieldPath);
      }
    }

    const passed = missingFields.length === 0;
    const score = (requiredFields.length - missingFields.length) / requiredFields.length;

    return {
      name: 'requiredFields',
      passed,
      score,
      message: passed
        ? `All required fields present`
        : `Missing fields: ${missingFields.join(', ')}`,
      severity: 'medium',
    };
  }

  private checkFindingsCount(response: AgentResponse, minFindings: number): CheckResult {
    const actual = response.findings?.length ?? 0;
    const passed = actual >= minFindings;

    return {
      name: 'findingsCount',
      passed,
      score: passed ? 1.0 : actual / minFindings,
      message: passed
        ? `Findings count check passed (${actual} >= ${minFindings})`
        : `Findings count check failed (${actual} < ${minFindings})`,
      severity: 'medium',
    };
  }

  private checkCategories(response: AgentResponse, expectedCategories: string[]): CheckResult {
    const findings = response.findings ?? [];
    const actualCategories = new Set(findings.map((f) => f.category));
    const missingCategories: string[] = [];

    for (const category of expectedCategories) {
      if (!actualCategories.has(category)) {
        missingCategories.push(category);
      }
    }

    const passed = missingCategories.length === 0;
    const score = (expectedCategories.length - missingCategories.length) / expectedCategories.length;

    return {
      name: 'expectedCategories',
      passed,
      score,
      message: passed
        ? `All expected categories found: ${expectedCategories.join(', ')}`
        : `Missing categories: ${missingCategories.join(', ')}`,
      severity: 'low',
    };
  }

  private checkCustomAssertion(response: AgentResponse, assertion: string): CheckResult {
    try {
      // Create a safe evaluation context
      const context = {
        response,
        success: response.success,
        confidence: response.confidence,
        answer: response.answer,
        findings: response.findings,
        layers: response.layers,
        executionTimeMs: response.executionTimeMs,
      };

      // Evaluate the assertion (simple expression evaluation)
      const fn = new Function(...Object.keys(context), `return (${assertion})`);
      const result = fn(...Object.values(context));
      const passed = Boolean(result);

      return {
        name: `custom:${assertion.slice(0, 30)}...`,
        passed,
        score: passed ? 1.0 : 0.0,
        message: passed
          ? `Custom assertion passed: ${assertion}`
          : `Custom assertion failed: ${assertion}`,
        severity: 'medium',
      };
    } catch (error: any) {
      return {
        name: `custom:${assertion.slice(0, 30)}...`,
        passed: false,
        score: 0.0,
        message: `Custom assertion error: ${error.message}`,
        severity: 'high',
      };
    }
  }

  private checkGroundTruth(response: AgentResponse, groundTruth: GroundTruth): CheckResult {
    const answer = String(
      response.answer ??
      response.raw?.conclusion ??
      response.raw?.answer ??
      ''
    );
    const answerNorm = this.normalizeText(answer);

    const summaryHit = answerNorm.includes(this.normalizeText(groundTruth.summary));
    const missingFacts = groundTruth.keyFacts.filter(fact => {
      const normFact = this.normalizeText(fact);
      return normFact.length > 0 && !answerNorm.includes(normFact);
    });

    let numericScore = 1.0;
    if (groundTruth.numericValues && Object.keys(groundTruth.numericValues).length > 0) {
      const answerNumbers = this.extractNumbers(answerNorm);
      const expected = Object.values(groundTruth.numericValues);
      if (expected.length > 0) {
        let matched = 0;
        for (const target of expected) {
          if (!Number.isFinite(target)) continue;
          const hasClose = answerNumbers.some(v => {
            const tolerance = Math.max(Math.abs(target) * 0.1, 1);
            return Math.abs(v - target) <= tolerance;
          });
          if (hasClose) matched++;
        }
        numericScore = expected.length > 0 ? matched / expected.length : 1.0;
      }
    }

    const factsScore = groundTruth.keyFacts.length > 0
      ? (groundTruth.keyFacts.length - missingFacts.length) / groundTruth.keyFacts.length
      : 1.0;
    const summaryScore = summaryHit ? 1.0 : 0.0;
    const score = summaryScore * 0.4 + factsScore * 0.5 + numericScore * 0.1;
    const passed = summaryHit && missingFacts.length === 0 && numericScore >= 0.5;

    const factsMessage = missingFacts.length === 0
      ? 'all key facts present'
      : `missing facts: ${missingFacts.join(', ')}`;
    const summaryMessage = summaryHit ? 'summary matched' : 'summary missing';
    const numericMessage = groundTruth.numericValues ? `numeric score=${numericScore.toFixed(2)}` : 'numeric check skipped';

    return {
      name: 'groundTruth',
      passed,
      score,
      message: `Ground truth check ${passed ? 'passed' : 'failed'} (${summaryMessage}; ${factsMessage}; ${numericMessage})`,
      severity: 'high',
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  private normalizeText(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[`*_#>~-]/g, ' ')
      .replace(/[\s\u3000]+/g, '')
      .trim();
  }

  private extractNumbers(value: string): number[] {
    const matches = value.match(/-?\d+(?:\.\d+)?/g);
    if (!matches) return [];
    return matches
      .map(v => Number(v))
      .filter(v => Number.isFinite(v));
  }

  private aggregateChecks(checks: CheckResult[]): GradeResult {
    const feedback: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const criterionScores: Record<string, number> = {};

    let totalWeight = 0;
    let weightedScore = 0;
    let hasCriticalFailure = false;

    // Severity weights
    const severityWeights: Record<string, number> = {
      critical: 2.0,
      high: 1.5,
      medium: 1.0,
      low: 0.5,
    };

    for (const check of checks) {
      const weight = severityWeights[check.severity] ?? 1.0;
      totalWeight += weight;
      weightedScore += check.score * weight;
      criterionScores[check.name] = check.score;

      if (check.passed) {
        feedback.push(`✓ ${check.message}`);
      } else {
        if (check.severity === 'critical') {
          hasCriticalFailure = true;
          errors.push(`✗ ${check.message}`);
        } else if (check.severity === 'high') {
          errors.push(`✗ ${check.message}`);
        } else {
          warnings.push(`⚠ ${check.message}`);
        }
      }
    }

    const score = totalWeight > 0 ? weightedScore / totalWeight : 1.0;
    const passed = !hasCriticalFailure && score >= 0.7;

    return {
      graderName: this.name,
      graderType: this.type,
      score,
      passed,
      criterionScores,
      feedback,
      warnings: warnings.length > 0 ? warnings : undefined,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ===========================================================================
// Internal Types
// ===========================================================================

interface CheckResult {
  name: string;
  passed: boolean;
  score: number;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// ===========================================================================
// Factory
// ===========================================================================

export function createCodeGrader(): CodeGrader {
  return new CodeGrader();
}

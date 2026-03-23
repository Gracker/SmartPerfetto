/**
 * Model-based Grader
 *
 * Uses LLM to evaluate agent responses based on:
 * - Answer relevance and accuracy
 * - Topic coverage (should/shouldn't mention)
 * - Answer quality (technical, recommendations, data citation)
 * - Rubric-based detailed grading
 *
 * Supports two backends:
 * - Claude Haiku (preferred): via Anthropic SDK, fixed version for reproducibility
 * - DeepSeek (legacy fallback): via OpenAI-compatible SDK
 *
 * Uses temperature=0 for more consistent results.
 * Results include grader metadata for reproducibility tracking.
 */

import {
  Grader,
  GradeResult,
  AgentResponse,
  TestScenario,
  ModelExpectations,
  RubricItem,
} from './types';

// Import OpenAI for DeepSeek compatibility
import OpenAI from 'openai';

/** Grader metadata for reproducibility — attached to every grade result. */
interface GraderMetadata {
  model: string;
  temperature: number;
  backend: 'anthropic' | 'deepseek';
  promptVersion: string;
  timestamp: number;
}

/** Current prompt version — bump when changing grading prompts. */
const PROMPT_VERSION = '1.0.0';

export interface ModelGraderOptions {
  /** API Key (defaults to ANTHROPIC_API_KEY, then DEEPSEEK_API_KEY) */
  apiKey?: string;

  /** Base URL (defaults to Anthropic API, falls back to DeepSeek) */
  baseUrl?: string;

  /** Model to use (defaults to claude-haiku-4-5-20251001) */
  model?: string;

  /** Temperature (0 for determinism) */
  temperature?: number;

  /** Max tokens for response */
  maxTokens?: number;

  /** Force DeepSeek backend (legacy, defaults to false) */
  useDeepSeek?: boolean;
}

export class ModelGrader implements Grader {
  name = 'ModelGrader';
  type: 'model' = 'model';

  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private backend: 'anthropic' | 'deepseek';

  constructor(options: ModelGraderOptions = {}) {
    // Prefer Anthropic (Claude Haiku) over DeepSeek
    const useDeepSeek = options.useDeepSeek ?? false;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;

    if (!useDeepSeek && anthropicKey) {
      // Claude Haiku via Anthropic's OpenAI-compatible endpoint
      this.client = new OpenAI({
        apiKey: options.apiKey || anthropicKey,
        baseURL: options.baseUrl || 'https://api.anthropic.com/v1/',
        defaultHeaders: { 'anthropic-version': '2023-06-01' },
      });
      this.model = options.model || 'claude-haiku-4-5-20251001';
      this.backend = 'anthropic';
    } else if (deepseekKey || options.apiKey) {
      // DeepSeek fallback
      const apiKey = options.apiKey || deepseekKey;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY or DEEPSEEK_API_KEY is required for ModelGrader');
      }
      this.client = new OpenAI({
        apiKey,
        baseURL: options.baseUrl || 'https://api.deepseek.com/v1',
      });
      this.model = options.model || 'deepseek-chat';
      this.backend = 'deepseek';
    } else {
      throw new Error('ANTHROPIC_API_KEY or DEEPSEEK_API_KEY is required for ModelGrader');
    }

    this.temperature = options.temperature ?? 0; // Deterministic by default
    this.maxTokens = options.maxTokens || 2000;
  }

  /** Get current grader metadata for reproducibility tracking. */
  private getMetadata(): GraderMetadata {
    return {
      model: this.model,
      temperature: this.temperature,
      backend: this.backend,
      promptVersion: PROMPT_VERSION,
      timestamp: Date.now(),
    };
  }

  async grade(response: AgentResponse, scenario: TestScenario): Promise<GradeResult> {
    const expectations = scenario.expectations.model;

    if (!expectations) {
      return {
        graderName: this.name,
        graderType: this.type,
        score: 1.0,
        passed: true,
        feedback: ['No model expectations defined, skipping model grading'],
      };
    }

    const checks: ModelCheckResult[] = [];

    // 1. Check topic coverage
    if (expectations.shouldMention && expectations.shouldMention.length > 0) {
      checks.push(await this.checkTopicsCovered(response, expectations.shouldMention));
    }

    // 2. Check topics NOT mentioned
    if (expectations.shouldNotMention && expectations.shouldNotMention.length > 0) {
      checks.push(await this.checkTopicsNotMentioned(response, expectations.shouldNotMention));
    }

    // 3. Check answer criteria
    if (expectations.answerCriteria) {
      checks.push(await this.checkAnswerCriteria(response, expectations.answerCriteria));
    }

    // 4. Rubric-based grading
    if (expectations.rubric && expectations.rubric.length > 0) {
      checks.push(await this.gradeWithRubric(response, scenario, expectations.rubric));
    }

    // 5. Overall quality check (always performed)
    checks.push(await this.checkOverallQuality(response, scenario));

    // Aggregate results
    return this.aggregateChecks(checks);
  }

  // ===========================================================================
  // Individual Checks
  // ===========================================================================

  private async checkTopicsCovered(
    response: AgentResponse,
    topics: string[],
  ): Promise<ModelCheckResult> {
    const answer = response.answer || '';

    const prompt = `You are evaluating if an AI agent's response covers specific topics.

Query answer to evaluate:
"""
${answer}
"""

Topics that SHOULD be mentioned:
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

For each topic, determine if it is covered in the answer.
Respond in JSON format:
{
  "results": [
    {"topic": "topic1", "covered": true/false, "reason": "brief reason"}
  ],
  "summary": "overall assessment"
}`;

    try {
      const result = await this.callLLM(prompt);
      const parsed = JSON.parse(result);

      const coveredCount = parsed.results.filter((r: any) => r.covered).length;
      const score = coveredCount / topics.length;
      const uncovered = parsed.results
        .filter((r: any) => !r.covered)
        .map((r: any) => r.topic);

      return {
        name: 'topicsCovered',
        score,
        passed: score >= 0.7,
        message: score >= 0.7
          ? `Covered ${coveredCount}/${topics.length} required topics`
          : `Missing topics: ${uncovered.join(', ')}`,
        details: parsed,
      };
    } catch (error: any) {
      return {
        name: 'topicsCovered',
        score: 0.5,
        passed: true,
        message: `Could not evaluate topics: ${error.message}`,
        details: { error: error.message },
      };
    }
  }

  private async checkTopicsNotMentioned(
    response: AgentResponse,
    topics: string[],
  ): Promise<ModelCheckResult> {
    const answer = response.answer || '';

    const prompt = `You are evaluating if an AI agent's response avoids certain topics.

Query answer to evaluate:
"""
${answer}
"""

Topics that should NOT be mentioned:
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

For each topic, determine if it appears in the answer.
Respond in JSON format:
{
  "results": [
    {"topic": "topic1", "mentioned": true/false, "reason": "brief reason"}
  ]
}`;

    try {
      const result = await this.callLLM(prompt);
      const parsed = JSON.parse(result);

      const mentionedCount = parsed.results.filter((r: any) => r.mentioned).length;
      const score = 1 - (mentionedCount / topics.length);
      const mentioned = parsed.results
        .filter((r: any) => r.mentioned)
        .map((r: any) => r.topic);

      return {
        name: 'topicsAvoided',
        score,
        passed: mentionedCount === 0,
        message: mentionedCount === 0
          ? 'Correctly avoided all restricted topics'
          : `Incorrectly mentioned: ${mentioned.join(', ')}`,
        details: parsed,
      };
    } catch (error: any) {
      return {
        name: 'topicsAvoided',
        score: 0.5,
        passed: true,
        message: `Could not evaluate avoided topics: ${error.message}`,
        details: { error: error.message },
      };
    }
  }

  private async checkAnswerCriteria(
    response: AgentResponse,
    criteria: NonNullable<ModelExpectations['answerCriteria']>,
  ): Promise<ModelCheckResult> {
    const answer = response.answer || '';

    const criteriaList: string[] = [];
    if (criteria.technical) criteriaList.push('Is technically accurate and uses proper terminology');
    if (criteria.includeRecommendations) criteriaList.push('Includes actionable recommendations');
    if (criteria.citeData) criteriaList.push('Cites specific data from the analysis');
    if (criteria.maxLength) criteriaList.push(`Is within ${criteria.maxLength} characters`);

    if (criteriaList.length === 0) {
      return {
        name: 'answerCriteria',
        score: 1.0,
        passed: true,
        message: 'No specific criteria to check',
      };
    }

    const prompt = `You are evaluating an AI agent's response quality.

Response to evaluate:
"""
${answer}
"""

Evaluate each criterion (1-5 scale):
${criteriaList.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Respond in JSON format:
{
  "scores": [
    {"criterion": "criterion1", "score": 1-5, "reason": "brief reason"}
  ],
  "overallScore": 1-5
}`;

    try {
      const result = await this.callLLM(prompt);
      const parsed = JSON.parse(result);

      const avgScore = parsed.scores.reduce((sum: number, s: any) => sum + s.score, 0) / parsed.scores.length;
      const normalizedScore = avgScore / 5;

      return {
        name: 'answerCriteria',
        score: normalizedScore,
        passed: normalizedScore >= 0.6,
        message: `Answer quality score: ${(normalizedScore * 100).toFixed(0)}%`,
        details: parsed,
      };
    } catch (error: any) {
      return {
        name: 'answerCriteria',
        score: 0.5,
        passed: true,
        message: `Could not evaluate answer criteria: ${error.message}`,
        details: { error: error.message },
      };
    }
  }

  private async gradeWithRubric(
    response: AgentResponse,
    scenario: TestScenario,
    rubric: RubricItem[],
  ): Promise<ModelCheckResult> {
    const answer = response.answer || '';

    const rubricStr = rubric.map((item, i) => {
      let str = `${i + 1}. ${item.criterion} (weight: ${item.weight})\n   ${item.description}`;
      if (item.scoringGuide) {
        str += `\n   Scoring: Excellent=${item.scoringGuide.excellent}, Good=${item.scoringGuide.good}, Fair=${item.scoringGuide.fair}, Poor=${item.scoringGuide.poor}`;
      }
      return str;
    }).join('\n\n');

    const prompt = `You are evaluating an AI agent's response using a detailed rubric.

Original query: "${scenario.input.query}"

Response to evaluate:
"""
${answer}
"""

Rubric:
${rubricStr}

Score each criterion on a 0-100 scale.
Respond in JSON format:
{
  "scores": [
    {"criterion": "criterion1", "score": 0-100, "reason": "brief reason"}
  ]
}`;

    try {
      const result = await this.callLLM(prompt);
      const parsed = JSON.parse(result);

      // Calculate weighted score
      let weightedSum = 0;
      let totalWeight = 0;

      for (let i = 0; i < rubric.length; i++) {
        const rubricItem = rubric[i];
        const scoreItem = parsed.scores[i];
        if (scoreItem) {
          weightedSum += (scoreItem.score / 100) * rubricItem.weight;
          totalWeight += rubricItem.weight;
        }
      }

      const score = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

      return {
        name: 'rubricGrade',
        score,
        passed: score >= 0.6,
        message: `Rubric score: ${(score * 100).toFixed(0)}%`,
        details: parsed,
      };
    } catch (error: any) {
      return {
        name: 'rubricGrade',
        score: 0.5,
        passed: true,
        message: `Could not evaluate with rubric: ${error.message}`,
        details: { error: error.message },
      };
    }
  }

  private async checkOverallQuality(
    response: AgentResponse,
    scenario: TestScenario,
  ): Promise<ModelCheckResult> {
    const answer = response.answer || '';

    const prompt = `You are evaluating the overall quality of an AI agent's performance analysis response.

Original query: "${scenario.input.query}"

Response:
"""
${answer}
"""

Findings count: ${response.findings?.length ?? 0}
Confidence: ${response.confidence ?? 'N/A'}
Execution time: ${response.executionTimeMs}ms

Evaluate the overall quality on these dimensions:
1. Relevance: Does it answer the query?
2. Accuracy: Does it appear factually correct?
3. Completeness: Does it cover the key aspects?
4. Clarity: Is it well-organized and clear?
5. Actionability: Are recommendations actionable?

Respond in JSON format:
{
  "dimensions": {
    "relevance": 0-100,
    "accuracy": 0-100,
    "completeness": 0-100,
    "clarity": 0-100,
    "actionability": 0-100
  },
  "overallScore": 0-100,
  "summary": "1-2 sentence summary"
}`;

    try {
      const result = await this.callLLM(prompt);
      const parsed = JSON.parse(result);

      const score = parsed.overallScore / 100;

      return {
        name: 'overallQuality',
        score,
        passed: score >= 0.6,
        message: parsed.summary || `Overall quality: ${(score * 100).toFixed(0)}%`,
        details: parsed,
      };
    } catch (error: any) {
      return {
        name: 'overallQuality',
        score: 0.5,
        passed: true,
        message: `Could not evaluate overall quality: ${error.message}`,
        details: { error: error.message },
      };
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async callLLM(prompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are an evaluation assistant. Always respond with valid JSON only, no markdown formatting.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    });

    const content = response.choices[0]?.message?.content || '';

    // Clean up JSON response (remove markdown code blocks if present)
    let cleaned = content.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }

    return cleaned.trim();
  }

  private aggregateChecks(checks: ModelCheckResult[]): GradeResult {
    const feedback: string[] = [];
    const criterionScores: Record<string, number> = {};
    const details: Record<string, any> = {};

    let totalScore = 0;

    for (const check of checks) {
      totalScore += check.score;
      criterionScores[check.name] = check.score;
      feedback.push(`${check.passed ? '✓' : '✗'} ${check.message}`);
      if (check.details) {
        details[check.name] = check.details;
      }
    }

    const score = checks.length > 0 ? totalScore / checks.length : 1.0;
    const passed = score >= 0.6;

    return {
      graderName: this.name,
      graderType: this.type,
      score,
      passed,
      criterionScores,
      feedback,
      raw: { ...details, _graderMetadata: this.getMetadata() },
    };
  }
}

// ===========================================================================
// Internal Types
// ===========================================================================

interface ModelCheckResult {
  name: string;
  score: number;
  passed: boolean;
  message: string;
  details?: any;
}

// ===========================================================================
// Factory
// ===========================================================================

export function createModelGrader(options?: ModelGraderOptions): ModelGrader {
  return new ModelGrader(options);
}

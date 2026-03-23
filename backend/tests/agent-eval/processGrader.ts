/**
 * Process-based Grader
 *
 * Evaluates the PROCESS quality of agent analysis by examining:
 * - Session log events (from JSONL session logs)
 * - Conversation steps (from session state snapshot)
 * - Plan lifecycle (submit → phase updates → completion)
 * - Tool call patterns (presence, no excessive errors)
 *
 * This is distinct from claudeVerifier (runtime gate, blocks/retries)
 * and CodeGrader (result quality checks). ProcessGrader is OFFLINE
 * evaluation — it only observes, never intervenes.
 *
 * Data source: reads session JSONL logs + session metadata from
 * the backend status API, avoiding reliance on real-time SSE events
 * which may have early-event loss (Codex review #2).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Grader,
  GradeResult,
  AgentResponse,
  TestScenario,
} from './types';

// =============================================================================
// Types
// =============================================================================

interface SessionLogEntry {
  timestamp: string;
  level: string;
  sessionId: string;
  component: string;
  message: string;
  data?: any;
  duration?: number;
  error?: { name: string; message: string; stack?: string };
}

interface ConversationStep {
  eventId: string;
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp: number;
  sourceEventType?: string;
}

interface CheckResult {
  name: string;
  passed: boolean;
  score: number;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// =============================================================================
// ProcessGrader
// =============================================================================

export class ProcessGrader implements Grader {
  name = 'ProcessGrader';
  type: 'code' = 'code';

  private logsDir: string;
  private backendUrl: string;

  constructor(options: { logsDir?: string; backendUrl?: string } = {}) {
    this.logsDir = options.logsDir || path.resolve(__dirname, '../../../logs/sessions');
    this.backendUrl = options.backendUrl || 'http://localhost:3000';
  }

  async grade(response: AgentResponse, scenario: TestScenario): Promise<GradeResult> {
    // Only grade agent-mode scenarios (skill-mode has no plan/hypothesis lifecycle)
    if (scenario.input.mode !== 'agent') {
      return {
        graderName: this.name,
        graderType: this.type,
        score: 1.0,
        passed: true,
        feedback: ['Skipped process grading for skill-mode scenario'],
      };
    }

    if (!response.success || !response.sessionId) {
      return {
        graderName: this.name,
        graderType: this.type,
        score: 0,
        passed: false,
        feedback: ['Cannot grade process: analysis failed or no sessionId'],
        errors: ['Analysis failed'],
      };
    }

    const checks: CheckResult[] = [];

    // Try to load process data from session status API
    const processData = await this.loadProcessData(response.sessionId);

    // 1. Check that analysis has conversation steps (not empty)
    checks.push(this.checkConversationNotEmpty(processData.conversationSteps));

    // 2. Check for tool calls (agent must have called at least one tool)
    checks.push(this.checkToolCallsExist(processData.conversationSteps));

    // 3. Check plan lifecycle (plan should be submitted for agent mode)
    checks.push(this.checkPlanSubmitted(processData));

    // 4. Check no excessive error events
    checks.push(this.checkErrorRate(processData));

    // 5. Check conclusion exists and is non-trivial
    checks.push(this.checkConclusionExists(response));

    return this.aggregateChecks(checks);
  }

  // ===========================================================================
  // Process Data Loading
  // ===========================================================================

  private async loadProcessData(sessionId: string): Promise<ProcessData> {
    // Try loading from backend status API first (most reliable)
    try {
      const statusResponse = await fetch(`${this.backendUrl}/api/agent/v1/${sessionId}/status`);
      if (statusResponse.ok) {
        const data = await statusResponse.json();
        return {
          conversationSteps: data.result?.conversationSteps || data.conversationSteps || [],
          plan: data.result?.claudeRuntimeState?.plan || null,
          planHistory: data.result?.claudeRuntimeState?.planHistory || [],
          hypotheses: data.result?.claudeRuntimeState?.hypotheses || [],
          notes: data.result?.claudeRuntimeState?.notes || [],
          uncertaintyFlags: data.result?.claudeRuntimeState?.uncertaintyFlags || [],
          errorCount: 0,
          toolCallCount: 0,
        };
      }
    } catch {
      // Fall through to log-based loading
    }

    // Fallback: read session JSONL log directly
    try {
      const logEntries = this.readSessionLog(sessionId);
      return this.extractProcessDataFromLogs(logEntries);
    } catch {
      return {
        conversationSteps: [],
        plan: null,
        planHistory: [],
        hypotheses: [],
        notes: [],
        uncertaintyFlags: [],
        errorCount: 0,
        toolCallCount: 0,
      };
    }
  }

  private readSessionLog(sessionId: string): SessionLogEntry[] {
    if (!fs.existsSync(this.logsDir)) return [];

    // Find log file matching sessionId
    const files = fs.readdirSync(this.logsDir)
      .filter(f => f.includes(sessionId) && f.endsWith('.jsonl'))
      .sort()
      .reverse(); // Most recent first

    if (files.length === 0) return [];

    const logPath = path.join(this.logsDir, files[0]);
    const content = fs.readFileSync(logPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean) as SessionLogEntry[];
  }

  private extractProcessDataFromLogs(entries: SessionLogEntry[]): ProcessData {
    const errorCount = entries.filter(e => e.level === 'error').length;
    const toolCallCount = entries.filter(e =>
      e.message.includes('tool_use') || e.component === 'mcp',
    ).length;

    return {
      conversationSteps: [],
      plan: null,
      planHistory: [],
      hypotheses: [],
      notes: [],
      uncertaintyFlags: [],
      errorCount,
      toolCallCount,
    };
  }

  // ===========================================================================
  // Individual Checks
  // ===========================================================================

  private checkConversationNotEmpty(steps: ConversationStep[]): CheckResult {
    const hasSteps = steps.length > 0;
    return {
      name: 'conversationNotEmpty',
      passed: hasSteps,
      score: hasSteps ? 1.0 : 0.0,
      message: hasSteps
        ? `Conversation has ${steps.length} steps`
        : 'No conversation steps found — analysis may not have run',
      severity: 'critical',
    };
  }

  private checkToolCallsExist(steps: ConversationStep[]): CheckResult {
    const toolSteps = steps.filter(s => s.phase === 'tool');
    const hasToolCalls = toolSteps.length > 0;
    return {
      name: 'toolCallsExist',
      passed: hasToolCalls,
      score: hasToolCalls ? 1.0 : 0.0,
      message: hasToolCalls
        ? `Agent made ${toolSteps.length} tool calls`
        : 'No tool calls found — agent may not have analyzed the trace',
      severity: 'high',
    };
  }

  private checkPlanSubmitted(data: ProcessData): CheckResult {
    const hasPlan = data.plan !== null;
    return {
      name: 'planSubmitted',
      passed: hasPlan,
      score: hasPlan ? 1.0 : 0.5, // Not having a plan is a warning, not failure
      message: hasPlan
        ? `Plan submitted with ${data.plan?.phases?.length || 0} phases`
        : 'No analysis plan submitted — plan enforcement may not be enabled',
      severity: 'medium',
    };
  }

  private checkErrorRate(data: ProcessData): CheckResult {
    const errorSteps = data.conversationSteps.filter(s => s.phase === 'error');
    const totalSteps = data.conversationSteps.length || 1;
    const errorRate = errorSteps.length / totalSteps;
    const passed = errorRate < 0.3; // Less than 30% error rate

    return {
      name: 'errorRate',
      passed,
      score: passed ? 1.0 - errorRate : 0.0,
      message: passed
        ? `Error rate acceptable: ${errorSteps.length}/${totalSteps} steps (${(errorRate * 100).toFixed(0)}%)`
        : `High error rate: ${errorSteps.length}/${totalSteps} steps (${(errorRate * 100).toFixed(0)}%)`,
      severity: 'high',
    };
  }

  private checkConclusionExists(response: AgentResponse): CheckResult {
    const conclusion = response.answer || '';
    const hasConclusion = conclusion.length >= 100;
    return {
      name: 'conclusionExists',
      passed: hasConclusion,
      score: hasConclusion ? 1.0 : Math.min(conclusion.length / 100, 0.9),
      message: hasConclusion
        ? `Conclusion present (${conclusion.length} chars)`
        : `Conclusion too short or missing (${conclusion.length} chars, need >= 100)`,
      severity: 'high',
    };
  }

  // ===========================================================================
  // Aggregation
  // ===========================================================================

  private aggregateChecks(checks: CheckResult[]): GradeResult {
    const feedback: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const criterionScores: Record<string, number> = {};

    const severityWeights: Record<string, number> = {
      critical: 2.0,
      high: 1.5,
      medium: 1.0,
      low: 0.5,
    };

    let totalWeight = 0;
    let weightedScore = 0;
    let hasCriticalFailure = false;

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
    const passed = !hasCriticalFailure && score >= 0.6;

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

// =============================================================================
// Internal Types
// =============================================================================

interface ProcessData {
  conversationSteps: ConversationStep[];
  plan: any | null;
  planHistory: any[];
  hypotheses: any[];
  notes: any[];
  uncertaintyFlags: any[];
  errorCount: number;
  toolCallCount: number;
}

// =============================================================================
// Factory
// =============================================================================

export function createProcessGrader(options?: { logsDir?: string; backendUrl?: string }): ProcessGrader {
  return new ProcessGrader(options);
}

/**
 * Direct Skill Executor
 *
 * Executes skills directly without the agent LLM loop.
 * Used when executionMode is 'direct_skill' on a StageTaskTemplate.
 *
 * Key responsibilities:
 * - Builds skill params from interval + template (with paramMapping support)
 * - Calls SkillExecutor.execute() directly (zero LLM overhead for SQL steps)
 * - Converts SkillExecutionResult → AgentResponse (same shape as agent output)
 * - Concurrency-limited parallel execution
 *
 * Performance: Eliminates ~12 LLM calls per frame (Understanding/Planning/SQL/Reflection × 3 agents)
 * and replaces with 1 composite skill call (which may still invoke 1 ai_assist diagnostic call).
 */

import { Finding } from '../../types';
import { AgentResponse, AgentToolResult, createTaskId } from '../../types/agentProtocol';
import { DirectSkillTask, FocusInterval, StageTaskTemplate } from '../../strategies/types';
import { ProgressEmitter } from '../orchestratorTypes';
import {
  SkillExecutor,
  createSkillExecutor,
} from '../../../services/skillEngine/skillExecutor';
import {
  skillRegistry,
  ensureSkillRegistryInitialized,
} from '../../../services/skillEngine/skillLoader';
import {
  displayResultToEnvelope,
} from '../../../types/dataContract';
import type { SkillExecutionResult } from '../../../services/skillEngine/types';

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_CONCURRENCY = 6;

// =============================================================================
// DirectSkillExecutor
// =============================================================================

export class DirectSkillExecutor {
  private traceProcessorService: any;
  private aiService: any;
  private traceId: string;
  private concurrency: number;

  constructor(
    traceProcessorService: any,
    aiService: any,
    traceId: string,
    concurrency: number = DEFAULT_CONCURRENCY
  ) {
    this.traceProcessorService = traceProcessorService;
    this.aiService = aiService;
    this.traceId = traceId;
    this.concurrency = concurrency;
  }

  /**
   * Execute a batch of direct skill tasks with concurrency limiting.
   * Returns AgentResponse[] compatible with the existing pipeline.
   *
   * Architecture note: A single SkillExecutor instance is shared across the batch.
   * SkillExecutor is stateless after registerSkills() — each execute() call creates
   * its own SkillExecutionContext, so concurrent calls are safe.
   */
  async executeTasks(
    tasks: DirectSkillTask[],
    emitter: ProgressEmitter
  ): Promise<AgentResponse[]> {
    if (tasks.length === 0) return [];

    // Ensure skill registry is initialized
    await ensureSkillRegistryInitialized();

    // Create a single shared SkillExecutor for the entire batch.
    // SkillExecutor.execute() is reentrant — each call creates isolated context.
    const skillExecutor = createSkillExecutor(
      this.traceProcessorService,
      this.aiService  // ModelRouter duck-types as aiService via callWithFallback()
    );
    skillExecutor.registerSkills(skillRegistry.getAllSkills());

    emitter.log(`DirectSkillExecutor: executing ${tasks.length} tasks (concurrency: ${this.concurrency})`);
    emitter.emitUpdate('progress', {
      phase: 'tasks_dispatched',
      taskCount: tasks.length,
      agents: [...new Set(tasks.map(t => t.template.agentId))],
      message: `直接执行 ${tasks.length} 个 Skill（跳过 Agent LLM）`,
    });

    const responses: AgentResponse[] = [];
    const batches = this.chunk(tasks, this.concurrency);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(task => this.executeSingle(task, skillExecutor, emitter))
      );
      responses.push(...batchResults);
    }

    emitter.log(`DirectSkillExecutor: completed ${responses.length} tasks, ${responses.filter(r => r.success).length} successful`);
    return responses;
  }

  /**
   * Execute a single direct skill task.
   * 1. Build params from interval + template
   * 2. Call shared SkillExecutor.execute()
   * 3. Convert SkillExecutionResult → AgentResponse
   */
  private async executeSingle(
    task: DirectSkillTask,
    skillExecutor: SkillExecutor,
    emitter: ProgressEmitter
  ): Promise<AgentResponse> {
    const { template, interval, scopeLabel } = task;
    const taskId = createTaskId();
    const startTime = Date.now();

    const skillId = template.directSkillId;
    if (!skillId) {
      return this.buildErrorResponse(template.agentId, taskId, startTime,
        `No directSkillId specified for direct_skill template`);
    }

    try {
      // 1. Build parameters
      const params = this.buildParams(template, interval);

      emitter.log(`DirectSkill[${skillId}]: executing for ${scopeLabel}`);

      // 2. Execute skill (SkillExecutor creates isolated context per call)
      const result = await skillExecutor.execute(skillId, this.traceId, params);

      // 3. Convert to AgentResponse
      return this.buildResponse(result, template, taskId, startTime, scopeLabel);
    } catch (error: any) {
      emitter.log(`DirectSkill[${skillId}]: error for ${scopeLabel}: ${error.message}`);
      return this.buildErrorResponse(template.agentId, taskId, startTime, error.message);
    }
  }

  /**
   * Build skill params from template and interval.
   * Uses paramMapping if defined, otherwise falls back to standard mapping.
   */
  private buildParams(
    template: StageTaskTemplate,
    interval: FocusInterval
  ): Record<string, any> {
    const params: Record<string, any> = { ...template.skillParams };

    if (template.paramMapping) {
      // Use explicit mapping: { skillParamName: intervalFieldOrSpecial }
      for (const [paramName, source] of Object.entries(template.paramMapping)) {
        switch (source) {
          case 'startTs':
            params[paramName] = interval.startTs;
            break;
          case 'endTs':
            params[paramName] = interval.endTs;
            break;
          case 'processName':
            params[paramName] = interval.processName;
            break;
          case 'duration':
            try {
              params[paramName] = String(BigInt(interval.endTs) - BigInt(interval.startTs));
            } catch {
              params[paramName] = '0';
            }
            break;
          default:
            // Try to read from interval.metadata
            if (interval.metadata && source in interval.metadata) {
              params[paramName] = interval.metadata[source];
            }
            break;
        }
      }
    } else {
      // Default mapping: start_ts, end_ts, package
      params.start_ts = interval.startTs;
      params.end_ts = interval.endTs;
      if (interval.processName) {
        params.package = interval.processName;
      }
    }

    return params;
  }

  /**
   * Convert SkillExecutionResult → AgentResponse.
   * Extracts findings from diagnostics, builds DataEnvelopes from displayResults.
   */
  private buildResponse(
    result: SkillExecutionResult,
    template: StageTaskTemplate,
    taskId: string,
    startTime: number,
    scopeLabel: string
  ): AgentResponse {
    // Extract findings from diagnostics (taskId ensures globally unique finding IDs)
    const findings = this.extractFindings(result, template, taskId, scopeLabel);

    // Build DataEnvelopes from displayResults
    const dataEnvelopes = result.displayResults
      .map(dr => {
        try {
          const env = displayResultToEnvelope(dr, result.skillId);
          // Ensure uniqueness per execution so the frontend doesn't dedupe away repeated
          // per-interval/per-frame executions of the same (skillId, stepId).
          env.meta.source = `${env.meta.source}#${taskId}`;
          return env;
        } catch {
          return null;
        }
      })
      .filter((env): env is NonNullable<typeof env> => env !== null);

    // Build tool result (single compound result for the whole skill)
    const toolResult: AgentToolResult = {
      success: result.success,
      data: result.rawResults || {},
      findings,
      executionTimeMs: result.executionTimeMs,
      dataEnvelopes,
    };

    // Compute confidence from diagnostics
    const confidence = this.computeConfidence(result);

    return {
      agentId: template.agentId,
      taskId,
      success: result.success,
      findings,
      confidence,
      executionTimeMs: Date.now() - startTime,
      toolResults: [toolResult],
    };
  }

  /**
   * Extract Finding[] from SkillExecutionResult diagnostics.
   * Maps diagnostic severity to finding severity and builds structured findings.
   *
   * Uses taskId (which contains a random component) for globally unique finding IDs,
   * avoiding collisions when concurrent tasks finish in the same millisecond.
   */
  private extractFindings(
    result: SkillExecutionResult,
    template: StageTaskTemplate,
    taskId: string,
    scopeLabel: string
  ): Finding[] {
    const findings: Finding[] = [];

    for (const diag of result.diagnostics) {
      findings.push({
        id: `${taskId}_${diag.id}`,
        category: template.domain,
        type: 'root_cause',
        severity: diag.severity,
        title: `[${scopeLabel}] ${diag.diagnosis}`,
        description: diag.suggestions?.join('；') || diag.diagnosis,
        evidence: diag.evidence ? [diag.evidence] : undefined,
        source: `direct_skill:${template.directSkillId}`,
      });
    }

    // If no diagnostics but AI summary exists, create an info finding
    if (findings.length === 0 && result.aiSummary) {
      findings.push({
        id: `${taskId}_summary`,
        category: template.domain,
        type: 'performance',
        severity: 'info',
        title: `[${scopeLabel}] 帧分析摘要`,
        description: result.aiSummary,
        source: `direct_skill:${template.directSkillId}`,
      });
    }

    return findings;
  }

  /**
   * Compute overall confidence from diagnostic results.
   * DiagnosticResult.confidence is always numeric (SkillExecutor converts
   * YAML string labels to numbers in executeDiagnosticStep).
   */
  private computeConfidence(result: SkillExecutionResult): number {
    if (!result.success) return 0.2;
    if (result.diagnostics.length === 0) return 0.5;

    const scores = result.diagnostics.map(d => d.confidence);
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  /**
   * Build an error AgentResponse.
   */
  private buildErrorResponse(
    agentId: string,
    taskId: string,
    startTime: number,
    errorMessage: string
  ): AgentResponse {
    return {
      agentId,
      taskId,
      success: false,
      findings: [],
      confidence: 0,
      executionTimeMs: Date.now() - startTime,
      toolResults: [{
        success: false,
        error: errorMessage,
        executionTimeMs: Date.now() - startTime,
      }],
    };
  }

  /**
   * Split array into chunks for concurrency limiting.
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

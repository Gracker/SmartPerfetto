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
import type { FrameMechanismRecord } from '../../types/jankCause';

interface RootCauseSnapshot {
  stepId: 'root_cause' | 'root_cause_summary';
  data: Record<string, any>;
}

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
        `No directSkillId specified for direct_skill template`, {
          executionMode: 'direct_skill',
          kind: 'skill',
          toolName: 'unknown_direct_skill',
        });
    }

    try {
      // 1. Build parameters
      const params = this.buildParams(template, interval);

      emitter.log(`DirectSkill[${skillId}]: executing for ${scopeLabel}`);

      // 2. Execute skill (SkillExecutor creates isolated context per call)
      const result = await skillExecutor.execute(skillId, this.traceId, params);

      // 3. Convert to AgentResponse
      return this.buildResponse(result, template, taskId, startTime, scopeLabel, interval);
    } catch (error: any) {
      emitter.log(`DirectSkill[${skillId}]: error for ${scopeLabel}: ${error.message}`);
      return this.buildErrorResponse(template.agentId, taskId, startTime, error.message, {
        executionMode: 'direct_skill',
        kind: 'skill',
        toolName: skillId,
        skillId,
        scopeLabel,
        ...(interval?.processName && { packageName: interval.processName }),
        ...(interval?.startTs && interval?.endTs && { timeRange: { start: String(interval.startTs), end: String(interval.endTs) } }),
        ...(interval?.metadata?.sourceEntityType && { sourceEntityType: interval.metadata.sourceEntityType }),
        ...(interval?.metadata?.sourceEntityId && { sourceEntityId: String(interval.metadata.sourceEntityId) }),
      });
    }
  }

  /**
   * Build skill params from template and interval.
   * Uses paramMapping if defined, otherwise falls back to standard mapping.
   *
   * Hardened to handle key naming mismatches (snake_case vs camelCase):
   * - Tries source key as-is
   * - Tries snake_case conversion
   * - Tries camelCase conversion
   * - Tries interval top-level fields
   */
  private buildParams(
    template: StageTaskTemplate,
    interval: FocusInterval
  ): Record<string, any> {
    const params: Record<string, any> = { ...template.skillParams };

    if (template.paramMapping) {
      // Use explicit mapping: { skillParamName: intervalFieldOrSpecial }
      for (const [paramName, source] of Object.entries(template.paramMapping)) {
        const value = this.resolveParamValue(source, interval);
        if (value !== undefined) {
          params[paramName] = value;
        }
      }
    } else {
      // Default mapping: start_ts, end_ts, package.
      // Skip sentinel values from the fake "global" interval (startTs/endTs = '0')
      // to let skill SQL treat missing params as unfiltered (NULL/empty-string).
      const isRealInterval = interval.startTs && interval.endTs
        && interval.startTs !== '0' && interval.endTs !== '0';
      if (isRealInterval) {
        params.start_ts = interval.startTs;
        params.end_ts = interval.endTs;
      }
      if (interval.processName) {
        params.package = interval.processName;
      }
    }

    // Normalize/alias common params for legacy skills.
    if (params.start_ts !== undefined && params.start_ts !== null) {
      params.start_ts = String(params.start_ts);
    }
    if (params.end_ts !== undefined && params.end_ts !== null) {
      params.end_ts = String(params.end_ts);
    }

    const pkg = typeof params.package === 'string' ? params.package.trim() : '';
    if (pkg) {
      if (params.package_name === undefined) params.package_name = pkg;
      if (params.process_name === undefined) params.process_name = pkg;
    }

    if (params.start_ts && params.end_ts) {
      try {
        const startNs = BigInt(String(params.start_ts));
        const endNs = BigInt(String(params.end_ts));
        const startSec = (startNs / 1000000000n).toString();
        const endSec = (endNs / 1000000000n).toString();
        if (params.time_range_start === undefined) params.time_range_start = startSec;
        if (params.time_range_end === undefined) params.time_range_end = endSec;
      } catch {
        // best-effort only
      }
    }

    return params;
  }

  /**
   * Resolve a parameter value from interval using multiple key variations.
   * Handles special values and key naming mismatches.
   */
  private resolveParamValue(source: string, interval: FocusInterval): any {
    // Handle special/reserved source names
    switch (source) {
      case 'startTs':
      case 'start_ts':
        return interval.startTs;
      case 'endTs':
      case 'end_ts':
        return interval.endTs;
      case 'processName':
      case 'process_name':
        return interval.processName;
      case 'duration':
        try {
          return String(BigInt(interval.endTs) - BigInt(interval.startTs));
        } catch {
          return '0';
        }
      case 'id':
        return interval.id;
      case 'label':
        return interval.label;
      case 'priority':
        return interval.priority;
    }

    // Try to read from interval.metadata with key variations
    if (interval.metadata) {
      const meta = interval.metadata;

      // 1. Try source as-is
      if (meta[source] !== undefined) {
        return meta[source];
      }

      // 2. Try snake_case conversion (frameId -> frame_id)
      const snakeCase = toSnakeCase(source);
      if (snakeCase !== source && meta[snakeCase] !== undefined) {
        return meta[snakeCase];
      }

      // 3. Try camelCase conversion (frame_id -> frameId)
      const camelCase = toCamelCase(source);
      if (camelCase !== source && meta[camelCase] !== undefined) {
        return meta[camelCase];
      }
    }

    // 4. Try interval top-level fields (for common ones)
    const intervalAny = interval as any;
    if (intervalAny[source] !== undefined) {
      return intervalAny[source];
    }

    return undefined;
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
    scopeLabel: string,
    interval: FocusInterval
  ): AgentResponse {
    // Extract findings from diagnostics (taskId ensures globally unique finding IDs)
    let findings = this.extractFindings(result, template, taskId, scopeLabel);

    const rootCauseSnapshot = this.extractRootCauseSnapshot(result.rawResults || {}, scopeLabel);

    // Enrich findings with root_cause data from rawResults (if available)
    // This populates Finding.details.cause_type for JankCauseSummarizer
    findings = this.enrichFindingsWithRootCauseData(findings, rootCauseSnapshot?.data || null, scopeLabel);

    // Persist frame-level mechanism record for aggregation that should bypass finding deduplication.
    const frameMechanismRecord = rootCauseSnapshot
      ? this.buildFrameMechanismRecord(rootCauseSnapshot.data, rootCauseSnapshot.stepId, interval, scopeLabel)
      : null;

    // Build DataEnvelopes from displayResults
    const dataEnvelopes = result.displayResults
      .map(dr => {
        try {
          // Pass column definitions from DisplayResult to preserve hidden/type/format etc.
          const explicitColumns = dr.columnDefinitions as any;
          // Bridge metadataFields -> metadataConfig.fields for v2 DataEnvelope
          const drAny = dr as any;
          const drForEnvelope = {
            ...drAny,
            metadataConfig: drAny.metadataConfig || (Array.isArray(drAny.metadataFields) ? { fields: drAny.metadataFields } : undefined),
          };
          const env = displayResultToEnvelope(drForEnvelope as any, result.skillId, explicitColumns);
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
      metadata: {
        kind: 'skill',
        toolName: result.skillId,
        skillId: result.skillId,
        executionMode: 'direct_skill',
        scopeLabel,
        ...(interval?.processName && { packageName: interval.processName }),
        ...(interval?.startTs && interval?.endTs && { timeRange: { start: String(interval.startTs), end: String(interval.endTs) } }),
        ...(interval?.metadata?.sourceEntityType && { sourceEntityType: interval.metadata.sourceEntityType }),
        ...(interval?.metadata?.sourceEntityId && { sourceEntityId: String(interval.metadata.sourceEntityId) }),
        ...(frameMechanismRecord && { frameMechanismRecord }),
      },
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
   * Enrich findings with root_cause data from rawResults.
   * Called after extractFindings() to add structured cause data to Finding.details.
   *
   * This is critical for JankCauseSummarizer which aggregates by cause_type.
   * Without this enrichment, findings would lack the cause_type field and
   * the conclusion generator would have to rely on LLM to infer patterns.
   *
   * @param findings - Findings extracted from diagnostics
   * @param rootCauseData - Extracted root cause row
   * @param scopeLabel - Scope label for logging/context
   * @returns Enriched findings with cause_type, primary_cause, etc. in details
   */
  private enrichFindingsWithRootCauseData(
    findings: Finding[],
    rootCauseData: Record<string, any> | null,
    scopeLabel: string
  ): Finding[] {
    if (!rootCauseData) {
      return findings;
    }

    // Enrich each finding with the root cause data
    return findings.map(f => ({
      ...f,
      details: {
        ...f.details,
        cause_type: rootCauseData.cause_type,
        primary_cause: rootCauseData.primary_cause,
        deep_reason: rootCauseData.deep_reason,
        optimization_hint: rootCauseData.optimization_hint,
        reason_code: rootCauseData.reason_code,
        secondary_info: rootCauseData.secondary_info,
        confidence_level: rootCauseData.confidence,
        frame_dur_ms: rootCauseData.frame_dur_ms,
        jank_type: rootCauseData.jank_type,
        slice_name: rootCauseData.slice_name,
        slice_dur: rootCauseData.slice_dur,
        frame_budget_ms: rootCauseData.frame_budget_ms,
        main_q3_pct: rootCauseData.main_q3_pct,
        main_q4_pct: rootCauseData.main_q4_pct,
        render_q4_pct: rootCauseData.render_q4_pct,
        main_max_sched_ms: rootCauseData.main_max_sched_ms,
        main_io_block_ms: rootCauseData.main_io_block_ms,
        gpu_fence_ms: rootCauseData.gpu_fence_ms,
        mechanism_group: rootCauseData.mechanism_group,
        supply_constraint: rootCauseData.supply_constraint,
        trigger_layer: rootCauseData.trigger_layer,
        amplification_path: rootCauseData.amplification_path,
        scope: scopeLabel,
      },
    }));
  }

  /**
   * Extract and normalize root cause row from raw skill results.
   */
  private extractRootCauseSnapshot(
    rawResults: Record<string, any>,
    scopeLabel: string
  ): RootCauseSnapshot | null {
    const stepId: 'root_cause' | 'root_cause_summary' | null = rawResults['root_cause']
      ? 'root_cause'
      : rawResults['root_cause_summary']
        ? 'root_cause_summary'
        : null;

    const availableKeys = Object.keys(rawResults);
    if (!stepId) {
      if (availableKeys.length > 0) {
        console.log(`[DirectSkillExecutor] root_cause not found in rawResults. Available keys: ${availableKeys.join(', ')}`);
      }
      return null;
    }

    const stepData = rawResults[stepId];
    if (!stepData?.data) {
      return null;
    }

    const rootCauseData = this.extractRootCauseRow(stepData.data);
    if (!rootCauseData) {
      console.log(`[DirectSkillExecutor] Failed to extract root_cause row. Data structure: ${JSON.stringify(stepData.data).slice(0, 200)}`);
      return null;
    }

    if (rootCauseData.cause_type) {
      console.log(`[DirectSkillExecutor] Extracted cause_type="${rootCauseData.cause_type}" for ${scopeLabel}`);
    }

    return {
      stepId,
      data: rootCauseData,
    };
  }

  /**
   * Build a per-frame mechanism record used by StrategyExecutor aggregation.
   */
  private buildFrameMechanismRecord(
    rootCauseData: Record<string, any>,
    sourceStep: 'root_cause' | 'root_cause_summary',
    interval: FocusInterval,
    scopeLabel: string
  ): FrameMechanismRecord | null {
    const causeType = typeof rootCauseData.cause_type === 'string'
      ? rootCauseData.cause_type.trim()
      : '';
    if (!causeType) {
      return null;
    }

    const meta = interval.metadata || {};
    const frameIdRaw =
      meta.frameId ??
      meta.frame_id ??
      rootCauseData.frame_id ??
      rootCauseData.frameId ??
      interval.id ??
      interval.startTs;

    const sessionIdRaw =
      meta.sessionId ??
      meta.session_id ??
      rootCauseData.session_id ??
      rootCauseData.sessionId;

    const frameIndexRaw =
      meta.frameIndex ??
      meta.frame_index ??
      rootCauseData.frame_index ??
      rootCauseData.frameIndex;

    const pidRaw = meta.pid ?? rootCauseData.pid;
    const processNameRaw =
      interval.processName ||
      meta.processName ||
      meta.process_name ||
      rootCauseData.process_name;

    const confidenceLevelRaw =
      rootCauseData.confidence_level ??
      rootCauseData.confidence;

    const frameDurMsRaw =
      rootCauseData.frame_dur_ms ??
      rootCauseData.frameDurMs;

    const jankTypeRaw =
      rootCauseData.jank_type ??
      rootCauseData.jankType ??
      meta.jankType ??
      meta.jank_type;

    const primaryCauseRaw = rootCauseData.primary_cause;
    const secondaryInfoRaw = rootCauseData.secondary_info;
    const mechanismGroupRaw = rootCauseData.mechanism_group;
    const supplyConstraintRaw = rootCauseData.supply_constraint;
    const triggerLayerRaw = rootCauseData.trigger_layer;
    const amplificationPathRaw = rootCauseData.amplification_path;

    const record: FrameMechanismRecord = {
      frameId: String(frameIdRaw),
      startTs: String(interval.startTs),
      endTs: String(interval.endTs),
      scopeLabel,
      causeType,
      sourceStep,
      ...(sessionIdRaw !== undefined && sessionIdRaw !== null ? { sessionId: String(sessionIdRaw) } : {}),
      ...(typeof processNameRaw === 'string' && processNameRaw.length > 0 ? { processName: processNameRaw } : {}),
      ...(typeof primaryCauseRaw === 'string' && primaryCauseRaw.length > 0 ? { primaryCause: primaryCauseRaw } : {}),
      ...(typeof secondaryInfoRaw === 'string' && secondaryInfoRaw.length > 0 ? { secondaryInfo: secondaryInfoRaw } : {}),
      ...(typeof confidenceLevelRaw === 'number' || typeof confidenceLevelRaw === 'string' ? { confidenceLevel: confidenceLevelRaw } : {}),
      ...(typeof jankTypeRaw === 'string' && jankTypeRaw.length > 0 ? { jankType: jankTypeRaw } : {}),
      ...(typeof mechanismGroupRaw === 'string' && mechanismGroupRaw.length > 0 ? { mechanismGroup: mechanismGroupRaw } : {}),
      ...(typeof supplyConstraintRaw === 'string' && supplyConstraintRaw.length > 0 ? { supplyConstraint: supplyConstraintRaw } : {}),
      ...(typeof triggerLayerRaw === 'string' && triggerLayerRaw.length > 0 ? { triggerLayer: triggerLayerRaw } : {}),
      ...(typeof amplificationPathRaw === 'string' && amplificationPathRaw.length > 0 ? { amplificationPath: amplificationPathRaw } : {}),
    };

    const frameIndex = this.toOptionalNumber(frameIndexRaw);
    if (frameIndex !== undefined) {
      record.frameIndex = frameIndex;
    }

    const pid = this.toOptionalNumber(pidRaw);
    if (pid !== undefined) {
      record.pid = pid;
    }

    const frameDurMs = this.toOptionalNumber(frameDurMsRaw);
    if (frameDurMs !== undefined) {
      record.frameDurMs = frameDurMs;
    }

    return record;
  }

  private toOptionalNumber(value: any): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  /**
   * Extract root cause row from step data.
   * Handles multiple data formats that SkillExecutor may produce.
   *
   * Data formats seen in practice:
   * 1. Array of objects: [{ cause_type, primary_cause, ... }] (most common from SQL)
   * 2. Columnar: { columns: [...], rows: [[...]] } (raw SQL result)
   * 3. Single object with cause_type (direct result)
   *
   * @param data - Step data in various possible formats
   * @returns First row as a key-value object, or null if extraction fails
   */
  private extractRootCauseRow(data: any): Record<string, any> | null {
    if (!data) return null;

    // Format 1: Array of objects (most common - SkillExecutor transforms SQL to this)
    // This is what frameAgent.extractSummaryRow expects
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
      return data[0];
    }

    // Format 2: { columns, rows } (columnar SQL result - raw format)
    if (Array.isArray(data.columns) && Array.isArray(data.rows) && data.rows.length > 0) {
      const columns: string[] = data.columns;
      const row = data.rows[0];
      const result: Record<string, any> = {};
      columns.forEach((col, idx) => {
        result[col] = row[idx];
      });
      return result;
    }

    // Format 3: Single object with cause_type (direct result)
    if (typeof data === 'object' && !Array.isArray(data) && data.cause_type) {
      return data;
    }

    return null;
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
    errorMessage: string,
    metadata?: Record<string, any>
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
        metadata: {
          executionMode: 'direct_skill',
          ...(metadata || {}),
        },
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

// =============================================================================
// Utilities
// =============================================================================

/**
 * Convert camelCase to snake_case.
 * frameId -> frame_id
 */
function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Convert snake_case to camelCase.
 * frame_id -> frameId
 */
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

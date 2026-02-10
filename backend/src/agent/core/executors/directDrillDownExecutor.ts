/**
 * Direct Drill-Down Executor
 *
 * A specialized executor for handling explicit drill-down follow-up queries.
 * Bypasses the strategy pipeline entirely and directly invokes the appropriate
 * skill based on the follow-up resolution.
 *
 * Use cases:
 * - "分析帧 1436069" → directly runs jank_frame_detail for that frame
 * - "分析会话 3" → directly runs scrolling_analysis for that session
 *
 * Benefits:
 * - Zero LLM overhead for explicit drill-down requests
 * - Avoids re-executing global discovery stages
 * - Handles intervals that need timestamp enrichment via lightweight queries
 */

import { AnalysisExecutor } from './analysisExecutor';
import { DirectSkillExecutor } from './directSkillExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  concludeDecision,
} from '../orchestratorTypes';
import { FollowUpResolution } from '../followUpHandler';
import { Finding } from '../../types';
import type { AgentResponse } from '../../types/agentProtocol';
import type { FrameMechanismRecord } from '../../types/jankCause';
import { FocusInterval, StageTaskTemplate } from '../../strategies/types';
import { emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback } from '../feedbackSynthesizer';
import { summarizeJankCauses } from '../jankCauseSummarizer';
import {
  DrillDownEntityType,
  DrillDownSkillConfig,
  getDrillDownSkillConfig,
} from '../../config/drillDownRegistry';

// =============================================================================
// Skill Mapping
// =============================================================================

type DrillDownFocus = 'default' | 'cpu' | 'cpu_frequency';

interface DrillDownSkillPlan {
  entityType: DrillDownEntityType;
  focus: DrillDownFocus;
  reason: string;
  skills: DrillDownSkillConfig[];
}

const CPU_IN_RANGE_SKILLS: DrillDownSkillConfig[] = [
  {
    skillId: 'cpu_load_in_range',
    domain: 'cpu',
    agentId: 'cpu_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
    },
  },
  {
    skillId: 'scheduling_analysis',
    domain: 'cpu',
    agentId: 'cpu_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
      package: 'processName',
    },
  },
];

const CPU_FREQ_IN_RANGE_SKILLS: DrillDownSkillConfig[] = [
  {
    skillId: 'cpu_freq_timeline',
    domain: 'cpu',
    agentId: 'cpu_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
    },
  },
  ...CPU_IN_RANGE_SKILLS,
];

// =============================================================================
// DirectDrillDownExecutor
// =============================================================================

export class DirectDrillDownExecutor implements AnalysisExecutor {
  constructor(
    private followUp: FollowUpResolution,
    private services: AnalysisServices
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const allFindings: Finding[] = [];
    let confidence = 0.5;

    // Determine target skills based on entity + follow-up focus.
    const skillPlan = this.determineSkillPlan(ctx);
    if (!skillPlan) {
      emitter.log('[DrillDown] Could not determine target skill plan, falling back');
      return {
        findings: [],
        lastStrategy: concludeDecision(0.3, 'Could not determine drill-down target'),
        confidence: 0.3,
        informationGaps: ['Unable to map follow-up to specific drill-down plan'],
        rounds: 0,
        stopReason: 'No matching drill-down skill',
      };
    }

    const skillIds = skillPlan.skills.map(skill => skill.skillId);
    const skillLabel = skillIds.join(' + ');
    let intervals = this.followUp.focusIntervals || [];

    // Enrich intervals that need timestamps
    const enrichmentSkill = getDrillDownSkillConfig(skillPlan.entityType);
    intervals = await this.enrichIntervalsIfNeeded(
      intervals,
      enrichmentSkill,
      ctx.options.traceProcessorService,
      ctx.traceId,
      emitter
    );

    // Filter out intervals that couldn't be enriched
    const validIntervals = intervals.filter(i =>
      i.startTs && i.startTs !== '0' && i.endTs && i.endTs !== '0'
    );

    if (validIntervals.length === 0) {
      emitter.log('[DrillDown] No valid intervals after enrichment');
      return {
        findings: [],
        lastStrategy: concludeDecision(0.3, 'No valid intervals for drill-down'),
        confidence: 0.3,
        informationGaps: ['Could not resolve timestamps for requested entities'],
        rounds: 0,
        stopReason: 'No valid intervals',
      };
    }

    emitter.log(`[DrillDown] Focus=${skillPlan.focus}, executing ${skillLabel} for ${validIntervals.length} interval(s)`);
    emitter.emitUpdate('progress', {
      phase: 'round_start',
      round: 1,
      maxRounds: 1,
      message: `直接执行 ${skillLabel}（${skillPlan.reason}）`,
    });

    const experimentId = ctx.sessionContext?.startTraceAgentExperiment({
      type: 'run_skill',
      objective: `[drill_down:${skillPlan.focus}] ${skillIds.join(',')} intervals=${validIntervals.length}`,
    });

    // Build direct skill tasks (one per skill per interval).
    const tasks = skillPlan.skills.flatMap((skill) => {
      const template: StageTaskTemplate = {
        agentId: skill.agentId,
        domain: skill.domain,
        scope: 'per_interval',
        executionMode: 'direct_skill',
        directSkillId: skill.skillId,
        paramMapping: skill.paramMapping,
        descriptionTemplate: `Drill-down: {{scopeLabel}}`,
      };

      return validIntervals.map((interval, idx) => ({
        template,
        interval,
        scopeLabel: interval.label || `区间${idx + 1}`,
      }));
    });

    // Execute via DirectSkillExecutor
    const directExecutor = new DirectSkillExecutor(
      ctx.options.traceProcessorService,
      this.services.modelRouter,
      ctx.traceId
    );

    const responses = await directExecutor.executeTasks(tasks, emitter);

    // Emit data envelopes (with deduplication via registry)
    emitDataEnvelopes(responses, emitter, this.services.emittedEnvelopeRegistry);

    // v2.0: Ingest tool outputs as durable evidence digests (goal-driven agent scaffold).
    const producedEvidenceIds =
      ctx.sessionContext?.ingestEvidenceFromResponses(responses, { stageName: 'drill_down', round: 1 }) || [];
    if (experimentId) {
      const ok = responses.some(r => r.success);
      const firstErr = (() => {
        const failed = responses.find(r => !r.success);
        const err = failed?.toolResults?.find(tr => !tr.success)?.error;
        return typeof err === 'string' ? err.slice(0, 200) : undefined;
      })();
      ctx.sessionContext?.completeTraceAgentExperiment({
        id: experimentId,
        status: ok ? 'succeeded' : 'failed',
        producedEvidenceIds,
        error: ok ? undefined : firstErr,
      });
    }

    // Synthesize findings
    const synthesis = await synthesizeFeedback(
      responses,
      ctx.sharedContext,
      this.services.modelRouter,
      emitter,
      this.services.messageBus,
      ctx.sessionContext
    );

    allFindings.push(...synthesis.newFindings);
    this.refreshDrillDownJankContext(ctx, responses, allFindings, emitter);

    // Update confidence from responses
    const confidences = responses
      .filter(r => r.success)
      .map(r => r.confidence)
      .filter(c => typeof c === 'number');
    if (confidences.length > 0) {
      confidence = confidences.reduce((s, c) => s + c, 0) / confidences.length;
    }

    if (synthesis.newFindings.length > 0) {
      emitter.emitUpdate('finding', {
        round: 1,
        findings: synthesis.newFindings,
      });
    }

    emitter.emitUpdate('progress', {
      phase: 'synthesis_complete',
      confirmedFindings: synthesis.confirmedFindings.length,
      updatedHypotheses: synthesis.updatedHypotheses.length,
      message: `综合 ${responses.length} 个 Skill 执行结果`,
    });

    const successCount = responses.filter(r => r.success).length;
    emitter.log(`[DrillDown] Completed: ${successCount}/${responses.length} successful, ${allFindings.length} findings`);

    return {
      findings: allFindings,
      lastStrategy: concludeDecision(confidence, `Drill-down ${skillLabel} completed`),
      confidence,
      informationGaps: synthesis.informationGaps,
      rounds: 1,
      stopReason: `Drill-down ${skillLabel} completed for ${validIntervals.length} interval(s)`,
    };
  }

  /**
   * Enrich intervals that have needsEnrichment flag by querying for timestamps.
   */
  private async enrichIntervalsIfNeeded(
    intervals: FocusInterval[],
    skillConfig: DrillDownSkillConfig,
    traceProcessorService: any,
    traceId: string,
    emitter: ProgressEmitter
  ): Promise<FocusInterval[]> {
    if (!traceProcessorService || !skillConfig.enrichmentQuery) {
      return intervals;
    }

    const enrichedIntervals: FocusInterval[] = [];

    for (const interval of intervals) {
      // Skip if doesn't need enrichment
      if (!interval.metadata?.needsEnrichment) {
        enrichedIntervals.push(interval);
        continue;
      }

      emitter.log(`[DrillDown] Enriching interval for ${interval.label}`);

      try {
        // Build query params from interval metadata
        const entityId = interval.metadata.sourceEntityId;
        const entityType = interval.metadata.sourceEntityType;
        const normalizedEntityId = this.normalizeLooseNumericId(entityId);

        if ((entityType === 'frame' || entityType === 'session' || entityType === 'startup') && !normalizedEntityId) {
          emitter.log(`[DrillDown] Skip enrichment for ${interval.label}: invalid entity id (${String(entityId)})`);
          enrichedIntervals.push(interval);
          continue;
        }

        let rowObj: Record<string, any> | null = null;
        if (entityType === 'frame') {
          const query = skillConfig.enrichmentQuery.replace('$frame_id', String(normalizedEntityId));
          rowObj = await this.queryFirstRow(traceProcessorService, traceId, query);
          if (!rowObj && normalizedEntityId) {
            rowObj = await this.tryResolveFrameIntervalWithFallbacks(
              traceProcessorService,
              traceId,
              normalizedEntityId,
              emitter,
              interval.label || `帧 ${normalizedEntityId}`
            );
          }
        } else if (entityType === 'session') {
          const query = skillConfig.enrichmentQuery.replace('$session_id', String(normalizedEntityId));
          rowObj = await this.queryFirstRow(traceProcessorService, traceId, query);
        } else if (entityType === 'startup') {
          const query = skillConfig.enrichmentQuery.replace('$startup_id', String(normalizedEntityId));
          rowObj = await this.queryFirstRow(traceProcessorService, traceId, query);
        }

        if (rowObj) {
          const resolvedFrameId = this.normalizeLooseNumericId(rowObj.frame_id);
          const originalFrameId = this.normalizeLooseNumericId(entityId);
          const resolvedFromAlias =
            entityType === 'frame' &&
            rowObj.resolve_source === 'doframe_alias' &&
            resolvedFrameId !== null &&
            originalFrameId !== null &&
            resolvedFrameId !== originalFrameId;

          const enrichedLabel = resolvedFromAlias
            ? `${interval.label || `帧 ${originalFrameId}`} (映射帧 ${resolvedFrameId})`
            : interval.label;

          if (resolvedFromAlias) {
            emitter.log(`[DrillDown] Resolved doFrame ${originalFrameId} -> frame ${resolvedFrameId}`);
          }

          // Update interval with enriched data
          const enrichedInterval: FocusInterval = {
            ...interval,
            startTs: String(rowObj.start_ts || interval.startTs),
            endTs: String(rowObj.end_ts || interval.endTs),
            processName: rowObj.process_name || interval.processName,
            label: enrichedLabel,
            metadata: {
              ...interval.metadata,
              needsEnrichment: false,
              enriched: true,
              ...(resolvedFrameId !== null && { frameId: resolvedFrameId, frame_id: resolvedFrameId }),
              ...(resolvedFromAlias && {
                originalFrameId,
                original_frame_id: originalFrameId,
                resolvedFrom: 'doframe_alias',
              }),
              ...(rowObj.resolve_source && { resolveSource: rowObj.resolve_source }),
              // Add any additional enriched fields
              ...(rowObj.jank_type !== undefined && rowObj.jank_type !== null && {
                jankType: rowObj.jank_type,
                jank_type: rowObj.jank_type,
              }),
              ...(rowObj.layer_name !== undefined && rowObj.layer_name !== null && {
                layerName: rowObj.layer_name,
                layer_name: rowObj.layer_name,
              }),
              ...(rowObj.vsync_missed !== undefined && rowObj.vsync_missed !== null && {
                vsyncMissed: rowObj.vsync_missed,
                vsync_missed: rowObj.vsync_missed,
              }),
              ...(rowObj.dur !== undefined && rowObj.dur !== null && { dur: rowObj.dur }),
              ...(rowObj.startup_id !== undefined && rowObj.startup_id !== null && {
                startupId: rowObj.startup_id,
                startup_id: rowObj.startup_id,
              }),
              ...(rowObj.startup_type !== undefined && rowObj.startup_type !== null && {
                startupType: rowObj.startup_type,
                startup_type: rowObj.startup_type,
              }),
              ...(rowObj.dur_ms !== undefined && rowObj.dur_ms !== null && {
                durMs: rowObj.dur_ms,
                dur_ms: rowObj.dur_ms,
              }),
              ...(rowObj.ttid_ms !== undefined && rowObj.ttid_ms !== null && {
                ttidMs: rowObj.ttid_ms,
                ttid_ms: rowObj.ttid_ms,
              }),
              ...(rowObj.ttfd_ms !== undefined && rowObj.ttfd_ms !== null && {
                ttfdMs: rowObj.ttfd_ms,
                ttfd_ms: rowObj.ttfd_ms,
              }),
            },
          };

          emitter.log(`[DrillDown] Enriched: ${interval.label} → ts=[${enrichedInterval.startTs}, ${enrichedInterval.endTs}]`);
          enrichedIntervals.push(enrichedInterval);
        } else {
          // Query returned no results - keep original interval but log warning
          emitter.log(`[DrillDown] Enrichment query returned no results for ${interval.label}`);
          enrichedIntervals.push(interval);
        }
      } catch (error: any) {
        emitter.log(`[DrillDown] Enrichment failed for ${interval.label}: ${error.message}`);
        enrichedIntervals.push(interval);
      }
    }

    return enrichedIntervals;
  }

  private async queryFirstRow(
    traceProcessorService: any,
    traceId: string,
    sql: string
  ): Promise<Record<string, any> | null> {
    const result = await this.executeTraceQuery(traceProcessorService, traceId, sql);
    return this.toRowObject(result);
  }

  private async tryResolveFrameIntervalWithFallbacks(
    traceProcessorService: any,
    traceId: string,
    frameId: string,
    emitter: ProgressEmitter,
    scopeLabel: string
  ): Promise<Record<string, any> | null> {
    const legacyRow = await this.queryFirstRow(
      traceProcessorService,
      traceId,
      this.buildLegacyFrameEnrichmentQuery(frameId)
    );
    if (legacyRow) {
      return { ...legacyRow, resolve_source: 'legacy_android_frames' };
    }

    const doFrameAliasRow = await this.queryFirstRow(
      traceProcessorService,
      traceId,
      this.buildDoFrameAliasEnrichmentQuery(frameId)
    );
    if (doFrameAliasRow) {
      return { ...doFrameAliasRow, resolve_source: 'doframe_alias' };
    }

    emitter.log(`[DrillDown] Fallback enrichment failed for frame ${frameId} (${scopeLabel})`);
    return null;
  }

  private buildLegacyFrameEnrichmentQuery(frameId: string): string {
    return `
      SELECT
        af.frame_id,
        af.ts as start_ts,
        af.ts + af.dur as end_ts,
        af.dur,
        p.name as process_name,
        ej.jank_type,
        ej.layer_name,
        ej.vsync_missed
      FROM android_frames af
      LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
      LEFT JOIN process p ON af.upid = p.upid
      WHERE af.frame_id = ${frameId}
      LIMIT 1
    `;
  }

  private buildDoFrameAliasEnrichmentQuery(frameId: string): string {
    return `
      WITH target_slice AS (
        SELECT
          s.ts,
          s.dur,
          t.upid
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        WHERE s.name = 'Choreographer#doFrame ${frameId}'
           OR s.name GLOB '*Choreographer#doFrame ${frameId}*'
           OR s.name = 'doFrame ${frameId}'
           OR s.name GLOB '*doFrame ${frameId}*'
        ORDER BY s.dur DESC
        LIMIT 1
      )
      SELECT
        COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
        a.ts as start_ts,
        a.ts + a.dur as end_ts,
        a.dur,
        p.name as process_name,
        a.jank_type,
        a.layer_name,
        NULL as vsync_missed
      FROM actual_frame_timeline_slice a
      JOIN target_slice ts
        ON a.upid = ts.upid
       AND a.ts < ts.ts + ts.dur + 5000000
       AND a.ts + a.dur > ts.ts - 5000000
      LEFT JOIN process p ON a.upid = p.upid
      ORDER BY ABS((a.ts + a.dur / 2) - (ts.ts + ts.dur / 2)) ASC, a.dur DESC
      LIMIT 1
    `;
  }

  private toRowObject(result: { columns?: string[]; rows?: any[] } | null | undefined): Record<string, any> | null {
    if (!result || !Array.isArray(result.rows) || result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row as Record<string, any>;
    }

    const columns = Array.isArray(result.columns) ? result.columns : [];
    if (!Array.isArray(row) || columns.length === 0) {
      return null;
    }

    const rowObj: Record<string, any> = {};
    columns.forEach((col: string, idx: number) => {
      rowObj[col] = row[idx];
    });
    return rowObj;
  }

  private normalizeLooseNumericId(id: any): string | null {
    if (id === null || id === undefined) return null;
    if (typeof id === 'number' && Number.isFinite(id)) return String(Math.trunc(id));
    const s = String(id).trim();
    if (!s) return null;
    const compact = s.replace(/[,\s，_]/g, '');
    if (!/^\d+$/.test(compact)) return null;
    return compact;
  }

  private async executeTraceQuery(
    traceProcessorService: any,
    traceId: string,
    sql: string
  ): Promise<{ columns: string[]; rows: any[] }> {
    if (!traceProcessorService) {
      throw new Error('Trace processor service is unavailable');
    }

    const queryFn = traceProcessorService.query;
    if (typeof queryFn === 'function') {
      if (queryFn.length === 1) {
        return await queryFn.call(traceProcessorService, sql);
      }
      return await queryFn.call(traceProcessorService, traceId, sql);
    }

    const executeQueryFn = traceProcessorService.executeQuery;
    if (typeof executeQueryFn === 'function') {
      if (executeQueryFn.length === 1) {
        return await executeQueryFn.call(traceProcessorService, sql);
      }
      return await executeQueryFn.call(traceProcessorService, traceId, sql);
    }

    throw new Error('Trace processor service does not expose query/executeQuery');
  }

  private refreshDrillDownJankContext(
    ctx: ExecutionContext,
    responses: AgentResponse[],
    findings: Finding[],
    emitter: ProgressEmitter
  ): void {
    const frameMechanismRecords = this.dedupeFrameMechanismRecords(
      this.collectFrameMechanismRecords(responses)
    );
    ctx.sharedContext.frameMechanismRecords = frameMechanismRecords;

    const jankSummary = summarizeJankCauses(findings, frameMechanismRecords);
    if (jankSummary.totalJankFrames > 0) {
      ctx.sharedContext.jankCauseSummary = jankSummary;
      emitter.log(
        `[DrillDown] Refreshed jank summary: ${jankSummary.totalJankFrames} frame(s), ` +
        `primary=${jankSummary.primaryCause?.label || 'unknown'}`
      );
      return;
    }

    ctx.sharedContext.jankCauseSummary = undefined;
    emitter.log('[DrillDown] Cleared stale jank summary for current drill-down scope');
  }

  private collectFrameMechanismRecords(responses: AgentResponse[]): FrameMechanismRecord[] {
    const records: FrameMechanismRecord[] = [];

    for (const response of responses) {
      const toolResults = response.toolResults || [];
      for (const toolResult of toolResults) {
        const candidate = toolResult?.metadata && typeof toolResult.metadata === 'object'
          ? (toolResult.metadata as Record<string, any>).frameMechanismRecord
          : null;
        if (!candidate || typeof candidate !== 'object') {
          continue;
        }

        const normalized = this.normalizeFrameMechanismRecord(candidate);
        if (normalized) {
          records.push(normalized);
        }
      }
    }

    return records;
  }

  private normalizeFrameMechanismRecord(candidate: any): FrameMechanismRecord | null {
    const frameIdRaw = candidate.frameId ?? candidate.frame_id;
    const startTsRaw = candidate.startTs ?? candidate.start_ts;
    const endTsRaw = candidate.endTs ?? candidate.end_ts;
    const causeTypeRaw = candidate.causeType ?? candidate.cause_type;

    const sourceStep: 'root_cause' | 'root_cause_summary' =
      candidate.sourceStep === 'root_cause_summary' ? 'root_cause_summary' : 'root_cause';

    if (frameIdRaw === undefined || startTsRaw === undefined || endTsRaw === undefined) {
      return null;
    }
    if (typeof causeTypeRaw !== 'string' || causeTypeRaw.trim().length === 0) {
      return null;
    }

    const normalized: FrameMechanismRecord = {
      frameId: String(frameIdRaw),
      startTs: String(startTsRaw),
      endTs: String(endTsRaw),
      scopeLabel: typeof candidate.scopeLabel === 'string' && candidate.scopeLabel.trim().length > 0
        ? candidate.scopeLabel
        : 'unknown_scope',
      causeType: causeTypeRaw.trim(),
      sourceStep,
    };

    if (candidate.sessionId !== undefined || candidate.session_id !== undefined) {
      normalized.sessionId = String(candidate.sessionId ?? candidate.session_id);
    }
    if (candidate.frameIndex !== undefined) {
      const frameIndex = Number(candidate.frameIndex);
      if (Number.isFinite(frameIndex)) normalized.frameIndex = frameIndex;
    }
    if (typeof candidate.processName === 'string' && candidate.processName.length > 0) {
      normalized.processName = candidate.processName;
    }
    if (candidate.pid !== undefined) {
      const pid = Number(candidate.pid);
      if (Number.isFinite(pid)) normalized.pid = pid;
    }
    if (typeof candidate.primaryCause === 'string' && candidate.primaryCause.length > 0) {
      normalized.primaryCause = candidate.primaryCause;
    }
    if (typeof candidate.secondaryInfo === 'string' && candidate.secondaryInfo.length > 0) {
      normalized.secondaryInfo = candidate.secondaryInfo;
    }
    if (typeof candidate.confidenceLevel === 'number' || typeof candidate.confidenceLevel === 'string') {
      normalized.confidenceLevel = candidate.confidenceLevel;
    }
    if (candidate.frameDurMs !== undefined) {
      const frameDurMs = Number(candidate.frameDurMs);
      if (Number.isFinite(frameDurMs)) normalized.frameDurMs = frameDurMs;
    }
    if (typeof candidate.jankType === 'string' && candidate.jankType.length > 0) {
      normalized.jankType = candidate.jankType;
    }

    const mechanismGroup = candidate.mechanismGroup ?? candidate.mechanism_group;
    if (typeof mechanismGroup === 'string' && mechanismGroup.length > 0) {
      normalized.mechanismGroup = mechanismGroup;
    }

    const supplyConstraint = candidate.supplyConstraint ?? candidate.supply_constraint;
    if (typeof supplyConstraint === 'string' && supplyConstraint.length > 0) {
      normalized.supplyConstraint = supplyConstraint;
    }

    const triggerLayer = candidate.triggerLayer ?? candidate.trigger_layer;
    if (typeof triggerLayer === 'string' && triggerLayer.length > 0) {
      normalized.triggerLayer = triggerLayer;
    }

    const amplificationPath = candidate.amplificationPath ?? candidate.amplification_path;
    if (typeof amplificationPath === 'string' && amplificationPath.length > 0) {
      normalized.amplificationPath = amplificationPath;
    }

    return normalized;
  }

  private dedupeFrameMechanismRecords(records: FrameMechanismRecord[]): FrameMechanismRecord[] {
    const seen = new Set<string>();
    const deduped: FrameMechanismRecord[] = [];

    for (const record of records) {
      const key = [
        record.sessionId || 'nosession',
        record.frameId,
        record.startTs,
        record.causeType,
      ].join('|');

      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(record);
    }

    return deduped;
  }

  /**
   * Determine drill-down skill plan based on:
   * 1) resolved entity target (frame/session/startup)
   * 2) user follow-up focus (default/cpu/cpu_frequency)
   */
  private determineSkillPlan(ctx: ExecutionContext): DrillDownSkillPlan | null {
    const entityType = this.determineTargetEntityType();
    if (!entityType) return null;

    const focus = this.detectDrillDownFocus(ctx.query, ctx.intent.aspects || []);
    if (focus === 'cpu_frequency') {
      return {
        entityType,
        focus,
        reason: '聚焦 CPU 频率变化与调度时序',
        skills: CPU_FREQ_IN_RANGE_SKILLS,
      };
    }

    if (focus === 'cpu') {
      return {
        entityType,
        focus,
        reason: '聚焦 CPU 负载与调度证据',
        skills: CPU_IN_RANGE_SKILLS,
      };
    }

    return {
      entityType,
      focus: 'default',
      reason: entityType === 'frame'
        ? '聚焦目标帧的卡顿根因'
        : entityType === 'session'
          ? '聚焦目标会话的整体卡顿分布'
          : '聚焦目标启动事件的启动瓶颈',
      skills: [getDrillDownSkillConfig(entityType)],
    };
  }

  /**
   * Resolve drill-down target entity type from follow-up params/interval metadata.
   */
  private determineTargetEntityType(): DrillDownEntityType | null {
    const params = this.followUp.resolvedParams;
    const intervals = this.followUp.focusIntervals || [];

    // Check resolved params for entity type hints (support both snake_case and camelCase)
    if (params.frame_id !== undefined || params.frameId !== undefined) {
      return 'frame';
    }
    if ((params.session_id !== undefined || params.sessionId !== undefined) &&
        params.frame_id === undefined && params.frameId === undefined) {
      return 'session';
    }
    if (
      (params.startup_id !== undefined || params.startupId !== undefined) &&
      params.frame_id === undefined && params.frameId === undefined &&
      params.session_id === undefined && params.sessionId === undefined
    ) {
      return 'startup';
    }

    // Check intervals for entity type metadata
    if (intervals.length > 0) {
      const firstInterval = intervals[0];
      const entityType = firstInterval.metadata?.sourceEntityType;
      if (entityType === 'frame' || entityType === 'session' || entityType === 'startup') {
        return entityType;
      }

      // Infer from metadata
      if (firstInterval.metadata?.frameId !== undefined ||
          firstInterval.metadata?.frame_id !== undefined) {
        return 'frame';
      }
      if (firstInterval.metadata?.sessionId !== undefined ||
          firstInterval.metadata?.session_id !== undefined) {
        return 'session';
      }
      if (firstInterval.metadata?.startupId !== undefined ||
          firstInterval.metadata?.startup_id !== undefined) {
        return 'startup';
      }
    }

    return null;
  }

  /**
   * Detect follow-up focus from query/aspects to avoid repeatedly answering
   * frame-level generic root cause when user asks a CPU/CpuFreq sub-question.
   */
  private detectDrillDownFocus(query: string, aspects: string[]): DrillDownFocus {
    const queryText = String(query || '').toLowerCase();
    const aspectTokens = (aspects || [])
      .flatMap(a => String(a || '').toLowerCase().split(/[\s,;|/:_-]+/))
      .filter(Boolean);

    const cpuAspectHints = new Set([
      'cpu',
      'scheduling',
      'scheduler',
      'sched',
      'runqueue',
      'runnable',
      'thread',
      'threads',
      'big',
      'little',
      'prime',
      'placement',  // from "core_placement" after tokenization by _
    ]);
    const freqAspectHints = new Set([
      'frequency',
      'cpu_frequency',
      'freq',
      'cpufreq',
      'throttle',
      'boost',
      'mhz',
    ]);

    const queryHasCpuSignals = /\bcpu\b|调度|scheduler|sched|runqueue|runnable|线程|大核|小核|核心|\bcore\b/.test(queryText);
    const queryHasFreqSignals = /频率|freq|mhz|降频|升频|throttle|boost/.test(queryText);
    const aspectHasCpuSignals = aspectTokens.some(token => cpuAspectHints.has(token));
    const aspectHasFreqSignals = aspectTokens.some(token => freqAspectHints.has(token));

    if (queryHasFreqSignals || aspectHasFreqSignals) return 'cpu_frequency';
    if (queryHasCpuSignals || aspectHasCpuSignals) return 'cpu';
    return 'default';
  }
}

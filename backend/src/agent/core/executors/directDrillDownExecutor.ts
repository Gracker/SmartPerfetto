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
import { FocusInterval, StageTaskTemplate } from '../../strategies/types';
import { emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback } from '../feedbackSynthesizer';

// =============================================================================
// Skill Mapping
// =============================================================================

interface DrillDownSkillConfig {
  skillId: string;
  domain: string;
  agentId: string;
  paramMapping: Record<string, string>;
  /** SQL query to fetch timestamps when interval needs enrichment */
  enrichmentQuery?: string;
}

/**
 * Maps entity types to their corresponding drill-down skills.
 * Each entry defines how to invoke the skill for that entity type.
 */
const DRILL_DOWN_SKILLS: Record<string, DrillDownSkillConfig> = {
  frame: {
    skillId: 'jank_frame_detail',
    domain: 'frame',
    agentId: 'frame_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
      package: 'processName',
      frame_id: 'frameId',
      jank_type: 'jankType',
      dur_ms: 'durMs',
      main_start_ts: 'mainStartTs',
      main_end_ts: 'mainEndTs',
      render_start_ts: 'renderStartTs',
      render_end_ts: 'renderEndTs',
      pid: 'pid',
      session_id: 'sessionId',
      layer_name: 'layerName',
      token_gap: 'tokenGap',
      vsync_missed: 'vsyncMissed',
      jank_responsibility: 'jankResponsibility',
      frame_index: 'frameIndex',
    },
    enrichmentQuery: `
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
      WHERE af.frame_id = $frame_id
      LIMIT 1
    `,
  },
  session: {
    skillId: 'scrolling_analysis',
    domain: 'frame',
    agentId: 'frame_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
      package: 'processName',
      session_id: 'sessionId',
    },
    enrichmentQuery: `
      SELECT
        session_id,
        MIN(ts) as start_ts,
        MAX(ts + dur) as end_ts,
        process_name
      FROM (
        SELECT
          af.frame_id,
          af.ts,
          af.dur,
          ej.scroll_id as session_id,
          p.name as process_name
        FROM android_frames af
        LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
        LEFT JOIN process p ON af.upid = p.upid
        WHERE ej.scroll_id = $session_id
      )
      GROUP BY session_id
    `,
  },
};

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

    // Determine target skill based on follow-up resolution
    const skillConfig = this.determineTargetSkill();
    if (!skillConfig) {
      emitter.log('[DrillDown] Could not determine target skill, falling back');
      return {
        findings: [],
        lastStrategy: concludeDecision(0.3, 'Could not determine drill-down target'),
        confidence: 0.3,
        informationGaps: ['Unable to map follow-up to specific skill'],
        rounds: 0,
        stopReason: 'No matching drill-down skill',
      };
    }

    const { skillId, domain, agentId, paramMapping } = skillConfig;
    let intervals = this.followUp.focusIntervals || [];

    // Enrich intervals that need timestamps
    intervals = await this.enrichIntervalsIfNeeded(
      intervals,
      skillConfig,
      ctx.options.traceProcessorService,
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

    emitter.log(`[DrillDown] Executing ${skillId} for ${validIntervals.length} interval(s)`);
    emitter.emitUpdate('progress', {
      phase: 'round_start',
      round: 1,
      maxRounds: 1,
      message: `直接执行 ${skillId} (跳过策略流水线)`,
    });

    // Build direct skill tasks
    const template: StageTaskTemplate = {
      agentId,
      domain,
      scope: 'per_interval',
      executionMode: 'direct_skill',
      directSkillId: skillId,
      paramMapping,
      descriptionTemplate: `Drill-down: {{scopeLabel}}`,
    };

    const tasks = validIntervals.map((interval, idx) => ({
      template,
      interval,
      scopeLabel: interval.label || `区间${idx + 1}`,
    }));

    // Execute via DirectSkillExecutor
    const directExecutor = new DirectSkillExecutor(
      ctx.options.traceProcessorService,
      this.services.modelRouter,
      ctx.traceId
    );

    const responses = await directExecutor.executeTasks(tasks, emitter);

    // Emit data envelopes
    emitDataEnvelopes(responses, emitter);

    // Synthesize findings
    const synthesis = await synthesizeFeedback(
      responses,
      ctx.sharedContext,
      this.services.modelRouter,
      emitter,
      this.services.messageBus
    );

    allFindings.push(...synthesis.newFindings);

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
      lastStrategy: concludeDecision(confidence, `Drill-down ${skillId} completed`),
      confidence,
      informationGaps: synthesis.informationGaps,
      rounds: 1,
      stopReason: `Drill-down ${skillId} completed for ${validIntervals.length} interval(s)`,
    };
  }

  /**
   * Enrich intervals that have needsEnrichment flag by querying for timestamps.
   */
  private async enrichIntervalsIfNeeded(
    intervals: FocusInterval[],
    skillConfig: DrillDownSkillConfig,
    traceProcessorService: any,
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

        let query = skillConfig.enrichmentQuery;
        if (entityType === 'frame') {
          query = query.replace('$frame_id', String(entityId));
        } else if (entityType === 'session') {
          query = query.replace('$session_id', String(entityId));
        }

        const result = await traceProcessorService.executeQuery(query);

        if (result && result.rows && result.rows.length > 0) {
          const row = result.rows[0];
          const columns = result.columns || [];

          // Build row object from columns
          const rowObj: Record<string, any> = {};
          columns.forEach((col: string, idx: number) => {
            rowObj[col] = row[idx];
          });

          // Update interval with enriched data
          const enrichedInterval: FocusInterval = {
            ...interval,
            startTs: String(rowObj.start_ts || interval.startTs),
            endTs: String(rowObj.end_ts || interval.endTs),
            processName: rowObj.process_name || interval.processName,
            metadata: {
              ...interval.metadata,
              needsEnrichment: false,
              enriched: true,
              // Add any additional enriched fields
              ...(rowObj.jank_type && { jankType: rowObj.jank_type }),
              ...(rowObj.layer_name && { layerName: rowObj.layer_name }),
              ...(rowObj.vsync_missed && { vsyncMissed: rowObj.vsync_missed }),
              ...(rowObj.dur && { dur: rowObj.dur }),
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

  /**
   * Determine the target skill based on follow-up resolution.
   * Looks at resolvedParams and focusIntervals to infer entity type.
   */
  private determineTargetSkill(): DrillDownSkillConfig | null {
    const params = this.followUp.resolvedParams;
    const intervals = this.followUp.focusIntervals || [];

    // Check resolved params for entity type hints (support both snake_case and camelCase)
    if (params.frame_id !== undefined || params.frameId !== undefined) {
      return DRILL_DOWN_SKILLS.frame;
    }
    if ((params.session_id !== undefined || params.sessionId !== undefined) &&
        params.frame_id === undefined && params.frameId === undefined) {
      return DRILL_DOWN_SKILLS.session;
    }

    // Check intervals for entity type metadata
    if (intervals.length > 0) {
      const firstInterval = intervals[0];
      const entityType = firstInterval.metadata?.sourceEntityType;
      if (entityType && DRILL_DOWN_SKILLS[entityType]) {
        return DRILL_DOWN_SKILLS[entityType];
      }

      // Infer from metadata
      if (firstInterval.metadata?.frameId !== undefined ||
          firstInterval.metadata?.frame_id !== undefined) {
        return DRILL_DOWN_SKILLS.frame;
      }
      if (firstInterval.metadata?.sessionId !== undefined ||
          firstInterval.metadata?.session_id !== undefined) {
        return DRILL_DOWN_SKILLS.session;
      }
    }

    return null;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Extend Executor
 *
 * Handles "extend" follow-up queries that analyze additional entities
 * from the candidate list that weren't analyzed in previous rounds.
 *
 * Use cases:
 * - "继续分析" → analyze next batch of unanalyzed frames
 * - "分析更多帧" → explicit request for more frame analysis
 * - "看看其他卡顿帧" → extend analysis to remaining jank frames
 *
 * Key characteristics:
 * - Gets unanalyzed candidate frames/sessions from EntityStore
 * - Runs drill-down analysis on a batch (configurable size)
 * - Marks analyzed entities to prevent re-analysis
 * - Returns capturedEntities and analyzedEntityIds for orchestrator write-back
 */

import { AnalysisExecutor } from './analysisExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  concludeDecision,
} from '../orchestratorTypes';
import { Finding } from '../../types';
import { DirectSkillExecutor } from './directSkillExecutor';
import {
  captureEntitiesFromResponses,
  mergeCapturedEntities,
  CapturedEntities,
} from '../entityCapture';
import type { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { FrameEntity, SessionEntity, EntityId } from '../../context/entityStore';
import type { FocusInterval, DirectSkillTask, StageTaskTemplate } from '../../strategies/types';
import type { AgentResponse } from '../../types/agentProtocol';
import type { FocusStore, UserFocus } from '../../context/focusStore';

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_SKILL_ID = 'jank_frame_detail';

// =============================================================================
// ExtendExecutor
// =============================================================================

export class ExtendExecutor implements AnalysisExecutor {
  private focusStore?: FocusStore;

  constructor(
    private sessionContext: EnhancedSessionContext,
    private services: AnalysisServices,
    private traceProcessorService?: any,
    private traceId?: string,
    private batchSize: number = DEFAULT_BATCH_SIZE
  ) {}

  /**
   * Set FocusStore for focus-aware prioritization (v2.0)
   */
  setFocusStore(focusStore: FocusStore): void {
    this.focusStore = focusStore;
  }

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    emitter.log('[Extend] Starting extend analysis');
    emitter.emitUpdate('progress', {
      phase: 'extending',
      message: '正在查找未分析的实体...',
    });

    const entityStore = this.sessionContext.getEntityStore();

    // Get unanalyzed candidates
    const unanalyzedFrames = entityStore.getUnanalyzedCandidateFrames();
    const unanalyzedSessions = entityStore.getUnanalyzedCandidateSessions();

    emitter.log(`[Extend] Found ${unanalyzedFrames.length} unanalyzed frames, ${unanalyzedSessions.length} unanalyzed sessions`);

    // Nothing to extend?
    if (unanalyzedFrames.length === 0 && unanalyzedSessions.length === 0) {
      return this.buildNothingToExtendResult();
    }

    // Determine what to extend based on available data and context
    // Priority: frames (more common for jank analysis)
    const entityType: 'frame' | 'session' = unanalyzedFrames.length > 0 ? 'frame' : 'session';
    const unanalyzedIds = entityType === 'frame' ? unanalyzedFrames : unanalyzedSessions;

    // Prioritize based on FocusStore if available (v2.0)
    const prioritizedIds = this.prioritizeByFocus(entityType, unanalyzedIds, emitter);

    // Take a batch from prioritized list
    const batchIds = prioritizedIds.slice(0, this.batchSize);
    emitter.log(`[Extend] Processing batch of ${batchIds.length} ${entityType}s`);

    emitter.emitUpdate('progress', {
      phase: 'extending',
      message: `正在分析 ${batchIds.length} 个${entityType === 'frame' ? '帧' : '会话'}...`,
      batchSize: batchIds.length,
      remainingCount: unanalyzedIds.length - batchIds.length,
    });

    // Build FocusIntervals from cached entities
    const intervals = this.buildIntervalsFromIds(entityType, batchIds);

    if (intervals.length === 0) {
      emitter.log('[Extend] Failed to build intervals from entity IDs');
      return this.buildResolutionFailedResult(batchIds.length);
    }

    const experimentId = ctx.sessionContext?.startTraceAgentExperiment({
      type: 'run_skill',
      objective: `[extend] entityType=${entityType} batch=${batchIds.length}`,
    });

    // Run analysis on the batch
    const { findings, responses } = await this.runBatchAnalysis(
      entityType,
      intervals,
      emitter
    );

    // v2.0: Ingest tool outputs as durable evidence digests (goal-driven agent scaffold).
    const producedEvidenceIds =
      ctx.sessionContext?.ingestEvidenceFromResponses(responses, { stageName: 'extend', round: 1 }) || [];
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

    // Capture entities from responses
    const capturedEntities = captureEntitiesFromResponses(responses);

    // Build analyzed entity IDs
    const analyzedEntityIds = entityType === 'frame'
      ? { frames: batchIds }
      : { sessions: batchIds };

    // Generate summary
    const summary = this.generateExtendSummary(entityType, batchIds.length, unanalyzedIds.length - batchIds.length);

    // Add summary finding
    findings.push({
      id: `extend_summary_${Date.now()}`,
      category: 'extension',
      type: 'extend_summary',
      severity: 'info',
      title: '扩展分析完成',
      description: summary,
      source: 'extend_executor',
      confidence: 0.85,
      details: {
        entityType,
        analyzedCount: batchIds.length,
        remainingCount: unanalyzedIds.length - batchIds.length,
      },
    });

    emitter.emitUpdate('finding', {
      round: 1,
      findings,
    });

    emitter.emitUpdate('progress', {
      phase: 'synthesis_complete',
      confirmedFindings: findings.length,
      updatedHypotheses: 0,
      message: summary,
    });

    emitter.log('[Extend] Extend analysis complete');

    return {
      findings,
      lastStrategy: concludeDecision(0.85, 'Extend analysis complete'),
      confidence: 0.85,
      informationGaps: unanalyzedIds.length > batchIds.length
        ? [`还有 ${unanalyzedIds.length - batchIds.length} 个${entityType === 'frame' ? '帧' : '会话'}未分析`]
        : [],
      rounds: 1,
      stopReason: 'Extend complete',
      capturedEntities,
      analyzedEntityIds,
    };
  }

  // ===========================================================================
  // Focus-Aware Prioritization (v2.0)
  // ===========================================================================

  /**
   * Prioritize entities based on user focus from FocusStore.
   *
   * This enables the system to analyze entities that the user has shown
   * interest in (via clicks, questions, etc.) before other candidates.
   */
  private prioritizeByFocus(
    entityType: 'frame' | 'session',
    ids: EntityId[],
    emitter: ProgressEmitter
  ): EntityId[] {
    if (!this.focusStore || ids.length === 0) {
      return ids;
    }

    const entityStore = this.sessionContext.getEntityStore();
    const topFocuses = this.focusStore.getTopFocuses(5);

    if (topFocuses.length === 0) {
      emitter.log('[Extend] No user focus - using default order');
      return ids;
    }

    // Score each entity based on relevance to user focus
    const scored = ids.map(id => {
      let score = 0;
      const entity = entityType === 'frame'
        ? entityStore.getFrame(id)
        : entityStore.getSession(id);

      if (!entity) return { id, score };

      for (const focus of topFocuses) {
        // Match by entity type and ID
        if (focus.type === 'entity') {
          if (focus.target.entityType === entityType && focus.target.entityId === id) {
            score += focus.weight * 10; // Direct match
          }
        }

        // Match by time range overlap
        if (focus.type === 'timeRange' && focus.target.timeRange && entity.start_ts && entity.end_ts) {
          const focusStart = BigInt(focus.target.timeRange.start);
          const focusEnd = BigInt(focus.target.timeRange.end);
          const entityStart = BigInt(entity.start_ts);
          const entityEnd = BigInt(entity.end_ts);

          // Check for overlap
          if (entityStart <= focusEnd && entityEnd >= focusStart) {
            score += focus.weight * 5; // Time overlap
          }
        }

        // Match by session for frames
        if (entityType === 'frame' && focus.target.entityType === 'session') {
          const frame = entity as FrameEntity;
          if (frame.session_id === focus.target.entityId) {
            score += focus.weight * 3; // Same session
          }
        }
      }

      return { id, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const prioritizedIds = scored.map(s => s.id);

    // Log prioritization if any reordering happened
    const topScores = scored.slice(0, 3).filter(s => s.score > 0);
    if (topScores.length > 0) {
      emitter.log(`[Extend] Focus-aware prioritization: top ${topScores.length} entities scored ${topScores.map(s => s.score.toFixed(2)).join(', ')}`);
    }

    return prioritizedIds;
  }

  // ===========================================================================
  // Interval Building
  // ===========================================================================

  private buildIntervalsFromIds(
    entityType: 'frame' | 'session',
    ids: EntityId[]
  ): FocusInterval[] {
    const entityStore = this.sessionContext.getEntityStore();
    const intervals: FocusInterval[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];

      if (entityType === 'frame') {
        const frame = entityStore.getFrame(id);
        if (frame && frame.start_ts && frame.end_ts) {
          intervals.push(this.buildIntervalFromFrame(frame, i));
        }
      } else {
        const session = entityStore.getSession(id);
        if (session && session.start_ts && session.end_ts) {
          intervals.push(this.buildIntervalFromSession(session, i));
        }
      }
    }

    return intervals;
  }

  private buildIntervalFromFrame(frame: FrameEntity, index: number): FocusInterval {
    return {
      id: index,
      processName: frame.process_name || '',
      startTs: frame.start_ts || '0',
      endTs: frame.end_ts || '0',
      priority: 1,
      label: `帧 ${frame.frame_id}`,
      metadata: {
        sourceEntityType: 'frame',
        sourceEntityId: frame.frame_id,
        frameId: frame.frame_id,
        frame_id: frame.frame_id,
        sessionId: frame.session_id,
        session_id: frame.session_id,
        jankType: frame.jank_type,
        jank_type: frame.jank_type,
        durMs: frame.dur_ms,
        dur_ms: frame.dur_ms,
        mainStartTs: frame.main_start_ts,
        main_start_ts: frame.main_start_ts,
        mainEndTs: frame.main_end_ts,
        main_end_ts: frame.main_end_ts,
        renderStartTs: frame.render_start_ts,
        render_start_ts: frame.render_start_ts,
        renderEndTs: frame.render_end_ts,
        render_end_ts: frame.render_end_ts,
        pid: frame.pid,
        layerName: frame.layer_name,
        layer_name: frame.layer_name,
        vsyncMissed: frame.vsync_missed,
        vsync_missed: frame.vsync_missed,
      },
    };
  }

  private buildIntervalFromSession(session: SessionEntity, index: number): FocusInterval {
    return {
      id: index,
      processName: session.process_name || '',
      startTs: session.start_ts || '0',
      endTs: session.end_ts || '0',
      priority: 1,
      label: `会话 ${session.session_id}`,
      metadata: {
        sourceEntityType: 'session',
        sourceEntityId: session.session_id,
        sessionId: session.session_id,
        session_id: session.session_id,
        frameCount: session.frame_count,
        frame_count: session.frame_count,
        jankCount: session.jank_count,
        jank_count: session.jank_count,
        maxVsyncMissed: session.max_vsync_missed,
        max_vsync_missed: session.max_vsync_missed,
        jankTypes: session.jank_types,
        jank_types: session.jank_types,
      },
    };
  }

  // ===========================================================================
  // Batch Analysis
  // ===========================================================================

  private async runBatchAnalysis(
    entityType: 'frame' | 'session',
    intervals: FocusInterval[],
    emitter: ProgressEmitter
  ): Promise<{ findings: Finding[]; responses: AgentResponse[] }> {
    if (!this.traceProcessorService || !this.traceId) {
      emitter.log('[Extend] No trace processor service - generating summary only');
      return { findings: [], responses: [] };
    }

    // Build DirectSkillTasks for each interval
    const skillId = entityType === 'frame' ? 'jank_frame_detail' : 'scroll_session_analysis';
    const template: StageTaskTemplate = {
      agentId: 'frame_agent',
      domain: entityType,
      executionMode: 'direct_skill',
      scope: 'per_interval',
      directSkillId: skillId,
      descriptionTemplate: `分析{{scopeLabel}}的详细信息`,
      skillParams: {},
      paramMapping: entityType === 'frame'
        ? {
            frame_id: 'frameId',
            start_ts: 'startTs',
            end_ts: 'endTs',
            process_name: 'processName',
            session_id: 'sessionId',
            jank_type: 'jankType',
          }
        : {
            session_id: 'sessionId',
            start_ts: 'startTs',
            end_ts: 'endTs',
            // scroll_session_analysis scopes its frames by the package input.
            package: 'processName',
          },
    };

    const tasks: DirectSkillTask[] = intervals.map((interval, index) => ({
      interval,
      template,
      scopeLabel: interval.label || `${entityType} ${index}`,
    }));

    // Execute via DirectSkillExecutor
    const directExecutor = new DirectSkillExecutor(
      this.traceProcessorService,
      this.services.modelRouter,
      this.traceId,
      Math.min(this.batchSize, 6) // Concurrency limit
    );

    try {
      const responses = await directExecutor.executeTasks(tasks, emitter);

      // Collect findings from responses
      const findings: Finding[] = [];
      for (const response of responses) {
        if (response.findings && response.findings.length > 0) {
          findings.push(...response.findings);
        }
      }

      return { findings, responses };
    } catch (error: any) {
      emitter.log(`[Extend] Batch analysis failed: ${error.message}`);
      return { findings: [], responses: [] };
    }
  }

  // ===========================================================================
  // Summary Generation
  // ===========================================================================

  private generateExtendSummary(
    entityType: 'frame' | 'session',
    analyzedCount: number,
    remainingCount: number
  ): string {
    const entityName = entityType === 'frame' ? '帧' : '会话';
    const parts: string[] = [];

    parts.push(`本次扩展分析了 ${analyzedCount} 个${entityName}。`);

    if (remainingCount > 0) {
      parts.push(`还有 ${remainingCount} 个${entityName}未分析。`);
      parts.push('您可以继续说"继续分析"来分析更多。');
    } else {
      parts.push('所有候选实体已分析完毕。');
    }

    return parts.join('');
  }

  // ===========================================================================
  // Error Results
  // ===========================================================================

  private buildNothingToExtendResult(): ExecutorResult {
    return {
      findings: [{
        id: `extend_info_${Date.now()}`,
        category: 'info',
        type: 'extend_complete',
        severity: 'info',
        title: '无更多实体可分析',
        description: '当前已分析所有候选帧和会话，无需扩展分析。如需分析其他内容，请提出新的问题。',
        source: 'extend_executor',
        confidence: 1.0,
      }],
      lastStrategy: concludeDecision(0.9, 'Nothing to extend'),
      confidence: 0.9,
      informationGaps: [],
      rounds: 1,
      stopReason: 'Nothing to extend',
    };
  }

  private buildResolutionFailedResult(requestedCount: number): ExecutorResult {
    return {
      findings: [{
        id: `extend_error_${Date.now()}`,
        category: 'error',
        type: 'extend_error',
        severity: 'warning',
        title: '实体解析失败',
        description: `无法从缓存中解析 ${requestedCount} 个实体的时间范围。这些实体可能缺少时间戳信息。`,
        source: 'extend_executor',
        confidence: 1.0,
      }],
      lastStrategy: concludeDecision(0.3, 'Entity resolution failed'),
      confidence: 0.3,
      informationGaps: ['实体缓存缺少必要的时间戳信息'],
      rounds: 1,
      stopReason: 'Entity resolution failed',
    };
  }
}
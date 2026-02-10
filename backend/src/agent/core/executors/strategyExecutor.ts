/**
 * Strategy Executor
 *
 * Executes a matched StagedAnalysisStrategy as a deterministic multi-stage pipeline.
 * Owns the stage loop, builds tasks from templates, runs them, extracts intervals,
 * and checks early-stop conditions.
 *
 * Includes:
 * - Phase 2: Error boundaries around extractIntervals/shouldStop with degradation
 * - Phase 3: stage_transition SSE events and skillParams type validation
 */

import { Finding } from '../../types';
import {
  AgentTask,
  AgentResponse,
  createTaskId,
  TraceConfig,
} from '../../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  StageTaskTemplate,
  StrategyExecutionState,
  FocusInterval,
  DirectSkillTask,
  intervalHelpers,
} from '../../strategies';
import { AnalysisExecutor } from './analysisExecutor';
import { DirectSkillExecutor } from './directSkillExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  concludeDecision,
} from '../orchestratorTypes';
import { executeTaskGraph, emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback } from '../feedbackSynthesizer';
import type { DataEnvelope } from '../../../types/dataContract';
import {
  captureEntitiesFromResponses,
  captureEntitiesFromIntervals,
  mergeCapturedEntities,
  CapturedEntities,
} from '../entityCapture';
import { detectTraceConfig } from './traceConfigDetector';
import { summarizeJankCauses } from '../jankCauseSummarizer';
import type { FrameMechanismRecord } from '../../types/jankCause';

export class StrategyExecutor implements AnalysisExecutor {
  constructor(
    private strategy: StagedAnalysisStrategy,
    private services: AnalysisServices
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const allFindings: Finding[] = [];
    let stagedConfidence = 0.5;
    // Seed with cross-turn contradictions so deterministic strategies can still surface them.
    let informationGaps: string[] = (() => {
      const cx = ctx.sessionContext?.getTraceAgentState()?.contradictions;
      if (!Array.isArray(cx) || cx.length === 0) return [];
      return cx
        .slice(-3)
        .map(c => `矛盾: ${String((c as any)?.description || '').trim()}`)
        .filter(s => s !== '矛盾:');
    })();
    let stopReason: string | null = null;
    let rounds = 0;
    const hardMaxRounds = Math.max(1, ctx.config.maxRounds);
    const accumulatedFrameMechanismRecords = this.dedupeFrameMechanismRecords(
      ctx.sharedContext.frameMechanismRecords || []
    );

    // Accumulate captured entities across all stages
    const allCapturedEntities: CapturedEntities[] = [];
    const analyzedFrameIds: string[] = [];
    const analyzedSessionIds: string[] = [];

    // Phase 1 Fix: Use prebuilt intervals from follow-up resolution if available.
    // v2.0: Fall back to incrementalScope-derived focusIntervals for incremental turns.
    // This allows multi-turn follow-ups to skip redundant discovery stages.
    const prebuiltIntervals = this.getPrebuiltIntervals(ctx);
    const hasPrebuiltContext = prebuiltIntervals.length > 0;

    if (hasPrebuiltContext) {
      const source = (ctx.options.prebuiltIntervals && ctx.options.prebuiltIntervals.length > 0)
        ? 'follow-up'
        : 'incremental';
      emitter.log(`[FollowUp] Using ${prebuiltIntervals.length} pre-built interval(s) (${source})`);
    }

    // Infer prebuilt granularity for smarter stage skipping.
    // Example: drill-down to a specific frame should skip "session_overview".
    const prebuiltEntityType: 'frame' | 'session' | 'unknown' = (() => {
      if (!hasPrebuiltContext) return 'unknown';
      const meta = prebuiltIntervals[0]?.metadata || {};
      if (meta.sourceEntityType === 'frame' || meta.frame_id || meta.frameId) return 'frame';
      if (meta.sourceEntityType === 'session' || meta.session_id || meta.sessionId) return 'session';
      return 'unknown';
    })();

    const state: StrategyExecutionState = {
      strategyId: this.strategy.id,
      currentStageIndex: 0,
      focusIntervals: prebuiltIntervals,
      confidence: hasPrebuiltContext ? 0.7 : 0.5, // Higher starting confidence for drill-down
    };

    // Deferred L2 frame tables that will be emitted after L4 per-frame analysis
    // so that expandableData is already assembled when the table first renders in the UI.
    const deferredExpandableTables: DataEnvelope[] = [];

    // Determine which stages will actually run (for accurate progress reporting)
    const stagesToRun = this.strategy.stages.filter(stage => {
      if (!hasPrebuiltContext) return true;
      if (prebuiltEntityType === 'frame' && stage.name === 'session_overview') return false;
      const isDiscoveryStage = !!stage.extractIntervals;
      const allTasksGlobal = stage.tasks.every(t => t.scope === 'global');
      return !(isDiscoveryStage && allTasksGlobal);
    });
    const effectiveTotalStages = stagesToRun.length;

    emitter.log(`Executing strategy: ${this.strategy.name} (${effectiveTotalStages}/${this.strategy.stages.length} stages${hasPrebuiltContext ? ', follow-up mode' : ''})`);

    // =========================================================================
    // Pre-Stage: Detect trace configuration (VSync period, refresh rate)
    // =========================================================================
    // This runs once at the start to populate sharedContext.traceConfig,
    // which is used for accurate jank threshold calculation and contradiction resolution.
    if (!ctx.sharedContext.traceConfig) {
      try {
        const traceConfig = await detectTraceConfig(
          ctx.options.traceProcessorService,
          this.services.modelRouter,
          ctx.traceId,
          emitter
        );
        ctx.sharedContext.traceConfig = traceConfig;

        // Also add to globalMetrics for backward compatibility
        ctx.sharedContext.globalMetrics = ctx.sharedContext.globalMetrics || {};
        ctx.sharedContext.globalMetrics.refreshRateHz = traceConfig.refreshRateHz;
        ctx.sharedContext.globalMetrics.vsyncPeriodMs = traceConfig.vsyncPeriodMs;
        ctx.sharedContext.globalMetrics.isVRR = traceConfig.isVRR;
      } catch (error: any) {
        emitter.log(`[TraceConfig] Detection failed, using defaults: ${error.message}`);
      }
    }

    for (let i = 0; i < this.strategy.stages.length; i++) {
      const stage = this.strategy.stages[i];
      state.currentStageIndex = i;

      // =========================================================================
      // Follow-Up Optimization: Skip discovery stages when we have prebuilt context
      // =========================================================================
      // Discovery stages (with extractIntervals) produce focus intervals.
      // If we already have prebuilt intervals from follow-up resolution,
      // these stages would just regenerate what we already have.
      const isDiscoveryStage = !!stage.extractIntervals;
      const allTasksGlobal = stage.tasks.every(t => t.scope === 'global');

      if (hasPrebuiltContext && isDiscoveryStage && allTasksGlobal) {
        emitter.log(`[FollowUp] Skipping discovery stage "${stage.name}" - already have ${state.focusIntervals.length} pre-built interval(s)`);
        emitter.emitUpdate('stage_transition', {
          stageIndex: i,
          totalStages: this.strategy.stages.length,
          stageName: stage.name,
          intervalCount: state.focusIntervals.length,
          skipped: true,
          skipReason: 'Using pre-built intervals from follow-up',
        });
        continue;
      }

      // If prebuilt intervals are already frame-level, skip session-level extraction stages.
      if (hasPrebuiltContext && prebuiltEntityType === 'frame' && stage.name === 'session_overview') {
        emitter.log(`[FollowUp] Skipping stage "${stage.name}" - prebuilt intervals are already frame-level`);
        emitter.emitUpdate('stage_transition', {
          stageIndex: i,
          totalStages: this.strategy.stages.length,
          stageName: stage.name,
          intervalCount: state.focusIntervals.length,
          skipped: true,
          skipReason: 'Pre-built frame intervals (skip session overview)',
        });
        continue;
      }

      // Hard safety cap: prevent unusually long strategies from running too many stages.
      // (softMaxRounds is a preference used by adaptive loops; deterministic strategies should be stage-driven.)
      if (rounds >= hardMaxRounds) {
        stopReason = `Reached hard stage budget (${hardMaxRounds})`;
        emitter.log(`[Budget] ${stopReason}; stopping before stage "${stage.name}"`);
        emitter.emitUpdate('progress', {
          phase: 'early_stop',
          reason: stopReason,
          message: `提前终止: ${stopReason}`,
        });
        break;
      }

      rounds++;

      // Phase 3: Emit stage_transition event
      emitter.emitUpdate('stage_transition', {
        stageIndex: i,
        totalStages: this.strategy.stages.length,
        stageName: stage.name,
        intervalCount: state.focusIntervals.length,
      });

      // 1. Emit progress with template interpolation
      // Use rounds (actual executed stage count) for consistent numbering
      const progressMessage = stage.progressMessageTemplate
        .replace('{{stageIndex}}', String(rounds))
        .replace('{{totalStages}}', String(effectiveTotalStages));

      emitter.emitUpdate('progress', {
        phase: 'round_start',
        round: rounds,
        maxRounds: effectiveTotalStages,
        message: progressMessage,
      });

      // 2. Build tasks from stage templates (split by execution mode)
      const { agentTasks, directSkillTasks } = this.buildStageTasksSplit(
        stage, state.focusIntervals, ctx, emitter
      );

      if (agentTasks.length === 0 && directSkillTasks.length === 0) {
        stopReason = `No tasks generated for strategy stage: ${stage.name}`;
        break;
      }

      const stageExperimentId = ctx.sessionContext?.startTraceAgentExperiment({
        type: 'run_skill',
        objective: `[strategy:${this.strategy.id}] stage=${stage.name} intervals=${state.focusIntervals.length} agentTasks=${agentTasks.length} directSkillTasks=${directSkillTasks.length}`,
      });

      if (agentTasks.length > 0) {
        emitter.emitUpdate('progress', {
          phase: 'tasks_dispatched',
          taskCount: agentTasks.length,
          agents: agentTasks.map(t => t.targetAgentId),
          message: `派发 ${agentTasks.length} 个 Agent 任务`,
        });
      }

      // 3. Execute both agent tasks and direct skill tasks in parallel
      const [agentResponses, directResponses] = await Promise.all([
        agentTasks.length > 0
          ? executeTaskGraph(agentTasks, this.services.messageBus, emitter, this.services.circuitBreaker)
          : Promise.resolve([]),
        directSkillTasks.length > 0
          ? this.executeDirectSkillTasks(directSkillTasks, ctx, emitter)
          : Promise.resolve([]),
      ]);
      const responses = [...agentResponses, ...directResponses];

      if (stage.name === 'frame_analysis') {
        const stageMechanismRecords = this.collectFrameMechanismRecords(responses);
        if (stageMechanismRecords.length > 0) {
          accumulatedFrameMechanismRecords.push(...stageMechanismRecords);
          const uniqueRecords = this.dedupeFrameMechanismRecords(accumulatedFrameMechanismRecords);
          accumulatedFrameMechanismRecords.length = 0;
          accumulatedFrameMechanismRecords.push(...uniqueRecords);
          ctx.sharedContext.frameMechanismRecords = [...uniqueRecords];
          emitter.log(
            `[FrameMechanism] Captured ${stageMechanismRecords.length} record(s) in stage, ` +
            `${uniqueRecords.length} unique total`
          );
        }
      }

      // Capture entities from responses for EntityStore
      const capturedFromResponses = captureEntitiesFromResponses(responses);
      allCapturedEntities.push(capturedFromResponses);

      // Track analyzed entities from per_interval stages (for extend support)
      if (directSkillTasks.length > 0) {
        for (const task of directSkillTasks) {
          const meta = task.interval.metadata || {};
          const frameId = meta.frameId || meta.frame_id || meta.sourceEntityId;
          const sessionId = meta.sessionId || meta.session_id;
          if (meta.sourceEntityType === 'frame' && frameId) {
            analyzedFrameIds.push(String(frameId));
          } else if (meta.sourceEntityType === 'session' && sessionId) {
            analyzedSessionIds.push(String(sessionId));
          }
        }
      }

      // Defer frame tables that need expandableData until after per-frame analysis completes.
      // This avoids rendering a non-expandable table first (which cannot be "patched" later due to frontend dedupe).
      const { responsesForEmit, deferred } = this.deferExpandableFrameTables(stage, responses);
      deferredExpandableTables.push(...deferred);

      // If this stage is a per-frame direct-skill stage, assemble expandableData into deferred tables and emit them.
      // We intentionally suppress emitting per-frame direct skill envelopes as standalone tables (noise).
      const registry = this.services.emittedEnvelopeRegistry;

      if (stage.name === 'frame_analysis' && deferredExpandableTables.length > 0 && directSkillTasks.length > 0) {
        let merged = this.attachExpandableDataToDeferredTables(
          deferredExpandableTables,
          directSkillTasks,
          directResponses
        );
        // Filter duplicates via registry
        if (registry && merged.length > 0) {
          merged = registry.filterNewEnvelopes(merged);
        }
        if (merged.length > 0) {
          emitter.log(`Emitting ${merged.length} merged expandable table(s)`);
          emitter.emitUpdate('data', merged);
        }
        // Clear so we don't re-emit if a future stage exists.
        deferredExpandableTables.length = 0;
        // Still emit any agent envelopes from this stage (rare; typically none).
        if (agentResponses.length > 0) {
          emitDataEnvelopes(agentResponses, emitter, registry);
        }
      } else {
        emitDataEnvelopes(responsesForEmit, emitter, registry);
      }

      // v2.0: Ingest tool outputs as durable evidence digests (goal-driven agent scaffold).
      // Evidence digests are durable and bounded, but frame_analysis can generate
      // a large amount of per-frame tool outputs; prefer a derived summary when large.
      let stageProducedEvidenceIds: string[] = [];
      if (stage.name === 'frame_analysis' && responses.length > 10) {
        emitter.log(`[Evidence] Skip per-response evidence ingestion for frame_analysis (${responses.length} responses); rely on derived summaries`);
      } else {
        stageProducedEvidenceIds =
          ctx.sessionContext?.ingestEvidenceFromResponses(responses, { stageName: stage.name, round: rounds }) || [];
      }

      const synthesis = await synthesizeFeedback(
        responses,
        ctx.sharedContext,
        this.services.modelRouter,
        emitter,
        this.services.messageBus,
        ctx.sessionContext
      );
      const agentCount = agentResponses.length;
      const directCount = directResponses.length;
      const synthesisMessage = this.buildSynthesisMessage(agentCount, directCount);
      emitter.emitUpdate('progress', {
        phase: 'synthesis_complete',
        confirmedFindings: synthesis.confirmedFindings.length,
        updatedHypotheses: synthesis.updatedHypotheses.length,
        message: synthesisMessage,
      });

      informationGaps = synthesis.informationGaps;
      allFindings.push(...synthesis.newFindings);

      if (synthesis.newFindings.length > 0) {
        emitter.emitUpdate('finding', {
          round: rounds,
          findings: synthesis.newFindings,
        });
      }

      // After frame_analysis stage, compute jank cause summary for conclusion generation
      // Preferred source is frame mechanism records; findings remain fallback.
      const frameMechanismRecords = ctx.sharedContext.frameMechanismRecords || [];
      if (stage.name === 'frame_analysis' && (allFindings.length > 0 || frameMechanismRecords.length > 0)) {
        try {
          const jankSummary = summarizeJankCauses(allFindings, frameMechanismRecords);
          if (jankSummary.totalJankFrames > 0) {
            ctx.sharedContext.jankCauseSummary = jankSummary;
            emitter.log(
              `[JankSummary] Aggregated ${jankSummary.totalJankFrames} frames: ` +
              `primary=${jankSummary.primaryCause?.label} (${jankSummary.primaryCause?.percentage}%), ` +
              `secondary=${jankSummary.secondaryCauses.length} causes`
            );

            // Also record a compact derived evidence digest for citations.
            const summaryEvidenceId = ctx.sessionContext?.addEvidenceDigest({
              kind: 'derived',
              title: `[strategy] frame_analysis · jank cause summary`,
              digest: `frames=${jankSummary.totalJankFrames} primary=${jankSummary.primaryCause?.label || 'unknown'}(${jankSummary.primaryCause?.percentage || 0}%) secondary=${jankSummary.secondaryCauses.length}`,
              source: {
                stage: stage.name,
                strategyId: this.strategy.id,
              },
            });
            if (summaryEvidenceId) {
              stageProducedEvidenceIds.push(summaryEvidenceId);
            }
          }
        } catch (error: any) {
          emitter.log(`[JankSummary] Failed to compute jank cause summary: ${error.message}`);
        }
      }

      if (stageExperimentId) {
        const ok = responses.some(r => r.success);
        const firstErr = (() => {
          const failed = responses.find(r => !r.success);
          const err = failed?.toolResults?.find(tr => !tr.success)?.error;
          return typeof err === 'string' ? err.slice(0, 200) : undefined;
        })();
        ctx.sessionContext?.completeTraceAgentExperiment({
          id: stageExperimentId,
          status: ok ? 'succeeded' : 'failed',
          producedEvidenceIds: stageProducedEvidenceIds,
          error: ok ? undefined : firstErr,
        });
      }

      // Update confidence from successful responses
      const confidences = responses
        .filter(r => r.success)
        .map(r => r.confidence)
        .filter(c => typeof c === 'number');
      if (confidences.length > 0) {
        const avg = confidences.reduce((s, c) => s + c, 0) / confidences.length;
        stagedConfidence = Math.max(stagedConfidence, avg);
      }
      state.confidence = stagedConfidence;

      // 4. Phase 2: Extract focus intervals with error boundary
      if (stage.extractIntervals) {
        try {
          state.focusIntervals = stage.extractIntervals(responses, intervalHelpers);

          if (state.focusIntervals.length > 0) {
            ctx.sharedContext.focusedTimeRange = {
              start: state.focusIntervals[0].startTs,
              end: state.focusIntervals[0].endTs,
            };
            emitter.emitUpdate('progress', {
              phase: 'progress',
              message: `已定位 ${state.focusIntervals.length} 个分析区间`,
            });

            // Capture entities from extracted intervals (richer metadata)
            const capturedFromIntervals = captureEntitiesFromIntervals(state.focusIntervals);
            allCapturedEntities.push(capturedFromIntervals);
          }
        } catch (error: any) {
          emitter.log(`extractIntervals failed: ${error.message}, continuing with empty intervals`);
          emitter.emitUpdate('degraded', {
            module: 'strategyExecutor.extractIntervals',
            fallback: 'empty intervals, subsequent per_interval stages will be skipped',
            error: error.message,
          });
          state.focusIntervals = [];
        }
      }

      // 5. Phase 2: Check early stop with error boundary
      if (stage.shouldStop) {
        try {
          const stopResult = stage.shouldStop(state.focusIntervals);
          if (stopResult.stop) {
            stopReason = stopResult.reason;
            break;
          }
        } catch (error: any) {
          emitter.log(`shouldStop failed: ${error.message}, continuing`);
          emitter.emitUpdate('degraded', {
            module: 'strategyExecutor.shouldStop',
            fallback: 'continuing to next stage',
            error: error.message,
          });
        }
      }
    }

    // If all stages completed without early stop
    if (!stopReason) {
      stopReason = `Strategy ${this.strategy.name} completed`;
    }

    // If we deferred expandable tables but never reached the stage that binds L4 results,
    // emit them as-is so the user still sees the frame list.
    if (deferredExpandableTables.length > 0) {
      const finalRegistry = this.services.emittedEnvelopeRegistry;
      let tablesToEmit = deferredExpandableTables;
      if (finalRegistry) {
        tablesToEmit = finalRegistry.filterNewEnvelopes(deferredExpandableTables);
      }
      if (tablesToEmit.length > 0) {
        emitter.log(`Emitting ${tablesToEmit.length} deferred table(s) without expandableData (no bind stage reached)`);
        emitter.emitUpdate('data', tablesToEmit);
      }
    }

    // Merge all captured entities from all stages
    const mergedCapturedEntities = allCapturedEntities.length > 0
      ? mergeCapturedEntities(...allCapturedEntities)
      : undefined;

    return {
      findings: allFindings,
      lastStrategy: concludeDecision(stagedConfidence, stopReason),
      confidence: stagedConfidence,
      informationGaps,
      rounds,
      stopReason,
      capturedEntities: mergedCapturedEntities,
      analyzedEntityIds: {
        frames: [...new Set(analyzedFrameIds)],
        sessions: [...new Set(analyzedSessionIds)],
      },
    };
  }

  private deferExpandableFrameTables(
    stage: StageDefinition,
    responses: AgentResponse[]
  ): { responsesForEmit: AgentResponse[]; deferred: DataEnvelope[] } {
    // Only defer in the stage that produces the frame list (Stage 1 in scrolling strategy).
    // Keep it strategy-agnostic by checking for the known stepId and list layer.
    if (stage.name !== 'session_overview') {
      return { responsesForEmit: responses, deferred: [] };
    }

    const deferred: DataEnvelope[] = [];

    const responsesForEmit = responses.map((response) => {
      if (!response.toolResults || response.toolResults.length === 0) return response;

      const toolResults = response.toolResults.map((tr) => {
        const envelopes = tr.dataEnvelopes || [];
        if (envelopes.length === 0) return tr;

        const kept: DataEnvelope[] = [];
        for (const env of envelopes) {
          const stepId = env.meta?.stepId;
          const layer = env.display?.layer;
          const format = env.display?.format;

          // get_app_jank_frames is the L2 frame list table that should be expandable.
          // We defer it until per-frame analysis results are available.
          if (stepId === 'get_app_jank_frames' && layer === 'list' && (format === 'table' || !format)) {
            deferred.push(env);
            continue;
          }
          kept.push(env);
        }

        return {
          ...tr,
          dataEnvelopes: kept.length > 0 ? kept : undefined,
        };
      });

      return {
        ...response,
        toolResults,
      };
    });

    return { responsesForEmit, deferred };
  }

  private attachExpandableDataToDeferredTables(
    tables: DataEnvelope[],
    tasks: DirectSkillTask[],
    responses: AgentResponse[]
  ): DataEnvelope[] {
    if (tables.length === 0 || tasks.length === 0 || responses.length === 0) return [];

    // Build per-table lookup: (sessionId, frameId) -> rowIndex
    const tableInfos = tables.map((env) => {
      const payload = env.data as any;
      const columns: string[] = Array.isArray(payload?.columns) ? payload.columns : [];
      const rows: any[][] = Array.isArray(payload?.rows) ? payload.rows : [];

      const colIndex = new Map<string, number>();
      columns.forEach((c, idx) => colIndex.set(c, idx));

      const frameIdIdx = colIndex.get('frame_id');
      const sessionIdIdx = colIndex.get('session_id');
      const startTsIdx = colIndex.get('start_ts');

      const items: Array<Record<string, any>> = rows.map((row) => {
        const obj: Record<string, any> = {};
        columns.forEach((c, idx) => {
          obj[c] = row[idx];
        });
        return obj;
      });

      const keyToRowIndex = new Map<string, number>();
      for (let i = 0; i < items.length; i++) {
        const frameId = frameIdIdx !== undefined ? items[i][columns[frameIdIdx]] : items[i].frame_id;
        const sessionId = sessionIdIdx !== undefined ? items[i][columns[sessionIdIdx]] : items[i].session_id;
        const startTs = startTsIdx !== undefined ? items[i][columns[startTsIdx]] : items[i].start_ts;

        // Prefer strongest key (session+frame), but also store fallbacks to be robust
        // when some tables omit session_id.
        if (sessionId !== undefined && frameId !== undefined) {
          keyToRowIndex.set(`sf:${String(sessionId)}:${String(frameId)}`, i);
        }
        if (frameId !== undefined) {
          keyToRowIndex.set(`f:${String(frameId)}`, i);
        }
        if (startTs !== undefined) {
          keyToRowIndex.set(`ts:${String(startTs)}`, i);
        }
      }

      return {
        env,
        columns,
        rows,
        items,
        keyToRowIndex,
      };
    });

    // Merge all tables into one lookup to route frame results.
    const globalKeyToTable = new Map<string, { tableIdx: number; rowIdx: number }>();
    tableInfos.forEach((ti, tableIdx) => {
      for (const [key, rowIdx] of ti.keyToRowIndex.entries()) {
        if (!globalKeyToTable.has(key)) {
          globalKeyToTable.set(key, { tableIdx, rowIdx });
        }
      }
    });

    // Initialize expandableData arrays per table (fully populated so type contract stays simple).
    const perTableExpandable: Array<any[]> = tableInfos.map((ti) =>
      ti.items.map((item) => ({
        item,
        result: {
          success: false,
          sections: {},
          error: 'No frame analysis result bound',
        },
      }))
    );

    // Bind each per-frame response into the corresponding row.
    const count = Math.min(tasks.length, responses.length);
    for (let i = 0; i < count; i++) {
      const interval = tasks[i].interval;
      const sessionId = interval.metadata?.sessionId ?? interval.metadata?.session_id;
      const frameId = interval.metadata?.frameId ?? interval.metadata?.frame_id ?? interval.id;
      const startTs = interval.startTs;

      const candidateKeys = [
        (sessionId !== undefined && frameId !== undefined) ? `sf:${String(sessionId)}:${String(frameId)}` : '',
        (frameId !== undefined) ? `f:${String(frameId)}` : '',
        startTs ? `ts:${String(startTs)}` : '',
      ].filter(Boolean);
      if (candidateKeys.length === 0) continue;

      const location = candidateKeys
        .map((k) => globalKeyToTable.get(k))
        .find((v) => v !== undefined);
      if (!location) continue;

      const resp = responses[i];
      const toolResult = resp.toolResults?.[0];
      const rawResults = (toolResult?.data || {}) as Record<string, any>;

      const sections = this.rawResultsToSections(rawResults, resp.findings || toolResult?.findings);

      perTableExpandable[location.tableIdx][location.rowIdx] = {
        item: tableInfos[location.tableIdx].items[location.rowIdx],
        result: {
          success: resp.success,
          sections,
          error: toolResult?.error,
        },
      };
    }

    // Attach expandableData to table payloads.
    for (let i = 0; i < tableInfos.length; i++) {
      const payload = tableInfos[i].env.data as any;
      payload.expandableData = perTableExpandable[i];
    }

    return tableInfos.map((ti) => ti.env);
  }

  private rawResultsToSections(
    rawResults: Record<string, any>,
    findings?: Finding[]
  ): Record<string, any> {
    const sections: Record<string, any> = {};

    // Always include diagnostics/findings if present.
    if (findings && findings.length > 0) {
      sections.findings = {
        title: '诊断要点',
        data: findings.map((f) => ({
          severity: f.severity,
          title: f.title,
          description: f.description || '',
          source: f.source || '',
        })),
      };
    }

    for (const [stepId, stepResult] of Object.entries(rawResults || {})) {
      if (!stepResult || typeof stepResult !== 'object') continue;

      const title = (stepResult.display && stepResult.display.title) ? String(stepResult.display.title) : stepId;
      const data = (stepResult as any).data;

      // Common table-like shape: {columns, rows}
      if (data && typeof data === 'object' && Array.isArray((data as any).columns) && Array.isArray((data as any).rows)) {
        const cols: string[] = (data as any).columns;
        const rows: any[][] = (data as any).rows;
        const objects = rows.map((row) => {
          const obj: Record<string, any> = {};
          cols.forEach((c, idx) => {
            obj[c] = row[idx];
          });
          return obj;
        });
        if (objects.length > 0) {
          sections[stepId] = { title, data: objects };
        }
        continue;
      }

      // Already an array of objects.
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
        sections[stepId] = { title, data };
        continue;
      }

      // Fallback: wrap scalar/object as single-row table.
      if (data !== undefined && data !== null) {
        sections[stepId] = {
          title,
          data: [
            typeof data === 'object' ? data : { value: data },
          ],
        };
      }
    }

    return sections;
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
      const key = this.buildFrameMechanismRecordKey(record);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(record);
    }

    return deduped;
  }

  private buildFrameMechanismRecordKey(record: FrameMechanismRecord): string {
    return [
      record.sessionId || 'nosession',
      record.frameId,
      record.startTs,
      record.causeType,
    ].join('|');
  }

  private getPrebuiltIntervals(ctx: ExecutionContext): FocusInterval[] {
    const optionIntervals = ctx.options.prebuiltIntervals;
    if (Array.isArray(optionIntervals) && optionIntervals.length > 0) {
      return optionIntervals;
    }

    const incrementalIntervals = ctx.incrementalScope?.focusIntervals;
    if (Array.isArray(incrementalIntervals) && incrementalIntervals.length > 0) {
      return incrementalIntervals;
    }

    return [];
  }

  private buildSynthesisMessage(agentCount: number, directCount: number): string {
    if (agentCount > 0 && directCount > 0) {
      return `综合 ${agentCount} 个 Agent + ${directCount} 个 Skill 结果`;
    }
    if (directCount > 0) {
      return `综合 ${directCount} 个 Skill 执行结果`;
    }
    return `综合 ${agentCount} 个 Agent 反馈`;
  }

  /**
   * Phase 3: Validate skillParams types against optional schema in template.
   */
  private validateSkillParams(template: StageTaskTemplate, emitter: ProgressEmitter): void {
    const schema = (template as any).skillParamsSchema as Record<string, string> | undefined;
    if (!schema || !template.skillParams) return;

    for (const [key, expectedType] of Object.entries(schema)) {
      const value = template.skillParams[key];
      if (value === undefined) continue;
      const actualType = typeof value;
      if (actualType !== expectedType) {
        emitter.log(`skillParam "${key}" type mismatch: expected ${expectedType}, got ${actualType} (value: ${value})`);
      }
    }
  }

  /**
   * Split stage templates into agent tasks and direct skill tasks.
   * Templates with executionMode: 'direct_skill' produce DirectSkillTask[],
   * all others produce AgentTask[] via existing buildStageTasks logic.
   */
  private buildStageTasksSplit(
    stage: StageDefinition,
    focusIntervals: FocusInterval[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): { agentTasks: AgentTask[]; directSkillTasks: DirectSkillTask[] } {
    const agentTemplates: StageTaskTemplate[] = [];
    const directTemplates: StageTaskTemplate[] = [];

    for (const template of stage.tasks) {
      this.validateSkillParams(template, emitter);
      if (template.executionMode === 'direct_skill') {
        directTemplates.push(template);
      } else {
        agentTemplates.push(template);
      }
    }

    // Build agent tasks from agent templates (existing logic)
    const agentTasks = this.buildStageTasksFromTemplates(
      agentTemplates, focusIntervals, ctx
    );

    // Build direct skill tasks from direct templates
    const directSkillTasks: DirectSkillTask[] = [];
    for (const template of directTemplates) {
      const filteredIntervals = template.scope === 'per_interval'
        ? this.filterIntervalsForTemplate(template, focusIntervals, emitter)
        : [];

      const scopes = template.scope === 'global'
        ? [{ interval: { id: 0, processName: '', startTs: '0', endTs: '0', priority: 0 } as FocusInterval, scopeLabel: '全局' }]
        : filteredIntervals.map(interval => ({
            interval,
            scopeLabel: interval.label || `区间${interval.id}`,
          }));

      for (const { interval, scopeLabel } of scopes) {
        directSkillTasks.push({ template, interval, scopeLabel });
      }
    }

    return { agentTasks, directSkillTasks };
  }

  /**
   * Build AgentTask[] from a subset of templates (factored out from buildStageTasks).
   */
  private buildStageTasksFromTemplates(
    templates: StageTaskTemplate[],
    focusIntervals: FocusInterval[],
    ctx: ExecutionContext
  ): AgentTask[] {
    if (templates.length === 0) return [];

    const hypothesis = Array.from(ctx.sharedContext.hypotheses.values())
      .find(h => h.status === 'proposed' || h.status === 'investigating');
    const relevantFindings = ctx.sharedContext.confirmedFindings.slice(-5);
    const intentSummary = { primaryGoal: ctx.intent.primaryGoal, aspects: ctx.intent.aspects };
    const historyContext = ctx.sessionContext?.generatePromptContext(700)?.trim() || '';

    const tasks: AgentTask[] = [];

    for (const template of templates) {
      const filteredIntervals = template.scope === 'per_interval'
        ? this.filterIntervalsForTemplate(template, focusIntervals)
        : [];

      const scopes = template.scope === 'global'
        ? [{ scopeLabel: '全局' as string }]
        : filteredIntervals.map(interval => ({
            scopeLabel: interval.label || `区间${interval.id}`,
            timeRange: { start: interval.startTs, end: interval.endTs },
            packageName: interval.processName,
          }));

      for (const scope of scopes) {
        const description = template.descriptionTemplate
          .replace('{{scopeLabel}}', scope.scopeLabel);

        tasks.push({
          id: createTaskId(),
          description,
          targetAgentId: template.agentId,
          priority: template.priority || 5,
          context: {
            query: ctx.query,
            intent: intentSummary,
            hypothesis,
            domain: template.domain,
            ...('timeRange' in scope && { timeRange: scope.timeRange }),
            evidenceNeeded: template.evidenceNeeded || [],
            relevantFindings,
            additionalData: {
              traceProcessorService: ctx.options.traceProcessorService,
              packageName: ('packageName' in scope ? scope.packageName : undefined) || ctx.options.packageName,
              adb: ctx.options.adb,
              adbContext: ctx.options.adbContext,
              scopeLabel: scope.scopeLabel,
              ...(historyContext ? { historyContext } : {}),
              ...(template.skillParams && { skillParams: template.skillParams }),
              ...(template.focusTools && { focusTools: template.focusTools }),
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });
      }
    }

    return tasks;
  }

  private filterIntervalsForTemplate(
    template: StageTaskTemplate,
    intervals: FocusInterval[],
    emitter?: ProgressEmitter
  ): FocusInterval[] {
    if (typeof template.intervalFilter !== 'function') {
      return intervals;
    }

    const filtered: FocusInterval[] = [];
    for (const interval of intervals) {
      try {
        if (template.intervalFilter(interval)) {
          filtered.push(interval);
        }
      } catch (error: any) {
        if (emitter) {
          emitter.log(
            `[StrategyExecutor] intervalFilter failed for template ${template.directSkillId || template.agentId}: ${error?.message || error}`
          );
        }
      }
    }
    return filtered;
  }

  /**
   * Execute direct skill tasks via DirectSkillExecutor.
   * Lazily creates the executor from context options.
   */
  private async executeDirectSkillTasks(
    tasks: DirectSkillTask[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): Promise<AgentResponse[]> {
    const executor = new DirectSkillExecutor(
      ctx.options.traceProcessorService,
      this.services.modelRouter,  // Used as aiService for ai_assist steps
      ctx.traceId
    );
    return executor.executeTasks(tasks, emitter);
  }
}

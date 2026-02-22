/**
 * Strategy Executor
 *
 * Executes a matched StagedAnalysisStrategy as a deterministic multi-stage pipeline.
 * Core responsibility here is lifecycle orchestration; data shaping and task construction
 * are delegated to helper components in ./strategy.
 */

import { Finding } from '../../types';
import {
  AgentResponse,
} from '../../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StrategyExecutionState,
  intervalHelpers,
  DirectSkillTask,
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
import {
  resolveStrategyPrebuiltContext,
  shouldSkipStageForPrebuilt,
} from './strategy/strategyStagePlanner';
import { StrategyStageTaskBuilder } from './strategy/strategyStageTaskBuilder';
import { StrategyFrameEnvelopeCoordinator } from './strategy/strategyFrameEnvelopeCoordinator';
import { StrategyFrameMechanismCollector } from './strategy/strategyFrameMechanismCollector';

export class StrategyExecutor implements AnalysisExecutor {
  private readonly taskBuilder = new StrategyStageTaskBuilder();
  private readonly frameEnvelopeCoordinator = new StrategyFrameEnvelopeCoordinator();
  private readonly frameMechanismCollector = new StrategyFrameMechanismCollector();

  constructor(
    private strategy: StagedAnalysisStrategy,
    private services: AnalysisServices
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const allFindings: Finding[] = [];
    let stagedConfidence = 0.5;

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

    const accumulatedFrameMechanismRecords = this.frameMechanismCollector.dedupe(
      ctx.sharedContext.frameMechanismRecords || []
    );

    const allCapturedEntities: CapturedEntities[] = [];
    const analyzedFrameIds: string[] = [];
    const analyzedSessionIds: string[] = [];

    const prebuilt = resolveStrategyPrebuiltContext(this.strategy, ctx);

    if (prebuilt.hasPrebuiltContext) {
      const source = (ctx.options.prebuiltIntervals && ctx.options.prebuiltIntervals.length > 0)
        ? 'follow-up'
        : 'incremental';
      emitter.log(`[FollowUp] Using ${prebuilt.prebuiltIntervals.length} pre-built interval(s) (${source})`);
    }

    const state: StrategyExecutionState = {
      strategyId: this.strategy.id,
      currentStageIndex: 0,
      focusIntervals: prebuilt.prebuiltIntervals,
      confidence: prebuilt.hasPrebuiltContext ? 0.7 : 0.5,
    };

    const deferredExpandableTables: DataEnvelope[] = [];

    emitter.log(
      `Executing strategy: ${this.strategy.name} (${prebuilt.effectiveTotalStages}/${this.strategy.stages.length} stages${prebuilt.hasPrebuiltContext ? ', follow-up mode' : ''})`
    );

    if (!ctx.sharedContext.traceConfig) {
      await this.ensureTraceConfig(ctx, emitter);
    }

    for (let i = 0; i < this.strategy.stages.length; i++) {
      const stage = this.strategy.stages[i];
      state.currentStageIndex = i;

      const skipDecision = shouldSkipStageForPrebuilt(stage, {
        hasPrebuiltContext: prebuilt.hasPrebuiltContext,
        prebuiltEntityType: prebuilt.prebuiltEntityType,
      });
      if (skipDecision.skip) {
        emitter.log(`[FollowUp] Skipping stage "${stage.name}" - ${skipDecision.reason}`);
        emitter.emitUpdate('stage_transition', {
          stageIndex: i,
          totalStages: this.strategy.stages.length,
          stageName: stage.name,
          intervalCount: state.focusIntervals.length,
          skipped: true,
          skipReason: skipDecision.reason,
        });
        continue;
      }

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

      emitter.emitUpdate('stage_transition', {
        stageIndex: i,
        totalStages: this.strategy.stages.length,
        stageName: stage.name,
        intervalCount: state.focusIntervals.length,
      });

      const progressMessage = stage.progressMessageTemplate
        .replace('{{stageIndex}}', String(rounds))
        .replace('{{totalStages}}', String(prebuilt.effectiveTotalStages));

      emitter.emitUpdate('progress', {
        phase: 'round_start',
        round: rounds,
        maxRounds: prebuilt.effectiveTotalStages,
        message: progressMessage,
      });

      const { agentTasks, directSkillTasks } = this.taskBuilder.buildStageTasksSplit(
        stage,
        state.focusIntervals,
        ctx,
        emitter
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
        const stageMechanismRecords = this.frameMechanismCollector.collectFromResponses(responses);
        if (stageMechanismRecords.length > 0) {
          accumulatedFrameMechanismRecords.push(...stageMechanismRecords);
          const uniqueRecords = this.frameMechanismCollector.dedupe(accumulatedFrameMechanismRecords);
          accumulatedFrameMechanismRecords.length = 0;
          accumulatedFrameMechanismRecords.push(...uniqueRecords);
          ctx.sharedContext.frameMechanismRecords = [...uniqueRecords];
          emitter.log(
            `[FrameMechanism] Captured ${stageMechanismRecords.length} record(s) in stage, ${uniqueRecords.length} unique total`
          );
        }
      }

      const capturedFromResponses = captureEntitiesFromResponses(responses);
      allCapturedEntities.push(capturedFromResponses);

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

      const { responsesForEmit, deferred } = this.frameEnvelopeCoordinator.deferExpandableFrameTables(stage, responses);
      deferredExpandableTables.push(...deferred);

      const registry = this.services.emittedEnvelopeRegistry;

      if (stage.name === 'frame_analysis' && deferredExpandableTables.length > 0 && directSkillTasks.length > 0) {
        let merged = this.frameEnvelopeCoordinator.attachExpandableDataToDeferredTables(
          deferredExpandableTables,
          directSkillTasks,
          directResponses
        );
        if (registry && merged.length > 0) {
          merged = registry.filterNewEnvelopes(merged);
        }
        if (merged.length > 0) {
          emitter.log(`Emitting ${merged.length} merged expandable table(s)`);
          emitter.emitUpdate('data', merged);
        }
        deferredExpandableTables.length = 0;
        if (agentResponses.length > 0) {
          emitDataEnvelopes(agentResponses, emitter, registry);
        }
      } else {
        emitDataEnvelopes(responsesForEmit, emitter, registry);
      }

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
      const synthesisMessage = this.buildSynthesisMessage(agentResponses.length, directResponses.length);
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

      const frameMechanismRecords = ctx.sharedContext.frameMechanismRecords || [];
      if (stage.name === 'frame_analysis' && (allFindings.length > 0 || frameMechanismRecords.length > 0)) {
        try {
          const jankSummary = summarizeJankCauses(allFindings, frameMechanismRecords);
          if (jankSummary.totalJankFrames > 0) {
            ctx.sharedContext.jankCauseSummary = jankSummary;
            emitter.log(
              `[JankSummary] Aggregated ${jankSummary.totalJankFrames} frames: primary=${jankSummary.primaryCause?.label} (${jankSummary.primaryCause?.percentage}%), secondary=${jankSummary.secondaryCauses.length} causes`
            );

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

      const confidences = responses
        .filter(r => r.success)
        .map(r => r.confidence)
        .filter(c => typeof c === 'number');
      if (confidences.length > 0) {
        const avg = confidences.reduce((s, c) => s + c, 0) / confidences.length;
        stagedConfidence = Math.max(stagedConfidence, avg);
      }
      state.confidence = stagedConfidence;

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

    if (!stopReason) {
      stopReason = `Strategy ${this.strategy.name} completed`;
    }

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

  private async ensureTraceConfig(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<void> {
    try {
      const traceConfig = await detectTraceConfig(
        ctx.options.traceProcessorService,
        this.services.modelRouter,
        ctx.traceId,
        emitter
      );
      ctx.sharedContext.traceConfig = traceConfig;

      ctx.sharedContext.globalMetrics = ctx.sharedContext.globalMetrics || {};
      ctx.sharedContext.globalMetrics.refreshRateHz = traceConfig.refreshRateHz;
      ctx.sharedContext.globalMetrics.vsyncPeriodMs = traceConfig.vsyncPeriodMs;
      ctx.sharedContext.globalMetrics.isVRR = traceConfig.isVRR;
    } catch (error: any) {
      emitter.log(`[TraceConfig] Detection failed, using defaults: ${error.message}`);
    }
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

  private async executeDirectSkillTasks(
    tasks: DirectSkillTask[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): Promise<AgentResponse[]> {
    const executor = new DirectSkillExecutor(
      ctx.options.traceProcessorService,
      this.services.modelRouter,
      ctx.traceId
    );
    return executor.executeTasks(tasks, emitter);
  }
}

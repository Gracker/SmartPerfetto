/**
 * Hypothesis Executor
 *
 * Executes the adaptive hypothesis-driven analysis loop.
 * Owns the multi-round iteration that:
 * 1. Plans a task graph based on hypotheses
 * 2. Dispatches tasks to domain agents
 * 3. Synthesizes feedback
 * 4. Evaluates early-stop conditions
 * 5. Decides next strategy (continue/deep_dive/pivot/conclude)
 */

import { Intent, Finding, Evaluation } from '../../types';
import {
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
} from '../../types/agentProtocol';
import { DomainAgentRegistry } from '../../agents/domain';
import {
  IterationStrategyPlanner,
  StrategyDecision,
} from '../../agents/iterationStrategyPlanner';
import { AnalysisExecutor } from './analysisExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  translateStrategy,
  InterventionRequest,
} from '../orchestratorTypes';
import { createHypothesis } from '../hypothesisGenerator';
import { planTaskGraph, buildTasksFromGraph } from '../taskGraphPlanner';
import { executeTaskGraph, emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback, SynthesisResult } from '../feedbackSynthesizer';
import type { FocusStore, UserFocus } from '../../context/focusStore';

// =============================================================================
// Intervention Configuration
// =============================================================================

interface InterventionConfig {
  /** Confidence threshold below which intervention is triggered */
  confidenceThreshold: number;
  /** Maximum analysis time before timeout intervention (ms) */
  timeoutThresholdMs: number;
  /** Enable automatic interventions */
  autoIntervention: boolean;
}

const DEFAULT_INTERVENTION_CONFIG: InterventionConfig = {
  confidenceThreshold: 0.4,  // Lower than orchestrator's conclusion threshold
  timeoutThresholdMs: 90000, // 90 seconds
  autoIntervention: true,
};

// =============================================================================
// HypothesisExecutor
// =============================================================================

export class HypothesisExecutor implements AnalysisExecutor {
  private focusStore?: FocusStore;
  private interventionConfig: InterventionConfig;

  constructor(
    private services: AnalysisServices,
    private agentRegistry: DomainAgentRegistry,
    private strategyPlanner: IterationStrategyPlanner,
    interventionConfig?: Partial<InterventionConfig>
  ) {
    this.interventionConfig = { ...DEFAULT_INTERVENTION_CONFIG, ...interventionConfig };
  }

  /**
   * Set FocusStore for focus-aware analysis planning (v2.0)
   */
  setFocusStore(focusStore: FocusStore): void {
    this.focusStore = focusStore;
  }

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const startTime = Date.now();
    const allFindings: Finding[] = [];
    let lastStrategy: StrategyDecision | null = null;
    // Seed with cross-turn contradictions so the planner prioritizes resolving them.
    let informationGaps: string[] = (() => {
      const cx = ctx.sessionContext?.getTraceAgentState()?.contradictions;
      if (!Array.isArray(cx) || cx.length === 0) return [];
      return cx
        .slice(-3)
        .map(c => `矛盾: ${String((c as any)?.description || '').trim()}`)
        .filter(s => s !== '矛盾:');
    })();
    let currentRound = 0;
    let noProgressRounds = 0;
    let failureRounds = 0;
    let stopReason: string | null = null;
    let interventionRequest: InterventionRequest | undefined;
    let hypothesesAnnounced = false;

    const hardMaxRounds = Math.max(1, ctx.config.maxRounds);
    const softMaxRounds = (() => {
      const soft = ctx.config.softMaxRounds;
      if (typeof soft !== 'number' || !Number.isFinite(soft)) return hardMaxRounds;
      return Math.max(1, Math.min(hardMaxRounds, Math.floor(soft)));
    })();

    while (currentRound < hardMaxRounds) {
      currentRound++;
      emitter.log(`=== Round ${currentRound}/${hardMaxRounds}${softMaxRounds !== hardMaxRounds ? ` (soft=${softMaxRounds})` : ''} ===`);

      emitter.emitUpdate('progress', {
        phase: 'round_start',
        round: currentRound,
        maxRounds: hardMaxRounds,
        softMaxRounds,
        message: `分析轮次 ${currentRound}${softMaxRounds !== hardMaxRounds ? `（建议≤${softMaxRounds}）` : ''}`,
      });

      // 1. Plan task graph and dispatch tasks
      const plannerHistoryContext = ctx.sessionContext?.generatePromptContext(900) || '';
      const taskHistoryContext = ctx.sessionContext?.generatePromptContext(500) || '';
      const taskGraph = await planTaskGraph(
        ctx.query, ctx.intent, ctx.sharedContext, informationGaps,
        ctx.options, this.services.modelRouter, this.agentRegistry, emitter,
        // Goal-driven mode: treat "task" as an experiment; default to one per round.
        { maxTasks: 1, historyContext: plannerHistoryContext }
      );
      const tasks = buildTasksFromGraph(
        taskGraph, ctx.query, ctx.intent, ctx.sharedContext,
        ctx.options, this.agentRegistry, emitter,
        { historyContext: taskHistoryContext }
      );

      let effectiveTasks = tasks;

      // v2.0: Apply incremental scope to reduce redundant work on follow-up turns.
      // This is a best-effort filter (never drop to zero tasks).
      const incrementalScope = ctx.incrementalScope;
      if (
        incrementalScope &&
        incrementalScope.isExtension &&
        incrementalScope.type !== 'full' &&
        Array.isArray(incrementalScope.relevantAgents) &&
        incrementalScope.relevantAgents.length > 0
      ) {
        const allowed = new Set(incrementalScope.relevantAgents);
        const filtered = tasks.filter(t => allowed.has(t.targetAgentId));

        if (filtered.length > 0 && filtered.length < tasks.length) {
          emitter.log(`[IncrementalAnalysis] Filtered taskGraph tasks ${tasks.length} → ${filtered.length} (allowed: ${incrementalScope.relevantAgents.join(', ')})`);
          emitter.emitUpdate('progress', {
            phase: 'task_scope_filtered',
            before: tasks.length,
            after: filtered.length,
            allowedAgents: incrementalScope.relevantAgents,
            message: `增量范围生效：任务 ${tasks.length} → ${filtered.length}`,
          });
          effectiveTasks = filtered;
        } else if (filtered.length === 0) {
          emitter.log(`[IncrementalAnalysis] Scope filter would remove all tasks; keeping ${tasks.length} tasks`);
        }
      }

      if (effectiveTasks.length === 0) {
        stopReason = 'No tasks generated from task graph';
        emitter.log('No tasks to dispatch, concluding');
        break;
      }

      // Goal-driven experiment log (v1): treat this round as one experiment by default.
      const experimentObjective = effectiveTasks.length === 1
        ? `[${effectiveTasks[0].targetAgentId}] ${effectiveTasks[0].description}`
        : effectiveTasks.map(t => `[${t.targetAgentId}] ${t.description}`).join(' | ');
      const experimentId = ctx.sessionContext?.startTraceAgentExperiment({
        type: 'run_skill',
        objective: experimentObjective,
      });

      emitter.emitUpdate('progress', {
        phase: 'task_graph_planned',
        taskCount: tasks.length,
        taskGraph: taskGraph.nodes.map(node => ({
          id: node.id,
          domain: node.domain,
          description: node.description,
          evidenceNeeded: node.evidenceNeeded,
          dependsOn: node.dependsOn,
        })),
        message: `生成任务图 (${tasks.length} 个任务)`,
      });

      emitter.emitUpdate('progress', {
        phase: 'tasks_dispatched',
        taskCount: effectiveTasks.length,
        agents: effectiveTasks.map(t => t.targetAgentId),
        message: `派发 ${effectiveTasks.length} 个任务`,
      });

      // 2. Execute tasks with dependency ordering
      const responses = await executeTaskGraph(effectiveTasks, this.services.messageBus, emitter, this.services.circuitBreaker);
      emitDataEnvelopes(responses, emitter, this.services.emittedEnvelopeRegistry);

      // v2.0: Ingest tool outputs as durable evidence digests (goal-driven agent scaffold).
      const producedEvidenceIds =
        ctx.sessionContext?.ingestEvidenceFromResponses(responses, { stageName: 'hypothesis_round', round: currentRound }) || [];
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

      // 3. Synthesize feedback (messageBus ensures hypothesis broadcasts fire)
      const synthesis = await synthesizeFeedback(
        responses,
        ctx.sharedContext,
        this.services.modelRouter,
        emitter,
        this.services.messageBus,
        ctx.sessionContext
      );
      emitter.emitUpdate('progress', {
        phase: 'synthesis_complete',
        confirmedFindings: synthesis.confirmedFindings.length,
        updatedHypotheses: synthesis.updatedHypotheses.length,
        message: `综合 ${responses.length} 个 Agent 反馈`,
      });

      informationGaps = synthesis.informationGaps;
      allFindings.push(...synthesis.newFindings);

      if (!hypothesesAnnounced && currentRound === 1) {
        hypothesesAnnounced = this.emitEvidenceBasedHypothesesIfReady(
          ctx.sharedContext,
          synthesis,
          responses,
          emitter
        );
      }

      if (synthesis.newFindings.length > 0) {
        emitter.emitUpdate('finding', {
          round: currentRound,
          findings: synthesis.newFindings,
        });
      }

      // 4. Evaluate early stop
      const earlyStop = this.evaluateEarlyStop(
        responses, synthesis.newFindings.length,
        noProgressRounds, failureRounds, ctx.config, emitter
      );
      noProgressRounds = earlyStop.noProgressRounds;
      failureRounds = earlyStop.failureRounds;
      if (earlyStop.shouldStop) {
        stopReason = earlyStop.reason!;
        emitter.emitUpdate('progress', {
          phase: 'early_stop',
          reason: stopReason,
          noProgressRounds,
          failureRounds,
          message: `提前终止: ${stopReason}`,
        });
        break;
      }

      // 4.5 Check intervention conditions (v2.0)
      const elapsedMs = Date.now() - startTime;
      const currentConfidence = this.estimateCurrentConfidence(allFindings, ctx.sharedContext);
      const possibleDirections = this.buildPossibleDirections(ctx.sharedContext);

      interventionRequest = this.checkInterventionConditions(
        currentConfidence,
        possibleDirections,
        elapsedMs,
        currentRound,
        allFindings,
        emitter
      );

      if (interventionRequest) {
        emitter.log(`[HypothesisExecutor] Intervention triggered: ${interventionRequest.reason}`);
        emitter.emitUpdate('progress', {
          phase: 'intervention_required',
          type: interventionRequest.type,
          confidence: interventionRequest.confidence,
          reason: interventionRequest.reason,
          message: `需要用户干预: ${interventionRequest.reason}`,
        });
        // Don't break - we'll check in the orchestrator whether to pause
        // For now, continue to strategy decision which may also conclude
      }

      // 5. Decide next strategy with focus context (v2.0)
      const topFocuses = this.focusStore?.getTopFocuses(3) || [];
      const focusContext = this.buildFocusContext(topFocuses);

      const strategyContext = {
        sessionId: ctx.sharedContext.sessionId,
        traceId: ctx.sharedContext.traceId,
        evaluation: this.buildEvaluation(allFindings, ctx.sharedContext, topFocuses),
        previousResults: [],
        intent: ctx.intent,
        iterationCount: currentRound,
        maxIterations: hardMaxRounds,
        allFindings,
        // v2.0: User focus context for focus-aware decision making
        userFocusContext: focusContext,
      };

      lastStrategy = await this.strategyPlanner.planNextIteration(strategyContext);

      emitter.emitUpdate('progress', {
        phase: 'strategy_decision',
        strategy: lastStrategy.strategy,
        confidence: lastStrategy.confidence,
        reasoning: lastStrategy.reasoning,
        message: `策略: ${translateStrategy(lastStrategy.strategy)}`,
      });

      if (lastStrategy.strategy === 'conclude') {
        emitter.log('Strategy: conclude - ending analysis');
        break;
      }

      // Soft budget: prefer to stop after reaching user-preferred experiment count
      // *only if* the results are already good enough.
      if (currentRound >= softMaxRounds) {
        const currentConfidence = this.estimateCurrentConfidence(allFindings, ctx.sharedContext);
        const decisionConfidence = Math.max(lastStrategy.confidence, currentConfidence);
        const goodEnough =
          allFindings.length > 0 &&
          decisionConfidence >= ctx.config.confidenceThreshold;

        if (goodEnough) {
          stopReason = `Reached preferred experiment budget (${softMaxRounds}) with sufficient confidence`;
          emitter.log(`[Budget] ${stopReason}`);
          emitter.emitUpdate('progress', {
            phase: 'early_stop',
            reason: stopReason,
            message: `提前终止: ${stopReason}`,
          });
          lastStrategy = {
            strategy: 'conclude',
            confidence: decisionConfidence,
            reasoning: `结果已足够（confidence=${decisionConfidence.toFixed(2)}，findings=${allFindings.length}），达到偏好实验预算后收敛`,
          };
          break;
        }
      }

      // Handle deep_dive
      if (lastStrategy.strategy === 'deep_dive' && lastStrategy.focusArea) {
        emitter.log(`Strategy: deep_dive - focusing on ${lastStrategy.focusArea}`);
        ctx.sharedContext.focusedTimeRange = ctx.options.timeRange;

        const deepDiveHypothesis = createHypothesis(
          `深入分析 ${lastStrategy.focusArea} 领域`, 0.6
        );
        deepDiveHypothesis.status = 'investigating';
        this.services.messageBus.updateHypothesis(deepDiveHypothesis);
      }

      // Handle pivot — demote investigating hypotheses and add new direction
      if (lastStrategy.strategy === 'pivot' && lastStrategy.newDirection) {
        emitter.log(`Strategy: pivot - changing direction to ${lastStrategy.newDirection}`);

        for (const hypothesis of ctx.sharedContext.hypotheses.values()) {
          if (hypothesis.status === 'investigating') {
            const demoted: Hypothesis = {
              ...hypothesis,
              status: 'proposed',
              confidence: Math.max(0.3, hypothesis.confidence - 0.2),
              updatedAt: Date.now(),
            };
            this.services.messageBus.updateHypothesis(demoted);
          }
        }

        this.services.messageBus.updateHypothesis(
          createHypothesis(lastStrategy.newDirection, 0.5)
        );
      }
    }

    return {
      findings: allFindings,
      lastStrategy,
      confidence: lastStrategy?.confidence || 0.5,
      informationGaps,
      rounds: currentRound,
      stopReason,
      interventionRequest,
      pausedForIntervention: !!interventionRequest,
    };
  }

  private evaluateEarlyStop(
    responses: AgentResponse[],
    newFindingsCount: number,
    noProgressRounds: number,
    failureRounds: number,
    config: { maxNoProgressRounds: number; maxFailureRounds: number },
    emitter: ProgressEmitter
  ): { shouldStop: boolean; reason?: string; noProgressRounds: number; failureRounds: number } {
    const failedCount = responses.filter(r => !r.success).length;
    const failureRatio = responses.length > 0 ? failedCount / responses.length : 1;

    noProgressRounds = newFindingsCount === 0 ? noProgressRounds + 1 : 0;
    failureRounds = failureRatio > 0.6 ? failureRounds + 1 : 0;

    if (noProgressRounds >= config.maxNoProgressRounds) {
      return { shouldStop: true, reason: '连续多轮没有新增证据', noProgressRounds, failureRounds };
    }

    if (failureRounds >= config.maxFailureRounds) {
      return { shouldStop: true, reason: '任务执行失败过多，提前终止', noProgressRounds, failureRounds };
    }

    return { shouldStop: false, noProgressRounds, failureRounds };
  }

  // ===========================================================================
  // Intervention Methods (v2.0)
  // ===========================================================================

  /**
   * Estimate current analysis confidence based on findings and hypotheses.
   */
  private estimateCurrentConfidence(
    findings: Finding[],
    sharedContext: SharedAgentContext
  ): number {
    const hypotheses = Array.from(sharedContext.hypotheses.values());
    const confirmedCount = hypotheses.filter(h => h.status === 'confirmed').length;
    const investigatingCount = hypotheses.filter(h => h.status === 'investigating').length;
    const totalHypotheses = hypotheses.length;

    // Base confidence from findings
    const findingsScore = Math.min(1, findings.length * 0.15);

    // Hypothesis confirmation rate
    const hypothesisScore = totalHypotheses > 0
      ? (confirmedCount * 2 + investigatingCount) / (totalHypotheses * 2)
      : 0.5;

    // Critical findings boost confidence
    const criticalFindings = findings.filter(f => f.severity === 'critical').length;
    const criticalBoost = Math.min(0.2, criticalFindings * 0.1);

    return Math.min(1, findingsScore * 0.4 + hypothesisScore * 0.4 + criticalBoost + 0.2);
  }

  /**
   * Build possible analysis directions from current hypotheses.
   */
  private buildPossibleDirections(
    sharedContext: SharedAgentContext
  ): Array<{ id: string; description: string; confidence: number }> {
    const hypotheses = Array.from(sharedContext.hypotheses.values());
    const directions: Array<{ id: string; description: string; confidence: number }> = [];

    // Active hypotheses become possible directions
    for (const hypothesis of hypotheses) {
      if (hypothesis.status === 'proposed' || hypothesis.status === 'investigating') {
        directions.push({
          id: hypothesis.id,
          description: hypothesis.description,
          confidence: hypothesis.confidence,
        });
      }
    }

    // Add standard directions if no hypotheses
    if (directions.length === 0) {
      directions.push(
        { id: 'frame_analysis', description: '深入帧渲染分析', confidence: 0.5 },
        { id: 'cpu_analysis', description: '深入 CPU 调度分析', confidence: 0.5 },
        { id: 'binder_analysis', description: '深入 Binder IPC 分析', confidence: 0.5 }
      );
    }

    // Sort by confidence
    return directions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Check if intervention conditions are met.
   */
  private checkInterventionConditions(
    confidence: number,
    possibleDirections: Array<{ id: string; description: string; confidence: number }>,
    elapsedMs: number,
    roundsCompleted: number,
    findings: Finding[],
    emitter: ProgressEmitter
  ): InterventionRequest | undefined {
    if (!this.interventionConfig.autoIntervention) {
      return undefined;
    }

    // 1. Low confidence check
    if (confidence < this.interventionConfig.confidenceThreshold) {
      emitter.log(`[Intervention] Low confidence: ${confidence.toFixed(2)} < ${this.interventionConfig.confidenceThreshold}`);
      return {
        type: 'low_confidence',
        reason: `分析置信度较低 (${(confidence * 100).toFixed(0)}%)，需要确认是否继续`,
        confidence,
        possibleDirections,
        progressSummary: `已完成 ${roundsCompleted} 轮分析，发现 ${findings.length} 个问题`,
        elapsedTimeMs: elapsedMs,
        roundsCompleted,
      };
    }

    // 2. Ambiguity check (multiple directions with similar confidence)
    if (possibleDirections.length >= 2) {
      const topTwo = possibleDirections.slice(0, 2);
      const confidenceDiff = Math.abs(topTwo[0].confidence - topTwo[1].confidence);
      if (confidenceDiff < 0.15 && topTwo[0].confidence < 0.7) {
        emitter.log(`[Intervention] Ambiguity detected: ${topTwo.map(d => d.description).join(' vs ')}`);
        return {
          type: 'ambiguity',
          reason: '存在多个可能的分析方向，请选择重点',
          confidence,
          possibleDirections,
          progressSummary: `已完成 ${roundsCompleted} 轮分析，发现 ${findings.length} 个问题`,
          elapsedTimeMs: elapsedMs,
          roundsCompleted,
        };
      }
    }

    // 3. Timeout check
    if (elapsedMs > this.interventionConfig.timeoutThresholdMs) {
      emitter.log(`[Intervention] Timeout: ${elapsedMs}ms > ${this.interventionConfig.timeoutThresholdMs}ms`);
      return {
        type: 'timeout',
        reason: `分析时间较长 (${Math.round(elapsedMs / 1000)}秒)，是否继续?`,
        confidence,
        possibleDirections,
        progressSummary: `已完成 ${roundsCompleted} 轮分析，发现 ${findings.length} 个问题`,
        elapsedTimeMs: elapsedMs,
        roundsCompleted,
      };
    }

    return undefined;
  }

  private buildEvaluation(
    findings: Finding[],
    sharedContext: SharedAgentContext,
    topFocuses: UserFocus[] = []
  ): Evaluation {
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed').length;

    // v2.0: Calculate focus alignment score
    const focusAlignmentScore = this.calculateFocusAlignment(findings, topFocuses);

    // Quality score now includes focus alignment (v2.0)
    const baseQuality = Math.min(1, findings.length * 0.1 + confirmedHypotheses * 0.2);
    const adjustedQuality = baseQuality * (0.7 + 0.3 * focusAlignmentScore);

    return {
      passed: findings.length > 0,
      qualityScore: adjustedQuality,
      completenessScore: Math.min(1, findings.length * 0.15),
      contradictions: [],
      feedback: {
        strengths: findings.length > 0 ? ['发现了性能问题'] : [],
        weaknesses: [],
        missingAspects: topFocuses.length > 0 && focusAlignmentScore < 0.5
          ? ['分析结果与用户关注点关联度不高']
          : [],
        improvementSuggestions: [],
        priorityActions: [],
      },
      needsImprovement: findings.length === 0,
      suggestedActions: [],
    };
  }

  /**
   * Build user focus context string for LLM prompts (v2.0)
   */
  private buildFocusContext(topFocuses: UserFocus[]): string | undefined {
    if (topFocuses.length === 0) {
      return undefined;
    }

    const descriptions = topFocuses.map(focus => {
      const weight = (focus.weight * 100).toFixed(0);
      switch (focus.type) {
        case 'entity':
          return `- 实体: ${focus.target.entityType} ${focus.target.entityId || focus.target.entityName || ''} (关注度: ${weight}%)`;
        case 'timeRange':
          if (focus.target.timeRange) {
            return `- 时间范围: ${focus.target.timeRange.start} - ${focus.target.timeRange.end} (关注度: ${weight}%)`;
          }
          return `- 时间范围 (关注度: ${weight}%)`;
        case 'metric':
          return `- 指标: ${focus.target.metricName || '未知'} (关注度: ${weight}%)`;
        case 'question':
          const q = focus.target.question || '';
          return `- 问题: "${q.slice(0, 30)}${q.length > 30 ? '...' : ''}" (关注度: ${weight}%)`;
        default:
          return `- 未知关注点 (关注度: ${weight}%)`;
      }
    });

    return `用户当前关注点:\n${descriptions.join('\n')}`;
  }

  /**
   * Calculate how well findings align with user focus (v2.0)
   */
  private calculateFocusAlignment(findings: Finding[], topFocuses: UserFocus[]): number {
    if (topFocuses.length === 0 || findings.length === 0) {
      return 1.0; // No focus or no findings = neutral alignment
    }

    let alignedFindings = 0;

    for (const finding of findings) {
      for (const focus of topFocuses) {
        // Check for entity alignment
        if (focus.type === 'entity' && focus.target.entityType) {
          const details = finding.details || {};
          if (
            details.frame_id === focus.target.entityId ||
            details.session_id === focus.target.entityId ||
            details.process_name === focus.target.entityName
          ) {
            alignedFindings++;
            break;
          }
        }

        // Check for time range alignment
        if (focus.type === 'timeRange' && focus.target.timeRange && finding.details) {
          const findingTs = finding.details.timestamp || finding.details.ts;
          if (findingTs) {
            const ts = BigInt(String(findingTs));
            const start = BigInt(focus.target.timeRange.start);
            const end = BigInt(focus.target.timeRange.end);
            if (ts >= start && ts <= end) {
              alignedFindings++;
              break;
            }
          }
        }
      }
    }

    return alignedFindings / findings.length;
  }

  private emitEvidenceBasedHypothesesIfReady(
    sharedContext: SharedAgentContext,
    synthesis: SynthesisResult,
    responses: AgentResponse[],
    emitter: ProgressEmitter
  ): boolean {
    const hypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'proposed' || h.status === 'investigating' || h.status === 'confirmed')
      .map(h => h.description);
    if (hypotheses.length === 0) {
      return false;
    }

    const evidenceSummary = this.buildEvidenceSummary(synthesis, responses);
    if (evidenceSummary.length === 0) {
      return false;
    }

    emitter.emitUpdate('progress', {
      phase: 'hypotheses_generated',
      message: `基于首轮证据，形成 ${hypotheses.length} 个待验证假设`,
      hypotheses,
      evidenceBased: true,
      evidenceSummary,
    });
    return true;
  }

  private buildEvidenceSummary(
    synthesis: SynthesisResult,
    responses: AgentResponse[]
  ): string[] {
    const summary: string[] = [];

    for (const finding of synthesis.newFindings.slice(0, 3)) {
      summary.push(`发现: ${finding.title}`);
    }

    if (summary.length < 4) {
      for (const finding of synthesis.confirmedFindings.slice(0, 2)) {
        summary.push(`确认: ${finding.title}`);
      }
    }

    if (summary.length < 4 && responses.length > 0) {
      const successResponses = responses.filter(r => r.success).length;
      const withData = responses.filter(r =>
        (r.toolResults || []).some(t => t.success && t.data !== undefined && t.data !== null)
      ).length;
      if (withData > 0) {
        summary.push(`任务反馈: ${successResponses}/${responses.length} 成功，${withData} 个任务返回有效数据`);
      }
    }

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of summary) {
      if (seen.has(item)) continue;
      seen.add(item);
      deduped.push(item);
    }
    return deduped.slice(0, 5);
  }
}

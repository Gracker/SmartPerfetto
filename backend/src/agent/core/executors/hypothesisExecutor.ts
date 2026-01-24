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
} from '../orchestratorTypes';
import { createHypothesis } from '../hypothesisGenerator';
import { planTaskGraph, buildTasksFromGraph } from '../taskGraphPlanner';
import { executeTaskGraph, emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback } from '../feedbackSynthesizer';

export class HypothesisExecutor implements AnalysisExecutor {
  constructor(
    private services: AnalysisServices,
    private agentRegistry: DomainAgentRegistry,
    private strategyPlanner: IterationStrategyPlanner
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const allFindings: Finding[] = [];
    let lastStrategy: StrategyDecision | null = null;
    let informationGaps: string[] = [];
    let currentRound = 0;
    let noProgressRounds = 0;
    let failureRounds = 0;
    let stopReason: string | null = null;

    while (currentRound < ctx.config.maxRounds) {
      currentRound++;
      emitter.log(`=== Round ${currentRound}/${ctx.config.maxRounds} ===`);

      emitter.emitUpdate('progress', {
        phase: 'round_start',
        round: currentRound,
        maxRounds: ctx.config.maxRounds,
        message: `分析轮次 ${currentRound}`,
      });

      // 1. Plan task graph and dispatch tasks
      const taskGraph = await planTaskGraph(
        ctx.query, ctx.intent, ctx.sharedContext, informationGaps,
        ctx.options, this.services.modelRouter, this.agentRegistry, emitter
      );
      const tasks = buildTasksFromGraph(
        taskGraph, ctx.query, ctx.intent, ctx.sharedContext,
        ctx.options, this.agentRegistry, emitter
      );

      if (tasks.length === 0) {
        stopReason = 'No tasks generated from task graph';
        emitter.log('No tasks to dispatch, concluding');
        break;
      }

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
        taskCount: tasks.length,
        agents: tasks.map(t => t.targetAgentId),
        message: `派发 ${tasks.length} 个任务`,
      });

      // 2. Execute tasks with dependency ordering
      const responses = await executeTaskGraph(tasks, this.services.messageBus, emitter, this.services.circuitBreaker);
      emitDataEnvelopes(responses, emitter);

      // 3. Synthesize feedback (messageBus ensures hypothesis broadcasts fire)
      const synthesis = await synthesizeFeedback(responses, ctx.sharedContext, this.services.modelRouter, emitter, this.services.messageBus);
      emitter.emitUpdate('progress', {
        phase: 'synthesis_complete',
        confirmedFindings: synthesis.confirmedFindings.length,
        updatedHypotheses: synthesis.updatedHypotheses.length,
        message: `综合 ${responses.length} 个 Agent 反馈`,
      });

      informationGaps = synthesis.informationGaps;
      allFindings.push(...synthesis.newFindings);

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

      // 5. Decide next strategy
      const strategyContext = {
        evaluation: this.buildEvaluation(allFindings, ctx.sharedContext),
        previousResults: [],
        intent: ctx.intent,
        iterationCount: currentRound,
        maxIterations: ctx.config.maxRounds,
        allFindings,
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

  private buildEvaluation(findings: Finding[], sharedContext: SharedAgentContext): Evaluation {
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed').length;

    return {
      passed: findings.length > 0,
      qualityScore: Math.min(1, findings.length * 0.1 + confirmedHypotheses * 0.2),
      completenessScore: Math.min(1, findings.length * 0.15),
      contradictions: [],
      feedback: {
        strengths: findings.length > 0 ? ['发现了性能问题'] : [],
        weaknesses: [],
        missingAspects: [],
        improvementSuggestions: [],
        priorityActions: [],
      },
      needsImprovement: findings.length === 0,
      suggestedActions: [],
    };
  }
}

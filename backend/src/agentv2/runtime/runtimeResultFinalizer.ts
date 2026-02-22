import { ModelRouter } from '../../agent/core/modelRouter';
import type {
  AnalysisResult,
  ExecutorResult,
  ProgressEmitter,
} from '../../agent/core/orchestratorTypes';
import type { Finding, Intent } from '../../agent/types';
import type { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import { deriveConclusionContract, generateConclusion } from '../../agent/core/conclusionGenerator';
import { resolveConclusionScene } from '../../agent/core/conclusionSceneTemplates';
import { DEEP_REASON_LABEL } from '../../utils/analysisNarrative';
import type { SharedAgentContext } from '../../agent/types/agentProtocol';
import { applyCapturedEntities } from '../../agent/core/entityCapture';
import { InterventionController } from '../../agent/core/interventionController';

interface FinalizeAnalysisResultInput {
  query: string;
  sessionId: string;
  intent: Intent;
  sessionContext: EnhancedSessionContext;
  sharedContext: SharedAgentContext;
  emitter: ProgressEmitter;
  executorResult: ExecutorResult;
  mergedFindings: Finding[];
  startTime: number;
  singleFrameDrillDown: boolean;
  mode: 'focused_answer' | 'initial_report';
  historyBudget: number;
}

export class RuntimeResultFinalizer {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly interventionController: InterventionController
  ) {}

  handleExecutorIntervention(sessionId: string, executorResult: ExecutorResult): void {
    if (!executorResult.interventionRequest) {
      return;
    }

    const intervention = executorResult.interventionRequest;
    const options = [
      {
        id: 'continue',
        label: '继续分析',
        description: '继续当前分析策略',
        action: 'continue' as const,
        recommended: true,
      },
      {
        id: 'abort',
        label: '结束分析',
        description: '以当前结果结束',
        action: 'abort' as const,
      },
    ];

    this.interventionController.createAgentIntervention(
      sessionId,
      intervention.reason,
      options,
      {
        currentFindings: executorResult.findings,
        possibleDirections: intervention.possibleDirections.map(direction => ({
          id: direction.id,
          description: direction.description,
          confidence: direction.confidence,
          requiredAgents: [],
        })),
        elapsedTimeMs: intervention.elapsedTimeMs,
        confidence: intervention.confidence,
        roundsCompleted: intervention.roundsCompleted,
        progressSummary: intervention.progressSummary,
      }
    );
  }

  applyEntityWriteback(sessionContext: EnhancedSessionContext, executorResult: ExecutorResult): void {
    if (executorResult.capturedEntities) {
      applyCapturedEntities(sessionContext.getEntityStore(), executorResult.capturedEntities);
    }

    if (executorResult.analyzedEntityIds) {
      const store = sessionContext.getEntityStore();
      for (const frameId of executorResult.analyzedEntityIds.frames || []) {
        store.markFrameAnalyzed(frameId);
      }
      for (const sessionId of executorResult.analyzedEntityIds.sessions || []) {
        store.markSessionAnalyzed(sessionId);
      }
    }

    sessionContext.refreshTraceAgentCoverage();
  }

  async finalizeAnalysisResult(input: FinalizeAnalysisResultInput): Promise<AnalysisResult> {
    const conclusion = await generateConclusion(
      input.sharedContext,
      input.mergedFindings,
      input.intent,
      this.modelRouter,
      input.emitter,
      input.executorResult.stopReason || undefined,
      {
        turnCount: input.sessionContext.getAllTurns().length,
        historyContext: input.sessionContext.generatePromptContext(input.historyBudget),
      }
    );

    const result: AnalysisResult = {
      sessionId: input.sessionId,
      success: true,
      findings: input.mergedFindings,
      hypotheses: Array.from(input.sharedContext.hypotheses.values()),
      conclusion,
      conclusionContract: deriveConclusionContract(conclusion, {
        mode: input.mode,
        singleFrameDrillDown: input.singleFrameDrillDown,
        sceneId: this.resolveSceneIdHint(input.intent, input.mergedFindings),
      }) || undefined,
      confidence: input.executorResult.confidence,
      rounds: input.executorResult.rounds,
      totalDurationMs: Date.now() - input.startTime,
    };

    const recordedTurn = input.sessionContext.addTurn(
      input.query,
      input.intent,
      {
        success: true,
        findings: input.executorResult.findings,
        confidence: result.confidence,
        message: conclusion,
      },
      input.executorResult.findings
    );

    input.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: recordedTurn.turnIndex,
      query: input.query,
      conclusion,
      confidence: result.confidence,
    });

    input.sessionContext.recordTraceAgentTurn({
      turnId: recordedTurn.id,
      turnIndex: recordedTurn.turnIndex,
      query: input.query,
      followUpType: input.intent.followUpType,
      intentPrimaryGoal: input.intent.primaryGoal,
      conclusion,
      confidence: result.confidence,
    });

    return result;
  }

  private resolveSceneIdHint(intent: Intent, findings: Finding[]): string | undefined {
    try {
      return resolveConclusionScene({
        intent,
        findings,
        deepReasonLabel: DEEP_REASON_LABEL,
      }).selectedTemplate.id;
    } catch {
      return undefined;
    }
  }
}

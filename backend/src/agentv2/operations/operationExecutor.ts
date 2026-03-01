import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../agent/types';
import type { DecisionContext, PrincipleDecision } from '../contracts/policy';
import type { OperationPlan } from '../contracts/runtime';

export interface OperationExecutorInput {
  query: string;
  sessionId: string;
  traceId: string;
  context: DecisionContext;
  decision: PrincipleDecision;
  plan: OperationPlan;
  analyzeWithRuntimeEngine: () => Promise<AnalysisResult>;
  emitUpdate: (update: StreamingUpdate) => void;
}

export interface OperationExecutorOutput {
  result: AnalysisResult;
}

/**
 * Executes the governed analysis plan.
 *
 * Responsibilities:
 *   1. Emit plan progress event (SSE visibility)
 *   2. Enforce 'deny' gate from PrincipleEngine
 *   3. Delegate to the real mode executor
 *
 * Architecture note (2026-03-01 review):
 *   ApprovalController was removed because it emitted `intervention_required`
 *   events without awaiting a response (fire-and-forget). The real intervention
 *   mechanism lives in HypothesisExecutor's CircuitBreaker, which properly
 *   awaits user input via InterventionController.
 */
export class OperationExecutor {
  async execute(input: OperationExecutorInput): Promise<OperationExecutorOutput> {
    input.emitUpdate({
      type: 'progress',
      content: {
        phase: 'analysis_plan',
        mode: input.plan.mode,
        planId: input.plan.id,
        steps: input.plan.steps.length,
      },
      timestamp: Date.now(),
      id: `plan.${input.plan.id}`,
    });

    if (input.decision.outcome === 'deny') {
      return {
        result: {
          sessionId: input.sessionId,
          success: false,
          findings: [],
          hypotheses: [],
          conclusion: `Analysis denied by principles: ${input.decision.reasonCodes.join(', ')}`,
          confidence: 0,
          rounds: 0,
          totalDurationMs: 0,
        },
      };
    }

    const result = await input.analyzeWithRuntimeEngine();
    return { result };
  }
}

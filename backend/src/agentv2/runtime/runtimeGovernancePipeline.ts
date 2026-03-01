import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../agent/types';
import type { PreparedRuntimeContext } from './runtimeContextBuilder';
import { OperationPlanner } from '../operations/operationPlanner';
import { OperationExecutor } from '../operations/operationExecutor';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import { PrincipleEngine } from '../principles/principleEngine';
import type { PrincipleDecision } from '../contracts/policy';

interface ExecuteGovernedRuntimeAnalysisInput {
  query: string;
  sessionId: string;
  traceId: string;
  runtimeContext: PreparedRuntimeContext;
  principleEngine: PrincipleEngine;
  planner: OperationPlanner;
  operationExecutor: OperationExecutor;
  evidenceSynthesizer: EvidenceSynthesizer;
  emitUpdate: (update: StreamingUpdate) => void;
  analyzeWithRuntimeEngine: () => Promise<AnalysisResult>;
}

/**
 * Governed runtime analysis pipeline.
 *
 * Flow: PrincipleEngine → deny gate → execute → evidence synthesis
 *
 * Architecture note (2026-03-01 review):
 *   SoulGuard was removed because it validated OperationPlanner's synthetic
 *   step objects — not the actual StrategyExecutor/HypothesisExecutor
 *   behaviour. 3 of its 4 checks were structurally unreachable. Confidence
 *   honesty is now enforced post-execution via the existing CircuitBreaker
 *   in HypothesisExecutor.
 */
export async function executeGovernedRuntimeAnalysis(
  input: ExecuteGovernedRuntimeAnalysisInput
): Promise<AnalysisResult> {
  const decision = input.principleEngine.decide(input.runtimeContext.decisionContext);
  const plan = input.planner.buildPlan({
    context: input.runtimeContext.decisionContext,
    policy: decision.policy,
  });

  input.emitUpdate(buildPrinciplesAppliedUpdate(decision, plan.id));

  const execution = await input.operationExecutor.execute({
    query: input.query,
    sessionId: input.sessionId,
    traceId: input.traceId,
    context: input.runtimeContext.decisionContext,
    decision,
    plan,
    analyzeWithRuntimeEngine: input.analyzeWithRuntimeEngine,
    emitUpdate: update => input.emitUpdate(update),
  });

  const synthesized = input.evidenceSynthesizer.synthesize({
    originalConclusion: execution.result.conclusion,
    findings: execution.result.findings,
    decision,
  });

  return {
    ...execution.result,
    findings: synthesized.findings,
    conclusion: synthesized.conclusion,
  };
}

function buildPrinciplesAppliedUpdate(decision: PrincipleDecision, planId: string): StreamingUpdate {
  return {
    type: 'progress',
    content: {
      phase: 'principles_applied',
      planId,
      outcome: decision.outcome,
      matchedPrinciples: decision.matchedPrincipleIds,
      reasonCodes: decision.reasonCodes,
    },
    timestamp: Date.now(),
    id: `principles.${planId}`,
  };
}

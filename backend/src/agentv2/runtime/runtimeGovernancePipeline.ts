import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../agent/types';
import type { PreparedRuntimeContext } from './runtimeContextBuilder';
import { OperationPlanner } from '../operations/operationPlanner';
import { OperationExecutor } from '../operations/operationExecutor';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import { PrincipleEngine } from '../principles/principleEngine';
import { createSoulProfile } from '../soul/soulProfile';
import { evaluateSoulGuard } from '../soul/soulGuard';
import type { PrincipleDecision, SoulViolation } from '../contracts/policy';

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

export async function executeGovernedRuntimeAnalysis(
  input: ExecuteGovernedRuntimeAnalysisInput
): Promise<AnalysisResult> {
  const decision = input.principleEngine.decide(input.runtimeContext.decisionContext);
  const plan = input.planner.buildPlan({
    context: input.runtimeContext.decisionContext,
    policy: decision.policy,
  });

  input.emitUpdate(buildPrinciplesAppliedUpdate(decision, plan.id));

  const soulResult = evaluateSoulGuard(createSoulProfile(), {
    context: input.runtimeContext.decisionContext,
    plan,
  });

  if (!soulResult.passed) {
    input.emitUpdate(buildSoulViolationUpdate(soulResult.violations));
    return {
      sessionId: input.sessionId,
      success: false,
      findings: [],
      hypotheses: [],
      conclusion: `Soul guard blocked execution: ${soulResult.violations.map(v => v.code).join(', ')}`,
      confidence: 0,
      rounds: 0,
      totalDurationMs: 0,
    };
  }

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

function buildSoulViolationUpdate(violations: SoulViolation[]): StreamingUpdate {
  return {
    type: 'error',
    content: {
      message: `Soul guard violations: ${violations.map(v => v.code).join(', ')}`,
      violations,
    },
    timestamp: Date.now(),
    id: `soul.violation.${Date.now()}`,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {scanContent} from '../../agentv3/selfImprove/contentScanner';
import type {PhaseHint} from '../../agentv3/strategyLoader';
import type {
  CurationProposalV1,
  EvalCaseV1,
  ProposalCandidateMaterializationV1,
  ProposalGateCheckV1,
  ProposalGateId,
  ProposalGateVerdict,
  RepositoryTargetBindingV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {PROPOSAL_GATE_IDS} from '../../types/selfEvolution';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import type {EvalReplayRunStore} from './evalReplayRunStore';
import type {EvaluationReplayPublisher} from './evaluationReplayPublisher';
import {
  PROPOSAL_CONTAINMENT_PROTOCOL_VERSION,
  probeProposalContainment,
  type ProposalContainmentProbeV1,
} from './proposalContainmentGate';
import {proposalDraftContentHash} from './proposalGateContract';
import type {
  ProposalMaterializationPlanner,
} from './proposalMaterializationPlanner';
import {
  evaluateProposalPairedReplay,
} from './proposalPairedReplayGate';
import {
  createProposalGateSnapshotEvidenceV1,
  type ProposalGateAttemptSessionV1,
  type ProposalStore,
} from './proposalStore';
import {
  materializeProposalCandidate,
  serializeProposalCandidateContent,
  type ProposalBaseSnapshotV1,
} from './proposalSemanticGate';
import {
  validateProposalStatic,
  type ProposalStaticGateOptions,
  type ProposalStaticValidationProofV1,
} from './proposalStaticGate';
import {
  materializeProposalTreatment,
  type ProposalTreatmentMaterializationV1,
} from './proposalTreatmentMaterializer';
import {
  evaluationFullTreatmentContractHash,
} from './evaluationTreatment';
import {
  PROPOSAL_SQL_GUARDRAIL_FINGERPRINT,
  PROPOSAL_SQL_REGRESSION_VERSION,
} from './proposalSqlRegression';
import type {ReplayRunResult} from './replayRunner';

const MAX_PROPOSAL_BYTES = 512 * 1024;
const MAX_DELTA_BYTES = 256 * 1024;
const MAX_OPS_PER_OVERLAY = 32;
const MAX_STEPS_PER_OP = 64;
const PROPOSAL_GATE_POLICY_VERSION = 2;

export interface ProposalPairedReplayExecution {
  replay: ReplayRunResult;
  cases: readonly EvalCaseV1[];
  store: EvalReplayRunStore;
  publisher: EvaluationReplayPublisher;
  resolveBaselinePhaseHint?(
    scene: string,
    hintId: string,
  ): PhaseHint | undefined;
}

export interface ProposalGateServiceOptions {
  store: ProposalStore;
  planner: ProposalMaterializationPlanner;
  resolveBaseSnapshot(
    proposal: CurationProposalV1,
  ): ProposalBaseSnapshotV1 | Promise<ProposalBaseSnapshotV1>;
  staticValidation: ProposalStaticGateOptions;
  resolveRepositoryTargetBinding?(
    proposal: CurationProposalV1,
  ): RepositoryTargetBindingV1 | undefined
    | Promise<RepositoryTargetBindingV1 | undefined>;
  runPairedReplay?(
    proposal: CurationProposalV1,
    candidate: ProposalCandidateMaterializationV1,
    treatment: ProposalTreatmentMaterializationV1,
    treatmentBinding: {
      candidateContentHash: string;
      treatmentArtifactContentHash: string;
      materializedInputHash: string;
      fullTreatmentContractHash: string;
    },
  ): Promise<ProposalPairedReplayExecution>;
  now?: () => Date;
}

export function proposalGatePolicyFingerprint(
  options: Pick<
    ProposalGateServiceOptions,
    'planner' | 'staticValidation' | 'resolveRepositoryTargetBinding'
  >,
): string {
  return canonicalContentHash({
    schemaVersion: PROPOSAL_GATE_POLICY_VERSION,
    gates: PROPOSAL_GATE_IDS,
    size: {
      maxProposalBytes: MAX_PROPOSAL_BYTES,
      maxDeltaBytes: MAX_DELTA_BYTES,
      maxOpsPerOverlay: MAX_OPS_PER_OVERLAY,
      maxStepsPerOp: MAX_STEPS_PER_OP,
    },
    containmentProtocolVersion: PROPOSAL_CONTAINMENT_PROTOCOL_VERSION,
    materializationRegistryContentHash:
      options.planner.registry.contentHash,
    staticValidationPolicyFingerprint:
      options.staticValidation.validationPolicyFingerprint,
    sqlRegressionVersion: PROPOSAL_SQL_REGRESSION_VERSION,
    sqlGuardrailFingerprint: PROPOSAL_SQL_GUARDRAIL_FINGERPRINT,
    pairedReplay: {
      epsilon: 0.02,
      validationAndHoldoutRequired: true,
      l0PassToFailForbidden: true,
      l1DimensionsNonCompensating: true,
      unavailableIsInconclusive: true,
    },
    runtimeTreatmentPolicy: {
      allowedTiers: ['T0', 'T1', 'T2', 'T3'],
      forbiddenTiers: ['T4', 'T5a'],
      forbiddenVerdict: 'inconclusive',
    },
    repositoryTargetBinding: {
      schemaVersion: 1,
      enabled: options.resolveRepositoryTargetBinding !== undefined,
      eligibleTiers: ['T4', 'T5a'],
    },
  });
}

export class ProposalGateService {
  private readonly now: () => Date;

  constructor(private readonly options: ProposalGateServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async gate(input: {
    scope: RunManifestScope;
    proposalId: string;
  }): Promise<CurationProposalV1> {
    const stored = this.options.store.get(input.scope, input.proposalId);
    if (!stored) throw new Error('curation_proposal_not_found');
    if (stored.status === 'gated') return stored;
    if (stored.status !== 'draft' || stored.revision !== 1) {
      throw new Error('curation_proposal_not_gateable');
    }
    const proposal = stored;
    const session = this.options.store.beginGateAttempt({
      scope: input.scope,
      proposalId: input.proposalId,
      gatePolicyFingerprint: proposalGatePolicyFingerprint(this.options),
      startedAt: this.now().toISOString(),
    });
    if (
      (proposal.tier === 'T4' || proposal.tier === 'T5a')
      && this.options.resolveRepositoryTargetBinding
    ) {
      const binding = await this.options.resolveRepositoryTargetBinding(
        proposal,
      );
      if (binding) {
        this.options.store.recordGateEvidence(
          session,
          'repository_target_binding',
          binding,
        );
      }
    }
    const checks = createEmptyChecks();
    let plan: ReturnType<ProposalMaterializationPlanner['plan']> | undefined;
    let containment: ProposalContainmentProbeV1 | undefined;
    let base: ProposalBaseSnapshotV1 | undefined;
    let candidate: ProposalCandidateMaterializationV1 | undefined;
    let treatment: ProposalTreatmentMaterializationV1 | undefined;
    let staticProof: ProposalStaticValidationProofV1 | undefined;
    let pairedProof:
      Awaited<ReturnType<typeof evaluateProposalPairedReplay>> | undefined;

    await runCheck(checks, 0, async () => ({
      verdict: 'passed',
      evidenceContentHashes: [proposalDraftContentHash(proposal)],
    }));

    if (priorPassed(checks, 1)) {
      await runCheck(checks, 1, async () => {
        plan = this.options.planner.plan(proposal);
        this.options.store.recordGateEvidence(
          session,
          'materialization_plan',
          plan,
        );
        containment = probeProposalContainment({
          plan,
          registry: this.options.planner.registry,
          serializedContent: serializeProposalCandidateContent(proposal),
        });
        this.options.store.recordGateEvidence(
          session,
          'containment_probe',
          containment,
        );
        return {
          verdict: containment.verdict,
          reasonCodes: containment.reasonCodes,
          evidenceContentHashes: [
            plan.contentHash,
            containment.contentHash,
          ],
        };
      });
    }

    if (priorPassed(checks, 2)) {
      await runCheck(checks, 2, async () => {
        const threats = scanContent(canonicalJsonString({
          title: proposal.title,
          rationale: proposal.rationale,
          expectedEffect: proposal.expectedEffect,
          delta: proposal.deltas[0],
        }));
        return {
          verdict: threats.length === 0 ? 'passed' : 'failed',
          reasonCodes: [...new Set(threats.map(threat =>
            `prompt_injection_${threat.kind}`))].sort(),
        };
      });
    }

    if (priorPassed(checks, 3)) {
      await runCheck(checks, 3, async () => sizeGate(proposal));
    }

    if (priorPassed(checks, 4)) {
      await runCheck(checks, 4, async () => {
        if (!plan) throw new Error('semantic_materialization_plan_missing');
        base = await this.options.resolveBaseSnapshot(proposal);
        const baseEvidence = createProposalGateSnapshotEvidenceV1(base);
        this.options.store.recordGateEvidence(
          session,
          'base_snapshot_initial',
          baseEvidence,
        );
        candidate = materializeProposalCandidate({proposal, plan, base});
        this.options.store.recordGateEvidence(
          session,
          'candidate_materialization',
          candidate,
        );
        treatment = materializeProposalTreatment({
          proposal,
          candidate,
          base: {
            skillRegistryFingerprint: base.skillRegistryFingerprint,
            strategyRegistryFingerprint: base.strategyRegistryFingerprint,
          },
        });
        return {
          verdict: 'passed',
          evidenceContentHashes: [
            baseEvidence.contentHash,
            candidate.contentHash,
          ],
        };
      });
    }

    if (priorPassed(checks, 5)) {
      await runCheck(checks, 5, async () => {
        if (!base) throw new Error('optimistic_base_snapshot_missing');
        const current = await this.options.resolveBaseSnapshot(proposal);
        const unchanged = baseSnapshotHash(base) === baseSnapshotHash(current);
        return {
          verdict: unchanged ? 'passed' : 'failed',
          reasonCodes: unchanged
            ? []
            : ['optimistic_concurrency_base_changed'],
        };
      });
    }

    if (priorPassed(checks, 6)) {
      await runCheck(checks, 6, async () => {
        if (!candidate || !base) throw new Error('static_candidate_missing');
        staticProof = await validateProposalStatic({
          proposal,
          candidate,
          base,
          gateAttempt: gateAttemptBinding(session),
          options: this.options.staticValidation,
        });
        this.options.store.recordGateEvidence(
          session,
          'static_validation',
          staticProof,
        );
        if (staticProof.sqlRegressionProof) {
          this.options.store.recordGateEvidence(
            session,
            'sql_regression',
            staticProof.sqlRegressionProof,
          );
        }
        return {
          verdict: staticProof.verdict,
          reasonCodes: staticProof.validatorCodes,
          evidenceContentHashes: [
            staticProof.contentHash,
            ...(staticProof.sqlRegressionProof
              ? [staticProof.sqlRegressionProof.contentHash]
              : []),
          ],
        };
      });
    }

    if (priorPassed(checks, 7)) {
      await runCheck(checks, 7, async () => {
        if (proposal.tier === 'T4' || proposal.tier === 'T5a') {
          return {
            verdict: 'inconclusive',
            reasonCodes: ['runtime_treatment_forbidden_by_tier'],
          };
        }
        if (!candidate || !treatment || !this.options.runPairedReplay) {
          return {
            verdict: 'inconclusive',
            reasonCodes: ['paired_replay_runner_unavailable'],
          };
        }
        const treatmentBinding = {
          candidateContentHash: candidate.contentHash,
          treatmentArtifactContentHash: treatment.artifact.contentHash,
          materializedInputHash: treatment.roleVariant.materializedInputHash,
          fullTreatmentContractHash:
            evaluationFullTreatmentContractHash(treatment.roleVariant),
        };
        const execution = await this.options.runPairedReplay(
          proposal,
          candidate,
          treatment,
          treatmentBinding,
        );
        pairedProof = await evaluateProposalPairedReplay({
          proposal,
          candidate,
          treatment,
          gateAttempt: gateAttemptBinding(session),
          ...execution,
        });
        this.options.store.recordGateEvidence(
          session,
          'paired_replay',
          pairedProof,
        );
        return {
          verdict: pairedProof.verdict,
          evidenceContentHashes: [pairedProof.contentHash],
        };
      });
    }

    if (plan && containment && base) {
      await this.applyFinalOptimisticFence({
        proposal,
        session,
        checks,
        planContentHash: plan.contentHash,
        containmentContentHash: containment.contentHash,
        base,
      });
    }

    return this.options.store.finalizeGateAttempt({
      session,
      checks,
      trustedEvidence: {
        ...(staticProof?.sqlRegressionProof
          ? {sqlRegressionProof: staticProof.sqlRegressionProof}
          : {}),
        ...(pairedProof ? {pairedReplayProof: pairedProof} : {}),
      },
      completedAt: this.now().toISOString(),
    });
  }

  private async applyFinalOptimisticFence(input: {
    proposal: CurationProposalV1;
    session: ProposalGateAttemptSessionV1;
    checks: ProposalGateCheckV1[];
    planContentHash: string;
    containmentContentHash: string;
    base: ProposalBaseSnapshotV1;
  }): Promise<void> {
    const started = Date.now();
    try {
      const refreshedPlan = this.options.planner.plan(input.proposal);
      const refreshedContainment = probeProposalContainment({
        plan: refreshedPlan,
        registry: this.options.planner.registry,
        serializedContent:
          serializeProposalCandidateContent(input.proposal),
      });
      this.options.store.recordGateEvidence(
        input.session,
        'containment_probe_final',
        refreshedContainment,
      );
      const refreshedBase = await this.options.resolveBaseSnapshot(
        input.proposal,
      );
      const finalBaseEvidence =
        createProposalGateSnapshotEvidenceV1(refreshedBase);
      this.options.store.recordGateEvidence(
        input.session,
        'base_snapshot_final',
        finalBaseEvidence,
      );
      const unchanged =
        input.checks[5].verdict === 'passed'
        && refreshedPlan.contentHash === input.planContentHash
        && refreshedContainment.verdict === 'passed'
        && refreshedContainment.contentHash
          === input.containmentContentHash
        && baseSnapshotHash(refreshedBase) === baseSnapshotHash(input.base);
      replaceCheck(input.checks, 5, {
        verdict: unchanged ? 'passed' : 'failed',
        reasonCodes: unchanged
          ? []
          : input.checks[5].verdict === 'failed'
            ? input.checks[5].reasonCodes
            : ['optimistic_concurrency_changed_during_gate'],
        evidenceContentHashes: [
          refreshedContainment.contentHash,
          finalBaseEvidence.contentHash,
        ],
        durationMs: input.checks[5].durationMs + Date.now() - started,
      });
    } catch {
      replaceCheck(input.checks, 5, {
        verdict: 'failed',
        reasonCodes: ['optimistic_concurrency_final_probe_failed'],
        durationMs: input.checks[5].durationMs + Date.now() - started,
      });
    }
  }
}

interface CheckOutcome {
  verdict: ProposalGateVerdict;
  reasonCodes?: string[];
  evidenceContentHashes?: string[];
}

function gateAttemptBinding(session: ProposalGateAttemptSessionV1): {
  attemptId: string;
  ordinal: number;
  gatePolicyFingerprint: string;
} {
  return {
    attemptId: session.attemptId,
    ordinal: session.ordinal,
    gatePolicyFingerprint: session.gatePolicyFingerprint,
  };
}

function createEmptyChecks(): ProposalGateCheckV1[] {
  return PROPOSAL_GATE_IDS.map(gateId => ({
    schemaVersion: 1,
    gateId,
    verdict: 'not_run',
    reasonCodes: [],
    evidenceContentHashes: [],
    durationMs: 0,
  }));
}

async function runCheck(
  checks: ProposalGateCheckV1[],
  index: number,
  execute: () => Promise<CheckOutcome>,
): Promise<void> {
  const started = Date.now();
  try {
    replaceCheck(checks, index, {
      ...await execute(),
      durationMs: Date.now() - started,
    });
  } catch (error) {
    replaceCheck(checks, index, {
      verdict: errorVerdict(error),
      reasonCodes: [safeErrorCode(error, checks[index].gateId)],
      durationMs: Date.now() - started,
    });
  }
}

function replaceCheck(
  checks: ProposalGateCheckV1[],
  index: number,
  outcome: CheckOutcome & {durationMs?: number},
): void {
  checks[index] = {
    schemaVersion: 1,
    gateId: checks[index].gateId,
    verdict: outcome.verdict,
    reasonCodes: [...new Set(outcome.reasonCodes ?? [])].sort(),
    evidenceContentHashes: [
      ...new Set(outcome.evidenceContentHashes ?? []),
    ].sort(),
    durationMs: outcome.durationMs ?? checks[index].durationMs,
  };
}

function priorPassed(
  checks: readonly ProposalGateCheckV1[],
  index: number,
): boolean {
  return checks.slice(0, index).every(check => check.verdict === 'passed');
}

function sizeGate(proposal: CurationProposalV1): CheckOutcome {
  const delta = proposal.deltas[0];
  const reasonCodes: string[] = [];
  if (
    Buffer.byteLength(canonicalJsonString(proposal), 'utf8')
      > MAX_PROPOSAL_BYTES
  ) {
    reasonCodes.push('size_proposal_too_large');
  }
  if (
    Buffer.byteLength(delta.after ?? '', 'utf8')
      > MAX_DELTA_BYTES
  ) {
    reasonCodes.push('size_delta_too_large');
  }
  if (proposal.kind === 'skill_overlay_delta' && delta.after) {
    try {
      const overlay = JSON.parse(delta.after) as {
        operations?: Array<{steps?: unknown[]}>;
      };
      if (
        !Array.isArray(overlay.operations)
        || overlay.operations.length > MAX_OPS_PER_OVERLAY
      ) {
        reasonCodes.push('size_overlay_operation_limit');
      } else if (overlay.operations.some(operation =>
        Array.isArray(operation.steps)
        && operation.steps.length > MAX_STEPS_PER_OP)) {
        reasonCodes.push('size_overlay_step_limit');
      }
    } catch {
      reasonCodes.push('size_overlay_not_structured');
    }
  }
  return {
    verdict: reasonCodes.length === 0 ? 'passed' : 'failed',
    reasonCodes,
  };
}

function baseSnapshotHash(value: ProposalBaseSnapshotV1): string {
  return canonicalContentHash(value);
}

function errorVerdict(error: unknown): ProposalGateVerdict {
  const code = error instanceof Error ? error.message : '';
  return (
    code.includes('unavailable')
    || code.includes('timeout')
    || code.includes('cancel')
    || code.includes('inconclusive')
  ) ? 'inconclusive' : 'failed';
}

function safeErrorCode(error: unknown, gateId: ProposalGateId): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{3,160}$/.test(message)
    ? message
    : `${gateId}_gate_failed`;
}

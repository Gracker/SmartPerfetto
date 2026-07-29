// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import yaml from 'js-yaml';

import {
  buildStrategyRegistrySnapshot,
  type StrategyRegistryContribution,
} from '../../agentv3/strategyLoader';
import type {
  CurationProposalV1,
  ProposalCandidateMaterializationV1,
  ProposalGateVerdict,
  ProposalSqlRegressionProofV1,
} from '../../types/selfEvolution';
import {normalizeSkillDefinition} from '../skillEngine/skillLoader';
import type {SkillDefinition} from '../skillEngine/types';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
} from '../sqlGuardrailAnalyzer';
import {SQLValidator} from '../sqlValidator';
import {canonicalContentHash, immutableCanonicalSnapshot} from './canonicalJson';
import {
  composeEffectiveSkills,
  type EffectiveSkillCompositionResult,
} from './effectiveSkillComposer';
import {
  validateSkillDefinitionsInProcess,
  validateStrategyDefinitionsInProcess,
} from './inProcessValidator';
import {
  parseProposalSqlRegressionProofV1,
  parseProposalCandidateMaterializationV1,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';
import {runManagedProposalSqlRegression} from './proposalSqlRegression';
import {buildSkillRegistryAttribution} from './skillFingerprint';
import type {ProposalBaseSnapshotV1} from './proposalSemanticGate';

export interface ProposalStaticValidationProofV1 {
  schemaVersion: 1;
  proposalId: string;
  candidateMaterializationContentHash: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gatePolicyFingerprint: string;
  validationPolicyFingerprint: string;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
  effectiveRegistryFingerprint?: string;
  validatorCodes: string[];
  warningCodes: string[];
  sqlRegressionProof?: ProposalSqlRegressionProofV1;
  verdict: Exclude<ProposalGateVerdict, 'not_run'>;
  contentHash: string;
}

export interface ProposalStaticGateOptions {
  validationPolicyFingerprint: string;
  skillSnapshot?: {
    definitions: readonly SkillDefinition[];
    fragments?: ReadonlyMap<string, string>;
    origins?: ReadonlyMap<string, SkillOriginMetadata>;
    existingOverlays?: readonly unknown[];
  };
  strategySnapshot?: {
    existingContributions?: readonly StrategyRegistryContribution[];
    knownSkillIds: ReadonlySet<string>;
  };
  sqlRegression?: {
    repoRoot: string;
    uploadDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  };
}

export async function validateProposalStatic(input: {
  proposal: CurationProposalV1;
  candidate: ProposalCandidateMaterializationV1;
  base: ProposalBaseSnapshotV1;
  gateAttempt: {
    attemptId: string;
    ordinal: number;
    gatePolicyFingerprint: string;
  };
  options: ProposalStaticGateOptions;
}): Promise<ProposalStaticValidationProofV1> {
  const proposal = parseM6DraftProposal(input.proposal);
  const candidate = parseProposalCandidateMaterializationV1(input.candidate);
  const errors = new Set<string>();
  const warnings = new Set<string>();
  let sqlRegressionProof: ProposalSqlRegressionProofV1 | undefined;
  let effectiveRegistryFingerprint: string | undefined;

  if (!/^[0-9a-f]{64}$/.test(input.options.validationPolicyFingerprint)) {
    throw new Error('static_validation_policy_fingerprint_invalid');
  }

  if (proposal.kind === 'new_skill_draft') {
    const parsed = normalizeSkillDefinition(
      yaml.load(candidate.serializedContent),
      'proposal/new-skill.skill.yaml',
    );
    if (!parsed) {
      errors.add('static_skill_yaml_invalid');
    } else {
      const existing = input.options.skillSnapshot?.definitions ?? [];
      collectSkillValidation([...existing, parsed], errors, warnings);
    }
  } else if (
    proposal.kind === 'skill_overlay_delta'
  ) {
    const snapshot = input.options.skillSnapshot;
    if (!snapshot || snapshot.definitions.length === 0) {
      errors.add('static_effective_skill_snapshot_unavailable');
    } else {
      const existing = composeEffectiveSkills({
        scope: proposal.scope,
        baseSkills: snapshot.definitions,
        fragments: snapshot.fragments,
        overlays: snapshot.existingOverlays ?? [],
      });
      const candidateComposition = composeEffectiveSkills({
        scope: proposal.scope,
        baseSkills: snapshot.definitions,
        fragments: snapshot.fragments,
        overlays: [
          ...(snapshot.existingOverlays ?? []),
          JSON.parse(candidate.serializedContent),
        ],
      });
      if (
        existing.validationState !== 'passed'
        || candidateComposition.validationState !== 'passed'
        || skillRegistryFingerprint(existing, snapshot)
          !== input.base.skillRegistryFingerprint
      ) {
        errors.add('static_effective_skill_composition_invalid');
      } else {
        effectiveRegistryFingerprint = skillRegistryFingerprint(
          candidateComposition,
          snapshot,
        );
        collectSkillValidation(
          candidateComposition.skills,
          errors,
          warnings,
        );
      }
    }
  } else if (proposal.kind === 'strategy_section') {
    const snapshot = input.options.strategySnapshot;
    if (!snapshot) {
      errors.add('static_effective_strategy_snapshot_unavailable');
    } else {
      try {
        const existing = buildStrategyRegistrySnapshot({
          scope: proposal.scope,
          overlayGeneration: proposal.expectedOverlayGeneration,
          contributions: snapshot.existingContributions ?? [],
        });
        const candidateSnapshot = buildStrategyRegistrySnapshot({
          scope: proposal.scope,
          overlayGeneration: proposal.expectedOverlayGeneration,
          contributions: [
            ...(snapshot.existingContributions ?? []),
            JSON.parse(candidate.serializedContent),
          ],
        });
        if (
          existing.registryFingerprint
            !== input.base.strategyRegistryFingerprint
        ) {
          errors.add('static_strategy_base_snapshot_mismatch');
        } else {
          effectiveRegistryFingerprint =
            candidateSnapshot.registryFingerprint;
          const validation = validateStrategyDefinitionsInProcess({
            definitions: candidateSnapshot.getAllStrategies(),
            knownSkillIds: snapshot.knownSkillIds,
          });
          for (const issue of validation.issues) errors.add(issue.code);
        }
      } catch {
        errors.add('static_effective_strategy_composition_invalid');
      }
    }
  } else if (proposal.kind !== 'skill_sql') {
    try {
      JSON.parse(candidate.serializedContent);
    } catch {
      errors.add('static_structured_candidate_invalid');
    }
  }

  if (proposal.kind === 'skill_sql') {
    const snapshot = input.options.skillSnapshot;
    if (!snapshot || snapshot.definitions.length === 0) {
      errors.add('static_effective_skill_snapshot_unavailable');
    } else {
      const existing = composeEffectiveSkills({
        scope: proposal.scope,
        baseSkills: snapshot.definitions,
        fragments: snapshot.fragments,
        overlays: snapshot.existingOverlays ?? [],
      });
      if (
        existing.validationState !== 'passed'
        || skillRegistryFingerprint(existing, snapshot)
          !== input.base.skillRegistryFingerprint
      ) {
        errors.add('static_skill_base_snapshot_mismatch');
      } else {
        collectSkillValidation(existing.skills, errors, warnings);
      }
    }
    const sql = candidate.serializedContent;
    const validation = new SQLValidator().validateSQL(sql);
    validation.errors.forEach(() => errors.add('static_sql_validator_error'));
    validation.warnings.forEach(() =>
      warnings.add('static_sql_validator_warning'));
    const guardrails = analyzeSqlGuardrails(sql, {
      includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
    });
    guardrails.forEach(issue =>
      errors.add(`static_sql_guardrail_${issue.ruleId}`));
    if (!input.options.sqlRegression) {
      errors.add('static_sql_regression_unavailable');
    } else if (errors.size === 0) {
      try {
        sqlRegressionProof = await runManagedProposalSqlRegression({
          proposal,
          candidate,
          baselineSql: input.base.anchorContent!,
          gateAttemptId: input.gateAttempt.attemptId,
          gateAttemptOrdinal: input.gateAttempt.ordinal,
          gatePolicyFingerprint:
            input.gateAttempt.gatePolicyFingerprint,
          ...input.options.sqlRegression,
        });
        if (sqlRegressionProof.verdict !== 'passed') {
          errors.add(
            sqlRegressionProof.verdict === 'failed'
              ? 'static_sql_regression_failed'
              : 'static_sql_regression_inconclusive',
          );
        }
      } catch {
        errors.add('static_sql_regression_inconclusive');
      }
    }
  }

  const verdict: ProposalStaticValidationProofV1['verdict'] =
    errors.size === 0
    ? 'passed'
    : errors.has('static_sql_regression_inconclusive')
      || errors.has('static_sql_regression_unavailable')
      ? 'inconclusive'
      : 'failed';
  const withoutHash = {
    schemaVersion: 1 as const,
    proposalId: proposal.proposalId,
    candidateMaterializationContentHash: candidate.contentHash,
    gateAttemptId: input.gateAttempt.attemptId,
    gateAttemptOrdinal: input.gateAttempt.ordinal,
    gatePolicyFingerprint: input.gateAttempt.gatePolicyFingerprint,
    validationPolicyFingerprint:
      input.options.validationPolicyFingerprint,
    baseSkillRegistryFingerprint: input.base.skillRegistryFingerprint,
    baseStrategyRegistryFingerprint: input.base.strategyRegistryFingerprint,
    ...(effectiveRegistryFingerprint
      ? {effectiveRegistryFingerprint}
      : {}),
    validatorCodes: [...errors].sort(),
    warningCodes: [...warnings].sort(),
    ...(sqlRegressionProof ? {sqlRegressionProof} : {}),
    verdict,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseProposalStaticValidationProofV1(
  value: unknown,
): ProposalStaticValidationProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('proposal_static_validation_proof_invalid');
  }
  const proof = value as ProposalStaticValidationProofV1;
  const allowed = new Set([
    'schemaVersion',
    'proposalId',
    'candidateMaterializationContentHash',
    'gateAttemptId',
    'gateAttemptOrdinal',
    'gatePolicyFingerprint',
    'validationPolicyFingerprint',
    'baseSkillRegistryFingerprint',
    'baseStrategyRegistryFingerprint',
    'effectiveRegistryFingerprint',
    'validatorCodes',
    'warningCodes',
    'sqlRegressionProof',
    'verdict',
    'contentHash',
  ]);
  if (
    proof.schemaVersion !== 1
    || Object.keys(proof).some(key => !allowed.has(key))
    || !proof.proposalId?.trim()
    || !proof.gateAttemptId?.trim()
    || !Number.isSafeInteger(proof.gateAttemptOrdinal)
    || proof.gateAttemptOrdinal < 1
    || [
      proof.candidateMaterializationContentHash,
      proof.gatePolicyFingerprint,
      proof.validationPolicyFingerprint,
      proof.baseSkillRegistryFingerprint,
      proof.baseStrategyRegistryFingerprint,
      proof.contentHash,
      ...(proof.effectiveRegistryFingerprint
        ? [proof.effectiveRegistryFingerprint]
        : []),
    ].some(hash => !/^[0-9a-f]{64}$/.test(hash))
    || !Array.isArray(proof.validatorCodes)
    || !Array.isArray(proof.warningCodes)
    || !['passed', 'failed', 'inconclusive'].includes(proof.verdict)
  ) {
    throw new Error('proposal_static_validation_proof_invalid');
  }
  const normalized = immutableCanonicalSnapshot({
    ...proof,
    validatorCodes: [...proof.validatorCodes].sort(),
    warningCodes: [...proof.warningCodes].sort(),
    ...(proof.sqlRegressionProof
      ? {
          sqlRegressionProof: parseProposalSqlRegressionProofV1(
            proof.sqlRegressionProof,
          ),
        }
      : {}),
  });
  const {contentHash, ...withoutHash} = normalized;
  if (
    canonicalContentHash(withoutHash) !== contentHash
    || (normalized.verdict === 'passed'
      && normalized.validatorCodes.length > 0)
  ) {
    throw new Error('proposal_static_validation_proof_hash_mismatch');
  }
  return normalized;
}

function skillRegistryFingerprint(
  composition: Extract<
    EffectiveSkillCompositionResult,
    {validationState: 'passed'}
  >,
  snapshot: NonNullable<ProposalStaticGateOptions['skillSnapshot']>,
): string {
  return buildSkillRegistryAttribution({
    getAllSkills: () => [...composition.skills],
    getSkillOrigin: skillId => snapshot.origins?.get(skillId),
    getFragmentCache: () => new Map(snapshot.fragments ?? []),
    getAppliedOverlayIds: skillId =>
      composition.appliedOverlayIds[skillId] ?? [],
  }).registryFingerprint;
}

function collectSkillValidation(
  definitions: readonly SkillDefinition[],
  errors: Set<string>,
  warnings: Set<string>,
): void {
  const validation = validateSkillDefinitionsInProcess({definitions});
  for (const issue of validation.issues) {
    if (issue.severity === 'error') errors.add(issue.code);
    else warnings.add(issue.code);
  }
}

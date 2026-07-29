// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  ProposalCandidateMaterializationV1,
  ProposalGateCheckV1,
  ProposalGateResultV1,
  ProposalGateVerdict,
  ProposalMaterializationPlanV1,
  ProposalPairedReplayProofV1,
  RepositoryTargetBindingV1,
  ProposalSqlRegressionProofV1,
} from '../../types/selfEvolution';
import {
  PROPOSAL_GATE_IDS,
  PROPOSAL_KINDS,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {parseM6DraftProposal} from './proposalContract';

const HASH_RE = /^[0-9a-f]{64}$/;
const GATE_VERDICTS = new Set<ProposalGateVerdict>([
  'not_run',
  'passed',
  'failed',
  'inconclusive',
]);

export function proposalDraftContentHash(value: unknown): string {
  return canonicalContentHash(parseM6DraftProposal(value));
}

export function parseProposalGateResultV1(
  value: unknown,
): ProposalGateResultV1 {
  const result = record(value, 'proposal_gate_result_invalid');
  exactKeys(result, [
    'schemaVersion',
    'proposalId',
    'gateAttemptId',
    'gateAttemptOrdinal',
    'gatePolicyFingerprint',
    'draftRevision',
    'gatedRevision',
    'draftContentHash',
    'startedAt',
    'completedAt',
    'checks',
    'overallVerdict',
    'pairedGateVerdict',
    'materializationPlanContentHash',
    'candidateMaterializationContentHash',
    'sqlRegressionProofContentHash',
    'pairedReplayProofContentHash',
    'contentHash',
  ], [
    'materializationPlanContentHash',
    'candidateMaterializationContentHash',
    'sqlRegressionProofContentHash',
    'pairedReplayProofContentHash',
  ]);
  if (
    result.schemaVersion !== 1
    || result.draftRevision !== 1
    || result.gatedRevision !== 2
    || !nonEmpty(result.proposalId)
    || !nonEmpty(result.gateAttemptId)
    || !positiveInteger(result.gateAttemptOrdinal)
    || !hash(result.gatePolicyFingerprint)
    || !hash(result.draftContentHash)
    || !validDate(result.startedAt)
    || !validDate(result.completedAt)
  ) {
    fail('proposal_gate_result_invalid');
  }
  const checks = parseChecks(result.checks);
  const overallVerdict = parseTerminalVerdict(
    result.overallVerdict,
    'proposal_gate_overall_verdict_invalid',
  );
  if (!GATE_VERDICTS.has(result.pairedGateVerdict as ProposalGateVerdict)) {
    fail('proposal_gate_paired_verdict_invalid');
  }
  const pairedGateVerdict = result.pairedGateVerdict as ProposalGateVerdict;
  const expectedOverall = checks.every(check => check.verdict === 'passed')
    ? 'passed'
    : checks.some(check => check.verdict === 'failed')
      ? 'failed'
      : 'inconclusive';
  if (
    checks[checks.length - 1].verdict !== pairedGateVerdict
    || overallVerdict !== expectedOverall
    || Date.parse(result.completedAt as string)
      < Date.parse(result.startedAt as string)
  ) {
    fail('proposal_gate_verdict_invariant_failed');
  }
  for (const key of [
    'materializationPlanContentHash',
    'candidateMaterializationContentHash',
    'sqlRegressionProofContentHash',
    'pairedReplayProofContentHash',
  ] as const) {
    if (result[key] !== undefined && !hash(result[key])) {
      fail(`proposal_gate_${key}_invalid`);
    }
  }
  const evidenceBindings = [
    [result.materializationPlanContentHash, checks[1]],
    [result.candidateMaterializationContentHash, checks[4]],
    [result.sqlRegressionProofContentHash, checks[6]],
    [result.pairedReplayProofContentHash, checks[7]],
  ] as const;
  if (
    evidenceBindings.some(([contentHash, check]) =>
      contentHash !== undefined
      && !check.evidenceContentHashes.includes(contentHash as string))
    || (
      overallVerdict === 'passed'
      && (
        result.materializationPlanContentHash === undefined
        || result.candidateMaterializationContentHash === undefined
        || result.pairedReplayProofContentHash === undefined
      )
    )
  ) {
    fail('proposal_gate_evidence_binding_invalid');
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    proposalId: result.proposalId as string,
    gateAttemptId: result.gateAttemptId as string,
    gateAttemptOrdinal: result.gateAttemptOrdinal as number,
    gatePolicyFingerprint: result.gatePolicyFingerprint as string,
    draftRevision: 1 as const,
    gatedRevision: 2 as const,
    draftContentHash: result.draftContentHash as string,
    startedAt: result.startedAt as string,
    completedAt: result.completedAt as string,
    checks,
    overallVerdict,
    pairedGateVerdict,
    ...(result.materializationPlanContentHash !== undefined
      ? {materializationPlanContentHash:
        result.materializationPlanContentHash as string}
      : {}),
    ...(result.candidateMaterializationContentHash !== undefined
      ? {candidateMaterializationContentHash:
        result.candidateMaterializationContentHash as string}
      : {}),
    ...(result.sqlRegressionProofContentHash !== undefined
      ? {sqlRegressionProofContentHash:
        result.sqlRegressionProofContentHash as string}
      : {}),
    ...(result.pairedReplayProofContentHash !== undefined
      ? {pairedReplayProofContentHash:
        result.pairedReplayProofContentHash as string}
      : {}),
  };
  if (
    !hash(result.contentHash)
    || canonicalContentHash(withoutHash) !== result.contentHash
  ) {
    fail('proposal_gate_result_hash_mismatch');
  }
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: result.contentHash as string,
  });
}

export function createProposalGateResultV1(
  value: Omit<ProposalGateResultV1, 'schemaVersion' | 'contentHash'>,
): ProposalGateResultV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    ...value,
  };
  return parseProposalGateResultV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseCurationProposalV1(
  value: unknown,
): CurationProposalV1 {
  const proposal = record(value, 'proposal_invalid');
  if (proposal.status === 'draft') return parseM6DraftProposal(proposal);
  const expectedRevision = {
    gated: 2,
    accepted: 3,
    rejected: 3,
    applied: 4,
    reverted: 5,
  }[String(proposal.status)];
  if (expectedRevision === undefined || proposal.revision !== expectedRevision) {
    fail('proposal_status_revision_invalid');
  }
  const draftInput: Record<string, unknown> = {
    ...proposal,
    revision: 1,
    status: 'draft',
    pairedGateVerdict: 'not_run',
  };
  delete draftInput.gateResult;
  delete draftInput.activeActionId;
  const draft = parseM6DraftProposal(draftInput);
  const gateResult = parseProposalGateResultV1(proposal.gateResult);
  const draftHash = proposalDraftContentHash(draft);
  if (
    gateResult.proposalId !== draft.proposalId
    || gateResult.draftContentHash !== draftHash
    || proposal.pairedGateVerdict !== gateResult.pairedGateVerdict
  ) {
    fail('proposal_gate_result_binding_mismatch');
  }
  if (
    proposal.activeActionId !== undefined
    && (
      !nonEmpty(proposal.activeActionId)
      || !['accepted', 'applied'].includes(String(proposal.status))
    )
  ) {
    fail('proposal_active_action_invalid');
  }
  return immutableCanonicalSnapshot({
    ...draft,
    revision: expectedRevision,
    pairedGateVerdict: gateResult.pairedGateVerdict,
    gateResult,
    ...(proposal.activeActionId === undefined
      ? {}
      : {activeActionId: proposal.activeActionId as string}),
    status: proposal.status as
      'gated' | 'accepted' | 'rejected' | 'applied' | 'reverted',
  });
}

export function assertProposalEligibleForAcceptance(
  value: unknown,
): CurationProposalV1 {
  const proposal = parseCurationProposalV1(value);
  if (
    proposal.status !== 'gated'
    || proposal.revision !== 2
    || !gateResultPassed(proposal)
  ) {
    fail('proposal_not_eligible_for_acceptance');
  }
  return proposal;
}

export function assertProposalEligibleForApply(
  value: unknown,
): CurationProposalV1 {
  const proposal = parseCurationProposalV1(value);
  if (
    proposal.status !== 'accepted'
    || proposal.revision !== 3
    || proposal.activeActionId !== undefined
    || !gateResultPassed(proposal)
  ) {
    fail('proposal_not_eligible_for_apply');
  }
  return proposal;
}

function gateResultPassed(proposal: CurationProposalV1): boolean {
  return proposal.gateResult?.overallVerdict === 'passed'
    && proposal.gateResult.pairedGateVerdict === 'passed'
    && proposal.pairedGateVerdict === 'passed'
    && proposal.gateResult.checks.every(check => check.verdict === 'passed');
}

export function createRepositoryTargetBindingV1(
  value: Omit<RepositoryTargetBindingV1, 'schemaVersion' | 'contentHash'>,
): RepositoryTargetBindingV1 {
  return parseRepositoryTargetBindingV1(withHash(value));
}

export function parseRepositoryTargetBindingV1(
  value: unknown,
): RepositoryTargetBindingV1 {
  return parseContentHashedArtifact(
    value,
    'repository_target_binding_invalid',
    artifact => {
      exactKeys(artifact, [
        'schemaVersion',
        'proposalId',
        'proposalRevision',
        'repositoryRootIdentityHash',
        'repositoryRelativePath',
        'allowedRoot',
        'baseCommit',
        'baseBlobOid',
        'baseFileMode',
        'baseFileContentHash',
        'structuralPath',
        'anchorFingerprint',
        'proposedFileContent',
        'proposedFileContentHash',
        'symlinkFree',
        'containmentVerified',
        'contentHash',
      ]);
      if (
        artifact.schemaVersion !== 1
        || !nonEmpty(artifact.proposalId)
        || artifact.proposalRevision !== 1
        || !hash(artifact.repositoryRootIdentityHash)
        || !safeRelativePath(artifact.repositoryRelativePath)
        || !safeRelativePath(artifact.allowedRoot)
        || !/^[0-9a-f]{40,64}$/.test(String(artifact.baseCommit))
        || !/^[0-9a-f]{40,64}$/.test(String(artifact.baseBlobOid))
        || !/^[0-7]{6}$/.test(String(artifact.baseFileMode))
        || !hash(artifact.baseFileContentHash)
        || !nonEmpty(artifact.structuralPath)
        || !hash(artifact.anchorFingerprint)
        || typeof artifact.proposedFileContent !== 'string'
        || !hash(artifact.proposedFileContentHash)
        || artifact.proposedFileContentHash
          !== canonicalContentHash(artifact.proposedFileContent)
        || artifact.symlinkFree !== true
        || artifact.containmentVerified !== true
      ) {
        fail('repository_target_binding_invalid');
      }
      return {
        schemaVersion: 1,
        proposalId: artifact.proposalId as string,
        proposalRevision: 1,
        repositoryRootIdentityHash:
          artifact.repositoryRootIdentityHash as string,
        repositoryRelativePath: artifact.repositoryRelativePath as string,
        allowedRoot: artifact.allowedRoot as string,
        baseCommit: artifact.baseCommit as string,
        baseBlobOid: artifact.baseBlobOid as string,
        baseFileMode: artifact.baseFileMode as string,
        baseFileContentHash: artifact.baseFileContentHash as string,
        structuralPath: artifact.structuralPath as string,
        anchorFingerprint: artifact.anchorFingerprint as string,
        proposedFileContent: artifact.proposedFileContent as string,
        proposedFileContentHash: artifact.proposedFileContentHash as string,
        symlinkFree: true,
        containmentVerified: true,
      };
    },
  );
}

export function parseProposalMaterializationPlanV1(
  value: unknown,
): ProposalMaterializationPlanV1 {
  return parseContentHashedArtifact(
    value,
    'proposal_materialization_plan_invalid',
    artifact => {
      exactKeys(artifact, [
        'schemaVersion',
        'proposalId',
        'proposalRevision',
        'proposalKind',
        'draftContentHash',
        'materializationRegistryContentHash',
        'rootId',
        'rootIdentityHash',
        'relativeTargetPath',
        'targetKind',
        'tier',
        'channel',
        'fileExtension',
        'archiveEntries',
        'baseContentHash',
        'expectedRegistryFingerprint',
        'expectedOverlayGeneration',
        'contentHash',
      ]);
      if (
        artifact.schemaVersion !== 1
        || artifact.proposalRevision !== 1
        || !nonEmpty(artifact.proposalId)
        || !PROPOSAL_KINDS.includes(artifact.proposalKind as never)
        || !hash(artifact.draftContentHash)
        || !hash(artifact.materializationRegistryContentHash)
        || !nonEmpty(artifact.rootId)
        || !hash(artifact.rootIdentityHash)
        || !safeRelativePath(artifact.relativeTargetPath)
        || ![
          'skill_overlay',
          'strategy_overlay',
          'skill_note',
          'injection',
        ].includes(String(artifact.targetKind))
        || !['T0', 'T1', 'T2', 'T3', 'T4', 'T5a'].includes(
          String(artifact.tier),
        )
        || ![
          'runtime_overlay',
          'maintainer_draft',
          'contribution_bundle',
        ].includes(String(artifact.channel))
        || !['.json', '.yaml', '.md', '.sql'].includes(
          String(artifact.fileExtension),
        )
        || !Array.isArray(artifact.archiveEntries)
        || !hash(artifact.baseContentHash)
        || !hash(artifact.expectedRegistryFingerprint)
        || !nonEmpty(artifact.expectedOverlayGeneration)
      ) {
        fail('proposal_materialization_plan_invalid');
      }
      const entries = artifact.archiveEntries.map((entryValue: unknown) => {
        const entry = record(
          entryValue,
          'proposal_materialization_archive_entry_invalid',
        );
        exactKeys(entry, ['relativePath', 'contentHash']);
        if (!safeRelativePath(entry.relativePath) || !hash(entry.contentHash)) {
          fail('proposal_materialization_archive_entry_invalid');
        }
        return {
          relativePath: entry.relativePath as string,
          contentHash: entry.contentHash as string,
        };
      });
      return {
        schemaVersion: 1 as const,
        proposalId: artifact.proposalId as string,
        proposalRevision: 1 as const,
        proposalKind:
          artifact.proposalKind as ProposalMaterializationPlanV1['proposalKind'],
        draftContentHash: artifact.draftContentHash as string,
        materializationRegistryContentHash:
          artifact.materializationRegistryContentHash as string,
        rootId: artifact.rootId as string,
        rootIdentityHash: artifact.rootIdentityHash as string,
        relativeTargetPath: artifact.relativeTargetPath as string,
        targetKind:
          artifact.targetKind as ProposalMaterializationPlanV1['targetKind'],
        tier: artifact.tier as ProposalMaterializationPlanV1['tier'],
        channel: artifact.channel as ProposalMaterializationPlanV1['channel'],
        fileExtension:
          artifact.fileExtension as ProposalMaterializationPlanV1['fileExtension'],
        archiveEntries: entries,
        baseContentHash: artifact.baseContentHash as string,
        expectedRegistryFingerprint:
          artifact.expectedRegistryFingerprint as string,
        expectedOverlayGeneration:
          artifact.expectedOverlayGeneration as string,
      };
    },
  );
}

export function createProposalMaterializationPlanV1(
  value: Omit<ProposalMaterializationPlanV1, 'schemaVersion' | 'contentHash'>,
): ProposalMaterializationPlanV1 {
  return parseProposalMaterializationPlanV1(withHash(value));
}

export function parseProposalCandidateMaterializationV1(
  value: unknown,
): ProposalCandidateMaterializationV1 {
  return parseContentHashedArtifact(
    value,
    'proposal_candidate_materialization_invalid',
    artifact => {
      exactKeys(artifact, [
        'schemaVersion',
        'proposalId',
        'proposalRevision',
        'draftContentHash',
        'planContentHash',
        'artifactId',
        'targetKind',
        'serializedContent',
        'serializedContentHash',
        'contentHash',
      ]);
      if (
        artifact.schemaVersion !== 1
        || artifact.proposalRevision !== 1
        || !nonEmpty(artifact.proposalId)
        || !hash(artifact.draftContentHash)
        || !hash(artifact.planContentHash)
        || !nonEmpty(artifact.artifactId)
        || ![
          'skill_overlay',
          'strategy_overlay',
          'skill_note',
          'injection',
        ].includes(String(artifact.targetKind))
        || typeof artifact.serializedContent !== 'string'
        || canonicalContentHash(artifact.serializedContent)
          !== artifact.serializedContentHash
      ) {
        fail('proposal_candidate_materialization_invalid');
      }
      return {
        schemaVersion: 1 as const,
        proposalId: artifact.proposalId as string,
        proposalRevision: 1 as const,
        draftContentHash: artifact.draftContentHash as string,
        planContentHash: artifact.planContentHash as string,
        artifactId: artifact.artifactId as string,
        targetKind:
          artifact.targetKind as ProposalCandidateMaterializationV1['targetKind'],
        serializedContent: artifact.serializedContent as string,
        serializedContentHash: artifact.serializedContentHash as string,
      };
    },
  );
}

export function createProposalCandidateMaterializationV1(
  value: Omit<
    ProposalCandidateMaterializationV1,
    'schemaVersion' | 'contentHash' | 'serializedContentHash'
  >,
): ProposalCandidateMaterializationV1 {
  return parseProposalCandidateMaterializationV1(withHash({
    ...value,
    serializedContentHash: canonicalContentHash(value.serializedContent),
  }));
}

export function parseProposalSqlRegressionProofV1(
  value: unknown,
): ProposalSqlRegressionProofV1 {
  return parseContentHashedArtifact(
    value,
    'proposal_sql_regression_proof_invalid',
    artifact => {
      exactKeys(artifact, [
        'schemaVersion',
        'proposalId',
        'proposalRevision',
        'gateAttemptId',
        'gateAttemptOrdinal',
        'gatePolicyFingerprint',
        'draftContentHash',
        'candidateMaterializationContentHash',
        'corpusFingerprint',
        'traceProcessorVersion',
        'sqlValidatorVersion',
        'sqlGuardrailFingerprint',
        'oracleFingerprint',
        'budget',
        'cases',
        'verdict',
        'contentHash',
      ]);
      if (
        artifact.schemaVersion !== 1
        || artifact.proposalRevision !== 1
        || !nonEmpty(artifact.proposalId)
        || !nonEmpty(artifact.gateAttemptId)
        || !positiveInteger(artifact.gateAttemptOrdinal)
        || !hash(artifact.gatePolicyFingerprint)
        || !hash(artifact.draftContentHash)
        || !hash(artifact.candidateMaterializationContentHash)
        || !hash(artifact.corpusFingerprint)
        || !nonEmpty(artifact.traceProcessorVersion)
        || !nonEmpty(artifact.sqlValidatorVersion)
        || !hash(artifact.sqlGuardrailFingerprint)
        || !hash(artifact.oracleFingerprint)
        || !Array.isArray(artifact.cases)
        || artifact.cases.length === 0
      ) {
        fail('proposal_sql_regression_proof_invalid');
      }
      const budget = record(
        artifact.budget,
        'proposal_sql_regression_budget_invalid',
      );
      exactKeys(budget, [
        'timeoutMs',
        'maxCpuMs',
        'maxRows',
        'maxResponseBytes',
      ]);
      if (
        !positiveInteger(budget.timeoutMs)
        || !positiveInteger(budget.maxCpuMs)
        || !positiveInteger(budget.maxRows)
        || !positiveInteger(budget.maxResponseBytes)
      ) {
        fail('proposal_sql_regression_budget_invalid');
      }
      const cases = artifact.cases.map((caseValue: unknown) => {
        const caseResult = record(
          caseValue,
          'proposal_sql_regression_case_invalid',
        );
        exactKeys(caseResult, [
          'caseId',
          'traceContentHash',
          'queryContentHash',
          'baselineQueryContentHash',
          'baselineResultContentHash',
          'candidateResultContentHash',
          'oracleContentHash',
          'orderPolicy',
          'rowCount',
          'columns',
          'durationMs',
          'traceProcessorCpuMs',
          'resultBytes',
          'verdict',
          'reasonCode',
        ], ['reasonCode']);
        if (
          !nonEmpty(caseResult.caseId)
          || !hash(caseResult.traceContentHash)
          || !hash(caseResult.queryContentHash)
          || !hash(caseResult.baselineQueryContentHash)
          || !hash(caseResult.baselineResultContentHash)
          || !hash(caseResult.candidateResultContentHash)
          || !hash(caseResult.oracleContentHash)
          || !['sql_order_by', 'canonical_row_sort'].includes(
            String(caseResult.orderPolicy),
          )
          || !Number.isSafeInteger(caseResult.rowCount)
          || Number(caseResult.rowCount) < 0
          || !Array.isArray(caseResult.columns)
          || caseResult.columns.some(column => !nonEmpty(column))
          || !nonNegativeInteger(caseResult.durationMs)
          || !nonNegativeInteger(caseResult.traceProcessorCpuMs)
          || !nonNegativeInteger(caseResult.resultBytes)
        ) {
          fail('proposal_sql_regression_case_invalid');
        }
        return {
          caseId: caseResult.caseId as string,
          traceContentHash: caseResult.traceContentHash as string,
          queryContentHash: caseResult.queryContentHash as string,
          baselineQueryContentHash:
            caseResult.baselineQueryContentHash as string,
          baselineResultContentHash:
            caseResult.baselineResultContentHash as string,
          candidateResultContentHash:
            caseResult.candidateResultContentHash as string,
          oracleContentHash: caseResult.oracleContentHash as string,
          orderPolicy:
            caseResult.orderPolicy as 'sql_order_by' | 'canonical_row_sort',
          rowCount: caseResult.rowCount as number,
          columns: caseResult.columns as string[],
          durationMs: caseResult.durationMs as number,
          traceProcessorCpuMs: caseResult.traceProcessorCpuMs as number,
          resultBytes: caseResult.resultBytes as number,
          verdict: parseTerminalVerdict(
            caseResult.verdict,
            'proposal_sql_regression_case_verdict_invalid',
          ),
          ...(caseResult.reasonCode !== undefined
            ? {reasonCode: requiredString(caseResult.reasonCode)}
            : {}),
        };
      });
      const verdict = parseTerminalVerdict(
        artifact.verdict,
        'proposal_sql_regression_verdict_invalid',
      );
      if (
        (verdict === 'passed'
          && cases.some(caseResult => caseResult.verdict !== 'passed'))
        || (verdict !== 'passed'
          && cases.every(caseResult => caseResult.verdict === 'passed'))
      ) {
        fail('proposal_sql_regression_verdict_invariant_failed');
      }
      return {
        schemaVersion: 1 as const,
        proposalId: artifact.proposalId as string,
        proposalRevision: 1 as const,
        gateAttemptId: artifact.gateAttemptId as string,
        gateAttemptOrdinal: artifact.gateAttemptOrdinal as number,
        gatePolicyFingerprint: artifact.gatePolicyFingerprint as string,
        draftContentHash: artifact.draftContentHash as string,
        candidateMaterializationContentHash:
          artifact.candidateMaterializationContentHash as string,
        corpusFingerprint: artifact.corpusFingerprint as string,
        traceProcessorVersion: artifact.traceProcessorVersion as string,
        sqlValidatorVersion: artifact.sqlValidatorVersion as string,
        sqlGuardrailFingerprint: artifact.sqlGuardrailFingerprint as string,
        oracleFingerprint: artifact.oracleFingerprint as string,
        budget: {
          timeoutMs: budget.timeoutMs as number,
          maxCpuMs: budget.maxCpuMs as number,
          maxRows: budget.maxRows as number,
          maxResponseBytes: budget.maxResponseBytes as number,
        },
        cases,
        verdict,
      };
    },
  );
}

export function createProposalSqlRegressionProofV1(
  value: Omit<ProposalSqlRegressionProofV1, 'schemaVersion' | 'contentHash'>,
): ProposalSqlRegressionProofV1 {
  return parseProposalSqlRegressionProofV1(withHash(value));
}

export function parseProposalPairedReplayProofV1(
  value: unknown,
): ProposalPairedReplayProofV1 {
  return parseContentHashedArtifact(
    value,
    'proposal_paired_replay_proof_invalid',
    artifact => {
      exactKeys(artifact, [
        'schemaVersion',
        'proposalId',
        'proposalRevision',
        'gateAttemptId',
        'gateAttemptOrdinal',
        'gatePolicyFingerprint',
        'draftContentHash',
        'candidateArtifactId',
        'candidateMaterializationContentHash',
        'runId',
        'runSpecContentHash',
        'pinnedContentHash',
        'candidateContentHash',
        'treatmentArtifactContentHash',
        'materializedInputHash',
        'fullTreatmentContractHash',
        'caseContentHashes',
        'publishedRecords',
        'attestationContentHashes',
        'splitSummaries',
        'epsilon',
        'verdict',
        'contentHash',
      ]);
      if (
        artifact.schemaVersion !== 1
        || artifact.proposalRevision !== 1
        || !nonEmpty(artifact.proposalId)
        || !nonEmpty(artifact.gateAttemptId)
        || !positiveInteger(artifact.gateAttemptOrdinal)
        || !hash(artifact.gatePolicyFingerprint)
        || !hash(artifact.draftContentHash)
        || !nonEmpty(artifact.candidateArtifactId)
        || !hash(artifact.candidateMaterializationContentHash)
        || !nonEmpty(artifact.runId)
        || !hash(artifact.runSpecContentHash)
        || !hash(artifact.pinnedContentHash)
        || !hash(artifact.candidateContentHash)
        || !hash(artifact.treatmentArtifactContentHash)
        || !hash(artifact.materializedInputHash)
        || !hash(artifact.fullTreatmentContractHash)
        || artifact.epsilon !== 0.02
        || !Array.isArray(artifact.caseContentHashes)
        || !Array.isArray(artifact.publishedRecords)
        || !Array.isArray(artifact.attestationContentHashes)
        || !Array.isArray(artifact.splitSummaries)
      ) {
        fail('proposal_paired_replay_proof_invalid');
      }
      const splitSummaries = artifact.splitSummaries.map(
        (summaryValue: unknown) => {
          const summary = record(
            summaryValue,
            'proposal_paired_replay_summary_invalid',
          );
          exactKeys(summary, [
            'split',
            'caseCount',
            'baselineClaimVerifiedRatioMean',
            'candidateClaimVerifiedRatioMean',
            'baselineUnsupportedClaims',
            'candidateUnsupportedClaims',
            'baselineEvidenceAnchors',
            'candidateEvidenceAnchors',
            'verdict',
          ]);
          if (
            !['validation', 'holdout'].includes(String(summary.split))
            || !positiveInteger(summary.caseCount)
            || !unitNumber(summary.baselineClaimVerifiedRatioMean)
            || !unitNumber(summary.candidateClaimVerifiedRatioMean)
            || !nonNegativeInteger(summary.baselineUnsupportedClaims)
            || !nonNegativeInteger(summary.candidateUnsupportedClaims)
            || !nonNegativeInteger(summary.baselineEvidenceAnchors)
            || !nonNegativeInteger(summary.candidateEvidenceAnchors)
          ) {
            fail('proposal_paired_replay_summary_invalid');
          }
          return {
            split: summary.split as 'validation' | 'holdout',
            caseCount: summary.caseCount as number,
            baselineClaimVerifiedRatioMean:
              summary.baselineClaimVerifiedRatioMean as number,
            candidateClaimVerifiedRatioMean:
              summary.candidateClaimVerifiedRatioMean as number,
            baselineUnsupportedClaims:
              summary.baselineUnsupportedClaims as number,
            candidateUnsupportedClaims:
              summary.candidateUnsupportedClaims as number,
            baselineEvidenceAnchors:
              summary.baselineEvidenceAnchors as number,
            candidateEvidenceAnchors:
              summary.candidateEvidenceAnchors as number,
            verdict: parseTerminalVerdict(
              summary.verdict,
              'proposal_paired_replay_summary_verdict_invalid',
            ),
          };
        },
      );
      if (
        splitSummaries.length !== 2
        || splitSummaries[0].split !== 'validation'
        || splitSummaries[1].split !== 'holdout'
      ) {
        fail('proposal_paired_replay_split_coverage_invalid');
      }
      const verdict = parseTerminalVerdict(
        artifact.verdict,
        'proposal_paired_replay_verdict_invalid',
      );
      if (
        (verdict === 'passed'
          && splitSummaries.some(summary => summary.verdict !== 'passed'))
        || (verdict !== 'passed'
          && splitSummaries.every(summary => summary.verdict === 'passed'))
      ) {
        fail('proposal_paired_replay_verdict_invariant_failed');
      }
      const caseContentHashes = artifact.caseContentHashes.map(
        (caseValue: unknown) => {
          const caseHash = record(
            caseValue,
            'proposal_paired_replay_case_hash_invalid',
          );
          exactKeys(caseHash, ['caseId', 'split', 'contentHash']);
          if (
            !nonEmpty(caseHash.caseId)
            || !['train', 'validation', 'holdout'].includes(
              String(caseHash.split),
            )
            || !hash(caseHash.contentHash)
          ) {
            fail('proposal_paired_replay_case_hash_invalid');
          }
          return {
            caseId: caseHash.caseId as string,
            split: caseHash.split as 'train' | 'validation' | 'holdout',
            contentHash: caseHash.contentHash as string,
          };
        },
      );
      const publishedRecords = artifact.publishedRecords.map(
        (recordValue: unknown) => {
          const published = record(
            recordValue,
            'proposal_paired_replay_published_record_invalid',
          );
          exactKeys(
            published,
            ['caseId', 'role', 'resultRef', 'contentHash'],
          );
          if (
            !nonEmpty(published.caseId)
            || !['baseline', 'candidate'].includes(String(published.role))
            || !nonEmpty(published.resultRef)
            || !hash(published.contentHash)
          ) {
            fail('proposal_paired_replay_published_record_invalid');
          }
          return {
            caseId: published.caseId as string,
            role: published.role as 'baseline' | 'candidate',
            resultRef: published.resultRef as string,
            contentHash: published.contentHash as string,
          };
        },
      );
      if (
        new Set(publishedRecords.map(item =>
          `${item.caseId}\0${item.role}`)).size !== publishedRecords.length
      ) {
        fail('proposal_paired_replay_published_records_duplicate');
      }
      const expectedPublishedKeys = caseContentHashes
        .filter(item => item.split !== 'train')
        .flatMap(item => [
          `${item.caseId}\0baseline`,
          `${item.caseId}\0candidate`,
        ])
        .sort();
      const actualPublishedKeys = publishedRecords
        .map(item => `${item.caseId}\0${item.role}`)
        .sort();
      if (
        expectedPublishedKeys.length !== actualPublishedKeys.length
        || expectedPublishedKeys.some(
          (expected, index) => expected !== actualPublishedKeys[index],
        )
      ) {
        fail('proposal_paired_replay_published_records_incomplete');
      }
      const attestationContentHashes = hashArray(
        artifact.attestationContentHashes,
        'proposal_paired_replay_attestation_hashes_invalid',
      );
      const evaluatedCaseCount = caseContentHashes.filter(
        item => item.split !== 'train',
      ).length;
      if (
        attestationContentHashes.length !== evaluatedCaseCount
        || new Set(attestationContentHashes).size
          !== attestationContentHashes.length
      ) {
        fail('proposal_paired_replay_attestations_incomplete');
      }
      return {
        schemaVersion: 1 as const,
        proposalId: artifact.proposalId as string,
        proposalRevision: 1 as const,
        gateAttemptId: artifact.gateAttemptId as string,
        gateAttemptOrdinal: artifact.gateAttemptOrdinal as number,
        gatePolicyFingerprint: artifact.gatePolicyFingerprint as string,
        draftContentHash: artifact.draftContentHash as string,
        candidateArtifactId: artifact.candidateArtifactId as string,
        candidateMaterializationContentHash:
          artifact.candidateMaterializationContentHash as string,
        runId: artifact.runId as string,
        runSpecContentHash: artifact.runSpecContentHash as string,
        pinnedContentHash: artifact.pinnedContentHash as string,
        candidateContentHash: artifact.candidateContentHash as string,
        treatmentArtifactContentHash:
          artifact.treatmentArtifactContentHash as string,
        materializedInputHash: artifact.materializedInputHash as string,
        fullTreatmentContractHash:
          artifact.fullTreatmentContractHash as string,
        caseContentHashes,
        publishedRecords,
        attestationContentHashes,
        splitSummaries,
        epsilon: 0.02 as const,
        verdict,
      };
    },
  );
}

export function createProposalPairedReplayProofV1(
  value: Omit<ProposalPairedReplayProofV1, 'schemaVersion' | 'contentHash'>,
): ProposalPairedReplayProofV1 {
  return parseProposalPairedReplayProofV1(withHash(value));
}

function parseChecks(value: unknown): ProposalGateCheckV1[] {
  if (!Array.isArray(value) || value.length !== PROPOSAL_GATE_IDS.length) {
    fail('proposal_gate_checks_invalid');
  }
  return value.map((checkValue, index) => {
    const check = record(checkValue, 'proposal_gate_check_invalid');
    exactKeys(check, [
      'schemaVersion',
      'gateId',
      'verdict',
      'reasonCodes',
      'evidenceContentHashes',
      'durationMs',
    ]);
    if (
      check.schemaVersion !== 1
      || check.gateId !== PROPOSAL_GATE_IDS[index]
      || !GATE_VERDICTS.has(check.verdict as ProposalGateVerdict)
      || !Number.isSafeInteger(check.durationMs)
      || Number(check.durationMs) < 0
    ) {
      fail('proposal_gate_check_invalid');
    }
    return {
      schemaVersion: 1,
      gateId: check.gateId as ProposalGateCheckV1['gateId'],
      verdict: check.verdict as ProposalGateVerdict,
      reasonCodes: stringArray(
        check.reasonCodes,
        'proposal_gate_reason_codes_invalid',
      ),
      evidenceContentHashes: hashArray(
        check.evidenceContentHashes,
        'proposal_gate_evidence_hashes_invalid',
      ),
      durationMs: check.durationMs as number,
    };
  });
}

function parseContentHashedArtifact<T>(
  value: unknown,
  code: string,
  normalize: (value: Record<string, unknown>) => Omit<T, 'contentHash'>,
): T {
  const artifact = record(value, code);
  const normalized = normalize(artifact);
  if (
    !hash(artifact.contentHash)
    || canonicalContentHash(normalized) !== artifact.contentHash
  ) {
    fail(`${code}_hash_mismatch`);
  }
  return immutableCanonicalSnapshot({
    ...normalized,
    contentHash: artifact.contentHash,
  }) as T;
}

function withHash<T extends object>(
  value: T,
): T & {schemaVersion: 1; contentHash: string} {
  const withoutHash = {schemaVersion: 1 as const, ...value};
  return {
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  };
}

function parseTerminalVerdict(
  value: unknown,
  code: string,
): Exclude<ProposalGateVerdict, 'not_run'> {
  if (!['passed', 'failed', 'inconclusive'].includes(String(value))) {
    fail(code);
  }
  return value as Exclude<ProposalGateVerdict, 'not_run'>;
}

function safeRelativePath(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  const candidate = value as string;
  return (
    candidate.length <= 512
    && !candidate.startsWith('/')
    && !candidate.startsWith('\\')
    && !/^[A-Za-z]:/.test(candidate)
    && !candidate.includes('\0')
    && candidate.split(/[\\/]/).every(
      segment => segment !== '' && segment !== '.' && segment !== '..',
    )
  );
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  const required = new Set(keys.filter(key => !optional.includes(key)));
  if (
    Object.keys(value).some(key => !allowed.has(key))
    || [...required].some(key => !(key in value))
  ) {
    fail('proposal_gate_unknown_or_missing_field');
  }
}

function stringArray(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value)
    || value.some(item => !nonEmpty(item))
    || new Set(value).size !== value.length
    || [...value].sort().some((item, index) => item !== value[index])
  ) {
    fail(code);
  }
  return value as string[];
}

function hashArray(value: unknown, code: string): string[] {
  const values = stringArray(value, code);
  if (values.some(item => !hash(item))) fail(code);
  return values;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredString(value: unknown): string {
  if (!nonEmpty(value)) fail('proposal_gate_string_invalid');
  return value;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function unitNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function fail(code: string): never {
  throw new Error(code);
}
